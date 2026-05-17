import { and, eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { onchainPoolOhlcv, type OnchainPoolRow } from '../db/schema';
import {
  type OnchainOhlcvSeriesPoint,
  type OnchainOhlcvTimeframe,
  normalizeAddress,
} from '../modules/onchain/helpers';

export type RawOnchainPoolOhlcvReplay = {
  network_id: string;
  pool_address: string;
  timeframe: OnchainOhlcvTimeframe;
  aggregate?: number | string | null;
  timestamp: number | string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume_usd?: number | string | null;
};

export type OnchainPoolOhlcvIngestionOptions = {
  sourceKind?: 'replay' | 'live';
  sourceProvider?: string | null;
  sourceFetchedAt?: Date | null;
};

export type OnchainPoolOhlcvSourceMetadata = {
  source: 'replay' | 'live';
  sourceProviders: string[];
  latestSourceFetchedAt: Date | null;
  pointCount: number;
  nullVolumeCount: number;
};

function parseFiniteNumber(value: number | string | null | undefined, field: string, required = true) {
  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new Error(`Missing onchain OHLCV replay field: ${field}`);
    }
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid onchain OHLCV replay field: ${field}`);
  }

  return parsed;
}

function parseTimeframe(value: string): OnchainOhlcvTimeframe {
  if (value === 'minute' || value === 'hour' || value === 'day') {
    return value;
  }

  throw new Error(`Unsupported onchain OHLCV replay timeframe: ${value}`);
}

export function normalizeOnchainPoolOhlcvReplayBatch(rawRows: RawOnchainPoolOhlcvReplay[]) {
  return rawRows.map((row) => {
    const aggregate = Math.floor(parseFiniteNumber(row.aggregate ?? 1, 'aggregate') ?? 1);
    if (aggregate <= 0) {
      throw new Error(`Invalid onchain OHLCV replay field: aggregate`);
    }

    const timestamp = Math.floor(parseFiniteNumber(row.timestamp, 'timestamp') ?? 0);
    const open = parseFiniteNumber(row.open, 'open') ?? 0;
    const high = parseFiniteNumber(row.high, 'high') ?? 0;
    const low = parseFiniteNumber(row.low, 'low') ?? 0;
    const close = parseFiniteNumber(row.close, 'close') ?? 0;
    const volumeUsd = parseFiniteNumber(row.volume_usd, 'volume_usd', false);

    if (high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error(`Invalid onchain OHLCV replay high/low envelope at timestamp ${timestamp}`);
    }

    return {
      networkId: row.network_id.trim().toLowerCase(),
      poolAddress: normalizeAddress(row.pool_address),
      timeframe: parseTimeframe(row.timeframe),
      aggregate,
      timestamp,
      open,
      high,
      low,
      close,
      volumeUsd,
    };
  });
}

export function ingestOnchainPoolOhlcvReplayBatch(
  database: AppDatabase,
  rawRows: RawOnchainPoolOhlcvReplay[],
  options: OnchainPoolOhlcvIngestionOptions = {},
) {
  const normalizedRows = normalizeOnchainPoolOhlcvReplayBatch(rawRows);
  const sourceKind = options.sourceKind ?? 'replay';
  const sourceProvider = options.sourceProvider?.trim() || null;
  const sourceFetchedAt = options.sourceFetchedAt ?? null;

  for (const row of normalizedRows) {
    const sourcedRow = {
      ...row,
      sourceKind,
      sourceProvider,
      sourceFetchedAt,
    };

    database.db
      .insert(onchainPoolOhlcv)
      .values(sourcedRow)
      .onConflictDoUpdate({
        target: [
          onchainPoolOhlcv.networkId,
          onchainPoolOhlcv.poolAddress,
          onchainPoolOhlcv.timeframe,
          onchainPoolOhlcv.aggregate,
          onchainPoolOhlcv.timestamp,
        ],
        set: {
          open: sourcedRow.open,
          high: sourcedRow.high,
          low: sourcedRow.low,
          close: sourcedRow.close,
          volumeUsd: sourcedRow.volumeUsd,
          sourceKind: sourcedRow.sourceKind,
          sourceProvider: sourcedRow.sourceProvider,
          sourceFetchedAt: sourcedRow.sourceFetchedAt,
        },
      })
      .run();
  }

  return {
    candles_written: normalizedRows.length,
    pool_addresses: [...new Set(normalizedRows.map((row) => row.poolAddress))],
    timeframes: [...new Set(normalizedRows.map((row) => row.timeframe))],
    source_kind: sourceKind,
    source_provider: sourceProvider,
    source_fetched_at: sourceFetchedAt?.toISOString() ?? null,
  };
}

export function readOnchainPoolOhlcvSeries(
  database: AppDatabase,
  pool: OnchainPoolRow,
  timeframe: OnchainOhlcvTimeframe,
  aggregate: number,
  currency: 'usd' | 'token' = 'usd',
  tokenSelection: string | null = null,
): { series: OnchainOhlcvSeriesPoint[]; source: 'replay' | 'live'; metadata: OnchainPoolOhlcvSourceMetadata } | null {
  const rows = database.db
    .select()
    .from(onchainPoolOhlcv)
    .where(and(
      eq(onchainPoolOhlcv.networkId, pool.networkId),
      eq(onchainPoolOhlcv.poolAddress, normalizeAddress(pool.address)),
      eq(onchainPoolOhlcv.timeframe, timeframe),
      eq(onchainPoolOhlcv.aggregate, aggregate),
    ))
    .all()
    .sort((left, right) => left.timestamp - right.timestamp);

  if (rows.length === 0) {
    return null;
  }

  const multiplier = currency === 'token'
    && tokenSelection !== null
    && normalizeAddress(pool.quoteTokenAddress) === tokenSelection
    ? 1 / (pool.priceUsd ?? 1)
    : 1;

  return {
    source: rows.some((row) => row.sourceKind === 'live') ? 'live' : 'replay',
    metadata: {
      source: rows.some((row) => row.sourceKind === 'live') ? 'live' : 'replay',
      sourceProviders: [...new Set(rows.map((row) => row.sourceProvider).filter((provider): provider is string => Boolean(provider)))].sort(),
      latestSourceFetchedAt: rows.reduce<Date | null>((latest, row) =>
        row.sourceFetchedAt && (latest === null || row.sourceFetchedAt.getTime() > latest.getTime())
          ? row.sourceFetchedAt
          : latest, null),
      pointCount: rows.length,
      nullVolumeCount: rows.filter((row) => row.volumeUsd === null).length,
    },
    series: rows.map((row) => ({
      timestamp: row.timestamp,
      open: Number((row.open * multiplier).toFixed(6)),
      high: Number((row.high * multiplier).toFixed(6)),
      low: Number((row.low * multiplier).toFixed(6)),
      close: Number((row.close * multiplier).toFixed(6)),
      volumeUsd: Number((row.volumeUsd ?? 0).toFixed(2)),
    })),
  };
}
