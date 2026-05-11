import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { treasuryHoldings, treasurySourceDocuments, treasuryTransactions } from '../src/db/schema';
import { ingestTreasuryDisclosureReplay } from '../src/services/treasury-disclosure-ingestion';
import {
  normalizeTreasuryDisclosureReplay,
  type RawTreasuryDisclosureReplay,
} from '../src/services/treasury-disclosure-normalizer';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/treasury/strategy-bitcoin-disclosure.json'),
    'utf8',
  )) as RawTreasuryDisclosureReplay;
}

describe('treasury provider replay fixtures', () => {
  it('normalizes source disclosure rows into public treasury responses', async () => {
    const fixture = loadFixture();
    const normalized = normalizeTreasuryDisclosureReplay(fixture);

    expect(normalized).toMatchObject({
      sourceDocument: {
        sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1050446/000119312526120001/strategy-2026q1-8k.htm',
        entityId: 'strategy',
        provider: 'sec',
        documentType: 'treasury_disclosure',
        acceptedAt: new Date('2026-05-05T00:00:00.000Z'),
        rawJson: expect.stringContaining('"source_url"'),
        createdAt: new Date('2026-05-05T00:00:00.000Z'),
        updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      },
      entity: {
        id: 'strategy',
        name: 'Strategy',
        symbol: 'MSTR',
        entityType: 'company',
        country: 'United States',
        description: 'Strategy is a public company with a large bitcoin treasury position.',
        websiteUrl: 'https://www.strategy.com',
        updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      },
      holding: {
        entityId: 'strategy',
        coinId: 'bitcoin',
        amount: 650000,
        entryValueUsd: 42000000000,
        reportedAt: new Date('2026-05-05T00:00:00.000Z'),
        sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1050446/000119312526120001/strategy-2026q1-8k.htm',
      },
      transactions: [
        {
          id: 'strategy-bitcoin-2026-05-05-replay',
          entityId: 'strategy',
          coinId: 'bitcoin',
          type: 'buy',
          holdingNetChange: 25000,
          transactionValueUsd: 2500000000,
          holdingBalance: 650000,
          averageEntryValueUsd: 64615.38461538462,
          happenedAt: new Date('2026-05-05T00:00:00.000Z'),
          sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1050446/000119312526120001/strategy-2026q1-8k.htm',
        },
      ],
    });
    expect(normalized.sourceDocument.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      expect(ingestTreasuryDisclosureReplay(app.db, fixture)).toEqual({
        entity_id: 'strategy',
        coin_id: 'bitcoin',
        entities_written: 1,
        holdings_written: 1,
        transactions_written: 1,
        source_documents_written: 1,
        source_url: fixture.source_url,
      });
      expect(ingestTreasuryDisclosureReplay(app.db, fixture).transactions_written).toBe(1);
      expect(app.db.db
        .select()
        .from(treasurySourceDocuments)
        .where(eq(treasurySourceDocuments.sourceUrl, fixture.source_url))
        .all()).toHaveLength(1);
      expect(app.db.db
        .select()
        .from(treasuryTransactions)
        .where(eq(treasuryTransactions.id, 'strategy-bitcoin-2026-05-05-replay'))
        .all()).toHaveLength(1);

      const byCoinResponse = await app.inject({
        method: 'GET',
        url: '/companies/public_treasury/bitcoin?order=holdings_desc',
      });
      const detailResponse = await app.inject({
        method: 'GET',
        url: '/public_treasury/strategy',
      });
      const transactionsResponse = await app.inject({
        method: 'GET',
        url: '/public_treasury/strategy/transaction_history?order=date_desc',
      });

      expect(byCoinResponse.statusCode).toBe(200);
      expect(byCoinResponse.json()).toMatchObject({
        data: {
          coin_id: 'bitcoin',
          companies: expect.arrayContaining([
            expect.objectContaining({
              entity_id: 'strategy',
              total_holdings: 650000,
              entry_value_usd: 42000000000,
              reported_at: '2026-05-05T00:00:00.000Z',
              source_url: fixture.source_url,
            }),
          ]),
        },
        meta: {
          fixture: false,
          source: 'disclosure_replay',
          source_documents_count: 1,
          live_rows_count: 1,
          fallback_rows_count: 0,
        },
      });
      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json()).toMatchObject({
        data: {
          id: 'strategy',
          total_entry_value_usd: 42000000000,
          holdings: [
            expect.objectContaining({
              coin_id: 'bitcoin',
              amount: 650000,
              source_url: fixture.source_url,
            }),
          ],
        },
        meta: {
          fixture: false,
          source: 'disclosure_replay',
          source_documents_count: 1,
          live_rows_count: 1,
          fallback_rows_count: 0,
        },
      });
      expect(transactionsResponse.statusCode).toBe(200);
      expect(transactionsResponse.json()).toMatchObject({
        data: {
          transactions: expect.arrayContaining([
            {
              date: new Date('2026-05-05T00:00:00.000Z').getTime(),
              source_url: fixture.source_url,
              coin_id: 'bitcoin',
              type: 'buy',
              holding_net_change: 25000,
              transaction_value_usd: 2500000000,
              holding_balance: 650000,
              average_entry_value_usd: 64615.38461538462,
            },
          ]),
        },
        meta: {
          fixture: true,
          source: 'hybrid',
          source_documents_count: 1,
          transaction_count: 4,
        },
      });

      const correctedFixture: RawTreasuryDisclosureReplay = {
        ...fixture,
        accepted_at: '2026-05-05T01:00:00.000Z',
        holding: {
          ...fixture.holding,
          amount: 651000,
          entry_value_usd: 42100000000,
        },
      };
      expect(ingestTreasuryDisclosureReplay(app.db, correctedFixture)).toMatchObject({
        source_documents_written: 1,
        transactions_written: 1,
      });

      const sourceDocuments = app.db.db
        .select()
        .from(treasurySourceDocuments)
        .where(eq(treasurySourceDocuments.sourceUrl, fixture.source_url))
        .all();
      expect(sourceDocuments).toHaveLength(1);
      expect(sourceDocuments[0]).toMatchObject({
        entityId: 'strategy',
        provider: 'sec',
        acceptedAt: new Date('2026-05-05T01:00:00.000Z'),
      });
      expect(JSON.parse(sourceDocuments[0]!.rawJson).holding.amount).toBe(651000);

      expect(app.db.db
        .select()
        .from(treasuryHoldings)
        .where(eq(treasuryHoldings.entityId, 'strategy'))
        .all()).toEqual([
          expect.objectContaining({
            coinId: 'bitcoin',
            amount: 651000,
            entryValueUsd: 42100000000,
          }),
        ]);
      expect(app.db.db
        .select()
        .from(treasuryTransactions)
        .where(eq(treasuryTransactions.id, 'strategy-bitcoin-2026-05-05-replay'))
        .all()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
