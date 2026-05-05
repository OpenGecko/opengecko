import { createHash } from 'node:crypto';

import type { treasuryEntities, treasuryHoldings, treasurySourceDocuments, treasuryTransactions } from '../db/schema';

type RawTreasuryDisclosureEntity = {
  id: string;
  name: string;
  symbol?: string | null;
  entity_type: 'company' | 'government';
  country?: string | null;
  description?: string | null;
  website_url?: string | null;
};

type RawTreasuryDisclosureTransaction = {
  id: string;
  type: 'buy' | 'sell';
  holding_net_change: number;
  transaction_value_usd?: number | null;
  holding_balance: number;
  average_entry_value_usd?: number | null;
  happened_at: string;
};

export type RawTreasuryDisclosureReplay = {
  source_url: string;
  accepted_at: string;
  entity: RawTreasuryDisclosureEntity;
  coin_id: string;
  holding: {
    amount: number;
    entry_value_usd?: number | null;
    reported_at: string;
  };
  transactions: RawTreasuryDisclosureTransaction[];
};

function parseDate(value: string, field: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${field} timestamp: ${value}`);
  }

  return new Date(timestamp);
}

function assertFiniteNumber(value: number, field: string) {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${field} value: ${value}`);
  }

  return value;
}

function inferSourceProvider(sourceUrl: string) {
  try {
    const hostname = new URL(sourceUrl).hostname.toLowerCase();
    if (hostname.endsWith('sec.gov')) {
      return 'sec';
    }
  } catch {
    return 'disclosure_replay';
  }

  return 'disclosure_replay';
}

export function normalizeTreasuryDisclosureReplay(raw: RawTreasuryDisclosureReplay): {
  sourceDocument: typeof treasurySourceDocuments.$inferInsert;
  entity: typeof treasuryEntities.$inferInsert;
  holding: typeof treasuryHoldings.$inferInsert;
  transactions: Array<typeof treasuryTransactions.$inferInsert>;
} {
  const acceptedAt = parseDate(raw.accepted_at, 'accepted_at');
  const reportedAt = parseDate(raw.holding.reported_at, 'holding.reported_at');
  const rawJson = JSON.stringify(raw);

  return {
    sourceDocument: {
      sourceUrl: raw.source_url,
      entityId: raw.entity.id,
      provider: inferSourceProvider(raw.source_url),
      documentType: 'treasury_disclosure',
      acceptedAt,
      contentHash: createHash('sha256').update(rawJson).digest('hex'),
      rawJson,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    },
    entity: {
      id: raw.entity.id,
      name: raw.entity.name,
      symbol: raw.entity.symbol ?? null,
      entityType: raw.entity.entity_type,
      country: raw.entity.country ?? null,
      description: raw.entity.description ?? '',
      websiteUrl: raw.entity.website_url ?? null,
      updatedAt: acceptedAt,
    },
    holding: {
      entityId: raw.entity.id,
      coinId: raw.coin_id,
      amount: assertFiniteNumber(raw.holding.amount, 'holding.amount'),
      entryValueUsd: raw.holding.entry_value_usd ?? null,
      reportedAt,
      sourceUrl: raw.source_url,
    },
    transactions: raw.transactions.map((transaction) => ({
      id: transaction.id,
      entityId: raw.entity.id,
      coinId: raw.coin_id,
      type: transaction.type,
      holdingNetChange: assertFiniteNumber(transaction.holding_net_change, `transaction.${transaction.id}.holding_net_change`),
      transactionValueUsd: transaction.transaction_value_usd ?? null,
      holdingBalance: assertFiniteNumber(transaction.holding_balance, `transaction.${transaction.id}.holding_balance`),
      averageEntryValueUsd: transaction.average_entry_value_usd ?? null,
      happenedAt: parseDate(transaction.happened_at, `transaction.${transaction.id}.happened_at`),
      sourceUrl: raw.source_url,
    })),
  };
}
