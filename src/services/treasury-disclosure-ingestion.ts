import type { AppDatabase } from '../db/client';
import { treasuryEntities, treasuryHoldings, treasurySourceDocuments, treasuryTransactions } from '../db/schema';
import {
  normalizeTreasuryDisclosureReplay,
  type RawTreasuryDisclosureReplay,
} from './treasury-disclosure-normalizer';

export function ingestTreasuryDisclosureReplay(database: AppDatabase, raw: RawTreasuryDisclosureReplay) {
  const normalized = normalizeTreasuryDisclosureReplay(raw);

  database.db
    .insert(treasuryEntities)
    .values(normalized.entity)
    .onConflictDoUpdate({
      target: treasuryEntities.id,
      set: {
        name: normalized.entity.name,
        symbol: normalized.entity.symbol,
        entityType: normalized.entity.entityType,
        country: normalized.entity.country,
        description: normalized.entity.description,
        websiteUrl: normalized.entity.websiteUrl,
        updatedAt: normalized.entity.updatedAt,
      },
    })
    .run();

  database.db
    .insert(treasurySourceDocuments)
    .values(normalized.sourceDocument)
    .onConflictDoUpdate({
      target: treasurySourceDocuments.sourceUrl,
      set: {
        entityId: normalized.sourceDocument.entityId,
        provider: normalized.sourceDocument.provider,
        documentType: normalized.sourceDocument.documentType,
        acceptedAt: normalized.sourceDocument.acceptedAt,
        contentHash: normalized.sourceDocument.contentHash,
        rawJson: normalized.sourceDocument.rawJson,
        updatedAt: normalized.sourceDocument.updatedAt,
      },
    })
    .run();

  database.db
    .insert(treasuryHoldings)
    .values(normalized.holding)
    .onConflictDoUpdate({
      target: [treasuryHoldings.entityId, treasuryHoldings.coinId],
      set: {
        amount: normalized.holding.amount,
        entryValueUsd: normalized.holding.entryValueUsd,
        reportedAt: normalized.holding.reportedAt,
        sourceUrl: normalized.holding.sourceUrl,
      },
    })
    .run();

  for (const transaction of normalized.transactions) {
    database.db
      .insert(treasuryTransactions)
      .values(transaction)
      .onConflictDoUpdate({
        target: treasuryTransactions.id,
        set: {
          entityId: transaction.entityId,
          coinId: transaction.coinId,
          type: transaction.type,
          holdingNetChange: transaction.holdingNetChange,
          transactionValueUsd: transaction.transactionValueUsd,
          holdingBalance: transaction.holdingBalance,
          averageEntryValueUsd: transaction.averageEntryValueUsd,
          happenedAt: transaction.happenedAt,
          sourceUrl: transaction.sourceUrl,
        },
      })
      .run();
  }

  return {
    entity_id: normalized.entity.id,
    coin_id: normalized.holding.coinId,
    entities_written: 1,
    holdings_written: 1,
    transactions_written: normalized.transactions.length,
    source_documents_written: 1,
    source_url: normalized.holding.sourceUrl,
  };
}
