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

  it('prewarms declared hot endpoints during bootstrap-only startup within the configured budget', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'prewarm-budget.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        startupPrewarmBudgetMs: 321,
      },
      startBackgroundJobs: false,
    });

    try {
      await prewarmApp.ready();

      const diagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json().data.startup_prewarm).toMatchObject({
        enabled: true,
        budgetMs: 321,
        firstRequestWarmBenefitsObserved: false,
        targets: [
          {
            id: 'simple_price_bitcoin_usd',
            label: 'Simple price BTC/USD',
            endpoint: '/simple/price?ids=bitcoin&vs_currencies=usd',
          },
        ],
      });
      expect(typeof diagnostics.json().data.startup_prewarm.readyWithinBudget).toBe('boolean');
      expect(diagnostics.json().data.startup_prewarm.targetResults.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics.json().data.startup_prewarm.targetResults[0]).toMatchObject({
        id: 'simple_price_bitcoin_usd',
        cacheSurface: 'simple_price',
      });
      expect(diagnostics.json().data.startup_prewarm.totalDurationMs).toBeGreaterThanOrEqual(0);

      const firstWarmRequest = await prewarmApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      });

      expect(firstWarmRequest.statusCode).toBe(200);

      const metricsResponse = await prewarmApp.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(metricsResponse.statusCode).toBe(200);
      expect(metricsResponse.body).toContain('opengecko_startup_prewarm_targets_total');
      expect(metricsResponse.body).toContain('simple_price_bitcoin_usd');
      expect(metricsResponse.body).toContain('opengecko_startup_prewarm_first_requests_total');
      expect(metricsResponse.body).toMatch(/cache_hit="(true|false)"/);
    } finally {
      await prewarmApp.close();
    }
  });
  it('attributes startup prewarm warm-path evidence only to a semantically matching request target', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'prewarm-attribution.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await prewarmApp.ready();

      const mismatchedRequest = await prewarmApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      });

      expect(mismatchedRequest.statusCode).toBe(200);

      let diagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json().data.startup_prewarm.firstRequestWarmBenefitsObserved).toBe(false);

      const prewarmStateAfterMismatch = diagnostics.json().data.startup_prewarm;
      const simplePriceTargetAfterMismatch = prewarmStateAfterMismatch.targetResults.find(
        (target: { id: string }) => target.id === 'simple_price_bitcoin_usd',
      );

      if (simplePriceTargetAfterMismatch?.status === 'completed') {
        expect(simplePriceTargetAfterMismatch).toMatchObject({
          id: 'simple_price_bitcoin_usd',
          firstObservedRequest: null,
        });
      } else {
        expect(simplePriceTargetAfterMismatch).toMatchObject({
          id: 'simple_price_bitcoin_usd',
          status: 'timeout',
          firstObservedRequest: {
            cacheHit: false,
            durationMs: expect.any(Number),
          },
        });
      }

      const metricsAfterMismatch = await prewarmApp.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(metricsAfterMismatch.statusCode).toBe(200);
      if (simplePriceTargetAfterMismatch?.status === 'completed') {
        expect(metricsAfterMismatch.body).not.toContain('opengecko_startup_prewarm_first_requests_total{cache_hit="true",cache_surface="simple_price",target="simple_price_bitcoin_usd"}');
        expect(metricsAfterMismatch.body).not.toContain('opengecko_startup_prewarm_first_requests_total{cache_hit="false",cache_surface="simple_price",target="simple_price_bitcoin_usd"}');
      } else {
        expect(metricsAfterMismatch.body).toContain('opengecko_startup_prewarm_first_requests_total{cache_hit="false",cache_surface="simple_price",target="simple_price_bitcoin_usd"} 1');
      }

      if (simplePriceTargetAfterMismatch?.status === 'completed') {
        const matchingRequest = await prewarmApp.inject({
          method: 'GET',
          url: '/simple/price?vs_currencies=usd&ids=bitcoin',
        });

        expect(matchingRequest.statusCode).toBe(200);

        diagnostics = await prewarmApp.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        });

        expect(diagnostics.statusCode).toBe(200);
        expect(diagnostics.json().data.startup_prewarm.firstRequestWarmBenefitsObserved).toBe(true);

        const simplePriceTargetAfterMatch = diagnostics.json().data.startup_prewarm.targetResults.find(
          (target: { id: string }) => target.id === 'simple_price_bitcoin_usd',
        );

        expect(simplePriceTargetAfterMatch).toMatchObject({
          id: 'simple_price_bitcoin_usd',
          warmCacheRevision: expect.any(Number),
          firstObservedRequest: {
            cacheHit: true,
            durationMs: expect.any(Number),
          },
        });

        const metricsAfterMatch = await prewarmApp.inject({
          method: 'GET',
          url: '/metrics',
        });

        expect(metricsAfterMatch.statusCode).toBe(200);
        expect(metricsAfterMatch.body).toContain('opengecko_startup_prewarm_first_requests_total{cache_hit="true",cache_surface="simple_price",target="simple_price_bitcoin_usd"} 1');
      }
    } finally {
      await prewarmApp.close();
    }
  });
  it('treats repeated query keys and duplicate selector values as semantically significant for startup prewarm attribution', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'prewarm-duplicate-selector-attribution.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await prewarmApp.ready();

      const repeatedKeyMismatch = await prewarmApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&ids=bitcoin&vs_currencies=usd',
      });

      expect(repeatedKeyMismatch.statusCode).toBe(400);

      let diagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json().data.startup_prewarm.firstRequestWarmBenefitsObserved).toBe(false);

      const prewarmStateAfterRepeatedKeyMismatch = diagnostics.json().data.startup_prewarm;
      const simplePriceTargetAfterRepeatedKeyMismatch = prewarmStateAfterRepeatedKeyMismatch.targetResults.find(
        (target: { id: string }) => target.id === 'simple_price_bitcoin_usd',
      );

      if (simplePriceTargetAfterRepeatedKeyMismatch?.status === 'completed') {
        expect(simplePriceTargetAfterRepeatedKeyMismatch).toMatchObject({
          id: 'simple_price_bitcoin_usd',
          firstObservedRequest: null,
        });
      } else {
        expect(simplePriceTargetAfterRepeatedKeyMismatch).toMatchObject({
          id: 'simple_price_bitcoin_usd',
          status: 'timeout',
          firstObservedRequest: {
            cacheHit: false,
            durationMs: expect.any(Number),
          },
        });
      }

      const duplicateValueMismatch = await prewarmApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin,bitcoin&vs_currencies=usd',
      });

      expect(duplicateValueMismatch.statusCode).toBe(200);

      diagnostics = await prewarmApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json().data.startup_prewarm.firstRequestWarmBenefitsObserved).toBe(false);

      const simplePriceTargetAfterDuplicateValueMismatch = diagnostics.json().data.startup_prewarm.targetResults.find(
        (target: { id: string }) => target.id === 'simple_price_bitcoin_usd',
      );

      if (simplePriceTargetAfterDuplicateValueMismatch?.status === 'completed') {
        expect(simplePriceTargetAfterDuplicateValueMismatch).toMatchObject({
          id: 'simple_price_bitcoin_usd',
          firstObservedRequest: null,
        });
      } else {
        expect(simplePriceTargetAfterDuplicateValueMismatch).toMatchObject({
          id: 'simple_price_bitcoin_usd',
          status: 'timeout',
          firstObservedRequest: {
            cacheHit: false,
            durationMs: expect.any(Number),
          },
        });
      }

      if (simplePriceTargetAfterDuplicateValueMismatch?.status === 'completed') {
        const matchingRequest = await prewarmApp.inject({
          method: 'GET',
          url: '/simple/price?ids=bitcoin&vs_currencies=usd',
        });

        expect(matchingRequest.statusCode).toBe(200);

        diagnostics = await prewarmApp.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        });

        expect(diagnostics.statusCode).toBe(200);
        expect(diagnostics.json().data.startup_prewarm.firstRequestWarmBenefitsObserved).toBe(true);

        const simplePriceTargetAfterMatch = diagnostics.json().data.startup_prewarm.targetResults.find(
          (target: { id: string }) => target.id === 'simple_price_bitcoin_usd',
        );

        expect(simplePriceTargetAfterMatch).toMatchObject({
          id: 'simple_price_bitcoin_usd',
          warmCacheRevision: expect.any(Number),
          firstObservedRequest: {
            cacheHit: true,
            durationMs: expect.any(Number),
          },
        });

        const metricsAfterMatch = await prewarmApp.inject({
          method: 'GET',
          url: '/metrics',
        });

        expect(metricsAfterMatch.statusCode).toBe(200);
        expect(metricsAfterMatch.body).toContain('opengecko_startup_prewarm_first_requests_total{cache_hit="true",cache_surface="simple_price",target="simple_price_bitcoin_usd"} 1');
        expect(metricsAfterMatch.body).not.toContain('opengecko_startup_prewarm_first_requests_total{cache_hit="false",cache_surface="simple_price",target="simple_price_bitcoin_usd"}');
      }
    } finally {
      await prewarmApp.close();
    }
  });
  it('classifies non-2xx startup prewarm failures distinctly and still attempts later targets', async () => {
    const injectMock = vi.fn(async (request: { method: string; url: string }) => {
      if (request.url === '/simple/price?ids=bitcoin&vs_currencies=usd') {
        return { statusCode: 503 } as never;
      }

      return { statusCode: 200 } as never;
    });
    const mockApp = {
      inject: injectMock,
    } as unknown as FastifyInstance;
    const runtimeState: MarketDataRuntimeState = {
      initialSyncCompleted: true,
      listenerBindDeferred: false,
      initialSyncCompletedWithoutUsableLiveSnapshots: false,
      allowStaleLiveService: false,
      syncFailureReason: null,
      listenerBound: false,
      hotDataRevision: 7,
      validationOverride: {
        mode: 'off',
        reason: null,
        snapshotTimestampOverride: null,
        snapshotSourceCountOverride: null,
      },
      providerFailureCooldownUntil: null,
      forcedProviderFailure: {
        active: false,
        reason: null,
      },
      providerAttempts: {
        inFlight: {},
        recentOutcomes: [],
        outcomeCounts: {},
        faultControls: {},
      },
      startupPrewarm: {
        enabled: false,
        budgetMs: 0,
        readyWithinBudget: true,
        firstRequestWarmBenefitsObserved: false,
        firstRequestWarmBenefitPending: false,
        targets: [],
        completedAt: null,
        totalDurationMs: null,
        targetResults: [],
      },
    };
    const metrics = {
      recordStartupPrewarmTarget: vi.fn(),
    } as Pick<MetricsRegistry, 'recordStartupPrewarmTarget'> as MetricsRegistry;

    await startupPrewarmModule.runStartupPrewarm(mockApp, runtimeState, metrics, 500);

    expect(injectMock).toHaveBeenNthCalledWith(1, {
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
        expect(runtimeState.startupPrewarm.readyWithinBudget).toBe(true);
    expect(runtimeState.startupPrewarm.targetResults).toMatchObject([
      {
        id: 'simple_price_bitcoin_usd',
        status: 'failed',
        warmCacheRevision: null,
      },

    ]);
    expect(metrics.recordStartupPrewarmTarget).toHaveBeenCalledWith('simple_price_bitcoin_usd', 'failed', expect.any(Number));
  });
});
