import { and, asc, eq, gte, lte } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { marketChartSourcePoints } from '../db/schema';
import { HttpError } from '../http/errors';
import { downsampleTimeSeries, getRangeDurationMs } from '../modules/chart-semantics';
import { getGranularityMs, parseChartInterval } from '../modules/coins/helpers';

export type MarketChartSourceKind = 'replay' | 'live';
export type MarketChartInterval = '1m' | '1d';

export type RawMarketChartReplay = {
  provider: string;
  captured_at: string;
  coin_id: string;
  vs_currency?: string;
  interval?: MarketChartInterval;
  points: Array<{
    timestamp: number | string;
    price: number | string;
    market_cap?: number | string | null;
    total_volume?: number | string | null;
    open?: number | string | null;
    high?: number | string | null;
    low?: number | string | null;
    close?: number | string | null;
  }>;
};

export type IngestMarketChartOptions = {
  sourceKind?: MarketChartSourceKind;
  sourceProvider?: string | null;
  sourceFetchedAt?: Date;
};

type ChartRange = { from: number; to: number };
type MarketChartSourceRow = typeof marketChartSourcePoints.$inferSelect;

function parseRequiredNumber(value: number | string | null | undefined, field: string) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Missing market chart field: ${field}`);
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid market chart field: ${field}`);
  }

  return parsed;
}

function parseOptionalNumber(value: number | string | null | undefined, field: string) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid market chart field: ${field}`);
  }

  return parsed;
}

function parseTimestamp(value: number | string, field: string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid market chart timestamp: ${field}`);
  }

  return new Date(parsed < 10_000_000_000 ? parsed * 1_000 : parsed);
}

function parseCapturedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid market chart captured_at timestamp: ${value}`);
  }

  return new Date(timestamp);
}

function normalizeInterval(value: string | undefined): MarketChartInterval {
  if (!value) {
    return '1d';
  }

  if (value === '1m' || value === '1d') {
    return value;
  }

  throw new Error(`Invalid market chart interval: ${value}`);
}

function resolveInterval(interval?: string) {
  return parseChartInterval(interval) === 'hourly' ? '1m' : '1d';
}

export function normalizeMarketChartReplay(raw: RawMarketChartReplay) {
  const coinId = raw.coin_id.trim().toLowerCase();
  const vsCurrency = (raw.vs_currency ?? 'usd').trim().toLowerCase();
  const interval = normalizeInterval(raw.interval);
  const capturedAt = parseCapturedAt(raw.captured_at);

  if (!coinId) {
    throw new Error('Missing market chart field: coin_id');
  }

  if (!vsCurrency) {
    throw new Error('Missing market chart field: vs_currency');
  }

  return {
    coinId,
    vsCurrency,
    interval,
    capturedAt,
    points: raw.points.map((point, index) => {
      const price = parseRequiredNumber(point.price, `points.${index}.price`);
      const open = parseOptionalNumber(point.open, `points.${index}.open`) ?? price;
      const high = parseOptionalNumber(point.high, `points.${index}.high`) ?? price;
      const low = parseOptionalNumber(point.low, `points.${index}.low`) ?? price;
      const close = parseOptionalNumber(point.close, `points.${index}.close`) ?? price;

      return {
        coinId,
        vsCurrency,
        interval,
        timestamp: parseTimestamp(point.timestamp, `points.${index}.timestamp`),
        price,
        marketCap: parseOptionalNumber(point.market_cap, `points.${index}.market_cap`),
        totalVolume: parseOptionalNumber(point.total_volume, `points.${index}.total_volume`),
        open,
        high,
        low,
        close,
      };
    }).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()),
  };
}

export function ingestMarketChartReplay(
  database: AppDatabase,
  raw: RawMarketChartReplay,
  options: IngestMarketChartOptions = {},
) {
  const normalized = normalizeMarketChartReplay(raw);
  const sourceKind = options.sourceKind ?? 'replay';
  const sourceProvider = options.sourceProvider ?? (raw.provider.trim() || 'unknown');
  const sourceFetchedAt = options.sourceFetchedAt ?? normalized.capturedAt;

  for (const point of normalized.points) {
    database.db
      .insert(marketChartSourcePoints)
      .values({
        ...point,
        sourceKind,
        sourceProvider,
        sourceFetchedAt,
      })
      .onConflictDoUpdate({
        target: [
          marketChartSourcePoints.coinId,
          marketChartSourcePoints.vsCurrency,
          marketChartSourcePoints.interval,
          marketChartSourcePoints.timestamp,
          marketChartSourcePoints.sourceKind,
          marketChartSourcePoints.sourceProvider,
        ],
        set: {
          price: point.price,
          marketCap: point.marketCap,
          totalVolume: point.totalVolume,
          open: point.open,
          high: point.high,
          low: point.low,
          close: point.close,
          sourceFetchedAt,
        },
      })
      .run();
  }

  return {
    coin_id: normalized.coinId,
    vs_currency: normalized.vsCurrency,
    interval: normalized.interval,
    points_written: normalized.points.length,
    source_kind: sourceKind,
    source_provider: sourceProvider,
    source_fetched_at: sourceFetchedAt.toISOString(),
  };
}

function latestRowsByTimestamp(rows: MarketChartSourceRow[]) {
  const byTimestamp = new Map<number, MarketChartSourceRow>();

  for (const row of rows) {
    const key = row.timestamp.getTime();
    const existing = byTimestamp.get(key);
    if (!existing) {
      byTimestamp.set(key, row);
      continue;
    }

    const sourceRankDelta = (row.sourceKind === 'live' ? 1 : 0) - (existing.sourceKind === 'live' ? 1 : 0);
    const fetchedAtDelta = (row.sourceFetchedAt?.getTime() ?? 0) - (existing.sourceFetchedAt?.getTime() ?? 0);

    if (sourceRankDelta > 0 || (sourceRankDelta === 0 && fetchedAtDelta > 0)) {
      byTimestamp.set(key, row);
    }
  }

  return [...byTimestamp.values()].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

function selectRows(database: AppDatabase, coinId: string, vsCurrency: string, interval: MarketChartInterval, range?: ChartRange) {
  const baseCondition = and(
    eq(marketChartSourcePoints.coinId, coinId),
    eq(marketChartSourcePoints.vsCurrency, vsCurrency),
    eq(marketChartSourcePoints.interval, interval),
  );
  const whereCondition = range
    ? and(
      baseCondition,
      gte(marketChartSourcePoints.timestamp, new Date(range.from)),
      lte(marketChartSourcePoints.timestamp, new Date(range.to)),
    )
    : baseCondition;

  return latestRowsByTimestamp(database.db
    .select()
    .from(marketChartSourcePoints)
    .where(whereCondition)
    .orderBy(asc(marketChartSourcePoints.timestamp))
    .all());
}

export function readMarketChartSourceRowsForDays(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  days: string,
  interval?: string,
) {
  const sourceInterval = resolveInterval(interval);
  const rows = selectRows(database, coinId, vsCurrency, sourceInterval);

  if (rows.length === 0) {
    return [];
  }

  if (days === 'max') {
    const duration = rows.at(-1)!.timestamp.getTime() - rows[0]!.timestamp.getTime();
    return downsampleTimeSeries(rows, getGranularityMs(duration, interval));
  }

  const dayCount = Number(days);
  if (!Number.isFinite(dayCount) || dayCount <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
  }

  const cutoff = rows.at(-1)!.timestamp.getTime() - dayCount * 24 * 60 * 60 * 1000;
  return downsampleTimeSeries(rows.filter((row) => row.timestamp.getTime() >= cutoff), getGranularityMs(dayCount * 24 * 60 * 60 * 1000, interval));
}

export function readMarketChartSourceRowsForRange(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  range: ChartRange,
  interval?: string,
) {
  const rows = selectRows(database, coinId, vsCurrency, resolveInterval(interval), range);

  return downsampleTimeSeries(rows, getGranularityMs(getRangeDurationMs(range), interval));
}

export function readMarketChartSourceOhlcRowsForDays(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  days: string,
  interval?: string,
) {
  return readMarketChartSourceRowsForDays(database, coinId, vsCurrency, days, interval);
}

export function readMarketChartSourceOhlcRowsForRange(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  range: ChartRange,
  interval?: string,
) {
  return readMarketChartSourceRowsForRange(database, coinId, vsCurrency, range, interval);
}
