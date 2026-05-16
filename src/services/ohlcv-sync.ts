import type { AppDatabase } from '../db/client';
import type { OhlcvSyncTargetRow } from '../db/schema';
import { fetchExchangeOHLCV } from '../providers/ccxt';
import type { CandleInterval } from './candle-store';
import { detectOhlcvGaps, enforceOhlcvRetention, repairOhlcvGaps, upsertCanonicalOhlcvCandle } from './candle-store';

type OhlcvSyncTargetLike = Pick<
  OhlcvSyncTargetRow,
  'coinId' | 'exchangeId' | 'symbol' | 'vsCurrency' | 'interval' | 'priorityTier' | 'latestSyncedAt' | 'oldestSyncedAt' | 'targetHistoryDays'
>;

const DAY_MS = 24 * 60 * 60 * 1000;
export const HISTORICAL_DEEPEN_CHUNK_DAYS = 180;
export const HISTORICAL_DEEPEN_OVERLAP_DAYS = 2;

function getIntervalMs(interval: CandleInterval) {
  return interval === '1m' ? 60_000 : DAY_MS;
}

function getSupportedTargetInterval(target: OhlcvSyncTargetLike): CandleInterval {
  if (target.interval === '1m' || target.interval === '1d') {
    return target.interval;
  }

  throw new Error(`Unsupported OHLCV interval: ${target.interval}`);
}

function persistCandles(database: AppDatabase, target: OhlcvSyncTargetLike, candles: Awaited<ReturnType<typeof fetchExchangeOHLCV>>) {
  const interval = getSupportedTargetInterval(target);

  for (const candle of candles) {
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
  }
}

async function repairPersistedGaps(database: AppDatabase, target: OhlcvSyncTargetLike) {
  const interval = getSupportedTargetInterval(target);

  return repairOhlcvGaps(database, {
    coinId: target.coinId,
    exchangeId: target.exchangeId,
    symbol: target.symbol,
    vsCurrency: target.vsCurrency,
    interval,
  }, (since, limit) => fetchExchangeOHLCV(target.exchangeId, target.symbol, interval, since, limit));
}

export { detectOhlcvGaps, repairOhlcvGaps, enforceOhlcvRetention };

export async function syncRecentOhlcvWindow(database: AppDatabase, target: OhlcvSyncTargetLike, now: Date) {
  const interval = getSupportedTargetInterval(target);
  const intervalMs = getIntervalMs(interval);
  const seededRecentSince = now.getTime() - 30 * DAY_MS;
  const since = target.latestSyncedAt
    ? target.latestSyncedAt.getTime() + intervalMs
    : seededRecentSince;

  const candles = await fetchExchangeOHLCV(target.exchangeId, target.symbol, interval, since);
  persistCandles(database, target, candles);
  await repairPersistedGaps(database, target);

  return candles;
}

export async function deepenHistoricalOhlcvWindow(database: AppDatabase, target: OhlcvSyncTargetLike, now: Date) {
  const interval = getSupportedTargetInterval(target);
  const intervalMs = getIntervalMs(interval);
  const desiredOldest = now.getTime() - target.targetHistoryDays * DAY_MS;
  const oldestSyncedAt = target.oldestSyncedAt?.getTime();

  if (oldestSyncedAt !== undefined && oldestSyncedAt <= desiredOldest) {
    return [];
  }

  const referenceEnd = oldestSyncedAt ?? target.latestSyncedAt?.getTime() ?? now.getTime();
  const chunkDays = HISTORICAL_DEEPEN_CHUNK_DAYS + HISTORICAL_DEEPEN_OVERLAP_DAYS;
  const since = Math.max(desiredOldest, referenceEnd - chunkDays * DAY_MS);
  const limit = Math.max(Math.ceil((referenceEnd - since) / intervalMs), 1);

  const candles = await fetchExchangeOHLCV(target.exchangeId, target.symbol, interval, since, limit);
  persistCandles(database, target, candles);
  await repairPersistedGaps(database, target);

  return candles;
}
