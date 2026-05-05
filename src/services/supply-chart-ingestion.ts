import { and, desc, eq, gte, lte } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { supplyChartPoints } from '../db/schema';
import { HttpError } from '../http/errors';
import { downsampleTimeSeries, getRangeDurationMs } from '../modules/chart-semantics';
import { getGranularityMs } from '../modules/coins/helpers';

export type SupplyChartSourceKind = 'replay' | 'live';
export type SupplyType = 'circulating' | 'total';

export type RawSupplyChartReplay = {
  provider: string;
  captured_at: string;
  coin_id: string;
  points: Array<{
    timestamp: number | string;
    circulating_supply?: number | string | null;
    total_supply?: number | string | null;
  }>;
};

export type IngestSupplyChartOptions = {
  sourceKind?: SupplyChartSourceKind;
  sourceProvider?: string | null;
  sourceFetchedAt?: Date;
};

type NormalizedSupplyChartPoint = {
  coinId: string;
  supplyType: SupplyType;
  timestamp: Date;
  value: number;
};

function parseFiniteNumber(value: number | string | null | undefined, field: string) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid supply chart field: ${field}`);
  }

  return parsed;
}

function parseTimestamp(value: number | string, field: string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid supply chart timestamp: ${field}`);
  }

  return new Date(parsed < 10_000_000_000 ? parsed * 1_000 : parsed);
}

function parseCapturedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid supply chart captured_at timestamp: ${value}`);
  }

  return new Date(timestamp);
}

function validateDays(days: string) {
  if (days === 'max') {
    return 'max' as const;
  }

  const dayCount = Number(days);
  if (!Number.isFinite(dayCount) || dayCount <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
  }

  return dayCount;
}

export function normalizeSupplyChartReplay(raw: RawSupplyChartReplay) {
  const coinId = raw.coin_id.trim().toLowerCase();
  const capturedAt = parseCapturedAt(raw.captured_at);
  const points: NormalizedSupplyChartPoint[] = [];

  if (!coinId) {
    throw new Error('Missing supply chart field: coin_id');
  }

  for (const [index, point] of raw.points.entries()) {
    const timestamp = parseTimestamp(point.timestamp, `points.${index}.timestamp`);
    const circulatingSupply = parseFiniteNumber(point.circulating_supply, `points.${index}.circulating_supply`);
    const totalSupply = parseFiniteNumber(point.total_supply, `points.${index}.total_supply`);

    if (circulatingSupply !== null) {
      points.push({ coinId, supplyType: 'circulating', timestamp, value: circulatingSupply });
    }

    if (totalSupply !== null) {
      points.push({ coinId, supplyType: 'total', timestamp, value: totalSupply });
    }
  }

  return {
    coinId,
    capturedAt,
    points: points.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()),
  };
}

export function ingestSupplyChartReplay(
  database: AppDatabase,
  raw: RawSupplyChartReplay,
  options: IngestSupplyChartOptions = {},
) {
  const normalized = normalizeSupplyChartReplay(raw);
  const sourceKind = options.sourceKind ?? 'replay';
  const sourceProvider = options.sourceProvider ?? (raw.provider.trim() || 'unknown');
  const sourceFetchedAt = options.sourceFetchedAt ?? normalized.capturedAt;

  for (const point of normalized.points) {
    database.db
      .insert(supplyChartPoints)
      .values({
        ...point,
        sourceKind,
        sourceProvider,
        sourceFetchedAt,
      })
      .onConflictDoUpdate({
        target: [
          supplyChartPoints.coinId,
          supplyChartPoints.supplyType,
          supplyChartPoints.timestamp,
          supplyChartPoints.sourceKind,
          supplyChartPoints.sourceProvider,
        ],
        set: {
          value: point.value,
          sourceFetchedAt,
        },
      })
      .run();
  }

  return {
    coin_id: normalized.coinId,
    points_written: normalized.points.length,
    source_kind: sourceKind,
    source_provider: sourceProvider,
    source_fetched_at: sourceFetchedAt.toISOString(),
  };
}

function latestRowsByTimestamp(rows: Array<typeof supplyChartPoints.$inferSelect>) {
  const byTimestamp = new Map<number, typeof supplyChartPoints.$inferSelect>();

  for (const row of rows) {
    const key = row.timestamp.getTime();
    const existing = byTimestamp.get(key);
    if (!existing) {
      byTimestamp.set(key, row);
      continue;
    }

    const existingRank = existing.sourceKind === 'live' ? 1 : 0;
    const rowRank = row.sourceKind === 'live' ? 1 : 0;
    const existingFetchedAt = existing.sourceFetchedAt?.getTime() ?? 0;
    const rowFetchedAt = row.sourceFetchedAt?.getTime() ?? 0;

    if (rowRank > existingRank || (rowRank === existingRank && rowFetchedAt > existingFetchedAt)) {
      byTimestamp.set(key, row);
    }
  }

  return [...byTimestamp.values()].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

export function readSupplyChartRowsForDays(
  database: AppDatabase,
  coinId: string,
  supplyType: SupplyType,
  days: string,
  interval?: string,
) {
  const dayCount = validateDays(days);
  const rows = latestRowsByTimestamp(database.db
    .select()
    .from(supplyChartPoints)
    .where(and(
      eq(supplyChartPoints.coinId, coinId),
      eq(supplyChartPoints.supplyType, supplyType),
    ))
    .orderBy(desc(supplyChartPoints.timestamp), desc(supplyChartPoints.sourceKind), desc(supplyChartPoints.sourceFetchedAt))
    .all());

  if (dayCount === 'max') {
    if (rows.length === 0) {
      return rows;
    }

    const duration = rows.at(-1)!.timestamp.getTime() - rows[0]!.timestamp.getTime();
    return downsampleTimeSeries(rows, getGranularityMs(duration, interval));
  }

  const latestTimestamp = rows.at(-1)?.timestamp.getTime();
  if (!latestTimestamp) {
    return [];
  }

  const cutoff = latestTimestamp - dayCount * 24 * 60 * 60 * 1000;
  return downsampleTimeSeries(
    rows.filter((row) => row.timestamp.getTime() >= cutoff),
    getGranularityMs(dayCount * 24 * 60 * 60 * 1000, interval),
  );
}

export function readSupplyChartRowsForRange(
  database: AppDatabase,
  coinId: string,
  supplyType: SupplyType,
  range: { from: number; to: number },
) {
  const rows = latestRowsByTimestamp(database.db
    .select()
    .from(supplyChartPoints)
    .where(and(
      eq(supplyChartPoints.coinId, coinId),
      eq(supplyChartPoints.supplyType, supplyType),
      gte(supplyChartPoints.timestamp, new Date(range.from)),
      lte(supplyChartPoints.timestamp, new Date(range.to)),
    ))
    .orderBy(desc(supplyChartPoints.timestamp), desc(supplyChartPoints.sourceKind), desc(supplyChartPoints.sourceFetchedAt))
    .all());

  return downsampleTimeSeries(rows, getRangeDurationMs(range));
}
