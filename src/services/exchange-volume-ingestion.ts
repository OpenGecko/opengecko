import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { exchangeVolumeSourcePoints } from '../db/schema';
import { HttpError } from '../http/errors';

export type ExchangeVolumeSourceKind = 'replay' | 'live';

export type RawExchangeVolumeReplay = {
  provider: string;
  captured_at: string;
  exchange_id: string;
  points: Array<{
    timestamp: number | string;
    volume_btc: number | string;
  }>;
};

export type IngestExchangeVolumeOptions = {
  sourceKind?: ExchangeVolumeSourceKind;
  sourceProvider?: string | null;
  sourceFetchedAt?: Date;
};

function parseFiniteNumber(value: number | string | null | undefined, field: string) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Missing exchange volume field: ${field}`);
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid exchange volume field: ${field}`);
  }

  return parsed;
}

function parseTimestamp(value: number | string, field: string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid exchange volume timestamp: ${field}`);
  }

  return new Date(parsed < 10_000_000_000 ? parsed * 1_000 : parsed);
}

function parseCapturedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid exchange volume captured_at timestamp: ${value}`);
  }

  return new Date(timestamp);
}

function parseDays(days: string) {
  const parsedDays = Number(days);

  if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
  }

  return parsedDays;
}

function parseRangeBound(value: string, name: 'from' | 'to') {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${name} value: ${value}`);
  }

  return parsed;
}

export function normalizeExchangeVolumeReplay(raw: RawExchangeVolumeReplay) {
  const exchangeId = raw.exchange_id.trim().toLowerCase();
  const capturedAt = parseCapturedAt(raw.captured_at);

  if (!exchangeId) {
    throw new Error('Missing exchange volume field: exchange_id');
  }

  return {
    exchangeId,
    capturedAt,
    points: raw.points.map((point, index) => ({
      exchangeId,
      timestamp: parseTimestamp(point.timestamp, `points.${index}.timestamp`),
      volumeBtc: parseFiniteNumber(point.volume_btc, `points.${index}.volume_btc`),
    })).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()),
  };
}

export function ingestExchangeVolumeReplay(
  database: AppDatabase,
  raw: RawExchangeVolumeReplay,
  options: IngestExchangeVolumeOptions = {},
) {
  const normalized = normalizeExchangeVolumeReplay(raw);
  const sourceKind = options.sourceKind ?? 'replay';
  const sourceProvider = options.sourceProvider ?? (raw.provider.trim() || 'unknown');
  const sourceFetchedAt = options.sourceFetchedAt ?? normalized.capturedAt;

  for (const point of normalized.points) {
    database.db
      .insert(exchangeVolumeSourcePoints)
      .values({
        ...point,
        sourceKind,
        sourceProvider,
        sourceFetchedAt,
      })
      .onConflictDoUpdate({
        target: [
          exchangeVolumeSourcePoints.exchangeId,
          exchangeVolumeSourcePoints.timestamp,
          exchangeVolumeSourcePoints.sourceKind,
          exchangeVolumeSourcePoints.sourceProvider,
        ],
        set: {
          volumeBtc: point.volumeBtc,
          sourceFetchedAt,
        },
      })
      .run();
  }

  return {
    exchange_id: normalized.exchangeId,
    points_written: normalized.points.length,
    source_kind: sourceKind,
    source_provider: sourceProvider,
    source_fetched_at: sourceFetchedAt.toISOString(),
  };
}

function latestRowsByTimestamp(rows: Array<typeof exchangeVolumeSourcePoints.$inferSelect>) {
  const byTimestamp = new Map<number, typeof exchangeVolumeSourcePoints.$inferSelect>();

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

function toVolumeTuples(rows: Array<typeof exchangeVolumeSourcePoints.$inferSelect>) {
  return rows
    .filter((row) => Number.isFinite(row.volumeBtc))
    .map((row) => [row.timestamp.getTime(), row.volumeBtc] satisfies [number, number]);
}

export function getSourceBackedExchangeVolumeChart(database: AppDatabase, exchangeId: string, days: string) {
  const parsedDays = parseDays(days);
  const cutoffMs = Date.now() - parsedDays * 24 * 60 * 60 * 1000;
  const rows = latestRowsByTimestamp(database.db
    .select()
    .from(exchangeVolumeSourcePoints)
    .where(and(
      eq(exchangeVolumeSourcePoints.exchangeId, exchangeId),
      gte(exchangeVolumeSourcePoints.timestamp, new Date(cutoffMs)),
    ))
    .orderBy(asc(exchangeVolumeSourcePoints.timestamp), desc(exchangeVolumeSourcePoints.sourceKind), desc(exchangeVolumeSourcePoints.sourceFetchedAt))
    .all());

  return toVolumeTuples(rows);
}

export function getSourceBackedExchangeVolumeChartRange(
  database: AppDatabase,
  exchangeId: string,
  from: string,
  to: string,
) {
  const fromSeconds = parseRangeBound(from, 'from');
  const toSeconds = parseRangeBound(to, 'to');

  if (fromSeconds > toSeconds) {
    throw new HttpError(400, 'invalid_parameter', 'Invalid time range: from must be less than or equal to to.');
  }

  const rows = latestRowsByTimestamp(database.db
    .select()
    .from(exchangeVolumeSourcePoints)
    .where(and(
      eq(exchangeVolumeSourcePoints.exchangeId, exchangeId),
      gte(exchangeVolumeSourcePoints.timestamp, new Date(fromSeconds * 1_000)),
      lte(exchangeVolumeSourcePoints.timestamp, new Date(toSeconds * 1_000)),
    ))
    .orderBy(asc(exchangeVolumeSourcePoints.timestamp), desc(exchangeVolumeSourcePoints.sourceKind), desc(exchangeVolumeSourcePoints.sourceFetchedAt))
    .all());

  return toVolumeTuples(rows);
}
