import { desc } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { treasuryEntities, treasuryHoldings, treasurySourceDocuments, treasuryTransactions } from '../db/schema';

export function runTreasurySweep(database: AppDatabase) {
  const entities = database.db.select().from(treasuryEntities).all();
  const holdings = database.db.select().from(treasuryHoldings).all();
  const transactions = database.db.select().from(treasuryTransactions).all();
  const latestSourceDocument = database.db
    .select()
    .from(treasurySourceDocuments)
    .orderBy(desc(treasurySourceDocuments.updatedAt))
    .limit(1)
    .get();

  return {
    targetsProcessed: holdings.length,
    rowsWritten: 0,
    sourceDocuments: latestSourceDocument ? 1 : 0,
    entitiesObserved: entities.length,
    transactionsObserved: transactions.length,
  };
}
