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

  it('clears stale-live recovery flags and bumps revision when bootstrap-only sync recovers stale-visible state', async () => {
    await getApp().close();
    app = undefined;

    const bootstrapApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'bootstrap-recovery.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    app = bootstrapApp;

    const state = getApp().marketDataRuntimeState;
    state.allowStaleLiveService = true;
    state.syncFailureReason = 'upstream timeout';
    state.hotDataRevision = 3;

    await getApp().ready();

    expect(state.initialSyncCompleted).toBe(true);
    expect(state.allowStaleLiveService).toBe(false);
    expect(state.syncFailureReason).toBeNull();
    expect(state.hotDataRevision).toBe(4);
  });
  it('keeps shared assets coherent across simple price and coins markets when stale-live policy flips', async () => {
    const state = getApp().marketDataRuntimeState;
    const { createDatabase } = await import('../../../src/db/client');
    const { marketSnapshots } = await import('../../../src/db/schema');
    const db = createDatabase(join(tempDir, 'test.db'));

    const healthySimple = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const healthyMarkets = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(healthySimple.statusCode).toBe(200);
    expect(healthyMarkets.statusCode).toBe(200);
    expect(healthySimple.json()).toEqual({
      bitcoin: {
        usd: healthyMarkets.json()[0].current_price,
      },
    });

    db.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    state.allowStaleLiveService = true;
    state.hotDataRevision += 1;

    const staleAllowedSimple = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const staleAllowedMarkets = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(staleAllowedSimple.statusCode).toBe(200);
    expect(staleAllowedMarkets.statusCode).toBe(200);
    expect(staleAllowedSimple.json()).toEqual({
      bitcoin: {
        usd: staleAllowedMarkets.json()[0].current_price,
      },
    });

    state.allowStaleLiveService = false;
    state.hotDataRevision += 1;

    const staleDisallowedSimple = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const staleDisallowedMarkets = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(staleDisallowedSimple.statusCode).toBe(200);
    expect(staleDisallowedSimple.json()).toEqual({});
    expect(staleDisallowedMarkets.statusCode).toBe(200);
    expect(staleDisallowedMarkets.json()).toEqual([
      expect.objectContaining({
        id: 'bitcoin',
        current_price: null,
        market_cap: null,
        total_volume: null,
        last_updated: null,
      }),
    ]);
  });
  it('keeps the full trust slice coherent across stale-live transitions, cache revisions, and timestamps', async () => {
    const state = getApp().marketDataRuntimeState;
    const { createDatabase } = await import('../../../src/db/client');
    const { marketSnapshots } = await import('../../../src/db/schema');
    const db = createDatabase(join(tempDir, 'test.db'));

    const [healthyDiagnostics, healthySimple, healthyMarkets, healthyDetail] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      }),
      getApp().inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/bitcoin?tickers=false&community_data=false&developer_data=false&localization=false',
      }),
    ]);

    expect(healthyDiagnostics.statusCode).toBe(200);
    expect(healthySimple.statusCode).toBe(200);
    expect(healthyMarkets.statusCode).toBe(200);
    expect(healthyDetail.statusCode).toBe(200);
    expect(healthyDiagnostics.json().data.hot_paths.shared_market_snapshot.source_class).toBe('fresh_live');
    expect(healthySimple.json().bitcoin.usd).toBe(healthyMarkets.json()[0].current_price);
    expect(healthySimple.json().bitcoin.usd).toBe(healthyDetail.json().market_data.current_price.usd);
    expect(healthySimple.json().bitcoin.last_updated_at).toBe(
      Math.floor(Date.parse(healthyMarkets.json()[0].last_updated) / 1000),
    );
    expect(healthyMarkets.json()[0].last_updated).toBe(healthyDetail.json().market_data.last_updated);

    db.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    state.initialSyncCompleted = true;
    state.allowStaleLiveService = true;
    state.syncFailureReason = 'upstream timeout';
    state.hotDataRevision += 1;
    const staleAllowedRevision = state.hotDataRevision;

    const [staleAllowedDiagnostics, staleAllowedSimple, staleAllowedMarkets, staleAllowedDetail] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      }),
      getApp().inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/bitcoin?tickers=false&community_data=false&developer_data=false&localization=false',
      }),
    ]);

    expect(staleAllowedDiagnostics.statusCode).toBe(200);
    expect(staleAllowedSimple.statusCode).toBe(200);
    expect(staleAllowedMarkets.statusCode).toBe(200);
    expect(staleAllowedDetail.statusCode).toBe(200);
    expect(staleAllowedDiagnostics.json().data.degraded).toMatchObject({
      active: true,
      stale_live_enabled: true,
      reason: 'upstream timeout',
    });
    expect(staleAllowedDiagnostics.json().data.hot_paths.cache_revision).toBe(staleAllowedRevision);
    expect(staleAllowedSimple.json().bitcoin.usd).toBe(staleAllowedMarkets.json()[0].current_price);
    expect(staleAllowedSimple.json().bitcoin.usd).toBe(staleAllowedDetail.json().market_data.current_price.usd);
    expect(staleAllowedSimple.json().bitcoin.last_updated_at).toBe(
      Math.floor(Date.parse(staleAllowedMarkets.json()[0].last_updated) / 1000),
    );
    expect(staleAllowedMarkets.json()[0].last_updated).toBe(staleAllowedDetail.json().market_data.last_updated);
    expect(new Date(staleAllowedDiagnostics.json().data.hot_paths.shared_market_snapshot.last_successful_live_refresh_at).getTime())
      .toBeGreaterThanOrEqual(Date.parse(staleAllowedMarkets.json()[0].last_updated));

    state.allowStaleLiveService = false;
    state.hotDataRevision += 1;
    const staleDisallowedRevision = state.hotDataRevision;

    const [staleDisallowedDiagnostics, staleDisallowedSimple, staleDisallowedMarkets, staleDisallowedDetail] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      }),
      getApp().inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/bitcoin?tickers=false&community_data=false&developer_data=false&localization=false',
      }),
    ]);

    expect(staleDisallowedDiagnostics.statusCode).toBe(200);
    expect(staleDisallowedSimple.statusCode).toBe(200);
    expect(staleDisallowedMarkets.statusCode).toBe(200);
    expect(staleDisallowedDetail.statusCode).toBe(200);
    expect(staleDisallowedDiagnostics.json().data.degraded).toMatchObject({
      active: false,
      stale_live_enabled: false,
      reason: 'upstream timeout',
    });
    expect(staleDisallowedDiagnostics.json().data.hot_paths.cache_revision).toBe(staleDisallowedRevision);
    expect(staleDisallowedSimple.json()).toEqual({});
    expect(staleDisallowedMarkets.json()).toEqual([
      expect.objectContaining({
        id: 'bitcoin',
        current_price: null,
        market_cap: null,
        total_volume: null,
        last_updated: null,
      }),
    ]);
    expect(staleDisallowedDetail.json()).toMatchObject({
      id: 'bitcoin',
      market_data: null,
    });
    db.client.close();
  });
  it('keeps validation degraded-state override resets deterministic across diagnostics and hot endpoints', async () => {
    const validationApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'validation-reset-determinism.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3102,
      },
      startBackgroundJobs: false,
    });

    try {
      await validationApp.ready();
      validationApp.marketDataRuntimeState.listenerBound = true;

      const baselineDiagnostics = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });
      const baselineRevision = baselineDiagnostics.json().data.hot_paths.cache_revision;

      const staleAllowedResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'stale_allowed',
          reason: 'validator stale reset check',
        },
      });

      expect(staleAllowedResponse.statusCode).toBe(200);
      const staleAllowedRevision = staleAllowedResponse.json().data.cache_revision;
      expect(staleAllowedRevision).toBeGreaterThan(baselineRevision);

      const [staleAllowedDiagnostics, staleAllowedSimple, staleAllowedMarkets, staleAllowedHealth] = await Promise.all([
        validationApp.inject({ method: 'GET', url: '/diagnostics/runtime' }),
        validationApp.inject({ method: 'GET', url: '/simple/price?ids=bitcoin&vs_currencies=usd' }),
        validationApp.inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&ids=bitcoin&per_page=1&page=1' }),
        validationApp.inject({ method: 'GET', url: '/health' }),
      ]);

      expect(staleAllowedDiagnostics.statusCode).toBe(200);
      expect(staleAllowedDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'degraded',
          degraded: true,
          validation_override_active: true,
        },
        degraded: {
          active: true,
          stale_live_enabled: true,
          reason: 'validator stale reset check',
          validation_override: {
            active: true,
            mode: 'stale_allowed',
            reason: 'validator stale reset check',
          },
        },
        hot_paths: {
          cache_revision: staleAllowedRevision,
        },
      });
      expect(staleAllowedSimple.statusCode).toBe(200);
      expect(staleAllowedSimple.json()).toEqual({
        bitcoin: {
          usd: expect.any(Number),
        },
      });
      expect(staleAllowedMarkets.statusCode).toBe(200);
      expect(staleAllowedMarkets.json()).toEqual([
        expect.objectContaining({
          id: 'bitcoin',
          current_price: expect.any(Number),
        }),
      ]);
      expect(staleAllowedHealth.statusCode).toBe(200);
      expect(staleAllowedHealth.json()).toEqual(contractFixtures.ping);

      const clearResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'off',
        },
      });

      expect(clearResponse.statusCode).toBe(200);
      const clearedRevision = clearResponse.json().data.cache_revision;
      expect(clearedRevision).toBe(staleAllowedRevision + 1);

      const [clearedDiagnostics, clearedSimple, clearedMarkets, clearedHealth] = await Promise.all([
        validationApp.inject({ method: 'GET', url: '/diagnostics/runtime' }),
        validationApp.inject({ method: 'GET', url: '/simple/price?ids=bitcoin&vs_currencies=usd' }),
        validationApp.inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&ids=bitcoin&per_page=1&page=1' }),
        validationApp.inject({ method: 'GET', url: '/health' }),
      ]);

      expect(clearedDiagnostics.statusCode).toBe(200);
      expect(clearedDiagnostics.json().data).toMatchObject({
        readiness: {
          validation_override_active: false,
        },
        degraded: {
          validation_override: {
            active: false,
            mode: 'off',
            reason: null,
          },
        },
        hot_paths: {
          cache_revision: clearedRevision,
        },
      });
      expect(clearedSimple.statusCode).toBe(200);
      expect(clearedSimple.json()).toEqual({
        bitcoin: {
          usd: expect.any(Number),
        },
      });
      expect(clearedMarkets.statusCode).toBe(200);
      expect(clearedMarkets.json()).toEqual([
        expect.objectContaining({
          id: 'bitcoin',
          current_price: expect.any(Number),
        }),
      ]);
      expect(clearedHealth.statusCode).toBe(200);
      expect(clearedHealth.json()).toEqual(contractFixtures.ping);
    } finally {
      await validationApp.close();
    }
  });
  it('propagates validation provider failure visibility without breaking hot endpoint contracts and clears cleanly', async () => {
    const validationApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'validation-provider-failure-consistency.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3102,
      },
      startBackgroundJobs: false,
    });

    try {
      await validationApp.ready();
      validationApp.marketDataRuntimeState.listenerBound = true;
      validationApp.marketDataRuntimeState.allowStaleLiveService = true;
      validationApp.marketDataRuntimeState.syncFailureReason = 'upstream timeout';
      validationApp.marketDataRuntimeState.hotDataRevision += 1;

      const enableResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/provider_failure',
        payload: {
          active: true,
          reason: 'contract-validation',
        },
      });

      expect(enableResponse.statusCode).toBe(200);
      expect(enableResponse.json()).toEqual({
        data: {
          active: true,
          reason: 'contract-validation',
        },
      });

      const [diagnosticsResponse, simpleResponse, marketsResponse, healthResponse] = await Promise.all([
        validationApp.inject({ method: 'GET', url: '/diagnostics/runtime' }),
        validationApp.inject({ method: 'GET', url: '/simple/price?ids=bitcoin&vs_currencies=usd' }),
        validationApp.inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&ids=bitcoin&per_page=1&page=1' }),
        validationApp.inject({ method: 'GET', url: '/health' }),
      ]);

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data).toMatchObject({
        readiness: {
          state: 'degraded',
          degraded: true,
          validation_override_active: true,
        },
        degraded: {
          active: true,
          stale_live_enabled: true,
          reason: 'default runtime exposing seeded/live snapshots after bootstrap sync',
          injected_provider_failure: {
            active: true,
            reason: 'contract-validation',
          },
          validation_override: {
            active: true,
            mode: 'stale_allowed',
            reason: 'default runtime exposing seeded/live snapshots after bootstrap sync',
          },
        },
      });
      expect(simpleResponse.statusCode).toBe(200);
      expect(simpleResponse.json()).toEqual({
        bitcoin: {
          usd: expect.any(Number),
        },
      });
      expect(marketsResponse.statusCode).toBe(200);
      expect(marketsResponse.json()).toEqual([
        expect.objectContaining({
          id: 'bitcoin',
          current_price: expect.any(Number),
        }),
      ]);
      expect(healthResponse.statusCode).toBe(200);
      expect(healthResponse.json()).toEqual(contractFixtures.ping);

      const clearResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/provider_failure',
        payload: {
          active: false,
        },
      });

      expect(clearResponse.statusCode).toBe(200);

      const clearedDiagnostics = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(clearedDiagnostics.statusCode).toBe(200);
      expect(clearedDiagnostics.json().data.degraded.injected_provider_failure).toEqual({
        active: false,
        reason: null,
      });
      expect(clearedDiagnostics.json().data.degraded.provider_failure_cooldown_until).toBeNull();
    } finally {
      await validationApp.close();
    }
  });
});
