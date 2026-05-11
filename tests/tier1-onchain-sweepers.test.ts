import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { onchainPoolTrades, onchainPools } from '../src/db/schema';
import * as defillamaProvider from '../src/providers/defillama';
import {
  runDefillamaPoolSweep,
  runDefillamaTokenSweep,
  runSubsquidTradeSweep,
} from '../src/services/tier1-onchain-sweepers';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(async () => [
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn(async () => [
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85_000, bid: 84_950, ask: 85_050, high: 86_000, low: 84_000, baseVolume: 5_000, quoteVolume: 425_000_000, percentage: 1.8, timestamp: Date.now(), raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2_000, bid: 1_999, ask: 2_001, high: 2_050, low: 1_950, baseVolume: 50_000, quoteVolume: 100_000_000, percentage: 2.56, timestamp: Date.now(), raw: {} },
  ]),
  fetchExchangeOHLCV: vi.fn(async () => []),
  fetchExchangeNetworks: vi.fn(async () => []),
  closeExchangePool: vi.fn(async () => undefined),
  isValidExchangeId: (value: string): value is string => ['binance'].includes(value),
}));

describe('Tier 1 onchain background sweepers', () => {
  it('durably upserts DeFiLlama pools, is idempotent, and keeps successful rows when another target fails', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-tier1-pool-sweep-'));
    const databaseUrl = join(tempDir, 'test.db');
    const app = buildApp({
      config: {
        databaseUrl,
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const firstResult = await runDefillamaPoolSweep(app.db, {
        now: new Date('2026-05-05T00:00:00.000Z'),
        targets: [{ id: 'bitcoin' }, { id: 'ethereum' }],
        fetchPoolData: async () => ({
          protocols: [],
          pools: [
            {
              chain: 'Ethereum',
              project: 'uniswap-v3',
              symbol: 'DAI-USDC',
              pool: 'tier1-dai-usdc',
              tvlUsd: 5_000_000,
              volumeUsd1d: 750_000,
              volumeUsd7d: 5_000_000,
              underlyingTokens: [
                '0x6b175474e89094c44da98b954eedeac495271d0f',
                '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              ],
            },
            {
              chain: 'Unsupported',
              project: 'unknown-dex',
              symbol: 'BAD-USDC',
              pool: 'tier1-bad-usdc',
              tvlUsd: 5_000_000,
              volumeUsd1d: 750_000,
              volumeUsd7d: 5_000_000,
              underlyingTokens: [
                '0x1111111111111111111111111111111111111111',
                '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              ],
            },
          ],
        }),
      });

      expect(firstResult).toMatchObject({
        targetsProcessed: 2,
        rowsWritten: 1,
        partialFailures: [
          expect.objectContaining({
            target: 'tier1-bad-usdc',
          }),
        ],
      });

      const row = app.db.db.select().from(onchainPools)
        .where(eq(onchainPools.name, 'DAI-USDC'))
        .limit(1)
        .get();
      expect(row).toMatchObject({
        networkId: 'eth',
        dexId: 'uniswap_v3',
        reserveUsd: 5_000_000,
        volume24hUsd: 750_000,
      });

      await runDefillamaPoolSweep(app.db, {
        now: new Date('2026-05-05T00:01:00.000Z'),
        targets: [{ id: 'bitcoin' }],
        fetchPoolData: async () => ({
          protocols: [],
          pools: [{
            chain: 'Ethereum',
            project: 'uniswap-v3',
            symbol: 'DAI-USDC',
            pool: 'tier1-dai-usdc',
            tvlUsd: 6_000_000,
            volumeUsd1d: 900_000,
            volumeUsd7d: 6_000_000,
            underlyingTokens: [
              '0x6b175474e89094c44da98b954eedeac495271d0f',
              '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            ],
          }],
        }),
      });

      const rows = app.db.db.select().from(onchainPools)
        .where(eq(onchainPools.name, 'DAI-USDC'))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        reserveUsd: 6_000_000,
        volume24hUsd: 900_000,
      });
    } finally {
      await app.close();
    }

    const restarted = buildApp({
      config: {
        databaseUrl,
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
    });

    try {
      vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
      vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
      await restarted.ready();
      const response = await restarted.inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools?sort=reserve_in_usd_desc',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'pool',
          attributes: expect.objectContaining({
            name: 'DAI-USDC',
            reserve_usd: 6_000_000,
          }),
        }),
      ]));
    } finally {
      vi.restoreAllMocks();
      await restarted.close();
    }
  });

  it('refreshes DeFiLlama token endpoint data only after successful price writes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-tier1-token-sweep-'));
    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);

      const before = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
      });
      expect(before.statusCode).toBe(200);
      const beforeUpdatedAt = before.json().data.attributes.updated_at;

      const result = await runDefillamaTokenSweep(app.db, {
        now: new Date('2026-05-05T00:02:00.000Z'),
        targets: [{ id: 'usd-coin' }],
        fetchTokenPrices: async (coins) => {
          expect(coins).toEqual(expect.arrayContaining([
            'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7',
          ]));

          return {
            'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
            price: 1.01,
            symbol: 'USDC',
            decimals: 6,
            confidence: 0.99,
            timestamp: 1_778_501_000,
            },
            'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7': {
              price: 1,
              symbol: 'USDT',
              decimals: 6,
              confidence: 0.99,
              timestamp: 1_778_501_000,
            },
          };
        },
      });

      expect(result.rowsWritten).toBeGreaterThan(0);

      const after = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
      });
      expect(after.statusCode).toBe(200);
      expect(after.json().data.attributes).toMatchObject({
        price_usd: 1.01,
        updated_at: Math.floor(Date.parse('2026-05-05T00:02:00.000Z') / 1000),
      });
      expect(after.json().data.attributes.updated_at).toBeGreaterThan(beforeUpdatedAt);

      const quoteAfter = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/tokens/0xdac17f958d2ee523a2206206994597c13d831ec7/info',
      });
      expect(quoteAfter.statusCode).toBe(200);
      expect(quoteAfter.json().data.attributes.updated_at).toBeGreaterThan(beforeUpdatedAt);

      await expect(runDefillamaTokenSweep(app.db, {
        now: new Date('2026-05-05T00:03:00.000Z'),
        targets: [{ id: 'usd-coin' }],
        fetchTokenPrices: async () => null,
      })).rejects.toThrow('provider returned no token prices');

      const afterFailure = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
      });
      expect(afterFailure.json().data.attributes.updated_at).toBe(after.json().data.attributes.updated_at);
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  });

  it('persists Subsquid trades idempotently and isolates per-pool failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-tier1-subsquid-sweep-'));
    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      const swaps = [{
        blockNumber: 20_000_000,
        blockTimestamp: 1_778_501_200,
        txHash: '0xtier1trade000000000000000000000000000000000000000000000000001',
        amount0: '-100',
        amount1: '0.03',
        sqrtPriceX96: '1',
        liquidity: '1',
        tick: 0,
      }];

      const result = await runSubsquidTradeSweep(app.db, {
        now: new Date('2026-05-05T00:04:00.000Z'),
        targets: [{ id: 'usd-coin' }, { id: 'ethereum' }],
        fetchSwaps: async (poolAddress) => {
          if (poolAddress === '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36') {
            throw new Error('mock upstream timeout');
          }
          return swaps;
        },
      });

      expect(result).toMatchObject({
        targetsProcessed: 2,
        rowsWritten: 1,
        partialFailures: [
          expect.objectContaining({
            target: 'eth:0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
          }),
        ],
      });

      await runSubsquidTradeSweep(app.db, {
        now: new Date('2026-05-05T00:05:00.000Z'),
        targets: [{ id: 'usd-coin' }],
        fetchSwaps: async () => swaps,
      });

      const rows = app.db.db.select().from(onchainPoolTrades)
        .where(and(
          eq(onchainPoolTrades.poolAddress, '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'),
          eq(onchainPoolTrades.txHash, '0xtier1trade000000000000000000000000000000000000000000000000001'),
        ))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sourceKind: 'live',
        sourceProvider: 'subsquid',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: [
          expect.objectContaining({
            attributes: expect.objectContaining({
              tx_hash: '0xtier1trade000000000000000000000000000000000000000000000000001',
            }),
          }),
        ],
        meta: {
          source: 'live',
        },
      });
    } finally {
      await app.close();
    }
  });
});
