import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildApp, getDatabaseStartupLogContext } from '../../../src/app';
import { chartPoints, coins, marketChartSourcePoints, marketSnapshots, ohlcvCandles } from '../../../src/db/schema';
import type { MetricsRegistry } from '../../../src/services/metrics';
import type { MarketDataRuntimeState } from '../../../src/services/market-runtime-state';
import * as candleStore from '../../../src/services/candle-store';
import * as catalogModule from '../../../src/modules/catalog';
import * as ccxtProvider from '../../../src/providers/ccxt';
import * as defillamaProvider from '../../../src/providers/defillama';
import * as sqdProvider from '../../../src/providers/sqd';
import * as startupPrewarmModule from '../../../src/services/startup-prewarm';
import * as currencyRatesModule from '../../../src/services/currency-rates';
import { resetCurrencyApiSnapshotForTests } from '../../../src/services/currency-rates';
import { syncOnchainTrades } from '../../../src/services/onchain-trade-sync';
import contractFixtures from '../../fixtures/contract-fixtures.json';

const currentDailyBucket = () => candleStore.toDailyBucket(Date.now()).getTime();
const defaultDefillamaTokenPriceMock = () => vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
const defaultDefillamaOnchainCatalogMocks = () => {
  vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);
  vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);
};

function resetCcxtProviderMocks() {
  const mockedFetchExchangeMarkets = ccxtProvider.fetchExchangeMarkets as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeTickers = ccxtProvider.fetchExchangeTickers as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeDerivativeTickers = ccxtProvider.fetchExchangeDerivativeTickers as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeOHLCV = ccxtProvider.fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeNetworks = ccxtProvider.fetchExchangeNetworks as ReturnType<typeof vi.fn>;
  const mockedCloseExchangePool = ccxtProvider.closeExchangePool as ReturnType<typeof vi.fn>;

  mockedFetchExchangeMarkets.mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', active: true, spot: true, baseName: 'Ripple', raw: {} },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', active: true, spot: true, baseName: 'Dogecoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', active: true, spot: true, baseName: 'Cardano', raw: {} },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', active: true, spot: true, baseName: 'Chainlink', raw: {} },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
  ]);
  mockedFetchExchangeTickers.mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', last: 2.5, bid: 2.49, ask: 2.51, high: 2.55, low: 2.45, baseVolume: 1000000, quoteVolume: 2500000, percentage: 3.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', last: 0.28, bid: 0.279, ask: 0.281, high: 0.29, low: 0.27, baseVolume: 10000000, quoteVolume: 2800000, percentage: 5.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', last: 1.05, bid: 1.049, ask: 1.051, high: 1.08, low: 1.02, baseVolume: 5000000, quoteVolume: 5250000, percentage: 2.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', last: 24, bid: 23.9, ask: 24.1, high: 25, low: 23, baseVolume: 500000, quoteVolume: 12000000, percentage: 3.5, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
  ]);
  mockedFetchExchangeDerivativeTickers.mockResolvedValue([]);
  mockedFetchExchangeOHLCV.mockResolvedValue([]);
  mockedFetchExchangeNetworks.mockResolvedValue([]);
  mockedCloseExchangePool.mockResolvedValue(undefined);
}

vi.mock('../../../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', active: true, spot: true, baseName: 'Ripple', raw: {} },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', active: true, spot: true, baseName: 'Dogecoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', active: true, spot: true, baseName: 'Cardano', raw: {} },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', active: true, spot: true, baseName: 'Chainlink', raw: {} },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', last: 2.5, bid: 2.49, ask: 2.51, high: 2.55, low: 2.45, baseVolume: 1000000, quoteVolume: 2500000, percentage: 3.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', last: 0.28, bid: 0.279, ask: 0.281, high: 0.29, low: 0.27, baseVolume: 10000000, quoteVolume: 2800000, percentage: 5.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', last: 1.05, bid: 1.049, ask: 1.051, high: 1.08, low: 1.02, baseVolume: 5000000, quoteVolume: 5250000, percentage: 2.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', last: 24, bid: 23.9, ask: 24.1, high: 25, low: 23, baseVolume: 500000, quoteVolume: 12000000, percentage: 3.5, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
  ]),
  fetchExchangeDerivativeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));



