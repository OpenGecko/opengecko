import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { onchainPoolTrades } from '../src/db/schema';
import { runOnchainTradeSyncJob } from '../src/jobs/sync-onchain-trades';
import {
  createHttpOnchainTradeFetcher,
  parseOnchainTradeTargetConfig,
  syncOnchainTrades,
} from '../src/services/onchain-trade-sync';
import type { RawOnchainTradeReplay } from '../src/services/onchain-trade-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/onchain-trades/eth-usdc-weth-pool-trades.json'),
    'utf8',
  )) as RawOnchainTradeReplay;
}

describe('onchain trade sync', () => {
  it('parses optional provider pool mappings from environment syntax', () => {
    expect(parseOnchainTradeTargetConfig(undefined)).toEqual([]);
    expect(parseOnchainTradeTargetConfig('   ')).toEqual([]);
    expect(parseOnchainTradeTargetConfig(
      'sqd=ETH:0x88E6A0c2dDD26FEEb64F039a2c41296FcB3f5640, eth:0x4E68Ccd3E89f51C3074ca5072bbAC773960dFa36',
    )).toEqual([
      {
        provider: 'sqd',
        networkId: 'eth',
        poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      },
      {
        provider: 'custom',
        networkId: 'eth',
        poolAddress: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      },
    ]);
    expect(() => parseOnchainTradeTargetConfig('sqd=eth')).toThrow(
      'Invalid onchain trade target config entry',
    );
  });

  it('exits without opening a database when no onchain trade targets are configured', async () => {
    await expect(runOnchainTradeSyncJob({
      LOG_LEVEL: 'silent',
      ONCHAIN_TRADE_TARGETS: '',
    })).resolves.toBeUndefined();
  });

  it('builds a provider-facing HTTP fetcher with stable target URL and defaults', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      captured_at: '2026-05-05T00:10:00.000Z',
      trades: [{
        token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        side: 'buy',
        volume_usd: '1',
        price_usd: '1',
        tx_hash: '0xtrade',
        block_timestamp: '1710000400',
      }],
    }), { status: 200 }));
    const fetcher = createHttpOnchainTradeFetcher('https://trades.example/', fetchImpl as unknown as typeof fetch);
    const response = await fetcher({
      provider: 'sqd',
      networkId: 'eth',
      poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://trades.example/providers/sqd/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades',
      expect.objectContaining({
        headers: { accept: 'application/json' },
      }),
    );
    expect(response).toMatchObject({
      provider: 'sqd',
      network_id: 'eth',
      pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      trades: [expect.objectContaining({ volume_usd: '1' })],
    });
  });

  it('covers optional provider fetcher failure and no-data branches', async () => {
    expect(() => createHttpOnchainTradeFetcher(undefined)).toThrow('ONCHAIN_TRADE_BASE_URL is required');

    const notFoundFetcher = createHttpOnchainTradeFetcher(
      'https://trades.example',
      vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    );
    await expect(notFoundFetcher({
      provider: 'sqd',
      networkId: 'eth',
      poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    })).resolves.toBeNull();

    const failedFetcher = createHttpOnchainTradeFetcher(
      'https://trades.example',
      vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(failedFetcher({
      provider: 'sqd',
      networkId: 'eth',
      poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    })).rejects.toThrow('Onchain trade provider request failed with status 500');

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      await expect(syncOnchainTrades(app.db, {
        targets: [{
          provider: 'mock.trades',
          networkId: 'eth',
          poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        }],
        fetcher: vi.fn(async () => null),
        now: new Date('2026-05-05T00:11:00.000Z'),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        trades_fetched: 0,
        trades_written: 0,
        results: [
          expect.objectContaining({
            provider: 'mock.trades',
            network_id: 'eth',
            pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          }),
        ],
      });

      await expect(syncOnchainTrades(app.db, {
        targets: [{
          provider: 'empty.trades',
          networkId: 'eth',
          poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        }],
        fetcher: vi.fn(async () => ({
          provider: 'empty.trades',
          captured_at: '2026-05-05T00:12:00.000Z',
          network_id: 'eth',
          pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          trades: [],
        })),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        trades_fetched: 0,
        trades_written: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('syncs mocked provider output into live source-attributed rows without changing trade route shape', async () => {
    const fixture = loadFixture();
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const result = await syncOnchainTrades(app.db, {
        targets: [{
          provider: 'mock.trades',
          networkId: fixture.network_id,
          poolAddress: fixture.pool_address,
        }],
        now: new Date('2026-05-05T00:13:00.000Z'),
        fetcher: vi.fn(async () => fixture),
      });

      expect(result).toMatchObject({
        targets_attempted: 1,
        trades_fetched: 2,
        trades_written: 2,
        source_fetched_at: '2026-05-05T00:13:00.000Z',
      });
      expect(app.db.db.select().from(onchainPoolTrades)
        .where(eq(onchainPoolTrades.poolAddress, fixture.pool_address))
        .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          tradeId: 'replay-usdcweth-2',
          sourceKind: 'live',
          sourceProvider: 'mock.trades',
        }),
      ]));

      const poolTradesResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/pools/${fixture.pool_address}/trades`,
      });
      const tokenTradesResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades`,
      });

      expect(poolTradesResponse.json()).toMatchObject({
        data: [
          expect.objectContaining({
            id: 'replay-usdcweth-2',
            type: 'trade',
            attributes: expect.objectContaining({
              tx_hash: '0xreplaytrade00000000000000000000000000000000000000000000000002',
              volume_in_usd: '275000.5',
            }),
          }),
          expect.objectContaining({
            id: 'replay-usdcweth-1',
            type: 'trade',
          }),
        ],
        meta: {
          network: 'eth',
          pool_address: fixture.pool_address,
          source: 'live',
        },
      });
      expect(tokenTradesResponse.json()).toMatchObject({
        data: [
          expect.objectContaining({
            id: 'replay-usdcweth-2',
            type: 'trade',
          }),
        ],
        meta: {
          network: 'eth',
          token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          source: 'live',
        },
      });
    } finally {
      await app.close();
    }
  });
});
