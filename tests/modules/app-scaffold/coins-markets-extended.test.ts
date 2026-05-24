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

  it('reuses preloaded chart series for market rows', async () => {
    const getCanonicalCloseSeriesSpy = vi.spyOn(candleStore, 'getCanonicalCloseSeries');
    const noRangeChartSeriesCalls = () => getCanonicalCloseSeriesSpy.mock.calls
      .filter(([, , vsCurrency, interval, range]) => vsCurrency === 'usd' && interval === '1d' && range === undefined);
    const countNoRangeChartSeriesCallsByCoin = () => noRangeChartSeriesCalls()
      .reduce<Record<string, number>>((counts, [, coinId]) => ({
        ...counts,
        [coinId]: (counts[coinId] ?? 0) + 1,
      }), {});
    const marketsUrl = '/coins/markets?vs_currency=usd&per_page=3&page=1&sparkline=true&price_change_percentage=24h,7d';

    const response = await getApp().inject({
      method: 'GET',
      url: marketsUrl,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(3);
    expect(noRangeChartSeriesCalls()).toHaveLength(3);
    expect(countNoRangeChartSeriesCallsByCoin()).toEqual(
      Object.fromEntries(response.json().map((row: { id: string }) => [row.id, 1])),
    );

    getCanonicalCloseSeriesSpy.mockClear();

    const cachedResponse = await getApp().inject({
      method: 'GET',
      url: marketsUrl,
    });

    expect(cachedResponse.statusCode).toBe(200);
    expect(cachedResponse.json()).toEqual(response.json());
    expect(noRangeChartSeriesCalls()).toHaveLength(0);

    getApp().marketDataRuntimeState.hotDataRevision += 1;
    getCanonicalCloseSeriesSpy.mockClear();

    const postRevisionResponse = await getApp().inject({
      method: 'GET',
      url: marketsUrl,
    });

    expect(postRevisionResponse.statusCode).toBe(200);
    expect(postRevisionResponse.json()).toEqual(response.json());
    expect(noRangeChartSeriesCalls()).toHaveLength(3);

    getCanonicalCloseSeriesSpy.mockClear();

    const optionsVariantResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&per_page=3&page=1&sparkline=false',
    });

    expect(optionsVariantResponse.statusCode).toBe(200);
    expect(optionsVariantResponse.json()).toHaveLength(3);
    expect(noRangeChartSeriesCalls()).toHaveLength(3);

    getApp().marketDataRuntimeState.hotDataRevision += 1;
    getCanonicalCloseSeriesSpy.mockClear();

    const uncompressedResponse = await getApp().inject({
      method: 'GET',
      url: marketsUrl,
      headers: {
        'accept-encoding': 'identity',
      },
    });

    expect(uncompressedResponse.statusCode).toBe(200);
    expect(noRangeChartSeriesCalls()).toHaveLength(3);

    getCanonicalCloseSeriesSpy.mockClear();

    const compressedCacheHitResponse = await getApp().inject({
      method: 'GET',
      url: marketsUrl,
      headers: {
        'accept-encoding': 'br',
      },
    });

    expect(compressedCacheHitResponse.statusCode).toBe(200);
    expect(compressedCacheHitResponse.headers['content-encoding']).toBe('br');
    expect(JSON.parse(brotliDecompressSync(compressedCacheHitResponse.rawPayload).toString('utf8'))).toEqual(uncompressedResponse.json());
    expect(noRangeChartSeriesCalls()).toHaveLength(0);
  });
  it('returns dual top movers payloads with stable polarity and explicit arrays', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('top_gainers');
    expect(body).toHaveProperty('top_losers');
    expect(Array.isArray(body.top_gainers)).toBe(true);
    expect(Array.isArray(body.top_losers)).toBe(true);
    expect(body.top_gainers.length).toBeGreaterThan(0);
    expect(body.top_losers).toEqual([]);
    expect(body.top_gainers[0].id).toBe('dogecoin');
    expect(body.top_gainers[0].symbol).toBe('doge');
    expect(body.top_gainers[0].name).toBe('Dogecoin');
    expect(body.top_gainers[0].current_price).toBe(0.28);
    expect(body.top_gainers[0].price_change_percentage_24h).toBe(5);
    expect(body.top_gainers[0].market_cap_rank === null || typeof body.top_gainers[0].market_cap_rank === 'number').toBe(true);
    expect(body.top_gainers.map((row: { price_change_percentage_24h: number | null }) => row.price_change_percentage_24h)).toEqual([5, 4, 3.5, 3, 2.56, 2, 1.8, 0.01]);
    expect(body.meta).toMatchObject({
      fixture: expect.any(Boolean),
      source: 'market_snapshots',
      snapshot_source: expect.stringMatching(/^(live|mixed|fixture|empty)$/),
      fallback: expect.any(Boolean),
      candidate_count: expect.any(Number),
      mover_count: body.top_gainers.length + body.top_losers.length,
      duration: '24h',
      price_change_percentage: expect.arrayContaining(['24h']),
    });
    expect(body.meta.fixture).toBe(body.meta.snapshot_source !== 'live');
    expect(body.meta.fallback).toBe(body.meta.fixture);
  });
  it('supports mover duration, tolerates trailing-empty mover windows, and validates invalid mover params explicitly', async () => {
    const validResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&duration=24h&top_coins=100&price_change_percentage=24h',
    });
    const trailingCommaResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&price_change_percentage=24h,',
    });
    const invalidPriceChangePercentageResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&price_change_percentage=24h,,7d',
    });
    const invalidDurationResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&duration=2h',
    });
    const invalidTopCoinsResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&top_coins=2',
    });
    const invalidCurrencyResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=notacurrency&duration=24h',
    });

    expect(validResponse.statusCode).toBe(200);
    expect(validResponse.json().top_gainers.length).toBeLessThanOrEqual(30);
    expect(validResponse.json().top_losers).toEqual([]);

    expect(trailingCommaResponse.statusCode).toBe(200);
    expect(trailingCommaResponse.json().top_gainers.length).toBeGreaterThan(0);
    expect(trailingCommaResponse.json().top_gainers[0]).toHaveProperty('price_change_percentage_24h');

    expect(invalidPriceChangePercentageResponse.statusCode).toBe(400);
    expect(invalidPriceChangePercentageResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'Unsupported price_change_percentage value: 24h,,7d',
    });

    expect(invalidDurationResponse.statusCode).toBe(400);
    expect(invalidDurationResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });

    expect(invalidTopCoinsResponse.statusCode).toBe(400);
    expect(invalidTopCoinsResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });

    expect(invalidCurrencyResponse.statusCode).toBe(400);
    expect(invalidCurrencyResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported vs_currency: notacurrency',
    });
  });
  it('returns new listings in an object envelope ordered newest first with listing timestamps', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/list/new',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('coins');
    expect(Array.isArray(body.coins)).toBe(true);
    expect(body.coins.length).toBe(9);
    expect(body.coins[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      symbol: expect.any(String),
      name: expect.any(String),
      activated_at: expect.any(Number),
    }));
    const activated = body.coins.map((row: { activated_at: number }) => row.activated_at);
    expect(activated.every((value: number) => Number.isFinite(value))).toBe(true);
    expect(activated).toEqual([...activated].sort((left, right) => right - left));
  });
  it('collapses duplicate exchange discoveries into one canonical listing using the earliest activation time', async () => {
    const mockedFetchExchangeMarkets = ccxtProvider.fetchExchangeMarkets as ReturnType<typeof vi.fn>;
    const activationStart = Date.now();

    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId: string) => {
      if (exchangeId === 'binance') {
        return [
          { exchangeId, symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
          { exchangeId, symbol: 'ZED/USDT', base: 'ZED', quote: 'USDT', active: true, spot: true, baseName: 'Zed Token', raw: {} },
        ];
      }

      return [
        { exchangeId, symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId, symbol: 'ZED/USDT', base: 'ZED', quote: 'USDT', active: true, spot: true, baseName: 'Zed Token', raw: {} },
      ];
    });

    const seededBeforeSync = getApp().db.db.select().from(coins).where(eq(coins.id, 'zed-token')).limit(1).get();
    expect(seededBeforeSync).toBeUndefined();

    await getApp().ready();

    const discovered = getApp().db.db.select().from(coins).where(eq(coins.id, 'zed-token')).limit(1).get();
    expect(discovered).toBeDefined();

    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/list/new',
    });

    expect(response.statusCode).toBe(200);
    const listings = response.json().coins as Array<{
      id: string;
      symbol: string;
      name: string;
      activated_at: number;
    }>;
    const zedListings = listings.filter((row) => row.id === 'zed-token');
    expect(zedListings).toHaveLength(1);
    expect(zedListings[0]).toMatchObject({
      id: 'zed-token',
      symbol: 'zed',
      name: 'Zed Token',
    });
    expect(zedListings[0]?.activated_at).toBe(Math.floor(discovered!.createdAt.getTime() / 1000));
    expect(discovered!.createdAt.getTime()).toBeGreaterThanOrEqual(activationStart);
  });
  it('supports coin market ordering and pagination defaults', async () => {
    const orderResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_asc',
    });
    const paginationResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&per_page=1&page=2',
    });

    expect(orderResponse.statusCode).toBe(200);
    expect(orderResponse.json()[0]).toMatchObject({
      id: 'chainlink',
    });

    expect(paginationResponse.statusCode).toBe(200);
    expect(paginationResponse.json()).toHaveLength(1);
    expect(paginationResponse.json()[0]).toMatchObject({
      id: 'ethereum',
    });
  });
  it('clamps oversized coin markets per_page requests to 250 without changing default page semantics', async () => {
    const [defaultPageResponse, clampedLargePerPageResponse, explicitPageOneResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&per_page=250',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&per_page=999&page=1',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&per_page=250&page=1',
      }),
    ]);

    expect(defaultPageResponse.statusCode).toBe(200);
    expect(clampedLargePerPageResponse.statusCode).toBe(200);
    expect(explicitPageOneResponse.statusCode).toBe(200);

    expect(defaultPageResponse.json()).toEqual(explicitPageOneResponse.json());
    expect(clampedLargePerPageResponse.json()).toEqual(explicitPageOneResponse.json());
    expect(clampedLargePerPageResponse.json().length).toBeLessThanOrEqual(250);
  });
  it('supports deterministic coin market volume ordering on the stabilized query path', async () => {
    const [volumeDescResponse, repeatedVolumeDescResponse, volumeAscResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=volume_desc&ids=bitcoin,ethereum,cardano,dogecoin',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=volume_desc&ids=bitcoin,ethereum,cardano,dogecoin',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=volume_asc&ids=bitcoin,ethereum,cardano,dogecoin',
      }),
    ]);

    expect(volumeDescResponse.statusCode).toBe(200);
    expect(repeatedVolumeDescResponse.statusCode).toBe(200);
    expect(volumeAscResponse.statusCode).toBe(200);

    expect(volumeDescResponse.json().map((row: { id: string }) => row.id)).toEqual([
      'bitcoin',
      'ethereum',
      'cardano',
      'dogecoin',
    ]);
    expect(repeatedVolumeDescResponse.json()).toEqual(volumeDescResponse.json());
    expect(volumeAscResponse.json().map((row: { id: string }) => row.id)).toEqual([
      'bitcoin',
      'ethereum',
      'cardano',
      'dogecoin',
    ]);
  });
});