describe('OpenGecko app scaffold', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-'));
    vi.restoreAllMocks();
    resetCurrencyApiSnapshotForTests();
    resetCcxtProviderMocks();
    defaultDefillamaTokenPriceMock();
    defaultDefillamaOnchainCatalogMocks();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    vi.clearAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns pool-scoped and token-aggregated onchain trades with threshold and token filtering semantics', async () => {
    const originalVitest = process.env.VITEST;
    process.env.VITEST = 'false';

    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockImplementation(async (poolAddress) => {
      const normalized = poolAddress.toLowerCase();
      if (normalized === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640') {
        return [
          {
            blockNumber: 100,
            blockTimestamp: 1710000100,
            txHash: '0xlivetx1',
            amount0: '-220000',
            amount1: '220500',
            sqrtPriceX96: '0',
            liquidity: '0',
            tick: 0,
          },
          {
            blockNumber: 99,
            blockTimestamp: 1710000000,
            txHash: '0xlivetx2',
            amount0: '-151000',
            amount1: '151000',
            sqrtPriceX96: '0',
            liquidity: '0',
            tick: 0,
          },
        ];
      }

      if (normalized === '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7') {
        return [
          {
            blockNumber: 98,
            blockTimestamp: 1709999200,
            txHash: '0xlivetx3',
            amount0: '-180000',
            amount1: '180050',
            sqrtPriceX96: '0',
            liquidity: '0',
            tick: 0,
          },
        ];
      }

      return null;
    });
    const poolTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades',
    });
    const filteredPoolTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?trade_volume_in_usd_greater_than=150000&token=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const pagedPoolTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?limit=1&before_timestamp=1710000000',
    });

    await syncOnchainTrades(getApp().db, {
      now: new Date('2026-05-05T00:13:00.000Z'),
      targets: [
        {
          provider: 'mock.trades',
          networkId: 'eth',
          poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        },
        {
          provider: 'mock.trades',
          networkId: 'eth',
          poolAddress: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
        },
      ],
      fetcher: async (target) => {
        if (target.poolAddress === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640') {
          return {
            provider: target.provider,
            captured_at: '2026-05-05T00:13:00.000Z',
            network_id: target.networkId,
            pool_address: target.poolAddress,
            trades: [
              {
                id: 'live-usdcweth-1',
                token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                side: 'buy',
                volume_usd: 220000,
                price_usd: 1,
                tx_hash: '0xlivetx1',
                block_timestamp: 1710000100,
              },
              {
                id: 'live-usdcweth-2',
                token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                side: 'buy',
                volume_usd: 151000,
                price_usd: 1,
                tx_hash: '0xlivetx2',
                block_timestamp: 1710000000,
              },
            ],
          };
        }

        return {
          provider: target.provider,
          captured_at: '2026-05-05T00:13:00.000Z',
          network_id: target.networkId,
          pool_address: target.poolAddress,
          trades: [
            {
              id: 'live-curve-1',
              token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              side: 'buy',
              volume_usd: 180000,
              price_usd: 1,
              tx_hash: '0xlivetx3',
              block_timestamp: 1709999200,
            },
          ],
        };
      },
    });

    const tokenTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades',
    });
    const filteredTokenTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?trade_volume_in_usd_greater_than=150000',
    });
    const pagedTokenTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?limit=1&before_timestamp=1709999200',
    });

    expect(poolTradesResponse.statusCode).toBe(200);
    expect(poolTradesResponse.json().meta).toMatchObject({
      fixture: false,
      network: 'eth',
      pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      source: 'live',
      updated_at: expect.any(String),
      field_provenance: expect.any(Object),
    });
    expect(poolTradesResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'trade',
          relationships: expect.objectContaining({
            pool: {
              data: {
                type: 'pool',
                id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
              },
            },
            network: {
              data: {
                type: 'network',
                id: 'eth',
              },
            },
          }),
        }),
      ]),
    );
    expect(poolTradesResponse.json().data.length).toBeGreaterThanOrEqual(2);
    expect(poolTradesResponse.json().data.map((trade: { attributes: { tx_hash: string } }) => trade.attributes.tx_hash)).toEqual([
      '0xlivetx1',
      '0xlivetx2',
    ]);
    expect(poolTradesResponse.json().data.every((trade: { relationships: { pool: { data: { id: string } } } }) =>
      trade.relationships.pool.data.id === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640')).toBe(true);

    expect(filteredPoolTradesResponse.statusCode).toBe(200);
    expect(filteredPoolTradesResponse.json().data.length).toBeGreaterThan(0);
    expect(filteredPoolTradesResponse.json().data.every((trade: {
      attributes: { volume_in_usd: string; token_address: string };
      relationships: { pool: { data: { id: string } } };
    }) =>
      Number(trade.attributes.volume_in_usd) > 150000
      && trade.attributes.token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      && trade.relationships.pool.data.id === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640')).toBe(true);

    expect(pagedPoolTradesResponse.statusCode).toBe(200);
    expect(pagedPoolTradesResponse.json().data).toHaveLength(1);
    expect(pagedPoolTradesResponse.json().data[0].attributes.block_timestamp).toBe(1710000000);

    expect(tokenTradesResponse.statusCode).toBe(200);
    expect(tokenTradesResponse.json().meta).toMatchObject({
      fixture: false,
      network: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      source: 'live',
      updated_at: expect.any(String),
      field_provenance: expect.any(Object),
    });
    expect(tokenTradesResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'trade',
          relationships: expect.objectContaining({
            token: {
              data: {
                type: 'token',
                id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              },
            },
            network: {
              data: {
                type: 'network',
                id: 'eth',
              },
            },
          }),
        }),
      ]),
    );
    expect(new Set(tokenTradesResponse.json().data.map((trade: { relationships: { pool: { data: { id: string } } } }) =>
      trade.relationships.pool.data.id))).toEqual(new Set([
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]));
    expect(tokenTradesResponse.json().data.every((trade: { attributes: { token_address: string } }) =>
      trade.attributes.token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true);

    expect(filteredTokenTradesResponse.statusCode).toBe(200);
    expect(filteredTokenTradesResponse.json().data.length).toBeGreaterThan(0);
    expect(filteredTokenTradesResponse.json().data.every((trade: { attributes: { volume_in_usd: string } }) =>
      Number(trade.attributes.volume_in_usd) > 150000)).toBe(true);

    expect(pagedTokenTradesResponse.statusCode).toBe(200);
    expect(pagedTokenTradesResponse.json().data).toHaveLength(1);
    expect(pagedTokenTradesResponse.json().data[0].attributes.block_timestamp).toBe(1709999200);
    process.env.VITEST = originalVitest;
  });
  it('caps SQD-backed pool trade route fetches to a route-scoped recent swap budget', async () => {
    const originalVitest = process.env.VITEST;
    process.env.VITEST = 'false';

    const sqdSpy = vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue([
      {
        blockNumber: 100,
        blockTimestamp: 1710000100,
        txHash: '0xlivetx1',
        amount0: '-220000',
        amount1: '220500',
        sqrtPriceX96: '0',
        liquidity: '0',
        tick: 0,
      },
    ]);
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?limit=20',
    });

    expect(response.statusCode).toBe(200);
    expect(sqdSpy).toHaveBeenCalledWith(
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      expect.objectContaining({
        toBlock: undefined,
        maxResults: 128,
      }),
    );

    process.env.VITEST = originalVitest;
  });
  it('rejects malformed onchain trade parameters explicitly', async () => {
    const invalidPoolTokenResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?token=0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });
    const malformedPoolThresholdResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?trade_volume_in_usd_greater_than=abc',
    });
    const malformedTokenThresholdResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?trade_volume_in_usd_greater_than=abc',
    });
    const malformedPoolLimitResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?limit=0',
    });
    const malformedTokenBeforeTimestampResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?before_timestamp=bad',
    });
    const malformedPoolTokenResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?token=not-an-address',
    });

    expect(invalidPoolTokenResponse.statusCode).toBe(400);
    expect(invalidPoolTokenResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Token is not a constituent of pool: 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });

    expect(malformedPoolThresholdResponse.statusCode).toBe(400);
    expect(malformedPoolThresholdResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid trade_volume_in_usd_greater_than value: abc',
    });

    expect(malformedTokenThresholdResponse.statusCode).toBe(400);
    expect(malformedTokenThresholdResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid trade_volume_in_usd_greater_than value: abc',
    });

    expect(malformedPoolLimitResponse.statusCode).toBe(400);
    expect(malformedPoolLimitResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid limit value: 0',
    });

    expect(malformedTokenBeforeTimestampResponse.statusCode).toBe(400);
    expect(malformedTokenBeforeTimestampResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid before_timestamp value: bad',
    });

    expect(malformedPoolTokenResponse.statusCode).toBe(400);
    expect(malformedPoolTokenResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid onchain address: not-an-address',
    });
  });
  it('returns pool-level onchain OHLCV with timeframe controls and currency/token semantics', async () => {
    const originalVitest = process.env.VITEST;
    process.env.VITEST = 'false';

    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockImplementation(async (poolAddress) => {
      if (poolAddress.toLowerCase() !== '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640') {
        return null;
      }

      return [
        {
          blockNumber: 1,
          blockTimestamp: 1714737600,
          txHash: '0xohlcvtx1',
          amount0: '-1000',
          amount1: '1000',
          sqrtPriceX96: '0',
          liquidity: '0',
          tick: 0,
        },
        {
          blockNumber: 2,
          blockTimestamp: 1714741200,
          txHash: '0xohlcvtx2',
          amount0: '-1200',
          amount1: '1200',
          sqrtPriceX96: '0',
          liquidity: '0',
          tick: 0,
        },
        {
          blockNumber: 3,
          blockTimestamp: 1714744800,
          txHash: '0xohlcvtx3',
          amount0: '-1500',
          amount1: '1500',
          sqrtPriceX96: '0',
          liquidity: '0',
          tick: 0,
        },
        {
          blockNumber: 4,
          blockTimestamp: 1714748400,
          txHash: '0xohlcvtx4',
          amount0: '900',
          amount1: '-900',
          sqrtPriceX96: '0',
          liquidity: '0',
          tick: 0,
        },
      ];
    });
    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour',
    });
    const aggregatedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?aggregate=2&limit=2',
    });
    const beforeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?before_timestamp=1714741200&limit=2',
    });
    const tokenCurrencyResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?currency=token&token=0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    });
    const emptyIntervalsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7/ohlcv/day?include_empty_intervals=true',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(baselineResponse.json()).toMatchObject({
      data: {
        type: 'ohlcv',
        attributes: {
          network: 'eth',
          pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          timeframe: 'hour',
          aggregate: 1,
          currency: 'usd',
          source: 'live',
        },
      },
    });
    const baselineSeries = baselineResponse.json().data.attributes.ohlcv_list;
    expect(baselineSeries.length).toBeGreaterThan(2);
    expect(baselineSeries[0]).toEqual(expect.objectContaining({
      timestamp: expect.any(Number),
      open: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      close: expect.any(Number),
      volume_usd: expect.any(Number),
    }));
    expect(baselineSeries.every((entry: { high: number; low: number; open: number; close: number; volume_usd: number }, index: number, arr: Array<{ timestamp: number }>) =>
      entry.high >= Math.max(entry.open, entry.close)
      && entry.low <= Math.min(entry.open, entry.close)
      && entry.volume_usd >= 0
      && (index === 0 || arr[index - 1]!.timestamp <= arr[index]!.timestamp))).toBe(true);

    expect(aggregatedResponse.statusCode).toBe(200);
    expect(aggregatedResponse.json().data.attributes.aggregate).toBe(2);
    expect(aggregatedResponse.json().data.attributes.ohlcv_list).toHaveLength(2);

    expect(beforeResponse.statusCode).toBe(200);
    expect(beforeResponse.json().data.attributes.ohlcv_list).toHaveLength(2);
    expect(beforeResponse.json().data.attributes.ohlcv_list.every((entry: { timestamp: number }) =>
      entry.timestamp <= 1714741200)).toBe(true);

    expect(tokenCurrencyResponse.statusCode).toBe(200);
    expect(tokenCurrencyResponse.json().data.attributes.currency).toBe('token');

    expect(emptyIntervalsResponse.statusCode).toBe(200);
    const emptySeries = emptyIntervalsResponse.json().data.attributes.ohlcv_list;
    expect(emptySeries.length).toBeGreaterThan(1);
    expect(emptySeries.every((entry: { volume_usd: number }) => typeof entry.volume_usd === 'number')).toBe(true);
    process.env.VITEST = originalVitest;
  });
  it('falls back to explicit fixture JSON for canonical pool trades and ohlcv when SQD returns null', async () => {
    const originalVitest = process.env.VITEST;
    process.env.VITEST = 'false';

    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);
    const tradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades',
    });
    const ohlcvResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour',
    });

    expect(tradesResponse.statusCode).toBe(200);
    expect(tradesResponse.headers['content-type']).toContain('application/json');
    expect(tradesResponse.json()).toMatchObject({
      meta: {
        network: 'eth',
        pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        source: 'fixture',
      },
    });
    expect(Array.isArray(tradesResponse.json().data)).toBe(true);
    expect(tradesResponse.json().data.length).toBeGreaterThan(0);

    expect(ohlcvResponse.statusCode).toBe(200);
    expect(ohlcvResponse.headers['content-type']).toContain('application/json');
    expect(ohlcvResponse.json()).toMatchObject({
      data: {
        type: 'ohlcv',
        attributes: {
          network: 'eth',
          pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          timeframe: 'hour',
          source: 'fixture',
        },
      },
    });
    expect(ohlcvResponse.json().data.attributes.ohlcv_list.length).toBeGreaterThan(0);

    process.env.VITEST = originalVitest;
  });
  it('proves token ohlcv falls back to the degraded seeded pool set when live swaps are unavailable', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/ohlcv/day?include_inactive_source=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: 'eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:day',
        type: 'ohlcv',
        attributes: {
          network: 'eth',
          token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          timeframe: 'day',
          aggregate: 1,
          include_inactive_source: true,
          source_pools: [
            '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
            '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
          ],
        },
      },
    });
    const fallbackSeries = response.json().data.attributes.ohlcv_list;
    expect(fallbackSeries.length).toBeGreaterThan(1);
    expect(fallbackSeries.every((entry: { high: number; low: number; open: number; close: number; volume_usd: number }, index: number, arr: Array<{ timestamp: number }>) =>
      entry.high >= Math.max(entry.open, entry.close)
      && entry.low <= Math.min(entry.open, entry.close)
      && entry.volume_usd >= 0
      && (index === 0 || arr[index - 1]!.timestamp <= arr[index]!.timestamp))).toBe(true);
    expect(fallbackSeries[0]).toMatchObject({
      timestamp: expect.any(Number),
      open: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      close: expect.any(Number),
      volume_usd: expect.any(Number),
    });
  }, 15_000);
});
