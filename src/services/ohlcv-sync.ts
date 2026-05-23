import type { AppDatabase } from '../db/client';
import type { OhlcvSyncTargetRow } from '../db/schema';
import { fetchExchangeOHLCV } from '../providers/ccxt';
import type { CandleInterval } from './candle-store';
import {
  detectOhlcvGaps,
  enforceOhlcvRetention,
  hasValidOhlcInvariants,
  repairOhlcvGaps,
  upsertCanonicalOhlcvCandle,
} from './candle-store';
import { isOhlcvTargetLeaseActive } from './ohlcv-worker-state';

type FetchedOhlcvCandle = Awaited<ReturnType<typeof fetchExchangeOHLCV>>[number];

export type OhlcvSyncResult = FetchedOhlcvCandle[] & {
  readonly rawFetchedCount: number;
  readonly acceptedCount: number;
  readonly persistedCount: number;
  readonly acceptedCandles: FetchedOhlcvCandle[];
};

type OhlcvSyncTargetLike = Pick<
  OhlcvSyncTargetRow,
  'coinId' | 'exchangeId' | 'symbol' | 'vsCurrency' | 'interval' | 'priorityTier' | 'latestSyncedAt' | 'oldestSyncedAt' | 'targetHistoryDays'
> & Partial<Pick<OhlcvSyncTargetRow, 'leaseOwner' | 'leaseToken'>>;

const DAY_MS = 24 * 60 * 60 * 1000;
export const HISTORICAL_DEEPEN_CHUNK_DAYS = 180;
export const HISTORICAL_DEEPEN_OVERLAP_DAYS = 2;
const NEVER_SYNCED_1M_RECENT_BOOTSTRAP_MINUTES = 60;

function getIntervalMs(interval: CandleInterval) {
  return interval === '1m' ? 60_000 : DAY_MS;
}

function getSupportedTargetInterval(target: OhlcvSyncTargetLike): CandleInterval {
  if (target.interval === '1m' || target.interval === '1d') {
    return target.interval;
  }

  throw new Error(`Unsupported OHLCV interval: ${target.interval}`);
}

function createOhlcvSyncResult(
  rawCandles: FetchedOhlcvCandle[],
  acceptedCandles: FetchedOhlcvCandle[],
  persistedCandles: FetchedOhlcvCandle[] = acceptedCandles,
): OhlcvSyncResult {
  const result = [...persistedCandles] as OhlcvSyncResult;

  Object.defineProperties(result, {
    rawFetchedCount: {
      value: rawCandles.length,
      enumerable: false,
    },
    acceptedCount: {
      value: acceptedCandles.length,
      enumerable: false,
    },
    persistedCount: {
      value: persistedCandles.length,
      enumerable: false,
    },
    acceptedCandles: {
      value: acceptedCandles,
      enumerable: false,
    },
  });

  return result;
}

function hasLeaseGuard(target: OhlcvSyncTargetLike): target is OhlcvSyncTargetLike & { leaseOwner: string; leaseToken: string } {
  return typeof target.leaseOwner === 'string'
    && target.leaseOwner.length > 0
    && typeof target.leaseToken === 'string'
    && target.leaseToken.length > 0;
}

function isLeaseActiveForWrite(database: AppDatabase, target: OhlcvSyncTargetLike, activeAt: Date) {
  if (!hasLeaseGuard(target)) {
    return true;
  }

  return isOhlcvTargetLeaseActive(database, {
    coinId: target.coinId,
    exchangeId: target.exchangeId,
    symbol: target.symbol,
    interval: target.interval,
    vsCurrency: target.vsCurrency,
    leaseOwner: target.leaseOwner,
    leaseToken: target.leaseToken,
    activeAt,
  });
}

function persistCandles(database: AppDatabase, target: OhlcvSyncTargetLike, candles: FetchedOhlcvCandle[]) {
  const interval = getSupportedTargetInterval(target);
  const acceptedCandles = candles.filter(hasValidOhlcInvariants);
  const persistedCandles: FetchedOhlcvCandle[] = [];

  for (const candle of acceptedCandles) {
    const writeAt = new Date();
    if (!isLeaseActiveForWrite(database, target, writeAt)) {
      break;
    }

    upsertCanonicalOhlcvCandle(database, {
      coinId: target.coinId,
      vsCurrency: target.vsCurrency,
      interval,
      timestamp: new Date(candle.timestamp),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      totalVolume: candle.volume,
      replaceExisting: true,
    });
    persistedCandles.push(candle);
  }

  return createOhlcvSyncResult(candles, acceptedCandles, persistedCandles);
}

async function repairPersistedGaps(database: AppDatabase, target: OhlcvSyncTargetLike) {
  const interval = getSupportedTargetInterval(target);
  const beforeWrite = hasLeaseGuard(target)
    ? () => isLeaseActiveForWrite(database, target, new Date())
    : undefined;

  return repairOhlcvGaps(database, {
    coinId: target.coinId,
    exchangeId: target.exchangeId,
    symbol: target.symbol,
    vsCurrency: target.vsCurrency,
    interval,
  }, (since, limit) => fetchExchangeOHLCV(target.exchangeId, target.symbol, interval, since, limit), { beforeWrite });
}

export { detectOhlcvGaps, repairOhlcvGaps, enforceOhlcvRetention };

export async function syncRecentOhlcvWindow(database: AppDatabase, target: OhlcvSyncTargetLike, now: Date) {
  const interval = getSupportedTargetInterval(target);
  const intervalMs = getIntervalMs(interval);
  const seededRecentSince = now.getTime() - 30 * DAY_MS;
  const neverSyncedIntradaySince = now.getTime() - NEVER_SYNCED_1M_RECENT_BOOTSTRAP_MINUTES * 60_000;
  const since = target.latestSyncedAt
    ? target.latestSyncedAt.getTime() + intervalMs
    : interval === '1m'
      ? neverSyncedIntradaySince
      : seededRecentSince;
  const limit = !target.latestSyncedAt && interval === '1m'
    ? NEVER_SYNCED_1M_RECENT_BOOTSTRAP_MINUTES
    : undefined;

  const candles = limit === undefined
    ? await fetchExchangeOHLCV(target.exchangeId, target.symbol, interval, since)
    : await fetchExchangeOHLCV(target.exchangeId, target.symbol, interval, since, limit);
  const result = persistCandles(database, target, candles);
  await repairPersistedGaps(database, target);

  return result;
}

export async function deepenHistoricalOhlcvWindow(database: AppDatabase, target: OhlcvSyncTargetLike, now: Date) {
  const interval = getSupportedTargetInterval(target);
  const intervalMs = getIntervalMs(interval);
  const desiredOldest = now.getTime() - target.targetHistoryDays * DAY_MS;
  const oldestSyncedAt = target.oldestSyncedAt?.getTime();

  if (oldestSyncedAt !== undefined && oldestSyncedAt <= desiredOldest) {
    return createOhlcvSyncResult([], []);
  }

  const referenceEnd = oldestSyncedAt ?? target.latestSyncedAt?.getTime() ?? now.getTime();
  const chunkDays = HISTORICAL_DEEPEN_CHUNK_DAYS + HISTORICAL_DEEPEN_OVERLAP_DAYS;
  const since = Math.max(desiredOldest, referenceEnd - chunkDays * DAY_MS);
  const limit = Math.max(Math.ceil((referenceEnd - since) / intervalMs), 1);

  const candles = await fetchExchangeOHLCV(target.exchangeId, target.symbol, interval, since, limit);
  const result = persistCandles(database, target, candles);
  await repairPersistedGaps(database, target);

  return result;
}
