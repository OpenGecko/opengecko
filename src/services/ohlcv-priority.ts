import { and, asc, eq, isNull, or } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { marketSnapshots, ohlcvSyncTargets } from '../db/schema';

export function selectTopOhlcvCoins(database: AppDatabase, limit: number) {
  return database.db
    .select({ coinId: marketSnapshots.coinId })
    .from(marketSnapshots)
    .where(and(
      eq(marketSnapshots.vsCurrency, 'usd'),
      or(isNull(marketSnapshots.marketCapRank), eq(marketSnapshots.sourceCount, 0), eq(marketSnapshots.sourceCount, 1), eq(marketSnapshots.sourceCount, 2), eq(marketSnapshots.sourceCount, 3), eq(marketSnapshots.sourceCount, 4), eq(marketSnapshots.sourceCount, 5), eq(marketSnapshots.sourceCount, 6), eq(marketSnapshots.sourceCount, 7), eq(marketSnapshots.sourceCount, 8), eq(marketSnapshots.sourceCount, 9), eq(marketSnapshots.sourceCount, 10)),
    ))
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
