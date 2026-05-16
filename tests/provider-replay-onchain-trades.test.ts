import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { onchainPoolTrades } from '../src/db/schema';
import {
  ingestOnchainTradeReplay,
  normalizeOnchainTradeReplay,
  type RawOnchainTradeReplay,
} from '../src/services/onchain-trade-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/onchain-trades/eth-usdc-weth-pool-trades.json'),
    'utf8',
  )) as RawOnchainTradeReplay;
}

describe('onchain trade provider replay fixtures', () => {
  it('replays source-attributed pool trades into public pool and token trade routes', async () => {
    const fixture = loadFixture();
    const normalized = normalizeOnchainTradeReplay(fixture);

    expect(normalized).toMatchObject({
      networkId: 'eth',
      poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      capturedAt: new Date('2026-05-05T00:09:00.000Z'),
      trades: [
        expect.objectContaining({
          tradeId: 'replay-usdcweth-2',
          tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          volumeUsd: 275000.5,
          blockTimestamp: 1710000300,
        }),
        expect.objectContaining({
          tradeId: 'replay-usdcweth-1',
          tokenAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          priceUsd: 3500.25,
        }),
      ],
    });

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      expect(ingestOnchainTradeReplay(app.db, fixture)).toEqual({
        network_id: 'eth',
        pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        trades_written: 2,
        source_kind: 'replay',
        source_provider: 'sqd-swap-replay',
        source_fetched_at: '2026-05-05T00:09:00.000Z',
      });
      expect(ingestOnchainTradeReplay(app.db, fixture)).toMatchObject({
        trades_written: 2,
      });
      expect(app.db.db.select().from(onchainPoolTrades)
        .where(eq(onchainPoolTrades.poolAddress, fixture.pool_address))
        .all()).toHaveLength(2);

      const poolTradesResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/pools/${fixture.pool_address}/trades`,
      });
      const filteredPoolTradesResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/pools/${fixture.pool_address}/trades?trade_volume_in_usd_greater_than=200000&token=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`,
      });
      const tokenTradesResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades`,
      });
      const coverageMatrixResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/coverage_matrix',
      });

      expect(poolTradesResponse.statusCode).toBe(200);
      expect(poolTradesResponse.json()).toMatchObject({
        data: [
          expect.objectContaining({
            id: 'replay-usdcweth-2',
            attributes: expect.objectContaining({
              tx_hash: '0xreplaytrade00000000000000000000000000000000000000000000000002',
              token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              volume_in_usd: '275000.5',
              block_timestamp: 1710000300,
            }),
          }),
          expect.objectContaining({
            id: 'replay-usdcweth-1',
            attributes: expect.objectContaining({
              token_address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            }),
          }),
        ],
        meta: {
          network: 'eth',
          pool_address: fixture.pool_address,
          source: 'replay',
        },
      });
      expect(filteredPoolTradesResponse.statusCode).toBe(200);
      expect(filteredPoolTradesResponse.json().data).toHaveLength(1);
      expect(filteredPoolTradesResponse.json().data[0]).toMatchObject({
        id: 'replay-usdcweth-2',
        attributes: expect.objectContaining({
          token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        }),
      });
      expect(tokenTradesResponse.statusCode).toBe(200);
      expect(tokenTradesResponse.json()).toMatchObject({
        data: [
          expect.objectContaining({
            id: 'replay-usdcweth-2',
            relationships: expect.objectContaining({
              token: {
                data: {
                  type: 'token',
                  id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                },
              },
            }),
          }),
        ],
        meta: {
          network: 'eth',
          token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          source: 'replay',
        },
      });
      expect(coverageMatrixResponse.statusCode).toBe(200);
      expect(coverageMatrixResponse.json().data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'onchain',
          last_successful_refresh_at: '2026-03-20T00:00:00.000Z',
          evidence: expect.objectContaining({
            notes: expect.stringContaining('replay rows prove Subsquid normalization but do not promote production trade freshness'),
          }),
        }),
      ]));
    } finally {
      await app.close();
    }
  });
});
