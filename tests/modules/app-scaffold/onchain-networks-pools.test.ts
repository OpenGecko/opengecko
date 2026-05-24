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

  it('returns onchain networks and network dexes', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        { chain: 'Ethereum', project: 'uniswap-v3', symbol: 'USDC-WETH', pool: 'pool-1', tvlUsd: 222000000, volumeUsd1d: 88000000, volumeUsd7d: 600000000, underlyingTokens: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'] },
        { chain: 'Arbitrum', project: 'uniswap-v3', symbol: 'ARB-WETH', pool: 'pool-2', tvlUsd: 10000000, volumeUsd1d: 1000000, volumeUsd7d: 7000000, underlyingTokens: ['0xarb', '0xweth'] },
        { chain: 'Base', project: 'aerodrome', symbol: 'cbBTC-USDC', pool: 'pool-3', tvlUsd: 20000000, volumeUsd1d: 2000000, volumeUsd7d: 14000000, underlyingTokens: ['0xcbbtc', '0xusdc'] },
        { chain: 'Polygon', project: 'sushiswap', symbol: 'USDC-WMATIC', pool: 'pool-4', tvlUsd: 8000000, volumeUsd1d: 500000, volumeUsd7d: 3000000, underlyingTokens: ['0xusdc', '0xwmatic'] },
        { chain: 'BSC', project: 'pancakeswap', symbol: 'WBNB-USDT', pool: 'pool-5', tvlUsd: 12000000, volumeUsd1d: 900000, volumeUsd7d: 6000000, underlyingTokens: ['0xwbnb', '0xusdt'] },
      ],
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      protocols: [
        { name: 'uniswap-v3', total24h: 88000000, total7d: 600000000, total30d: 2500000000, totalAllTime: 10000000000 },
        { name: 'curve', total24h: 41000000, total7d: 287000000, total30d: 1200000000, totalAllTime: 6000000000 },
        { name: 'aerodrome', total24h: 12000000, total7d: 84000000, total30d: 360000000, totalAllTime: 1000000000 },
        { name: 'sushiswap', total24h: 18000000, total7d: 100000000, total30d: 500000000, totalAllTime: 2000000000 },
        { name: 'pancakeswap', total24h: 24000000, total7d: 160000000, total30d: 700000000, totalAllTime: 5000000000 },
      ],
      total24h: 183000000,
      total7d: 1231000000,
      total30d: 5260000000,
      totalAllTime: 24000000000,
    });

    const networksResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks?page=1',
    });
    const dexesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes?page=1',
    });

    expect(networksResponse.statusCode).toBe(200);
    expect(networksResponse.json().data).toHaveLength(6);
    expect(networksResponse.json().data.map((entry: { id: string }) => entry.id)).toEqual([
      'arbitrum',
      'base',
      'bsc',
      'eth',
      'polygon',
      'solana',
    ]);
    expect(dexesResponse.json().data.map((entry: { id: string }) => entry.id)).toEqual([
      'curve',
      'uniswap_v3',
    ]);
    expect(dexesResponse.json()).toMatchObject(contractFixtures.onchainDexesEth);
  });
  it('proves current-head live onchain catalog expansion from provider-backed discovery data', async () => {
    const poolDataSpy = vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        { chain: 'Ethereum', project: 'uniswap-v3', symbol: 'USDC-WETH', pool: 'pool-1', tvlUsd: 222000000, volumeUsd1d: 88000000, volumeUsd7d: 600000000, underlyingTokens: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'] },
        { chain: 'Arbitrum', project: 'uniswap-v3', symbol: 'ARB-WETH', pool: 'pool-2', tvlUsd: 10000000, volumeUsd1d: 1000000, volumeUsd7d: 7000000, underlyingTokens: ['0xarb', '0xweth'] },
        { chain: 'Base', project: 'aerodrome', symbol: 'cbBTC-USDC', pool: 'pool-3', tvlUsd: 20000000, volumeUsd1d: 2000000, volumeUsd7d: 14000000, underlyingTokens: ['0xcbbtc', '0xusdc'] },
        { chain: 'Polygon', project: 'sushiswap', symbol: 'USDC-WMATIC', pool: 'pool-4', tvlUsd: 8000000, volumeUsd1d: 500000, volumeUsd7d: 3000000, underlyingTokens: ['0xusdc', '0xwmatic'] },
        { chain: 'BSC', project: 'pancakeswap', symbol: 'WBNB-USDT', pool: 'pool-5', tvlUsd: 12000000, volumeUsd1d: 900000, volumeUsd7d: 6000000, underlyingTokens: ['0xwbnb', '0xusdt'] },
      ],
    });
    const dexVolumesSpy = vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      protocols: [
        { name: 'uniswap-v3', total24h: 88000000, total7d: 600000000, total30d: 2500000000, totalAllTime: 10000000000 },
        { name: 'curve', total24h: 41000000, total7d: 287000000, total30d: 1200000000, totalAllTime: 6000000000 },
        { name: 'aerodrome', total24h: 12000000, total7d: 84000000, total30d: 360000000, totalAllTime: 1000000000 },
        { name: 'sushiswap', total24h: 18000000, total7d: 100000000, total30d: 500000000, totalAllTime: 2000000000 },
        { name: 'pancakeswap', total24h: 24000000, total7d: 160000000, total30d: 700000000, totalAllTime: 5000000000 },
      ],
      total24h: 183000000,
      total7d: 1231000000,
      total30d: 5260000000,
      totalAllTime: 24000000000,
    });

    const [networksResponse, ethDexesResponse, ethPoolsResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/onchain/networks?page=1',
      }),
      getApp().inject({
        method: 'GET',
        url: '/onchain/networks/eth/dexes?page=1',
      }),
      getApp().inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools?page=1',
      }),
    ]);

    expect(networksResponse.statusCode).toBe(200);
    expect(ethDexesResponse.statusCode).toBe(200);
    expect(ethPoolsResponse.statusCode).toBe(200);
    expect(poolDataSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(dexVolumesSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(networksResponse.json().meta).toMatchObject({
      total_count: 6,
    });
    expect(networksResponse.json().data.map((entry: { id: string }) => entry.id)).toEqual([
      'arbitrum',
      'base',
      'bsc',
      'eth',
      'polygon',
      'solana',
    ]);
    expect(networksResponse.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'base',
        type: 'network',
        attributes: expect.objectContaining({
          name: 'Base',
          coingecko_asset_platform_id: 'base',
        }),
      }),
      expect.objectContaining({
        id: 'bsc',
        type: 'network',
        attributes: expect.objectContaining({
          name: 'BNB Smart Chain',
          coingecko_asset_platform_id: 'binance-smart-chain',
        }),
      }),
    ]));
    expect(ethDexesResponse.json().meta).toMatchObject({
      total_count: 2,
      network: 'eth',
    });
    expect(ethPoolsResponse.json().meta).toMatchObject({
      data_source: 'live',
      page: 1,
    });
    const liveEthPool = ethPoolsResponse.json().data.find((entry: { id: string }) => entry.id === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
    expect(liveEthPool).toMatchObject({
      type: 'pool',
      attributes: {
        reserve_usd: 222000000,
        volume_usd: {
          h24: 88000000,
        },
      },
      relationships: {
        network: {
          data: {
            id: 'eth',
            type: 'network',
          },
        },
        dex: {
          data: {
            id: 'uniswap_v3',
            type: 'dex',
          },
        },
      },
    });
  });
  it('keeps live onchain catalog expansion when optional dex-volume enrichment is unavailable', async () => {
    const poolDataSpy = vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        { chain: 'Ethereum', project: 'uniswap-v3', symbol: 'USDC-WETH', pool: 'pool-1', tvlUsd: 222000000, volumeUsd1d: 88000000, volumeUsd7d: 600000000, underlyingTokens: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'] },
        { chain: 'Arbitrum', project: 'uniswap-v3', symbol: 'ARB-WETH', pool: 'pool-2', tvlUsd: 10000000, volumeUsd1d: 1000000, volumeUsd7d: 7000000, underlyingTokens: ['0xarb', '0xweth'] },
        { chain: 'Base', project: 'aerodrome', symbol: 'cbBTC-USDC', pool: 'pool-3', tvlUsd: 20000000, volumeUsd1d: 2000000, volumeUsd7d: 14000000, underlyingTokens: ['0xcbbtc', '0xusdc'] },
      ],
    });
    const dexVolumesSpy = vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
    const poolCallCountBeforeRequests = poolDataSpy.mock.calls.length;
    const dexVolumeCallCountBeforeRequests = dexVolumesSpy.mock.calls.length;

    const [networksResponse, ethDexesResponse, ethPoolsResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/onchain/networks?page=1',
      }),
      getApp().inject({
        method: 'GET',
        url: '/onchain/networks/eth/dexes?page=1',
      }),
      getApp().inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools?page=1',
      }),
    ]);

    expect(networksResponse.statusCode).toBe(200);
    expect(ethDexesResponse.statusCode).toBe(200);
    expect(ethPoolsResponse.statusCode).toBe(200);
    expect(poolDataSpy).toHaveBeenCalledTimes(poolCallCountBeforeRequests + 1);
    expect(dexVolumesSpy).toHaveBeenCalledTimes(dexVolumeCallCountBeforeRequests + 1);
    expect(networksResponse.json().meta).toMatchObject({
      total_count: 4,
    });
    expect(networksResponse.json().data.map((entry: { id: string }) => entry.id)).toEqual([
      'arbitrum',
      'base',
      'eth',
      'solana',
    ]);
    expect(ethDexesResponse.json().meta).toMatchObject({
      total_count: 2,
      network: 'eth',
    });
    expect(ethPoolsResponse.json().meta).toMatchObject({
      data_source: 'live',
      page: 1,
    });

    const liveEthPool = ethPoolsResponse.json().data.find((entry: { id: string }) => entry.id === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
    expect(liveEthPool).toMatchObject({
      type: 'pool',
      attributes: {
        reserve_usd: 222000000,
        volume_usd: {
          h24: 88000000,
        },
      },
      relationships: {
        network: {
          data: {
            id: 'eth',
            type: 'network',
          },
        },
        dex: {
          data: {
            id: 'uniswap_v3',
            type: 'dex',
          },
        },
      },
    });
  });
  it('short-circuits unknown onchain pool detail before live provider discovery', async () => {
    vi.restoreAllMocks();
    const poolDataSpy = vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData');
    const dexVolumesSpy = vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes');
    const poolCallCountBeforeRequest = poolDataSpy.mock.calls.length;
    const dexVolumeCallCountBeforeRequest = dexVolumesSpy.mock.calls.length;

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/not-a-pool',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain pool not found: not-a-pool',
    });
    expect(poolDataSpy.mock.calls.length).toBeGreaterThanOrEqual(poolCallCountBeforeRequest);
    expect(poolDataSpy.mock.calls.length - poolCallCountBeforeRequest).toBeLessThanOrEqual(1);
    expect(dexVolumesSpy.mock.calls.length).toBeGreaterThanOrEqual(dexVolumeCallCountBeforeRequest);
    expect(dexVolumesSpy.mock.calls.length - dexVolumeCallCountBeforeRequest).toBeLessThanOrEqual(1);
  });
  it('returns onchain networks with pagination metadata and asset-platform continuity', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('meta.page', 1);
    expect(body).toHaveProperty('meta.per_page', 100);
    expect(body).toHaveProperty('meta.total_pages', 1);
    expect(body).toHaveProperty('meta.total_count', 2);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'eth',
          type: 'network',
          attributes: expect.objectContaining({
            coingecko_asset_platform_id: 'ethereum',
          }),
        }),
        expect.objectContaining({
          id: 'solana',
          type: 'network',
          attributes: expect.objectContaining({
            coingecko_asset_platform_id: 'solana',
          }),
        }),
      ]),
    );
  });
  it('returns later onchain network pages with the same collection shape', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks?page=2',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [],
      meta: {
        page: 2,
        per_page: 100,
        total_pages: 1,
        total_count: 2,
      },
    });
  });
  it('returns network-scoped dexes with relationship continuity', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      meta: {
        page: 1,
        per_page: 100,
        total_pages: 1,
        total_count: 2,
        network: 'eth',
      },
    });
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'curve',
          type: 'dex',
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
          id: 'uniswap_v3',
          type: 'dex',
          relationships: {
            network: {
              data: {
                type: 'network',
                id: 'eth',
              },
            },
          },
        }),
      ]),
    );
    expect(body.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'raydium',
        }),
      ]),
    );
  });
  it('returns onchain network pools and pool detail', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        { chain: 'Ethereum', project: 'uniswap-v3', symbol: 'USDC-WETH', pool: 'pool-1', tvlUsd: 222000000, volumeUsd1d: 88000000, volumeUsd7d: 600000000, underlyingTokens: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'] },
        { chain: 'Ethereum', project: 'curve', symbol: 'DAI-USDC-USDT', pool: 'pool-2', tvlUsd: 515000000, volumeUsd1d: 41000000, volumeUsd7d: 287000000, underlyingTokens: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7'] },
        { chain: 'Ethereum', project: 'uniswap-v3', symbol: 'WETH-USDT', pool: 'pool-3', tvlUsd: 350000000, volumeUsd1d: 95000000, volumeUsd7d: 650000000, underlyingTokens: ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0xdac17f958d2ee523a2206206994597c13d831ec7'] },
      ],
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      protocols: [
        { name: 'uniswap-v3', total24h: 88000000, total7d: 600000000, total30d: 2500000000, totalAllTime: 10000000000 },
        { name: 'curve', total24h: 41000000, total7d: 287000000, total30d: 1200000000, totalAllTime: 6000000000 },
      ],
      total24h: 129000000,
      total7d: 887000000,
      total30d: 3700000000,
      totalAllTime: 16000000000,
    });

    const poolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });
    const poolDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    });

    expect(poolsResponse.statusCode).toBe(200);
    expect(poolsResponse.json()).toMatchObject(contractFixtures.onchainPoolsEth);
    expect(poolsResponse.json().meta.data_source).toBe('live');
    expect(poolsResponse.json().data[0]).toMatchObject({
      id: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      attributes: {
        reserve_usd: 350000000,
        price_usd: 2987.804878,
        volume_usd: {
          h24: 95000000,
        },
      },
    });
    expect(poolDetailResponse.json()).toMatchObject({
      data: {
        id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        type: 'pool',
        attributes: {
          name: 'USDC / WETH 0.05%',
          base_token_symbol: 'USDC',
          quote_token_symbol: 'WETH',
          reserve_usd: 222000000,
          price_usd: 0.683077,
          volume_usd: {
            h24: 88000000,
          },
        },
      },
      meta: {
        data_source: 'live',
      },
    });
  });
  it('falls back to seeded onchain pool and catalog data when DeFiLlama is unavailable', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);

    const networksResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks?page=1',
    });
    const poolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });
    const solanaPoolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/solana/pools?page=1',
    });

    expect(networksResponse.statusCode).toBe(200);
    expect(networksResponse.json()).toMatchObject(contractFixtures.onchainNetworks);
    expect(poolsResponse.statusCode).toBe(200);
    expect(poolsResponse.json()).toMatchObject(contractFixtures.onchainPoolsEth);
    expect(poolsResponse.json().meta.data_source).toBe('seeded');
    expect(solanaPoolsResponse.statusCode).toBe(200);
    expect(solanaPoolsResponse.json().meta.data_source).toBe('seeded');
    expect(solanaPoolsResponse.json().data).toContainEqual(expect.objectContaining({
      id: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
      type: 'pool',
    }));
  });
  it('keeps onchain pool detail scoped to the requested network and supports explicit includes/toggles', async () => {
    const includedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640?include=network,dex&include_volume_breakdown=true&include_composition=true',
    });
    const wrongNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/solana/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    });

    expect(includedResponse.statusCode).toBe(200);
    expect(includedResponse.json()).toMatchObject({
      data: {
        id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        relationships: {
          network: { data: { id: 'eth', type: 'network' } },
          dex: { data: { id: 'uniswap_v3', type: 'dex' } },
        },
        attributes: {
          volume_usd: {
            h24: 64500000,
            h24_buy_usd: 32250000,
            h24_sell_usd: 32250000,
          },
          composition: {
            base_token: {
              address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              symbol: 'USDC',
            },
            quote_token: {
              address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
              symbol: 'WETH',
            },
          },
        },
      },
      included: expect.arrayContaining([
        expect.objectContaining({ id: 'eth', type: 'network' }),
        expect.objectContaining({ id: 'uniswap_v3', type: 'dex' }),
      ]),
    });

    expect(wrongNetworkResponse.statusCode).toBe(404);
    expect(wrongNetworkResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain pool not found: 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    });
  });
  it('normalizes mixed-case onchain pool addresses before detail and multi lookups without changing canonical response ids', async () => {
    const lowercaseAddress = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
    const mixedCaseAddress = '0x88E6A0c2DDD26fEEB64F039a2C41296fCB3F5640';
    const lowercaseSecondAddress = '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36';
    const mixedCaseSecondAddress = '0x4E68CCD3E89F51C3074CA5072BBAC773960DFA36';

    const lowercaseDetailResponse = await getApp().inject({
      method: 'GET',
      url: `/onchain/networks/eth/pools/${lowercaseAddress}`,
    });
    const mixedCaseDetailResponse = await getApp().inject({
      method: 'GET',
      url: `/onchain/networks/eth/pools/${mixedCaseAddress}`,
    });
    const lowercaseMultiResponse = await getApp().inject({
      method: 'GET',
      url: `/onchain/networks/eth/pools/multi/${lowercaseAddress},${lowercaseSecondAddress}`,
    });
    const mixedCaseMultiResponse = await getApp().inject({
      method: 'GET',
      url: `/onchain/networks/eth/pools/multi/${mixedCaseAddress},${mixedCaseSecondAddress}`,
    });
    const unknownMixedCaseResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x00000000000000000000000000000000000000AA',
    });

    expect(lowercaseDetailResponse.statusCode).toBe(200);
    expect(mixedCaseDetailResponse.statusCode).toBe(200);
    expect(lowercaseDetailResponse.json().data).toMatchObject({
      id: lowercaseAddress,
      attributes: {
        address: lowercaseAddress,
      },
    });
    expect(mixedCaseDetailResponse.json()).toEqual(lowercaseDetailResponse.json());

    expect(lowercaseMultiResponse.statusCode).toBe(200);
    expect(mixedCaseMultiResponse.statusCode).toBe(200);
    expect(mixedCaseMultiResponse.json()).toEqual(lowercaseMultiResponse.json());
    expect(mixedCaseMultiResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      lowercaseAddress,
      lowercaseSecondAddress,
    ]);

    expect(unknownMixedCaseResponse.statusCode).toBe(404);
    expect(unknownMixedCaseResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain pool not found: 0x00000000000000000000000000000000000000aa',
    });
  });
  it('returns onchain pools scoped by dex', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes/uniswap_v3/pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty('relationships.dex.data.id', 'uniswap_v3');
  });
  it('keeps dex-scoped pools aligned to the requested dex and network', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes/uniswap_v3/pools?page=1&sort=reserve_in_usd_desc',
    });
    const mismatchedDexResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes/raydium/pools',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({ id: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36' }),
      expect.objectContaining({ id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' }),
    ]);
    expect(response.json().data).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7' })]),
    );

    expect(mismatchedDexResponse.statusCode).toBe(404);
    expect(mismatchedDexResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain dex not found: raydium',
    });
  });
  it('returns newest onchain pools for a network', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/new_pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty('type', 'pool');
  });
  it('orders network new pools by recency while preserving pool/dex continuity', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/new_pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    expect(response.json().data[0]).toMatchObject({
      relationships: {
        network: { data: { id: 'eth', type: 'network' } },
        dex: { data: { id: 'uniswap_v3', type: 'dex' } },
      },
    });
  });
});
