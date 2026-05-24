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

  it('returns global and network trending pools with stable ranking, duration support, and include handling', async () => {
    const globalResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/trending_pools?page=1',
    });
    const globalRepeatedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/trending_pools?page=1',
    });
    const durationResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/trending_pools?page=1&duration=6h',
    });
    const includeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/trending_pools?page=1&include=network,dex',
    });
    const networkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/trending_pools?page=1',
    });
    const networkDurationResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/trending_pools?page=1&duration=1h',
    });

    expect(globalResponse.statusCode).toBe(200);
    expect(globalRepeatedResponse.statusCode).toBe(200);
    expect(durationResponse.statusCode).toBe(200);
    expect(includeResponse.statusCode).toBe(200);
    expect(networkResponse.statusCode).toBe(200);
    expect(networkDurationResponse.statusCode).toBe(200);

    expect(globalResponse.json()).toMatchObject({
      meta: {
        page: 1,
        duration: '24h',
      },
    });
    expect(globalResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    expect(globalRepeatedResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual(
      globalResponse.json().data.map((pool: { id: string }) => pool.id),
    );
    expect(durationResponse.json()).toMatchObject({
      meta: {
        page: 1,
        duration: '6h',
      },
    });
    expect(durationResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    expect(includeResponse.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ type: 'pool' }),
      ]),
      included: expect.arrayContaining([
        expect.objectContaining({ id: 'eth', type: 'network' }),
        expect.objectContaining({ id: 'solana', type: 'network' }),
        expect.objectContaining({ id: 'uniswap_v3', type: 'dex' }),
        expect.objectContaining({ id: 'raydium', type: 'dex' }),
      ]),
    });
    expect(includeResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'pool' }),
      ]),
    );
    expect(networkResponse.json()).toMatchObject({
      meta: {
        page: 1,
        duration: '24h',
        network: 'eth',
      },
    });
    expect(networkResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    expect(networkResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationships: expect.objectContaining({
            network: { data: { id: 'eth', type: 'network' } },
          }),
        }),
      ]),
    );
    expect(networkDurationResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);
    expect(networkDurationResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationships: expect.objectContaining({
            network: {
              data: {
                id: 'eth',
                type: 'network',
              },
            },
          }),
        }),
      ]),
    );
  });
  it('returns global and network new pools as recency-ordered discovery feeds with include handling', async () => {
    const globalResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/new_pools?page=1&include=network,dex',
    });
    const networkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/new_pools?page=1&include=network,dex',
    });

    expect(globalResponse.statusCode).toBe(200);
    expect(networkResponse.statusCode).toBe(200);

    expect(globalResponse.json()).toMatchObject({
      meta: {
        page: 1,
      },
      included: expect.arrayContaining([
        expect.objectContaining({ id: 'eth', type: 'network' }),
        expect.objectContaining({ id: 'solana', type: 'network' }),
        expect.objectContaining({ id: 'uniswap_v3', type: 'dex' }),
        expect.objectContaining({ id: 'raydium', type: 'dex' }),
      ]),
    });
    expect(globalResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    const globalCreatedAt = globalResponse.json().data.map((pool: { attributes: { pool_created_at: number | null } }) => pool.attributes.pool_created_at ?? 0);
    expect(globalCreatedAt).toEqual([...globalCreatedAt].sort((left, right) => (right ?? 0) - (left ?? 0)));

    expect(networkResponse.json()).toMatchObject({
      meta: {
        page: 1,
      },
      included: expect.arrayContaining([
        expect.objectContaining({ id: 'eth', type: 'network' }),
        expect.objectContaining({ id: 'uniswap_v3', type: 'dex' }),
      ]),
    });
    expect(networkResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    expect(networkResponse.json().data.every((pool: { relationships: { network: { data: { id: string } } } }) =>
      pool.relationships.network.data.id === 'eth')).toBe(true);
    const networkCreatedAt = networkResponse.json().data.map((pool: { attributes: { pool_created_at: number | null } }) => pool.attributes.pool_created_at ?? 0);
    expect(networkCreatedAt).toEqual([...networkCreatedAt].sort((left, right) => (right ?? 0) - (left ?? 0)));
  });
  it('returns pool search results with exact matches ranked ahead of partial matches and supports network filtering', async () => {
    const exactAddressResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/search/pools?query=0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640&page=1',
    });
    const exactNameResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/search/pools?query=USDC&page=1',
    });
    const partialResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/search/pools?query=usdc&page=1',
    });
    const networkFilteredResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/search/pools?query=usdc&network=solana&page=1',
    });

    expect(exactAddressResponse.statusCode).toBe(200);
    expect(exactAddressResponse.json()).toMatchObject({
      meta: {
        page: 1,
        query: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      },
    });
    expect(exactAddressResponse.json().data[0]).toMatchObject({
      id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      relationships: {
        network: { data: { id: 'eth', type: 'network' } },
      },
    });

    expect(exactNameResponse.statusCode).toBe(200);
    expect(exactNameResponse.json().data.length).toBeGreaterThan(0);
    expect(exactNameResponse.json().data[0].id).toBe('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');

    expect(partialResponse.statusCode).toBe(200);
    expect(partialResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);

    expect(networkFilteredResponse.statusCode).toBe(200);
    expect(networkFilteredResponse.json()).toMatchObject({
      meta: {
        page: 1,
        network: 'solana',
      },
    });
    expect(networkFilteredResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    ]);
    expect(networkFilteredResponse.json().data.every((pool: { relationships: { network: { data: { id: string } } } }) =>
      pool.relationships.network.data.id === 'solana')).toBe(true);
  });
  it('returns trending search rows constrained to requested subsets and paginates deterministically', async () => {
    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/trending_search?page=1',
    });
    const subsetResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/trending_search?page=1&pools=0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640,58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    });
    const invalidSubsetResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/trending_search?page=1&pools=0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640,0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640,0x0000000000000000000000000000000000000000',
    });
    const pageOneResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/trending_search?page=1&per_page=2',
    });
    const pageTwoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/trending_search?page=2&per_page=2',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(baselineResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);

    expect(subsetResponse.statusCode).toBe(200);
    expect(subsetResponse.json()).toMatchObject({
      meta: {
        page: 1,
        candidate_count: 2,
      },
    });
    expect(subsetResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    ]);

    expect(invalidSubsetResponse.statusCode).toBe(200);
    expect(invalidSubsetResponse.json()).toMatchObject({
      meta: {
        page: 1,
        candidate_count: 1,
        ignored_candidates: [
          '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          '0x0000000000000000000000000000000000000000',
        ],
      },
    });
    expect(invalidSubsetResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);

    expect(pageOneResponse.statusCode).toBe(200);
    expect(pageTwoResponse.statusCode).toBe(200);
    expect(pageOneResponse.json()).toMatchObject({
      meta: {
        page: 1,
        per_page: 2,
      },
    });
    expect(pageTwoResponse.json()).toMatchObject({
      meta: {
        page: 2,
        per_page: 2,
      },
    });
    expect(pageOneResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);
    expect(pageTwoResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    expect(pageTwoResponse.json().data).not.toEqual(expect.arrayContaining(
      pageOneResponse.json().data.map((pool: { id: string }) => expect.objectContaining({ id: pool.id })),
    ));
  });
  it('returns megafilter pool rows for valid filter sets with numeric bounds, conjunctive filtering, deterministic sorting, and empty results', async () => {
    const validResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/megafilter?networks=eth&dexes=uniswap_v3&min_reserve_in_usd=300000000&min_volume_usd_h24=60000000&sort=reserve_in_usd_desc&page=1',
    });
    const maxBoundResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/megafilter?max_reserve_in_usd=330000000&sort=reserve_in_usd_desc&page=1',
    });
    const conjunctiveResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/megafilter?networks=eth&dexes=uniswap_v3&min_tx_count_h24=25000&sort=tx_count_h24_desc&page=1',
    });
    const emptyResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/megafilter?networks=solana&dexes=raydium&min_volume_usd_h24=50000000&sort=volume_usd_h24_desc&page=1',
    });

    expect(validResponse.statusCode).toBe(200);
    expect(validResponse.json()).toMatchObject({
      meta: {
        page: 1,
        sort: 'reserve_in_usd_desc',
        total_count: 2,
        applied_filters: {
          networks: ['eth'],
          dexes: ['uniswap_v3'],
          min_reserve_in_usd: 300000000,
          min_volume_usd_h24: 60000000,
        },
      },
    });
    expect(validResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);
    expect(validResponse.json().data.every((pool: {
      attributes: {
        reserve_in_usd: number;
        volume_usd_h24: number;
      };
      relationships: {
        network: { data: { id: string } };
        dex: { data: { id: string } };
      };
    }) => (
      pool.relationships.network.data.id === 'eth'
      && pool.relationships.dex.data.id === 'uniswap_v3'
      && pool.attributes.reserve_in_usd >= 300000000
      && pool.attributes.volume_usd_h24 >= 60000000
    ))).toBe(true);
    const sortedReserves = validResponse.json().data.map((pool: { attributes: { reserve_in_usd: number } }) => pool.attributes.reserve_in_usd);
    expect(sortedReserves).toEqual([...sortedReserves].sort((left, right) => right - left));

    expect(maxBoundResponse.statusCode).toBe(200);
    expect(maxBoundResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    ]);
    expect(maxBoundResponse.json().data.every((pool: { attributes: { reserve_in_usd: number } }) =>
      pool.attributes.reserve_in_usd <= 330000000)).toBe(true);

    expect(conjunctiveResponse.statusCode).toBe(200);
    expect(conjunctiveResponse.json()).toMatchObject({
      meta: {
        page: 1,
        sort: 'tx_count_h24_desc',
      },
    });
    expect(conjunctiveResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);
    expect(conjunctiveResponse.json().data.every((pool: {
      attributes: { tx_count_h24: number };
      relationships: {
        network: { data: { id: string } };
        dex: { data: { id: string } };
      };
    }) => (
      pool.relationships.network.data.id === 'eth'
      && pool.relationships.dex.data.id === 'uniswap_v3'
      && pool.attributes.tx_count_h24 >= 25000
    ))).toBe(true);
    const txCounts = conjunctiveResponse.json().data.map((pool: { attributes: { tx_count_h24: number } }) => pool.attributes.tx_count_h24);
    expect(txCounts).toEqual([...txCounts].sort((left, right) => right - left));

    expect(emptyResponse.statusCode).toBe(200);
    expect(emptyResponse.json()).toMatchObject({
      data: [],
      meta: {
        page: 1,
        sort: 'volume_usd_h24_desc',
        total_count: 0,
        applied_filters: {
          networks: ['solana'],
          dexes: ['raydium'],
          min_volume_usd_h24: 50000000,
        },
      },
    });
  });
  it('returns megafilter included token resources for supported include values', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/megafilter?networks=eth&sort=reserve_in_usd_desc&include=base_token,quote_token&page=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);
    expect(response.json()).toMatchObject({
      included: expect.arrayContaining([
        expect.objectContaining({
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          type: 'token',
          relationships: {
            network: {
              data: {
                type: 'network',
                id: 'eth',
              },
            },
          },
        }),
        expect.objectContaining({
          id: '0xdac17f958d2ee523a2206206994597c13d831ec7',
          type: 'token',
        }),
        expect.objectContaining({
          id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          type: 'token',
        }),
      ]),
    });
    expect(response.json().included).toHaveLength(3);
  });
  it('returns onchain pools by multi-address lookup', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/multi/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640,0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toHaveProperty('type', 'pool');
  });
  it('returns deterministic pool-multi results for requested addresses only with deduplicated includes', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/multi/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640,0x4e68ccd3e89f51c3074ca5072bbac773960dfa36?include=network,dex',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        expect.objectContaining({ id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' }),
        expect.objectContaining({ id: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36' }),
      ],
      included: expect.arrayContaining([
        expect.objectContaining({ id: 'eth', type: 'network' }),
        expect.objectContaining({ id: 'uniswap_v3', type: 'dex' }),
      ]),
    });
    expect(response.json().data).toHaveLength(2);
    expect(response.json().included).toHaveLength(2);
  });
});
