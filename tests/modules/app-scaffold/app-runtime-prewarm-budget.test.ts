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

  it('warms the simple-price startup target directly without self-injecting that endpoint', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'prewarm-direct-simple-price.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        startupPrewarmBudgetMs: 250,
      },
      startBackgroundJobs: false,
    });

    const injectSpy = vi.spyOn(prewarmApp, 'inject');

    try {
      await prewarmApp.ready();

      const simplePriceInjectCalls = injectSpy.mock.calls.filter((call) => {
        const request = (call as unknown[])[0] as string | { url?: string } | undefined;
        if (typeof request === 'string') {
          return request.includes('/simple/price');
        }

        return request?.url === '/simple/price?ids=bitcoin&vs_currencies=usd';
      });
      const coinsMarketsInjectCalls = injectSpy.mock.calls.filter((call) => {
        const request = (call as unknown[])[0] as string | { url?: string } | undefined;
        if (typeof request === 'string') {
          return request.includes('/coins/markets');
        }

        return request?.url === '/coins/markets?vs_currency=usd&ids=bitcoin';
      });

      expect(simplePriceInjectCalls).toHaveLength(0);
      expect(coinsMarketsInjectCalls).toHaveLength(0);

      const diagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json().data.startup_prewarm.enabled).toBe(true);
      expect(diagnostics.json().data.startup_prewarm.targetResults[0]).toMatchObject({
        id: 'simple_price_bitcoin_usd',
        status: 'completed',
        cacheSurface: 'simple_price',
        warmCacheRevision: expect.any(Number),
      });

      const firstWarmRequest = await prewarmApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      });

      expect(firstWarmRequest.statusCode).toBe(200);

      const updatedDiagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(updatedDiagnostics.statusCode).toBe(200);
      expect(updatedDiagnostics.json().data.startup_prewarm.firstRequestWarmBenefitsObserved).toBe(true);
      expect(updatedDiagnostics.json().data.startup_prewarm.targetResults[0]).toMatchObject({
        id: 'simple_price_bitcoin_usd',
        firstObservedRequest: {
          cacheHit: true,
          durationMs: expect.any(Number),
        },
      });
      expect(updatedDiagnostics.json().data.startup_prewarm.targetResults[0].warmCacheRevision)
        .toBe(updatedDiagnostics.json().data.hot_paths.cache_revision);
    } finally {
      injectSpy.mockRestore();
      await prewarmApp.close();
    }
  });
  it('preserves the first startup prewarm warm-hit observation across the deferred post-bind refresh revision bump', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'prewarm-first-hit-revision-window.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        startupPrewarmBudgetMs: 250,
        marketRefreshIntervalSeconds: 3600,
        currencyRefreshIntervalSeconds: 3600,
        searchRebuildIntervalSeconds: 3600,
      },
      startBackgroundJobs: true,
    });

    try {
      await prewarmApp.ready();

      const beforeRequestDiagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(beforeRequestDiagnostics.statusCode).toBe(200);
      expect(beforeRequestDiagnostics.json().data.readiness.listener_bind_deferred).toBe(true);
      expect(beforeRequestDiagnostics.json().data.startup_prewarm.targetResults).toEqual([]);
      expect(beforeRequestDiagnostics.json().data.startup_prewarm.firstRequestWarmBenefitPending).toBe(false);

      prewarmApp.marketRuntime?.markListenerBound();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const afterBindDiagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(afterBindDiagnostics.statusCode).toBe(200);
      expect(afterBindDiagnostics.json().data.readiness.listener_bind_deferred).toBe(false);
      expect(afterBindDiagnostics.json().data.startup_prewarm.firstRequestWarmBenefitPending).toBe(true);
      expect(afterBindDiagnostics.json().data.startup_prewarm.targetResults[0]).toMatchObject({
        id: 'simple_price_bitcoin_usd',
        status: 'completed',
        warmCacheRevision: expect.any(Number),
        firstObservedRequest: null,
      });

      const firstWarmRequest = await prewarmApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      });

      expect(firstWarmRequest.statusCode).toBe(200);

      const afterRequestDiagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(afterRequestDiagnostics.statusCode).toBe(200);
      expect(afterRequestDiagnostics.json().data.startup_prewarm.firstRequestWarmBenefitsObserved).toBe(true);
      expect(afterRequestDiagnostics.json().data.startup_prewarm.firstRequestWarmBenefitPending).toBe(false);
      expect(afterRequestDiagnostics.json().data.startup_prewarm.targetResults[0]).toMatchObject({
        id: 'simple_price_bitcoin_usd',
        firstObservedRequest: {
          cacheHit: true,
          durationMs: expect.any(Number),
        },
      });

      const metricsResponse = await prewarmApp.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(metricsResponse.statusCode).toBe(200);
      expect(metricsResponse.body).toContain('opengecko_startup_prewarm_first_requests_total{cache_hit="true",cache_surface="simple_price",target="simple_price_bitcoin_usd"} 1');
    } finally {
      await prewarmApp.close();
    }
  });
  it('skips trailing startup prewarm targets once an earlier target has exhausted the remaining budget', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'prewarm-direct-timeout.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    const injectMock = vi.fn(async (request: { method: string; url: string }) => {
      if (request.url === '/coins/markets?vs_currency=usd&ids=bitcoin') {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }

      return { statusCode: 200 } as never;
    });

    try {
      prewarmApp.inject = injectMock as never;
      await startupPrewarmModule.runStartupPrewarm(prewarmApp, prewarmApp.marketDataRuntimeState, prewarmApp.metrics, 5);

      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.readyWithinBudget).toBe(true);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.totalDurationMs).toBeLessThanOrEqual(5);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.targetResults[0]).toMatchObject({
        id: 'simple_price_bitcoin_usd',
        status: 'completed',
        warmCacheRevision: 0,
      });
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.targetResults).toHaveLength(1);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.firstRequestWarmBenefitPending).toBe(true);
      expect(injectMock).toHaveBeenCalledTimes(0);
    } finally {
      await prewarmApp.close();
    }
  });
  it('clamps startup prewarm readiness timing to the configured budget when a trailing target times out after it has started', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'prewarm-budget-clamp.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    const dateNowSpy = vi.spyOn(Date, 'now');
    let currentNow = 0;
    dateNowSpy.mockImplementation(() => currentNow);
    const injectMock = vi.fn(async () => {
      currentNow = 260;
      return { statusCode: 200 } as never;
    });

    try {
      prewarmApp.inject = injectMock as never;
      await startupPrewarmModule.runStartupPrewarm(prewarmApp, prewarmApp.marketDataRuntimeState, prewarmApp.metrics, 250);

      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.readyWithinBudget).toBe(true);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.totalDurationMs).toBe(0);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.targetResults).toMatchObject([
        {
          id: 'simple_price_bitcoin_usd',
          status: 'completed',
          warmCacheRevision: 0,
        },
      ]);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.firstRequestWarmBenefitPending).toBe(true);
      expect(injectMock).toHaveBeenCalledTimes(0);
    } finally {
      dateNowSpy.mockRestore();
      await prewarmApp.close();
    }
  });
  it('skips later startup prewarm targets at the budget boundary without failing readiness when an earlier target completed in budget', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'prewarm-budget-boundary.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    const dateNowSpy = vi.spyOn(Date, 'now');
    const nowValues = [
      0, // startedAt
      0, // elapsed before simple_price
      0, // targetStartedAt simple_price
      100, // prewarm started at direct simple price
      150, // totalDuration simple price
      250, // durationMs simple_price
      250, // elapsed before coins_markets -> no remaining budget
      250, // completedAt
    ];
    let fallbackNow = 250;
    dateNowSpy.mockImplementation(() => {
      const value = nowValues.shift();
      if (value !== undefined) {
        fallbackNow = value;
        return value;
      }

      return fallbackNow;
    });

    const injectSpy = vi.spyOn(prewarmApp, 'inject');

    try {
      await startupPrewarmModule.runStartupPrewarm(prewarmApp, prewarmApp.marketDataRuntimeState, prewarmApp.metrics, 250);

      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.readyWithinBudget).toBe(true);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.totalDurationMs).toBe(250);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.targetResults).toMatchObject([
        {
          id: 'simple_price_bitcoin_usd',
          status: 'completed',
          warmCacheRevision: 0,
        },
      ]);
      expect(injectSpy).not.toHaveBeenCalled();
    } finally {
      injectSpy.mockRestore();
      dateNowSpy.mockRestore();
      await prewarmApp.close();
    }
  });
  it('records failed prewarm outcomes on diagnostics and metrics surfaces without misclassifying them as timeouts', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'prewarm-failure-classification.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    const prewarmSpy = vi.spyOn(startupPrewarmModule, 'runStartupPrewarm').mockImplementation(async (_app, runtimeState, metrics) => {
      runtimeState.startupPrewarm = {
        enabled: true,
        budgetMs: 500,
        readyWithinBudget: true,
        firstRequestWarmBenefitsObserved: false,
        firstRequestWarmBenefitPending: false,
        targets: [
          {
            id: 'simple_price_bitcoin_usd',
            label: 'Simple price BTC/USD',
            endpoint: '/simple/price?ids=bitcoin&vs_currencies=usd',
          },
        ],
        completedAt: Date.now(),
        totalDurationMs: 12,
        targetResults: [
          {
            id: 'simple_price_bitcoin_usd',
            label: 'Simple price BTC/USD',
            endpoint: '/simple/price?ids=bitcoin&vs_currencies=usd',
            status: 'failed',
            durationMs: 5,
            cacheSurface: 'simple_price',
            warmCacheRevision: null,
            firstObservedRequest: null,
          },

        ],
      };
      metrics.recordStartupPrewarmTarget('simple_price_bitcoin_usd', 'failed', 5);
    });

    try {
      await prewarmApp.ready();

      const diagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnostics.statusCode).toBe(200);
      const prewarm = diagnostics.json().data.startup_prewarm;
      expect(prewarm.readyWithinBudget).toBe(true);
      expect(prewarm.targetResults).toHaveLength(1);
      expect(prewarm.targetResults[0]).toMatchObject({
        id: 'simple_price_bitcoin_usd',
        status: 'failed',
        warmCacheRevision: null,
      });

      const metricsResponse = await prewarmApp.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(metricsResponse.statusCode).toBe(200);
      expect(metricsResponse.body).toContain('opengecko_startup_prewarm_targets_total{outcome="failed",target="simple_price_bitcoin_usd"} 1');
      expect(metricsResponse.body).not.toContain('opengecko_startup_prewarm_targets_total{outcome="timeout",target="simple_price_bitcoin_usd"}');
    } finally {
      prewarmSpy.mockRestore();
      await prewarmApp.close();
    }
  });
  it('exposes scrapeable metrics that change after hot-path traffic', async () => {
    const beforeResponse = await getApp().inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(beforeResponse.statusCode).toBe(200);
    expect(beforeResponse.headers['content-type']).toContain('text/plain');
    const beforeBody = beforeResponse.body;
    expect(beforeBody).toContain('opengecko_startup_prewarm_targets_total');
    expect(beforeBody).toContain('simple_price_bitcoin_usd');
    expect(beforeBody).not.toContain('opengecko_http_requests_total{method="GET",route="/simple/price",status_code="200"} 2');

    await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    await getApp().inject({
      method: 'GET',
      url: '/simple/price?vs_currencies=usd&ids=bitcoin',
    });
    await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&per_page=2&page=1',
    });
    await getApp().inject({
      method: 'GET',
      url: '/coins/markets?per_page=2&page=1&vs_currency=usd',
    });

    const afterResponse = await getApp().inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(afterResponse.statusCode).toBe(200);
    const afterBody = afterResponse.body;
    expect(afterBody).toContain('opengecko_cache_events_total');
    expect(afterBody).toContain('surface="simple_price"');
    expect(afterBody).toContain('surface="coins_markets"');
    expect(afterBody).toContain('opengecko_http_requests_total{method="GET",route="/simple/price",status_code="200"} 2');
    expect(afterBody).toContain('opengecko_http_requests_total{method="GET",route="/coins/markets",status_code="200"} 2');
    expect(afterBody).toContain('opengecko_http_request_duration_ms_count{method="GET",route="/simple/price",status_code="200"} 2');
    expect(afterBody).not.toEqual(beforeBody);
  });
});
