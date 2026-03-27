import type { AppDatabase } from '../db/client';
import type { OhlcvSyncTargetRow } from '../db/schema';
import { fetchExchangeOHLCV } from '../providers/ccxt';
import { detectOhlcvGaps, enforceOhlcvRetention, repairOhlcvGaps, upsertCanonicalOhlcvCandle } from './candle-store';

type OhlcvSyncTargetLike = Pick<
  OhlcvSyncTargetRow,
  'coinId' | 'exchangeId' | 'symbol' | 'vsCurrency' | 'interval' | 'priorityTier' | 'latestSyncedAt' | 'oldestSyncedAt' | 'targetHistoryDays'
>;

const DAY_MS = 24 * 60 * 60 * 1000;

function persistCandles(database: AppDatabase, target: OhlcvSyncTargetLike, candles: Awaited<ReturnType<typeof fetchExchangeOHLCV>>) {
  for (const candle of candles) {
    upsertCanonicalOhlcvCandle(database, {
      coinId: target.coinId,
      vsCurrency: target.vsCurrency,
      interval: '1d',
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
  return repairOhlcvGaps(database, {
    coinId: target.coinId,
    exchangeId: target.exchangeId,
    symbol: target.symbol,
    vsCurrency: target.vsCurrency,
    interval: target.interval as '1m' | '1d',
  }, (since, limit) => fetchExchangeOHLCV(target.exchangeId, target.symbol, target.interval, since, limit));
}

export { detectOhlcvGaps, repairOhlcvGaps, enforceOhlcvRetention };

export async function syncRecentOhlcvWindow(database: AppDatabase, target: OhlcvSyncTargetLike, now: Date) {
  const seededRecentSince = now.getTime() - 30 * DAY_MS;
  const since = target.latestSyncedAt
    ? target.latestSyncedAt.getTime() + DAY_MS
    : seededRecentSince;

  const candles = await fetchExchangeOHLCV(target.exchangeId, target.symbol, '1d', since);
  persistCandles(database, target, candles);
  await repairPersistedGaps(database, target);

  return candles;
}

export async function deepenHistoricalOhlcvWindow(database: AppDatabase, target: OhlcvSyncTargetLike, now: Date) {
  const desiredOldest = now.getTime() - target.targetHistoryDays * DAY_MS;
  const since = target.oldestSyncedAt
    ? target.oldestSyncedAt.getTime() - 2 * DAY_MS
    : desiredOldest;

  const candles = await fetchExchangeOHLCV(target.exchangeId, target.symbol, '1d', since);
  persistCandles(database, target, candles);
  await repairPersistedGaps(database, target);

  return candles;
}
