import { readFileSync } from 'node:fs';

import { desc } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { treasuryEntities, treasuryHoldings, treasurySourceDocuments, treasuryTransactions } from '../db/schema';
import { ingestTreasuryDisclosureReplay } from './treasury-disclosure-ingestion';
import type { RawTreasuryDisclosureReplay } from './treasury-disclosure-normalizer';

type TreasurySweepOptions = {
  replayPath?: string | null;
};

function loadReplayPayload(replayPath: string): RawTreasuryDisclosureReplay[] {
  const parsed = JSON.parse(readFileSync(replayPath, 'utf8')) as RawTreasuryDisclosureReplay | RawTreasuryDisclosureReplay[];

  return Array.isArray(parsed) ? parsed : [parsed];
}

function summarizeCurrentTreasuryRows(database: AppDatabase, rowsWritten: number, targetsProcessed?: number) {
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
    targetsProcessed: targetsProcessed ?? holdings.length,
    rowsWritten,
    sourceDocuments: latestSourceDocument ? 1 : 0,
    entitiesObserved: entities.length,
    transactionsObserved: transactions.length,
  };
}

export function runTreasurySweep(database: AppDatabase, options: TreasurySweepOptions = {}) {
  const replayPath = options.replayPath?.trim();

  if (!replayPath) {
    return summarizeCurrentTreasuryRows(database, 0);
  }

  const payloads = loadReplayPayload(replayPath);
  let rowsWritten = 0;

  for (const payload of payloads) {
    const result = ingestTreasuryDisclosureReplay(database, payload);
    rowsWritten += result.entities_written
      + result.holdings_written
      + result.transactions_written
      + result.source_documents_written;
  }

  return summarizeCurrentTreasuryRows(database, rowsWritten, payloads.length);
}
