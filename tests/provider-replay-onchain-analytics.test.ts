import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { onchainTokenHolderCounts, onchainTokenHolders, onchainTokenTraders } from '../src/db/schema';
import {
  ingestOnchainAnalyticsReplay,
  normalizeOnchainAnalyticsReplay,
  type RawOnchainAnalyticsReplay,
} from '../src/services/onchain-analytics-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/onchain-analytics/eth-usdc-token-analytics.json'),
    'utf8',
  )) as RawOnchainAnalyticsReplay;
}

describe('onchain analytics provider replay fixtures', () => {
  it('replays token holder, trader, and holder-count analytics into public onchain analytics routes', async () => {
    const fixture = loadFixture();
    const normalized = normalizeOnchainAnalyticsReplay(fixture);

    expect(normalized.networkId).toBe('eth');
    expect(normalized.tokenAddress).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(normalized.capturedAt).toEqual(new Date('2026-05-05T00:03:00.000Z'));
    expect(normalized.holders).toEqual([
      expect.objectContaining({
        holderAddress: expect.stringMatching(/^0xholder9/),
        balance: 300000000,
        shareOfSupply: 0.3,
      }),
      expect.objectContaining({
        holderAddress: expect.stringMatching(/^0xholder9/),
        balance: 175000000,
        shareOfSupply: 0.175,
      }),
    ]);
    expect(normalized.traders).toEqual([
      expect.objectContaining({
        traderAddress: expect.stringMatching(/^0xtrader9/),
        volumeUsd: 15000000,
        tradeCount: 160,
        addressLabel: 'Replay Whale',
      }),
      expect.objectContaining({
        traderAddress: expect.stringMatching(/^0xtrader9/),
        realizedPnlUsd: 650000,
        tradeCount: 95,
      }),
    ]);
    expect(normalized.holderCounts).toEqual([
      { networkId: 'eth', tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', timestamp: 1711843200, holderCount: 205000 },
      { networkId: 'eth', tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', timestamp: 1712448000, holderCount: 209500 },
      { networkId: 'eth', tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', timestamp: 1713052800, holderCount: 214250 },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      expect(ingestOnchainAnalyticsReplay(app.db, fixture)).toEqual({
        network_id: 'eth',
        token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        holders_written: 2,
        traders_written: 2,
        holder_counts_written: 3,
        source_kind: 'replay',
        source_provider: 'etherscan-token-analytics-replay',
        source_fetched_at: '2026-05-05T00:03:00.000Z',
      });
      expect(ingestOnchainAnalyticsReplay(app.db, fixture)).toMatchObject({
        holders_written: 2,
        traders_written: 2,
        holder_counts_written: 3,
      });
      expect(app.db.db.select().from(onchainTokenHolders)
        .where(eq(onchainTokenHolders.tokenAddress, fixture.token_address))
        .all()).toHaveLength(2);
      expect(app.db.db.select().from(onchainTokenTraders)
        .where(eq(onchainTokenTraders.tokenAddress, fixture.token_address))
        .all()).toHaveLength(2);
      expect(app.db.db.select().from(onchainTokenHolderCounts)
        .where(eq(onchainTokenHolderCounts.tokenAddress, fixture.token_address))
        .all()).toHaveLength(3);

      const holdersResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/tokens/${fixture.token_address}/top_holders?holders=2&include_pnl_details=true`,
      });
      const tradersResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/tokens/${fixture.token_address}/top_traders?traders=2&sort=realized_pnl_usd_desc&include_address_label=true`,
      });
      const holdersChartResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/tokens/${fixture.token_address}/holders_chart?days=30`,
      });

      expect(holdersResponse.statusCode).toBe(200);
      expect(holdersResponse.json()).toMatchObject({
        data: [
          expect.objectContaining({
            id: '0xholder900000000000000000000000000000000001',
            attributes: expect.objectContaining({
              balance: '300000000',
              pnl_usd: '3000000',
            }),
          }),
          expect.objectContaining({
            id: '0xholder900000000000000000000000000000000002',
            attributes: expect.objectContaining({
              balance: '175000000',
            }),
          }),
        ],
        meta: {
          fixture: true,
          source: 'replay',
          note: 'Holder data is source-attributed replay, not live',
        },
      });
      expect(tradersResponse.statusCode).toBe(200);
      expect(tradersResponse.json()).toMatchObject({
        data: [
          expect.objectContaining({
            id: '0xtrader900000000000000000000000000000000002',
            attributes: expect.objectContaining({
              realized_pnl_usd: '650000',
              address_label: 'Replay Arb',
            }),
          }),
          expect.objectContaining({
            id: '0xtrader900000000000000000000000000000000001',
            attributes: expect.objectContaining({
              volume_usd: '15000000',
              is_whale: true,
            }),
          }),
        ],
        meta: {
          fixture: true,
          source: 'replay',
          note: 'Trader data is source-attributed replay, not live',
        },
      });
      expect(holdersChartResponse.statusCode).toBe(200);
      expect(holdersChartResponse.json()).toMatchObject({
        data: [
          expect.objectContaining({ id: '1711843200' }),
          expect.objectContaining({ id: '1712448000' }),
          expect.objectContaining({ id: '1713052800' }),
        ],
        meta: {
          fixture: true,
          source: 'replay',
          note: 'Holders chart data is source-attributed replay, not live',
        },
      });
    } finally {
      await app.close();
    }
  });
});
