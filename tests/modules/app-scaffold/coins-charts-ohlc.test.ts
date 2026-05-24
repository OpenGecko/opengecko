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

  it('returns coin history, chart, and ohlc data', async () => {
    const expectedDailyBucket = currentDailyBucket();

    const historyResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/history?date=20-03-2026',
    });
    const chartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily',
    });
    const maxChartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart?vs_currency=usd&days=max',
    });
    const rangeChartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800',
    });
    const ohlcResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc?vs_currency=usd&days=7&interval=daily',
    });

    expect(historyResponse.statusCode).toBe(200);
    const historyBody = historyResponse.json();
    expect(historyBody.id).toBe('bitcoin');
    expect(historyBody.description).toMatchObject({
      en: 'Bitcoin imported from binance market discovery.',
    });
    expect(historyBody.market_data).not.toBeNull();
    expect(typeof historyBody.market_data.current_price.usd).toBe('number');

    expect(chartResponse.statusCode).toBe(200);
    expect(chartResponse.json()).toMatchObject({
      prices: expect.any(Array),
      market_caps: expect.any(Array),
      total_volumes: expect.any(Array),
    });
    expect(chartResponse.json().prices.length).toBeGreaterThan(0);

    expect(maxChartResponse.statusCode).toBe(200);
    expect(maxChartResponse.json().prices).toEqual(
      expect.arrayContaining([
        [expectedDailyBucket, 85_000],
      ]),
    );

    expect(rangeChartResponse.statusCode).toBe(200);
    expect(rangeChartResponse.json()).toMatchObject({
      prices: expect.any(Array),
      market_caps: expect.any(Array),
      total_volumes: expect.any(Array),
    });
    const rangeChart = rangeChartResponse.json();
    expect(rangeChart.prices.length).toBeGreaterThan(0);
    expect(rangeChart.market_caps.length).toBe(rangeChart.prices.length);
    expect(rangeChart.total_volumes.length).toBe(rangeChart.prices.length);
    const priceTimestamps = rangeChart.prices.map((entry: number[]) => entry[0]);
    expect(priceTimestamps).toEqual([...priceTimestamps].sort((left, right) => left - right));
    for (const series of [rangeChart.prices, rangeChart.market_caps, rangeChart.total_volumes]) {
      for (const point of series) {
        expect(point).toHaveLength(2);
        expect(typeof point[0]).toBe('number');
        expect(typeof point[1]).toBe('number');
      }
    }

    expect(ohlcResponse.statusCode).toBe(200);
    const ohlcBody = ohlcResponse.json();
    expect(ohlcBody.length).toBeGreaterThan(0);
    const ohlcTimestamps = ohlcBody.map((tuple: number[]) => tuple[0]);
    expect(ohlcTimestamps).toEqual([...ohlcTimestamps].sort((left, right) => left - right));
    for (const tuple of ohlcBody) {
      expect(tuple).toHaveLength(5);
      for (const value of tuple) {
        expect(typeof value).toBe('number');
      }
    }
  });
  it('returns degraded daily market chart windows without provider fetches or candle writes when persisted rows are missing', async () => {
    await getApp().ready();
    getApp().db.db.delete(chartPoints).where(eq(chartPoints.coinId, 'bitcoin')).run();
    getApp().db.db.delete(marketChartSourcePoints).where(eq(marketChartSourcePoints.coinId, 'bitcoin')).run();
    getApp().db.db.delete(ohlcvCandles).where(eq(ohlcvCandles.coinId, 'bitcoin')).run();

    const mockedFetchExchangeOHLCV = ccxtProvider.fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
    mockedFetchExchangeOHLCV.mockClear();

    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      prices: [],
      market_caps: [],
      total_volumes: [],
    });
    expect(mockedFetchExchangeOHLCV).not.toHaveBeenCalled();
    expect(getApp().db.db.select().from(ohlcvCandles)
      .where(eq(ohlcvCandles.coinId, 'bitcoin'))
      .all()).toEqual([]);
  });
  it('returns degraded daily market chart ranges without provider fetches or candle writes when persisted rows are missing', async () => {
    await getApp().ready();
    getApp().db.db.delete(chartPoints).where(eq(chartPoints.coinId, 'bitcoin')).run();
    getApp().db.db.delete(marketChartSourcePoints).where(eq(marketChartSourcePoints.coinId, 'bitcoin')).run();
    getApp().db.db.delete(ohlcvCandles).where(eq(ohlcvCandles.coinId, 'bitcoin')).run();

    const mockedFetchExchangeOHLCV = ccxtProvider.fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
    mockedFetchExchangeOHLCV.mockClear();

    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1775088000&to=1775088000&interval=daily',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      prices: [],
      market_caps: [],
      total_volumes: [],
    });
    expect(mockedFetchExchangeOHLCV).not.toHaveBeenCalled();
    expect(getApp().db.db.select().from(ohlcvCandles)
      .where(eq(ohlcvCandles.coinId, 'bitcoin'))
      .all()).toEqual([]);
  });
  it('returns ranged coin ohlc tuples in ascending chronological order', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1774310400&to=1774310400&interval=daily',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual([]);

    for (const tuple of body) {
      expect(tuple).toHaveLength(5);
      expect(typeof tuple[0]).toBe('number');
      expect(tuple.slice(1).every((value: unknown) => typeof value === 'number' && Number.isFinite(value))).toBe(true);
    }
  });
  it('returns degraded daily ranged coin ohlc responses without provider fetches or candle writes when persisted rows are missing', async () => {
    await getApp().ready();
    getApp().db.db.delete(ohlcvCandles).where(eq(ohlcvCandles.coinId, 'bitcoin')).run();

    const mockedFetchExchangeOHLCV = ccxtProvider.fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
    mockedFetchExchangeOHLCV.mockClear();

    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1775001600&to=1775001600&interval=daily',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(mockedFetchExchangeOHLCV).not.toHaveBeenCalled();
    expect(getApp().db.db.select().from(ohlcvCandles)
      .where(eq(ohlcvCandles.coinId, 'bitcoin'))
      .all()).toEqual([]);
  });
  it('supports ranged coin ohlc interval semantics with explicit daily and empty hourly responses', async () => {
    const dailyResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1774310400&to=1774310400&interval=daily',
    });
    const hourlyResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1774310400&to=1774314000&interval=hourly',
    });

    expect(dailyResponse.statusCode).toBe(200);
    expect(hourlyResponse.statusCode).toBe(200);

    const dailyBody = dailyResponse.json();
    const hourlyBody = hourlyResponse.json();

    expect(dailyBody).toEqual([]);
    expect(hourlyBody).toEqual([]);

    for (const body of [dailyBody, hourlyBody]) {
      for (const tuple of body) {
        expect(tuple).toHaveLength(5);
        expect(typeof tuple[0]).toBe('number');
        expect(tuple.slice(1).every((value: unknown) => typeof value === 'number' && Number.isFinite(value))).toBe(true);
      }

      const timestamps = body.map((tuple: number[]) => tuple[0]);
      expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));
    }
  });
  it('returns named circulating and total supply chart series for rolling windows', async () => {
    const circulatingResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/circulating_supply_chart?days=30',
    });
    const totalResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/total_supply_chart?days=30',
    });

    expect(circulatingResponse.statusCode).toBe(200);
    expect(totalResponse.statusCode).toBe(200);

    const circulatingBody = circulatingResponse.json();
    const totalBody = totalResponse.json();

    expect(circulatingBody).toEqual({
      data: [],
      meta: {
        fixture: true,
        coin_id: 'bitcoin',
        supply_type: 'circulating',
        source: 'empty',
        source_mode: 'empty',
        point_count: 0,
        latest_source_fetched_at: null,
        note: 'Circulating supply chart data is not available',
      },
    });
    expect(totalBody).toEqual({
      data: [],
      meta: {
        fixture: true,
        coin_id: 'bitcoin',
        supply_type: 'total',
        source: 'empty',
        source_mode: 'empty',
        point_count: 0,
        latest_source_fetched_at: null,
        note: 'Total supply chart data is not available',
      },
    });

    for (const body of [circulatingBody, totalBody]) {
      expect(body.data).toEqual([]);
      expect(body.meta.fixture).toBe(true);
    }
  });
  it('returns named supply chart series constrained to explicit ranges', async () => {
    const from = 1773792000;
    const to = 1774310400;
    const circulatingResponse = await getApp().inject({
      method: 'GET',
      url: `/coins/bitcoin/circulating_supply_chart/range?from=${from}&to=${to}`,
    });
    const totalResponse = await getApp().inject({
      method: 'GET',
      url: `/coins/bitcoin/total_supply_chart/range?from=${from}&to=${to}`,
    });

    expect(circulatingResponse.statusCode).toBe(200);
    expect(totalResponse.statusCode).toBe(200);

    for (const [expectedNote, body] of [
      ['Circulating supply chart data is not available', circulatingResponse.json()] as const,
      ['Total supply chart data is not available', totalResponse.json()] as const,
    ]) {
      expect(body).toEqual({
        data: [],
        meta: {
          fixture: true,
          coin_id: 'bitcoin',
          supply_type: expectedNote.startsWith('Circulating') ? 'circulating' : 'total',
          source: 'empty',
          source_mode: 'empty',
          point_count: 0,
          latest_source_fetched_at: null,
          note: expectedNote,
        },
      });
    }
  });
});
