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

  it('uses the same seeded bootstrap runtime contract for default local hosts on port 3000', async () => {
    for (const host of ['0.0.0.0', '127.0.0.1']) {
      const bootstrapApp = buildApp({
        config: {
          databaseUrl: ':memory:',
          host,
          port: 3000,
          ccxtExchanges: [],
          logLevel: 'silent',
        },
        startBackgroundJobs: false,
      });

      try {
        await bootstrapApp.ready();

        expect(bootstrapApp.marketDataRuntimeState.validationOverride).toMatchObject({
          mode: 'off',
          reason: null,
        });
        expect(bootstrapApp.marketDataRuntimeState.listenerBindDeferred).toBe(false);

        const [simplePriceResponse, marketsResponse, detailResponse, diagnosticsResponse] = await Promise.all([
          bootstrapApp.inject({
            method: 'GET',
            url: '/simple/price?ids=bitcoin&vs_currencies=usd',
          }),
          bootstrapApp.inject({
            method: 'GET',
            url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
          }),
          bootstrapApp.inject({
            method: 'GET',
            url: '/coins/bitcoin?community_data=false&developer_data=false&localization=false&market_data=true&sparkline=false&tickers=false',
          }),
          bootstrapApp.inject({
            method: 'GET',
            url: '/diagnostics/runtime',
          }),
        ]);

        expect(simplePriceResponse.statusCode).toBe(200);
        expect(marketsResponse.statusCode).toBe(200);
        expect(detailResponse.statusCode).toBe(200);
        expect(diagnosticsResponse.statusCode).toBe(200);
      } finally {
        await bootstrapApp.close();
      }
    }
  });
  it('preserves seeded bootstrap runtime semantics after listener-bound transition for a live local host override on port 3000', async () => {
    const liveHostOverrideApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        host: '127.0.0.1',
        port: 3000,
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await liveHostOverrideApp.ready();
      liveHostOverrideApp.marketRuntime?.markListenerBound();
      liveHostOverrideApp.marketDataRuntimeState.listenerBound = true;

      expect(liveHostOverrideApp.marketDataRuntimeState.validationOverride).toMatchObject({
        mode: 'off',
        reason: null,
      });

      const [diagnosticsResponse, simplePriceResponse, marketsResponse, detailResponse] = await Promise.all([
        liveHostOverrideApp.inject({ method: 'GET', url: '/diagnostics/runtime' }),
        liveHostOverrideApp.inject({ method: 'GET', url: '/simple/price?ids=bitcoin&vs_currencies=usd' }),
        liveHostOverrideApp.inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false' }),
        liveHostOverrideApp.inject({ method: 'GET', url: '/coins/bitcoin?community_data=false&developer_data=false&localization=false&market_data=true&sparkline=false&tickers=false' }),
      ]);

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json()).toMatchObject({
        data: {
          readiness: {
            state: 'degraded',
            initial_sync_completed: true,
            listener_bound: true,
          },
          degraded: {
            active: true,
            stale_live_enabled: true,
            reason: null,
            validation_override: {
              active: false,
              mode: 'off',
              reason: null,
            },
          },
          hot_paths: {
            shared_market_snapshot: {
              source_class: 'stale_live',
              provider_count: expect.any(Number),
            },
          },
        },
      });

      expect(simplePriceResponse.statusCode).toBe(200);
      expect(simplePriceResponse.json()).toMatchObject({
        bitcoin: {
          usd: expect.any(Number),
        },
      });

      expect(marketsResponse.statusCode).toBe(200);
      expect(marketsResponse.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'bitcoin',
            current_price: expect.any(Number),
            market_cap: expect.any(Number),
            total_volume: expect.any(Number),
            last_updated: expect.any(String),
          }),
        ]),
      );

      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json()).toMatchObject({
        id: 'bitcoin',
        market_data: {
          current_price: {
            usd: expect.any(Number),
          },
          market_cap: {
            usd: null,
          },
          total_volume: {
            usd: expect.any(Number),
          },
          last_updated: expect.any(String),
        },
      });
    } finally {
      await liveHostOverrideApp.close();
    }
  });
  it('fails startup with a targeted initial sync timeout message before Fastify hook timeout masking', async () => {
    const bootstrapApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'startup-timeout.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
      pluginTimeout: 50,
      startupPluginTimeout: 10,
    });

    const originalReady = bootstrapApp.ready.bind(bootstrapApp);
    bootstrapApp.ready = () => originalReady();

    const initialSyncModule = await import('../../../src/services/initial-sync');
    const runInitialMarketSyncSpy = vi.spyOn(initialSyncModule, 'runInitialMarketSync')
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          coinsDiscovered: 0,
          chainsDiscovered: 0,
          snapshotsCreated: 0,
          tickersWritten: 0,
          exchangesSynced: 0,
          ohlcvCandlesWritten: 0,
        };
      });

    await expect(bootstrapApp.ready()).rejects.toThrow(/Startup initial sync exceeded 10ms before listener bind|A callback for 'onReady' hook timed out/);

    runInitialMarketSyncSpy.mockRestore();
    await bootstrapApp.close();
  });
  it('does not enforce the initial sync timeout on the background-runtime startup path', async () => {
    const initialSyncModule = await import('../../../src/services/initial-sync');
    const runInitialMarketSyncSpy = vi.spyOn(initialSyncModule, 'runInitialMarketSync')
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          coinsDiscovered: 0,
          chainsDiscovered: 0,
          snapshotsCreated: 0,
          tickersWritten: 0,
          exchangesSynced: 0,
          ohlcvCandlesWritten: 0,
        };
      });

    const bootstrapApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: true,
      pluginTimeout: 0,
    });

    await expect(bootstrapApp.ready()).resolves.toBe(bootstrapApp);

    runInitialMarketSyncSpy.mockRestore();
    await bootstrapApp.close();
  });
  it('binds the listener before background startup sync settles on the shared runtime path', async () => {
    const initialSyncModule = await import('../../../src/services/initial-sync');
    let releaseInitialSync!: () => void;
    const runInitialMarketSyncSpy = vi.spyOn(initialSyncModule, 'runInitialMarketSync')
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          releaseInitialSync = resolve;
        });
        return {
          coinsDiscovered: 0,
          chainsDiscovered: 0,
          snapshotsCreated: 0,
          tickersWritten: 0,
          exchangesSynced: 0,
          ohlcvCandlesWritten: 0,
        };
      });

    const bootstrapApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 0,
      },
      startBackgroundJobs: true,
      pluginTimeout: 0,
    });

    try {
      const listenPromise = bootstrapApp.listen({ host: '127.0.0.1', port: 0 });
      const address = await listenPromise;

      expect(typeof address).toBe('string');
      expect(runInitialMarketSyncSpy).toHaveBeenCalledTimes(1);
      expect(bootstrapApp.marketDataRuntimeState.listenerBound).toBe(true);
      expect(bootstrapApp.marketDataRuntimeState.initialSyncCompleted).toBe(false);
      expect(bootstrapApp.marketDataRuntimeState.listenerBindDeferred).toBe(false);

      const pingResponse = await bootstrapApp.inject({
        method: 'GET',
        url: '/ping',
      });
      expect(pingResponse.statusCode).toBe(200);

      const diagnosticsBeforeReady = await bootstrapApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });
      expect(diagnosticsBeforeReady.statusCode).toBe(200);
      expect(diagnosticsBeforeReady.json().data.readiness).toMatchObject({
        state: 'starting',
        listener_bound: true,
        listener_bind_deferred: false,
        initial_sync_completed: false,
      });

      releaseInitialSync();
      await bootstrapApp.marketRuntime?.whenReady();

      const diagnosticsAfterReady = await bootstrapApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });
      expect(diagnosticsAfterReady.statusCode).toBe(200);
      expect(diagnosticsAfterReady.json().data.readiness).toMatchObject({
        state: 'ready',
        listener_bound: true,
        initial_sync_completed: true,
      });
    } finally {
      releaseInitialSync?.();
      runInitialMarketSyncSpy.mockRestore();
      await bootstrapApp.marketRuntime?.whenReady().catch(() => undefined);
      await bootstrapApp.close();
    }
  });
  it('starts the validation diagnostics scheduler after listener binding and ticks no-op jobs', async () => {
    const bootstrapApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3102,
        marketRefreshIntervalSeconds: 1,
        searchRebuildIntervalSeconds: 1,
        currencyRefreshIntervalSeconds: 1,
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
      exposeSchedulerDiagnostics: true,
      pluginTimeout: 0,
    });

    try {
      await bootstrapApp.listen({ host: '127.0.0.1', port: 0 });

      const initialDiagnostics = await bootstrapApp.inject({
        method: 'GET',
        url: '/diagnostics/jobs',
      });
      expect(initialDiagnostics.statusCode).toBe(200);
      expect(initialDiagnostics.json().data.scheduler).toMatchObject({
        enabled: true,
        started: true,
        job_count: 15,
      });

      await expect.poll(async () => {
        const response = await bootstrapApp.inject({
          method: 'GET',
          url: '/diagnostics/jobs',
        });
        const marketJob = response.json().data.jobs.find((job: { name: string }) => job.name === 'market-refresh');
        return marketJob?.run_count ?? 0;
      }, { interval: 100, timeout: 2500 }).toBeGreaterThanOrEqual(1);

      const populatedDiagnostics = await bootstrapApp.inject({
        method: 'GET',
        url: '/diagnostics/jobs',
      });
      const marketJob = populatedDiagnostics.json().data.jobs.find((job: { name: string }) => job.name === 'market-refresh');
      expect(marketJob).toMatchObject({
        disabled: false,
        run_count: expect.any(Number),
        success_count: expect.any(Number),
        last_duration_ms: expect.any(Number),
        last_error: null,
        error_count: 0,
      });
      expect(marketJob.run_count).toBeGreaterThanOrEqual(1);
      expect(marketJob.success_count).toBeGreaterThanOrEqual(1);
      expect(marketJob.last_run_at).toEqual(expect.stringMatching(/^20\d{2}-\d{2}-\d{2}T.*Z$/));
      expect(marketJob.last_success_at).toEqual(expect.stringMatching(/^20\d{2}-\d{2}-\d{2}T.*Z$/));
    } finally {
      await bootstrapApp.close();
    }
  });
  it('keeps market-refresh observable but unticked when validation diagnostics disable that job', async () => {
    const bootstrapApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3102,
        marketRefreshIntervalSeconds: 1,
        searchRebuildIntervalSeconds: 1,
        currencyRefreshIntervalSeconds: 1,
        disableRemoteCurrencyRefresh: true,
        marketRefreshDisabled: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
      exposeSchedulerDiagnostics: true,
      pluginTimeout: 0,
    });

    try {
      await bootstrapApp.listen({ host: '127.0.0.1', port: 0 });

      await expect.poll(async () => {
        const response = await bootstrapApp.inject({
          method: 'GET',
          url: '/diagnostics/jobs',
        });
        const searchJob = response.json().data.jobs.find((job: { name: string }) => job.name === 'search-rebuild');
        return searchJob?.run_count ?? 0;
      }, { interval: 100, timeout: 2500 }).toBeGreaterThanOrEqual(1);

      const diagnostics = await bootstrapApp.inject({
        method: 'GET',
        url: '/diagnostics/jobs',
      });
      expect(diagnostics.json().data.scheduler).toMatchObject({
        enabled: true,
        started: true,
      });
      const marketJob = diagnostics.json().data.jobs.find((job: { name: string }) => job.name === 'market-refresh');
      expect(marketJob).toMatchObject({
        disabled: true,
        run_count: 0,
        success_count: 0,
        last_run_at: null,
        last_success_at: null,
        last_duration_ms: null,
        last_error: null,
      });
    } finally {
      await bootstrapApp.close();
    }
  });
  it('keeps the validation diagnostics scheduler stopped when the scheduler is globally disabled', async () => {
    const bootstrapApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3102,
        marketRefreshIntervalSeconds: 1,
        searchRebuildIntervalSeconds: 1,
        currencyRefreshIntervalSeconds: 1,
        disableRemoteCurrencyRefresh: true,
        schedulerDisabled: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
      exposeSchedulerDiagnostics: true,
      pluginTimeout: 0,
    });

    try {
      await bootstrapApp.listen({ host: '127.0.0.1', port: 0 });
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const diagnostics = await bootstrapApp.inject({
        method: 'GET',
        url: '/diagnostics/jobs',
      });
      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json().data.scheduler).toMatchObject({
        enabled: false,
        started: false,
        job_count: 15,
      });
      for (const job of diagnostics.json().data.jobs) {
        expect(job).toMatchObject({
          disabled: true,
          run_count: 0,
          success_count: 0,
          last_run_at: null,
          last_success_at: null,
        });
      }
    } finally {
      await bootstrapApp.close();
    }
  });
  it('allows background-runtime startup when fastify plugin timeout is disabled', async () => {
    const initialSyncModule = await import('../../../src/services/initial-sync');
    const runInitialMarketSyncSpy = vi.spyOn(initialSyncModule, 'runInitialMarketSync')
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          coinsDiscovered: 0,
          chainsDiscovered: 0,
          snapshotsCreated: 0,
          tickersWritten: 0,
          exchangesSynced: 0,
          ohlcvCandlesWritten: 0,
        };
      });

    const bootstrapApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: true,
      pluginTimeout: 0,
    });

    await expect(bootstrapApp.ready()).resolves.toBe(bootstrapApp);

    runInitialMarketSyncSpy.mockRestore();
    await bootstrapApp.close();
  });
  it('passes pluginTimeout=0 through to Fastify config', () => {
    const bootstrapApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      pluginTimeout: 0,
    });

    expect(bootstrapApp.initialConfig.pluginTimeout).toBe(0);

    void bootstrapApp.close();
  });
  it('emits the final listener-ready line after background startup completes', async () => {
    const writes: string[] = [];
    const startupProgressModule = await import('../../../src/services/startup-progress');
    const tracker = startupProgressModule.createStartupProgressTracker({
      write: (value: string) => {
        writes.push(value);
      },
    });

    const bootstrapApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 0,
      },
      startBackgroundJobs: true,
      pluginTimeout: 0,
      startupProgress: tracker,
    });

    tracker.start({ runtime: 'node', driver: 'better-sqlite3', databaseUrl: ':memory:' });
    tracker.complete('load_config');

    await bootstrapApp.ready();
    const port = 3000;
    bootstrapApp.marketRuntime?.markListenerBound();
    tracker.complete('start_http_listener');
    tracker.finish(port);

    expect(writes.join('')).toContain(`System ready. Listening on http://localhost:${port}`);

    await bootstrapApp.close();
  });
});
