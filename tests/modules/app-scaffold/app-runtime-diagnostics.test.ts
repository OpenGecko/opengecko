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

  it('builds startup log context for the active sqlite runtime', () => {
    expect(getDatabaseStartupLogContext({ runtime: 'bun', url: '/tmp/opengecko.db' })).toEqual({
      runtime: 'bun',
      driver: 'bun:sqlite',
      databaseUrl: '/tmp/opengecko.db',
    });

    expect(getDatabaseStartupLogContext({ runtime: 'node', url: '/tmp/opengecko.db' })).toEqual({
      runtime: 'node',
      driver: 'better-sqlite3',
      databaseUrl: '/tmp/opengecko.db',
    });
  });
  it('exposes provider failure injection only on the validation port and reports the injected state', async () => {
    await getApp().ready();
    const nonValidationResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_failure',
      payload: {
        active: true,
        reason: 'validator forced outage',
      },
    });

    expect(nonValidationResponse.statusCode).toBe(404);

    const validationApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'validation.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        port: 3102,
      },
      startBackgroundJobs: false,
    });

    try {
      await validationApp.ready();
      const enableResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/provider_failure',
        payload: {
          active: true,
          reason: 'validator forced outage',
        },
      });

      expect(enableResponse.statusCode).toBe(200);
      expect(enableResponse.json()).toEqual({
        data: {
          active: true,
          reason: 'validator forced outage',
        },
      });

      const diagnosticsResponse = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data.degraded.active).toBe(false);
      expect(diagnosticsResponse.json().data.readiness.validation_override_active).toBe(false);
      expect(diagnosticsResponse.json().data.degraded.injected_provider_failure).toEqual({
        active: true,
        reason: 'validator forced outage',
      });
      expect(diagnosticsResponse.json().data.degraded.validation_override).toEqual({
        active: false,
        mode: 'off',
        reason: null,
      });

      const metricsResponse = await validationApp.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(metricsResponse.statusCode).toBe(200);
      expect(metricsResponse.body).toContain('opengecko_provider_refresh_total{outcome="forced_failure"} 1');
      expect(metricsResponse.body).toContain('provider_forced_failure_total{provider="binance"} 1');

      const clearResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/provider_failure',
        payload: {
          active: false,
        },
      });

      expect(clearResponse.statusCode).toBe(200);
      expect(clearResponse.json()).toEqual({
        data: {
          active: false,
          reason: null,
        },
      });
    } finally {
      await validationApp.close();
    }
  });
  it('exposes degraded-state override only on the validation port and lets validation drive stale/degraded behavior', async () => {
    await getApp().ready();
    const nonValidationResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/degraded_state',
      payload: {
        mode: 'stale_allowed',
        reason: 'validator stale-live allowed',
      },
    });

    expect(nonValidationResponse.statusCode).toBe(404);

    const validationApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'validation-degraded-state.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        port: 3102,
      },
      startBackgroundJobs: false,
    });

    try {
      await validationApp.ready();
      validationApp.marketDataRuntimeState.listenerBound = true;
      const staleTimestamp = new Date('2025-03-19T00:00:00.000Z');

      validationApp.db.db
        .update(marketSnapshots)
        .set({
          lastUpdated: staleTimestamp,
          sourceProvidersJson: JSON.stringify(['binance']),
          sourceCount: 1,
        })
        .where(eq(marketSnapshots.coinId, 'bitcoin'))
        .run();

      validationApp.db.db
        .update(marketSnapshots)
        .set({
          lastUpdated: staleTimestamp,
          sourceProvidersJson: JSON.stringify(['binance']),
          sourceCount: 1,
        })
        .where(eq(marketSnapshots.coinId, 'ethereum'))
        .run();

      const staleDisallowedResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'stale_disallowed',
          reason: 'validator stale-live disallowed',
        },
      });

      expect(staleDisallowedResponse.statusCode).toBe(200);
      expect(staleDisallowedResponse.json().data.mode).toBe('stale_disallowed');

      const staleDisallowedSimple = await validationApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      });
      const staleDisallowedMarkets = await validationApp.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h',
      });
      const staleDisallowedDiagnostics = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(staleDisallowedSimple.statusCode).toBe(200);
      expect(staleDisallowedSimple.json()).toEqual({});
      expect(staleDisallowedMarkets.statusCode).toBe(200);
      expect(staleDisallowedMarkets.json()).toEqual([
        expect.objectContaining({
          id: 'bitcoin',
          current_price: null,
          market_cap: null,
          market_cap_rank: null,
          total_volume: null,
          high_24h: null,
          low_24h: null,
          price_change_24h: null,
          price_change_percentage_24h: null,
          ath: null,
          ath_change_percentage: null,
          ath_date: null,
          atl: null,
          atl_change_percentage: null,
          atl_date: null,
          last_updated: null,
          price_change_percentage_24h_in_currency: null,
        }),
      ]);
      expect(staleDisallowedDiagnostics.json().data.degraded).toMatchObject({
        active: true,
        stale_live_enabled: false,
        reason: 'validator stale-live disallowed',
        validation_override: {
          active: true,
          mode: 'stale_disallowed',
          reason: 'validator stale-live disallowed',
        },
      });
      expect(staleDisallowedDiagnostics.json().data.readiness).toMatchObject({
        degraded: true,
        validation_override_active: true,
      });
      expect(staleDisallowedDiagnostics.json().data.hot_paths.shared_market_snapshot).toMatchObject({
        source_class: 'stale_live',
        freshness: {
          is_stale: true,
        },
      });

      const staleAllowedResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'stale_allowed',
          reason: 'validator stale-live allowed',
        },
      });

      expect(staleAllowedResponse.statusCode).toBe(200);

      const staleAllowedSimple = await validationApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      });
      const staleAllowedMarkets = await validationApp.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h',
      });
      const staleAllowedDiagnostics = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(staleAllowedSimple.statusCode).toBe(200);
      expect(staleAllowedSimple.json()).toEqual({
        bitcoin: {
          usd: expect.any(Number),
        },
      });
      expect(staleAllowedMarkets.statusCode).toBe(200);
      expect(staleAllowedMarkets.json()[0]).toMatchObject({
        id: 'bitcoin',
        current_price: expect.any(Number),
      });
      expect(staleAllowedDiagnostics.json().data.degraded).toMatchObject({
        active: true,
        stale_live_enabled: true,
        reason: 'validator stale-live allowed',
        validation_override: {
          active: true,
          mode: 'stale_allowed',
          reason: 'validator stale-live allowed',
        },
      });
      expect(staleAllowedDiagnostics.json().data.readiness).toMatchObject({
        degraded: true,
        validation_override_active: true,
      });
      expect(staleAllowedDiagnostics.json().data.hot_paths.shared_market_snapshot).toMatchObject({
        source_class: 'stale_live',
        freshness: {
          is_stale: true,
        },
      });

      const bootstrapTimestamp = new Date('2026-03-20T00:00:00.000Z');
      validationApp.db.db
        .update(marketSnapshots)
        .set({
          price: 77777,
          marketCap: null,
          totalVolume: null,
          priceChange24h: null,
          priceChangePercentage24h: null,
          sourceProvidersJson: JSON.stringify([]),
          sourceCount: 0,
          lastUpdated: bootstrapTimestamp,
        })
        .where(eq(marketSnapshots.coinId, 'bitcoin'))
        .run();

      const degradedSeededResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'degraded_seeded_bootstrap',
          reason: 'validator degraded boot',
        },
      });

      expect(degradedSeededResponse.statusCode).toBe(200);

      const degradedSeededSimple = await validationApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      });
      const degradedSeededMarkets = await validationApp.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h',
      });
      const degradedSeededDiagnostics = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(degradedSeededSimple.json()).toEqual({
        bitcoin: {
          usd: 77777,
        },
      });
      expect(degradedSeededMarkets.json()[0]).toMatchObject({
        id: 'bitcoin',
        current_price: 77777,
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        high_24h: null,
        low_24h: null,
        price_change_percentage_24h: null,
        ath: null,
        ath_change_percentage: null,
        ath_date: null,
        atl: null,
        atl_change_percentage: null,
        atl_date: null,
        last_updated: null,
        price_change_percentage_24h_in_currency: null,
      });
      expect(degradedSeededDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'degraded',
          initial_sync_completed: false,
          degraded: true,
          validation_override_active: true,
        },
        degraded: {
          active: true,
          stale_live_enabled: false,
          reason: 'validator degraded boot',
          validation_override: {
            active: true,
            mode: 'degraded_seeded_bootstrap',
            reason: 'validator degraded boot',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'degraded_seeded_bootstrap',
            freshness: {
              is_stale: false,
            },
          },
        },
      });

      const clearResponse = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'off',
        },
      });

      expect(clearResponse.statusCode).toBe(200);
      expect(clearResponse.json().data.mode).toBe('off');
    } finally {
      await validationApp.close();
    }
  });
  it('returns supported quote currencies', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/supported_vs_currencies',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining(contractFixtures.supportedVsCurrencies));
    expect(response.json()).toContain('usdt');
  });
  it('returns exchange rates keyed by currency code', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchange_rates',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.exchangeRates);
    expect(response.json().data.usdt).toBeDefined();
    expect(response.json().data.usdt.type).toBe('fiat');
    expect(typeof response.json().data.usdt.value).toBe('number');
  });
  it('exposes the configured request timeout budget through runtime diagnostics', async () => {
    const configuredApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'timeout-budget.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        requestTimeoutMs: 4321,
        startupPrewarmBudgetMs: 321,
      },
      startBackgroundJobs: false,
    });

    try {
      const response = await configuredApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.transport).toEqual({
        request_timeout_ms: 4321,
        compression: {
          threshold_bytes: 1024,
        },
      });
      expect(response.json().data.startup_prewarm).toMatchObject({
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
      expect(typeof response.json().data.startup_prewarm.readyWithinBudget).toBe('boolean');
      expect(response.json().data.startup_prewarm.targetResults.length).toBeGreaterThanOrEqual(1);
      expect(response.json().data.startup_prewarm.targetResults[0]).toMatchObject({
        id: 'simple_price_bitcoin_usd',
        cacheSurface: 'simple_price',
      });
      expect(response.json().data.startup_prewarm.totalDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await configuredApp.close();
    }
  });
});
