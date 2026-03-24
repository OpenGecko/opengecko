import { and, asc, eq, lte } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { marketSnapshots, ohlcvSyncTargets } from '../db/schema';

export function selectTopOhlcvCoins(database: AppDatabase, limit: number) {
  return database.db
    .select()
    .from(marketSnapshots)
    .where(and(eq(marketSnapshots.vsCurrency, 'usd'), lte(marketSnapshots.marketCapRank, limit)))
    .orderBy(asc(marketSnapshots.marketCapRank), asc(marketSnapshots.coinId))
    .limit(limit)
    .all()
    .map((row) => row.coinId);
}

export function refreshOhlcvPriorityTiers(database: AppDatabase, now: Date, limit = 100) {
  const topCoinIds = new Set(selectTopOhlcvCoins(database, limit));
  const rows = database.db.select().from(ohlcvSyncTargets).all();

  for (const row of rows) {
    const nextPriorityTier = topCoinIds.has(row.coinId) ? 'top100' : 'long_tail';

    if (row.priorityTier === nextPriorityTier) {
      continue;
    }

    database.db.update(ohlcvSyncTargets).set({
      priorityTier: nextPriorityTier,
      updatedAt: now,
    }).where(and(
      eq(ohlcvSyncTargets.coinId, row.coinId),
      eq(ohlcvSyncTargets.exchangeId, row.exchangeId),
      eq(ohlcvSyncTargets.symbol, row.symbol),
      eq(ohlcvSyncTargets.interval, row.interval),
      eq(ohlcvSyncTargets.vsCurrency, row.vsCurrency),
    )).run();
  }
}
