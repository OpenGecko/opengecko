import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildApp, getDatabaseStartupLogContext } from '../src/app';
import { coins, marketSnapshots } from '../src/db/schema';
import type { MetricsRegistry } from '../src/services/metrics';
import type { MarketDataRuntimeState } from '../src/services/market-runtime-state';
import * as candleStore from '../src/services/candle-store';
import * as catalogModule from '../src/modules/catalog';
import * as startupPrewarmModule from '../src/services/startup-prewarm';
import contractFixtures from './fixtures/contract-fixtures.json';

vi.mock('../src/providers/ccxt', () => ({
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

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves the CoinGecko-compatible ping response', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/ping',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(contractFixtures.ping);
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

  it('returns chain coverage diagnostics', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/chain_coverage',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data.platform_counts.total');
    expect(body).toHaveProperty('data.contract_mapping.active_coins');
    expect(typeof body.data.platform_counts.total).toBe('number');
    expect(typeof body.data.contract_mapping.active_coins).toBe('number');
  });

  it('returns ohlcv worker lag and failure metrics', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/ohlcv_sync',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveProperty('top100.ready');
    expect(response.json().data).toHaveProperty('targets.waiting');
    expect(response.json().data).toHaveProperty('lag.oldest_recent_sync_ms');
  });

  it('returns machine-readable runtime diagnostics for ready live service', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        readiness: {
          state: 'ready',
          listener_bound: false,
          initial_sync_completed: true,
        },
        degraded: {
          active: false,
          stale_live_enabled: false,
          reason: null,
          injected_provider_failure: {
            active: false,
            reason: null,
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            available: true,
            source_class: 'fresh_live',
            freshness: {
              threshold_seconds: 300,
              is_stale: false,
            },
          },
        },
      },
    });
    expect(typeof response.json().data.hot_paths.shared_market_snapshot.freshness.age_seconds).toBe('number');
    expect(Array.isArray(response.json().data.hot_paths.shared_market_snapshot.providers)).toBe(true);
  });

  it('exposes provider failure injection only on the validation port and reports the injected state', async () => {
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
      await validationApp.listen({ host: '127.0.0.1', port: 0 });
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
      expect(diagnosticsResponse.json().data.degraded.injected_provider_failure).toEqual({
        active: true,
        reason: 'validator forced outage',
      });
      expect(diagnosticsResponse.json().data.degraded.validation_override).toEqual({
        active: false,
        mode: 'off',
        reason: null,
      });

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
      await validationApp.listen({ host: '127.0.0.1', port: 0 });
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
          total_volume: null,
          high_24h: null,
          low_24h: null,
          price_change_24h: null,
          price_change_percentage_24h: null,
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
        total_volume: null,
        price_change_percentage_24h: null,
        price_change_percentage_24h_in_currency: null,
      });
      expect(degradedSeededDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'degraded',
          initial_sync_completed: false,
        },
        degraded: {
          active: true,
          stale_live_enabled: true,
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
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/supported_vs_currencies',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining(contractFixtures.supportedVsCurrencies));
    expect(response.json()).toContain('usdt');
  });

  it('returns exchange rates keyed by currency code', async () => {
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
      expect(beforeRequestDiagnostics.json().data.startup_prewarm.targetResults[0]).toMatchObject({
        id: 'simple_price_bitcoin_usd',
        status: 'completed',
        warmCacheRevision: expect.any(Number),
        firstObservedRequest: null,
      });

      expect(beforeRequestDiagnostics.json().data.startup_prewarm.firstRequestWarmBenefitPending).toBe(true);

      prewarmApp.marketRuntime?.markListenerBound();
      await new Promise((resolve) => setTimeout(resolve, 50));

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

  it('returns simple prices with optional market fields', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      bitcoin: {
        usd: 85000,
        eur: 73530.28299112723,
        usd_24h_change: 1.8,
        eur_24h_change: 1.8,
      },
      ethereum: {
        usd: 2000,
        eur: expect.any(Number),
        usd_24h_change: 2.56,
        eur_24h_change: 2.56,
      },
    });
  });

  it('preserves the exact invalid-selector 400 envelope for simple price requests', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/price?vs_currencies=usd',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      error: 'invalid_parameter',
      message: 'One of ids, names, or symbols must be provided.',
    });
  });

  it('keeps equivalent simple price selector requests stable across parameter ordering', async () => {
    const [baselineResponse, reorderedResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_change=true',
      }),
      getApp().inject({
        method: 'GET',
        url: '/simple/price?vs_currencies=usd,eur&include_24hr_change=true&include_market_cap=true&ids=bitcoin,ethereum',
      }),
    ]);

    expect(baselineResponse.statusCode).toBe(200);
    expect(reorderedResponse.statusCode).toBe(200);
    expect(reorderedResponse.json()).toEqual(baselineResponse.json());
  });

  it('caches equivalent simple price requests across query ordering without widening selector semantics', async () => {
    const getMarketRowsSpy = vi.spyOn(catalogModule, 'getMarketRows');
    const baselineSelectorCalls = () => getMarketRowsSpy.mock.calls.filter(
      ([, vsCurrency, filters]) => vsCurrency === 'usd'
        && Array.isArray(filters?.ids)
        && filters.ids.length === 2
        && filters.ids.includes('bitcoin')
        && filters.ids.includes('ethereum'),
    ).length;

    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_change=true',
    });
    const afterBaselineCalls = baselineSelectorCalls();

    const reorderedResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?include_24hr_change=true&vs_currencies=eur,usd&include_market_cap=true&ids=ethereum,bitcoin',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(reorderedResponse.statusCode).toBe(200);
    expect(reorderedResponse.json()).toEqual(baselineResponse.json());
    expect(afterBaselineCalls).toBe(1);
    expect(baselineSelectorCalls()).toBe(1);
  });

  it('isolates simple price cache entries by precision and include flags', async () => {
    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const repeatedBaselineResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?vs_currencies=usd&ids=bitcoin',
    });
    const precisionResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd&precision=2',
    });
    const includeResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(repeatedBaselineResponse.statusCode).toBe(200);
    expect(precisionResponse.statusCode).toBe(200);
    expect(includeResponse.statusCode).toBe(200);

    expect(repeatedBaselineResponse.json()).toEqual(baselineResponse.json());
    expect(baselineResponse.json()).toEqual({
      bitcoin: {
        usd: 85000,
      },
    });
    expect(precisionResponse.json()).toEqual({
      bitcoin: {
        usd: 85000,
      },
    });
    expect(includeResponse.json()).toEqual({
      bitcoin: {
        usd: 85000,
        usd_market_cap: null,
      },
    });
    expect('usd_market_cap' in baselineResponse.json().bitcoin).toBe(false);
  });

  it('returns token prices by contract address', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(contractFixtures.tokenPrice);
  });

  it('returns seeded asset platforms', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/asset_platforms',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      ...contractFixtures.assetPlatforms,
      {
        id: 'solana',
        chain_identifier: 101,
        name: 'Solana',
        shortname: 'sol',
        native_coin_id: 'solana',
        image: null,
      },
    ]));
  });

  it('returns seeded exchanges and exchange detail data', async () => {
    const listResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/list',
    });
    const inactiveListResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/list?status=inactive',
    });
    const exchangesResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges?per_page=2&page=1',
    });
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance',
    });
    const volumeChartResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart?days=7',
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual(expect.arrayContaining([
      {
        id: 'binance',
        name: 'Binance',
      },
      {
        id: 'coinbase',
        name: 'Coinbase',
      },
      {
        id: 'kraken',
        name: 'Kraken',
      },
    ]));

    expect(inactiveListResponse.statusCode).toBe(200);
    expect(inactiveListResponse.json()).toEqual([]);

    expect(exchangesResponse.statusCode).toBe(200);
    expect(exchangesResponse.json()).toHaveLength(2);
    expect(exchangesResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'binance',
        name: 'Binance',
        year_established: null,
        country: null,
        trust_score_rank: null,
        trade_volume_24h_btc: expect.any(Number),
        trade_volume_24h_btc_normalized: null,
      }),
    ]));

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: 'binance',
      name: 'Binance',
      year_established: null,
      country: null,
      twitter_handle: null,
      tickers: expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          target: 'USDT',
        }),
        expect.objectContaining({
          coin_id: 'usd-coin',
          target: 'USDT',
        }),
      ]),
    });

    expect(volumeChartResponse.statusCode).toBe(200);
    const volumeChart = volumeChartResponse.json();
    expect(volumeChart.length).toBeGreaterThan(0);
    // Each entry is [timestamp, volumeBtc]
    for (const entry of volumeChart) {
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe('number');
      expect(typeof entry[1]).toBe('number');
    }
  });

  it('returns ranged exchange volume tuples in ascending chronological order with finite numerics', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart/range?from=0&to=4102444800',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBeGreaterThan(0);

    const timestamps = body.map((tuple: number[]) => tuple[0]);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));

    for (const tuple of body) {
      expect(tuple).toHaveLength(2);
      expect(typeof tuple[0]).toBe('number');
      expect(typeof tuple[1]).toBe('number');
      expect(Number.isFinite(tuple[1])).toBe(true);
    }
  });

  it('returns exchange tickers and supports coin filters', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?include_exchange_logo=true',
    });
    const filteredResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?coin_ids=ethereum&order=volume_asc',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('Binance');
    expect(response.json().tickers.length).toBeGreaterThanOrEqual(7);
    expect(response.json().tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: 'bitcoin',
        target: 'USDT',
      }),
      expect.objectContaining({
        coin_id: 'ethereum',
        target: 'USDT',
      }),
      expect.objectContaining({
        coin_id: 'usd-coin',
        target: 'USDT',
      }),
    ]));

    expect(filteredResponse.statusCode).toBe(200);
    expect(filteredResponse.json().tickers).toHaveLength(1);
    expect(filteredResponse.json().tickers[0]).toMatchObject({
      coin_id: 'ethereum',
      target: 'USDT',
    });
  });

  it('supports exchange ticker depth and dex pair formatting', async () => {
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance?dex_pair_format=contract_address',
    });
    const tickersResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?coin_ids=usd-coin&depth=true&dex_pair_format=contract_address',
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().tickers.find((ticker: { coin_id: string }) => ticker.coin_id === 'usd-coin')).toMatchObject({
      base: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      coin_id: 'usd-coin',
    });

    expect(tickersResponse.statusCode).toBe(200);
    expect(tickersResponse.json().tickers[0]).toMatchObject({
      base: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      coin_id: 'usd-coin',
    });
  });

  it('returns derivatives exchange registry rows', async () => {
    const listResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/list',
    });
    const exchangesResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges?order=trade_volume_24h_btc_desc&per_page=1&page=1',
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual(contractFixtures.derivativesExchangesList);

    expect(exchangesResponse.statusCode).toBe(200);
    expect(exchangesResponse.json()).toHaveLength(1);
    expect(exchangesResponse.json()[0]).toMatchObject(contractFixtures.derivativesExchanges[0]);
  });

  it('returns derivatives exchange detail without tickers by default and includes tickers on request', async () => {
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/binance_futures',
    });
    const includeTickersResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/binance_futures?include_tickers=true',
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: 'binance_futures',
      name: 'Binance Futures',
      open_interest_btc: 185000,
      trade_volume_24h_btc: 910000,
      number_of_perpetual_pairs: 412,
      number_of_futures_pairs: 38,
      year_established: 2019,
      country: 'Cayman Islands',
      description: "Binance Futures is Binance's derivatives venue for perpetual and dated futures markets.",
      url: 'https://www.binance.com/en/futures',
      image: 'https://assets.coingecko.com/markets/images/52/small/binance.jpg',
      centralized: true,
    });
    expect(detailResponse.json()).not.toHaveProperty('tickers');

    expect(includeTickersResponse.statusCode).toBe(200);
    expect(includeTickersResponse.json()).toMatchObject({
      id: 'binance_futures',
      name: 'Binance Futures',
    });
    expect(includeTickersResponse.json()).toHaveProperty('tickers');
    expect(includeTickersResponse.json().tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        market: 'Binance Futures',
        market_id: 'binance_futures',
        symbol: 'BTCUSDT',
        index_id: 'bitcoin',
        contract_type: 'perpetual',
      }),
    ]));
  });

  it('returns derivatives tickers', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.derivatives);
  });

  it('returns treasury entities and grouped public treasury rows', async () => {
    const entitiesResponse = await getApp().inject({
      method: 'GET',
      url: '/entities/list?entity_type=companies&page=1&per_page=10',
    });
    const groupedResponse = await getApp().inject({
      method: 'GET',
      url: '/companies/public_treasury/bitcoin?order=value_desc',
    });
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy',
    });

    expect(entitiesResponse.statusCode).toBe(200);
    expect(entitiesResponse.json()).toMatchObject([contractFixtures.treasuryEntities[1]]);

    expect(groupedResponse.statusCode).toBe(200);
    expect(groupedResponse.json()).toMatchObject(contractFixtures.companyTreasuryBitcoin);

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject(contractFixtures.treasuryEntityDetail);
  });

  it('returns treasury holding charts and transaction history', async () => {
    const chartResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/bitcoin/holding_chart?days=7',
    });
    const chartWithIntervalsResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/bitcoin/holding_chart?days=7&include_empty_intervals=true',
    });
    const transactionsResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/transaction_history?order=date_desc',
    });

    expect(chartResponse.statusCode).toBe(200);
    expect(chartResponse.json()).toEqual(contractFixtures.treasuryHoldingChart);

    expect(chartWithIntervalsResponse.statusCode).toBe(200);
    expect(chartWithIntervalsResponse.json()).toEqual(contractFixtures.treasuryHoldingChartWithIntervals);

    expect(transactionsResponse.statusCode).toBe(200);
    expect(transactionsResponse.json()).toEqual(contractFixtures.treasuryTransactionHistory);
  });

  it('returns onchain networks and network dexes', async () => {
    const networksResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks?page=1',
    });
    const dexesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes?page=1',
    });

    expect(networksResponse.statusCode).toBe(200);
    expect(networksResponse.json()).toMatchObject(contractFixtures.onchainNetworks);

    expect(dexesResponse.statusCode).toBe(200);
    expect(dexesResponse.json()).toMatchObject(contractFixtures.onchainDexesEth);
  });

  it('returns onchain networks with pagination metadata and asset-platform continuity', async () => {
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
    const poolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });
    const poolDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    });

    expect(poolsResponse.statusCode).toBe(200);
    expect(poolsResponse.json()).toMatchObject(contractFixtures.onchainPoolsEth);

    expect(poolDetailResponse.statusCode).toBe(200);
    expect(poolDetailResponse.json()).toMatchObject(contractFixtures.onchainPoolEthDetail);
  });

  it('keeps onchain pool detail scoped to the requested network and supports explicit includes/toggles', async () => {
    const includedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b?include=network,dex&include_volume_breakdown=true&include_composition=true',
    });
    const wrongNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/solana/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    });

    expect(includedResponse.statusCode).toBe(200);
    expect(includedResponse.json()).toMatchObject({
      data: {
        id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
              address: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
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
      message: 'Onchain pool not found: 0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    });
  });

  it('normalizes mixed-case onchain pool addresses before detail and multi lookups without changing canonical response ids', async () => {
    const lowercaseAddress = '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b';
    const mixedCaseAddress = '0x88E6A0c2dDD26FCe6B7C8F1EC5feF66F5f8f2B4B';
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
      expect.objectContaining({ id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b' }),
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    expect(response.json().data[0]).toMatchObject({
      relationships: {
        network: { data: { id: 'eth', type: 'network' } },
        dex: { data: { id: 'uniswap_v3', type: 'dex' } },
      },
    });
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      url: '/onchain/search/pools?query=0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b&page=1',
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
        query: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      },
    });
    expect(exactAddressResponse.json().data[0]).toMatchObject({
      id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      relationships: {
        network: { data: { id: 'eth', type: 'network' } },
      },
    });

    expect(exactNameResponse.statusCode).toBe(200);
    expect(exactNameResponse.json().data.length).toBeGreaterThan(0);
    expect(exactNameResponse.json().data[0].id).toBe('0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b');

    expect(partialResponse.statusCode).toBe(200);
    expect(partialResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      url: '/onchain/pools/trending_search?page=1&pools=0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b,58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    });
    const invalidSubsetResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/pools/trending_search?page=1&pools=0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b,0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b,0x0000000000000000000000000000000000000000',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    ]);

    expect(invalidSubsetResponse.statusCode).toBe(200);
    expect(invalidSubsetResponse.json()).toMatchObject({
      meta: {
        page: 1,
        candidate_count: 1,
        ignored_candidates: [
          '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
          '0x0000000000000000000000000000000000000000',
        ],
      },
    });
    expect(invalidSubsetResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
          id: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
          type: 'token',
        }),
      ]),
    });
    expect(response.json().included).toHaveLength(3);
  });

  it('returns onchain pools by multi-address lookup', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/multi/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b,0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
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
      url: '/onchain/networks/eth/pools/multi/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b,0x4e68ccd3e89f51c3074ca5072bbac773960dfa36?include=network,dex',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        expect.objectContaining({ id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b' }),
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

  it('returns onchain token detail, multi, and token-pools with canonical network-scoped identity continuity', async () => {
    const tokenDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const tokenDetailIncludedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?include=top_pools&include_inactive_source=true&include_composition=true',
    });
    const tokenMultiResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/multi/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const tokenPoolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/pools?page=1',
    });

    expect(tokenDetailResponse.statusCode).toBe(200);
    expect(tokenDetailResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token',
        attributes: {
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
          name: 'USDC',
          price_usd: 1,
        },
        relationships: {
          network: {
            data: {
              type: 'network',
              id: 'eth',
            },
          },
        },
      },
    });

    expect(tokenDetailIncludedResponse.statusCode).toBe(200);
    expect(tokenDetailIncludedResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        attributes: {
          top_pools: [
            '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
            '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
          ],
          inactive_source: false,
          composition: {
            pools: expect.arrayContaining([
              expect.objectContaining({
                pool_address: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
                role: 'base',
              }),
              expect.objectContaining({
                pool_address: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
                role: 'base',
              }),
            ]),
          },
        },
      },
      included: expect.arrayContaining([
        expect.objectContaining({
          id: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
          type: 'pool',
        }),
        expect.objectContaining({
          id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
          type: 'pool',
        }),
      ]),
    });

    expect(tokenMultiResponse.statusCode).toBe(200);
    expect(tokenMultiResponse.json()).toMatchObject({
      data: [
        expect.objectContaining({
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          type: 'token',
        }),
      ],
    });
    expect(tokenMultiResponse.json().data).toHaveLength(1);

    expect(tokenPoolsResponse.statusCode).toBe(200);
    expect(tokenPoolsResponse.json().meta).toMatchObject({
      page: 1,
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    expect(tokenPoolsResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    ]);
    expect(tokenPoolsResponse.json().data.every((pool: { attributes: { base_token_address: string; quote_token_address: string } }) =>
      pool.attributes.base_token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      || pool.attributes.quote_token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true);
  });

  it('rejects unknown or wrong-network onchain token lookups without bleeding identities across routes', async () => {
    const unknownTokenResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0x0000000000000000000000000000000000000001',
    });
    const wrongNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/solana/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const wrongNetworkPoolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/solana/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/pools',
    });

    expect(unknownTokenResponse.statusCode).toBe(404);
    expect(unknownTokenResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain token not found: 0x0000000000000000000000000000000000000001',
    });

    expect(wrongNetworkResponse.statusCode).toBe(404);
    expect(wrongNetworkResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain token not found: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });

    expect(wrongNetworkPoolsResponse.statusCode).toBe(404);
    expect(wrongNetworkPoolsResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain token not found: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
  });

  it('returns onchain simple token prices with optional field gating and network scoping', async () => {
    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });
    const includedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?include_market_cap=true&include_24hr_vol=true&include_24hr_price_change=true&include_total_reserve_in_usd=true',
    });
    const mixedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,0x0000000000000000000000000000000000000001',
    });
    const wrongNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/solana/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(baselineResponse.json()).toMatchObject({
      data: {
        id: 'eth',
        type: 'simple_token_price',
        attributes: {
          token_prices: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1',
          },
        },
      },
    });
    expect(baselineResponse.json().data.attributes).not.toHaveProperty('market_cap_usd');
    expect(baselineResponse.json().data.attributes).not.toHaveProperty('h24_volume_usd');
    expect(baselineResponse.json().data.attributes).not.toHaveProperty('h24_price_change_percentage');
    expect(baselineResponse.json().data.attributes).not.toHaveProperty('total_reserve_in_usd');

    expect(includedResponse.statusCode).toBe(200);
    expect(includedResponse.json()).toMatchObject({
      data: {
        id: 'eth',
        type: 'simple_token_price',
        attributes: {
          token_prices: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1',
          },
          market_cap_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': expect.any(String),
          },
          h24_volume_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': expect.any(String),
          },
          h24_price_change_percentage: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': expect.any(String),
          },
          total_reserve_in_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': expect.any(String),
          },
        },
      },
    });

    expect(mixedResponse.statusCode).toBe(200);
    expect(mixedResponse.json()).toMatchObject({
      data: {
        id: 'eth',
        type: 'simple_token_price',
        attributes: {
          token_prices: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1',
          },
        },
      },
    });

    expect(wrongNetworkResponse.statusCode).toBe(200);
    expect(wrongNetworkResponse.json()).toEqual({
      data: {
        id: 'solana',
        type: 'simple_token_price',
        attributes: {
          token_prices: {},
        },
      },
    });
  });

  it('returns onchain holder and trader analytics with deterministic ordering, count limits, enrichment gating, and holders chart windows', async () => {
    const topHoldersResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_holders',
    });
    const topHoldersLimitedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_holders?holders=2&include_pnl_details=true&include=token,network',
    });
    const topTradersResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_traders',
    });
    const topTradersSortedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_traders?traders=2&sort=realized_pnl_usd_desc&include_address_label=true',
    });
    const holdersChartResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/holders_chart',
    });
    const holdersChartShortResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/holders_chart?days=7',
    });

    expect(topHoldersResponse.statusCode).toBe(200);
    expect(topHoldersResponse.json().meta).toMatchObject({
      network: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      holders: 3,
    });
    expect(topHoldersResponse.json().data.map((holder: { id: string }) => holder.id)).toEqual([
      '0xholder000000000000000000000000000000000003',
      '0xholder000000000000000000000000000000000002',
      '0xholder000000000000000000000000000000000001',
    ]);
    expect(topHoldersResponse.json().data.map((holder: { attributes: { balance: string } }) => Number(holder.attributes.balance))).toEqual([
      200000000,
      150000000,
      100000000,
    ]);
    expect(topHoldersResponse.json().data[0].attributes).not.toHaveProperty('pnl_usd');

    expect(topHoldersLimitedResponse.statusCode).toBe(200);
    expect(topHoldersLimitedResponse.json().meta).toMatchObject({
      holders: 2,
      include_pnl_details: true,
    });
    expect(topHoldersLimitedResponse.json().data).toHaveLength(2);
    expect(topHoldersLimitedResponse.json().data).toEqual([
      expect.objectContaining({
        id: '0xholder000000000000000000000000000000000003',
        attributes: expect.objectContaining({
          pnl_usd: '2000000',
          avg_buy_price_usd: '0.98',
          realized_pnl_usd: '700000',
        }),
      }),
      expect.objectContaining({
        id: '0xholder000000000000000000000000000000000002',
        attributes: expect.objectContaining({
          pnl_usd: '1000000',
          avg_buy_price_usd: '0.99',
          realized_pnl_usd: '300000',
        }),
      }),
    ]);
    expect(topHoldersLimitedResponse.json()).toMatchObject({
      included: expect.arrayContaining([
        expect.objectContaining({
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          type: 'token',
        }),
        expect.objectContaining({
          id: 'eth',
          type: 'network',
        }),
      ]),
    });
    expect(topHoldersLimitedResponse.json().included).toHaveLength(2);

    expect(topTradersResponse.statusCode).toBe(200);
    expect(topTradersResponse.json().meta).toMatchObject({
      network: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      traders: 3,
      sort: 'volume_usd_desc',
    });
    expect(topTradersResponse.json().data.map((trader: { id: string }) => trader.id)).toEqual([
      '0xtrader000000000000000000000000000000000002',
      '0xtrader000000000000000000000000000000000001',
      '0xtrader000000000000000000000000000000000003',
    ]);
    expect(topTradersResponse.json().data.map((trader: { attributes: { is_whale: boolean } }) => trader.attributes.is_whale)).toEqual([
      true,
      false,
      false,
    ]);
    expect(topTradersResponse.json().data.map((trader: { attributes: { volume_usd: string } }) => Number(trader.attributes.volume_usd))).toEqual([
      12500000,
      9000000,
      4000000,
    ]);
    expect(topTradersResponse.json().data[0].attributes).not.toHaveProperty('address_label');

    expect(topTradersSortedResponse.statusCode).toBe(200);
    expect(topTradersSortedResponse.json().meta).toMatchObject({
      traders: 2,
      sort: 'realized_pnl_usd_desc',
      include_address_label: true,
    });
    expect(topTradersSortedResponse.json().data).toEqual([
      expect.objectContaining({
        id: '0xtrader000000000000000000000000000000000001',
        attributes: expect.objectContaining({
          realized_pnl_usd: '450000',
          address_label: 'Whale One',
        }),
      }),
      expect.objectContaining({
        id: '0xtrader000000000000000000000000000000000003',
        attributes: expect.objectContaining({
          realized_pnl_usd: '300000',
          address_label: 'Arb Bot',
        }),
      }),
    ]);

    expect(holdersChartResponse.statusCode).toBe(200);
    expect(holdersChartResponse.json().meta).toMatchObject({
      network: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      days: 30,
    });
    expect(holdersChartResponse.json().data.map((point: { attributes: { timestamp: number } }) => point.attributes.timestamp)).toEqual([
      1710028800,
      1710633600,
      1711238400,
      1711843200,
    ]);
    expect(holdersChartResponse.json().data.map((point: { attributes: { holder_count: number } }) => point.attributes.holder_count)).toEqual([
      181200,
      184500,
      188900,
      193400,
    ]);

    expect(holdersChartShortResponse.statusCode).toBe(200);
    expect(holdersChartShortResponse.json().meta).toMatchObject({
      days: 7,
    });
    expect(holdersChartShortResponse.json().data.map((point: { attributes: { timestamp: number } }) => point.attributes.timestamp)).toEqual([
      1711238400,
      1711843200,
    ]);
  });

  it('returns onchain categories and category pools with deterministic sorting, stable pagination, category scoping, and include handling', async () => {
    const categoriesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories?sort=h24_volume_usd_desc&page=1',
    });
    const categoriesPageTwoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories?sort=h24_volume_usd_desc&page=2',
    });
    const categoryPoolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/stablecoins/pools?sort=reserve_in_usd_desc&page=1',
    });
    const categoryPoolsIncludedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/stablecoins/pools?sort=reserve_in_usd_desc&page=1&include=network,dex',
    });

    expect(categoriesResponse.statusCode).toBe(200);
    expect(categoriesResponse.json()).toMatchObject({
      data: [
        expect.objectContaining({
          id: 'stablecoins',
          type: 'category',
          attributes: expect.objectContaining({
            name: 'Stablecoins',
          }),
        }),
      ],
      meta: expect.objectContaining({
        page: 1,
        per_page: 1,
        total_count: 2,
        total_pages: 2,
        sort: 'h24_volume_usd_desc',
      }),
    });
    expect(categoriesResponse.json().data).toHaveLength(1);
    expect(categoriesResponse.json().data.map((category: { id: string }) => category.id)).toEqual(['stablecoins']);

    expect(categoriesPageTwoResponse.statusCode).toBe(200);
    expect(categoriesPageTwoResponse.json()).toMatchObject({
      data: [
        expect.objectContaining({
          id: 'smart-contract-platform',
          type: 'category',
        }),
      ],
      meta: expect.objectContaining({
        page: 2,
        per_page: 1,
        total_count: 2,
        total_pages: 2,
        sort: 'h24_volume_usd_desc',
      }),
    });
    expect(categoriesPageTwoResponse.json().data).toHaveLength(1);
    expect(categoriesPageTwoResponse.json().data.map((category: { id: string }) => category.id)).toEqual(['smart-contract-platform']);
    expect(new Set([
      ...categoriesResponse.json().data.map((category: { id: string }) => category.id),
      ...categoriesPageTwoResponse.json().data.map((category: { id: string }) => category.id),
    ])).toEqual(new Set(['smart-contract-platform', 'stablecoins']));

    expect(categoryPoolsResponse.statusCode).toBe(200);
    expect(categoryPoolsResponse.json()).toMatchObject({
      meta: expect.objectContaining({
        page: 1,
        per_page: 100,
        total_count: 4,
        total_pages: 1,
        sort: 'reserve_in_usd_desc',
        category_id: 'stablecoins',
      }),
    });
    expect(categoryPoolsResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    ]);
    expect(categoryPoolsResponse.json().data.every((pool: {
      attributes: { base_token_symbol: string; quote_token_symbol: string };
    }) => ['USDC', 'USDT'].includes(pool.attributes.base_token_symbol) || ['USDC', 'USDT'].includes(pool.attributes.quote_token_symbol))).toBe(true);

    expect(categoryPoolsIncludedResponse.statusCode).toBe(200);
    expect(categoryPoolsIncludedResponse.json()).toMatchObject({
      data: expect.any(Array),
      included: expect.arrayContaining([
        expect.objectContaining({ id: 'eth', type: 'network' }),
        expect.objectContaining({ id: 'solana', type: 'network' }),
        expect.objectContaining({ id: 'uniswap_v3', type: 'dex' }),
        expect.objectContaining({ id: 'curve', type: 'dex' }),
        expect.objectContaining({ id: 'raydium', type: 'dex' }),
      ]),
    });
    expect(categoryPoolsIncludedResponse.json().data).toHaveLength(4);
  });

  it('rejects invalid onchain category sort/include values explicitly and returns not found for unknown categories', async () => {
    const invalidCategorySortResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories?sort=unsupported',
    });
    const invalidCategoryPoolsSortResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/stablecoins/pools?sort=unsupported',
    });
    const invalidCategoryPoolsIncludeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/stablecoins/pools?include=token',
    });
    const unknownCategoryResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/not-a-category/pools',
    });

    expect(invalidCategorySortResponse.statusCode).toBe(400);
    expect(invalidCategorySortResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported sort value: unsupported',
    });

    expect(invalidCategoryPoolsSortResponse.statusCode).toBe(400);
    expect(invalidCategoryPoolsSortResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported sort value: unsupported',
    });

    expect(invalidCategoryPoolsIncludeResponse.statusCode).toBe(400);
    expect(invalidCategoryPoolsIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: token',
    });

    expect(unknownCategoryResponse.statusCode).toBe(404);
    expect(unknownCategoryResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain category not found: not-a-category',
    });
  });

  it('validates malformed addresses and include flags for onchain simple token prices', async () => {
    const malformedAddressResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/not-an-address',
    });
    const invalidMarketCapFlagResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?include_market_cap=yes',
    });

    expect(malformedAddressResponse.statusCode).toBe(400);
    expect(malformedAddressResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid onchain address: not-an-address',
    });

    expect(invalidMarketCapFlagResponse.statusCode).toBe(400);
    expect(invalidMarketCapFlagResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid boolean query value: yes',
    });
  });

  it('returns metadata-focused onchain token info, pool info, and recently updated token info', async () => {
    const tokenInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
    });
    const poolInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/info',
    });
    const poolInfoIncludedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/info?include=pool',
    });
    const recentlyUpdatedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/tokens/info_recently_updated',
    });
    const recentlyUpdatedWithNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/tokens/info_recently_updated?include=network&network=eth',
    });

    expect(tokenInfoResponse.statusCode).toBe(200);
    expect(tokenInfoResponse.json()).toMatchObject({
      data: {
        id: 'eth_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token_info',
        attributes: {
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          name: 'USDC',
          symbol: 'USDC',
          coingecko_coin_id: 'usd-coin',
          decimals: 6,
          image_url: null,
        },
        relationships: {
          network: {
            data: {
              type: 'network',
              id: 'eth',
            },
          },
        },
      },
    });

    expect(poolInfoResponse.statusCode).toBe(200);
    expect(poolInfoResponse.json().data).toHaveLength(2);
    expect(poolInfoResponse.json().data.map((entry: { id: string }) => entry.id)).toContain('eth_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(poolInfoResponse.json().data.map((entry: { id: string }) => entry.id)).toContain('eth_0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(poolInfoResponse.json().data[0]).toMatchObject({
      type: 'token_info',
      attributes: {
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        symbol: 'USDC',
      },
    });
    expect(poolInfoResponse.json().data[1]).toMatchObject({
      type: 'token_info',
      attributes: {
        address: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
        symbol: 'WETH',
      },
    });

    expect(poolInfoIncludedResponse.statusCode).toBe(200);
    expect(poolInfoIncludedResponse.json()).toMatchObject({
      data: expect.any(Array),
      included: [
        expect.objectContaining({
          id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
          type: 'pool',
        }),
      ],
    });

    expect(recentlyUpdatedResponse.statusCode).toBe(200);
    expect(recentlyUpdatedResponse.json().meta).toEqual({ page: 1 });
    expect(recentlyUpdatedResponse.json().data.length).toBeGreaterThanOrEqual(4);
    expect(recentlyUpdatedResponse.json().data[0]).toMatchObject({
      type: 'token_info',
      attributes: {
        symbol: 'USDC',
      },
    });
    expect(recentlyUpdatedResponse.json().data.some((entry: { attributes: { symbol: string } }) => entry.attributes.symbol === 'USDC')).toBe(true);
    expect(recentlyUpdatedResponse.json().data[0].attributes.updated_at).toBeGreaterThanOrEqual(
      recentlyUpdatedResponse.json().data[1].attributes.updated_at,
    );

    expect(recentlyUpdatedWithNetworkResponse.statusCode).toBe(200);
    expect(recentlyUpdatedWithNetworkResponse.json()).toMatchObject({
      data: expect.any(Array),
      included: [
        {
          id: 'eth',
          type: 'network',
          attributes: expect.objectContaining({
            name: 'Ethereum',
          }),
        },
      ],
    });
    expect(recentlyUpdatedWithNetworkResponse.json().data.every((entry: { relationships: { network: { data: { id: string } } } }) =>
      entry.relationships.network.data.id === 'eth')).toBe(true);
  });

  it('validates onchain token info and recently updated token info parameters explicitly', async () => {
    const unknownTokenInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0x0000000000000000000000000000000000000001/info',
    });
    const invalidPoolInfoIncludeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/info?include=dex',
    });
    const invalidRecentlyUpdatedIncludeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/tokens/info_recently_updated?include=dex',
    });
    const invalidRecentlyUpdatedNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/tokens/info_recently_updated?network=not-a-network',
    });

    expect(unknownTokenInfoResponse.statusCode).toBe(404);
    expect(unknownTokenInfoResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain token not found: 0x0000000000000000000000000000000000000001',
    });

    expect(invalidPoolInfoIncludeResponse.statusCode).toBe(400);
    expect(invalidPoolInfoIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: dex',
    });

    expect(invalidRecentlyUpdatedIncludeResponse.statusCode).toBe(400);
    expect(invalidRecentlyUpdatedIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: dex',
    });

    expect(invalidRecentlyUpdatedNetworkResponse.statusCode).toBe(400);
    expect(invalidRecentlyUpdatedNetworkResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unknown onchain network: not-a-network',
    });
  });

  it('returns pool-scoped and token-aggregated onchain trades with threshold and token filtering semantics', async () => {
    const poolTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/trades',
    });
    const filteredPoolTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/trades?trade_volume_in_usd_greater_than=150000&token=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const tokenTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades',
    });
    const filteredTokenTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?trade_volume_in_usd_greater_than=150000',
    });

    expect(poolTradesResponse.statusCode).toBe(200);
    expect(poolTradesResponse.json().meta).toEqual({
      network: 'eth',
      pool_address: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    });
    expect(poolTradesResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'trade',
          relationships: expect.objectContaining({
            pool: {
              data: {
                type: 'pool',
                id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
    expect(poolTradesResponse.json().data.every((trade: { relationships: { pool: { data: { id: string } } } }) =>
      trade.relationships.pool.data.id === '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b')).toBe(true);

    expect(filteredPoolTradesResponse.statusCode).toBe(200);
    expect(filteredPoolTradesResponse.json().data.length).toBeGreaterThan(0);
    expect(filteredPoolTradesResponse.json().data.every((trade: {
      attributes: { volume_in_usd: string; token_address: string };
      relationships: { pool: { data: { id: string } } };
    }) =>
      Number(trade.attributes.volume_in_usd) > 150000
      && trade.attributes.token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      && trade.relationships.pool.data.id === '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b')).toBe(true);

    expect(tokenTradesResponse.statusCode).toBe(200);
    expect(tokenTradesResponse.json().meta).toEqual({
      network: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]));
    expect(tokenTradesResponse.json().data.every((trade: { attributes: { token_address: string } }) =>
      trade.attributes.token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true);

    expect(filteredTokenTradesResponse.statusCode).toBe(200);
    expect(filteredTokenTradesResponse.json().data.length).toBeGreaterThan(0);
    expect(filteredTokenTradesResponse.json().data.every((trade: { attributes: { volume_in_usd: string } }) =>
      Number(trade.attributes.volume_in_usd) > 150000)).toBe(true);
  });

  it('rejects malformed onchain trade parameters explicitly', async () => {
    const invalidPoolTokenResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/trades?token=0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });
    const malformedPoolThresholdResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/trades?trade_volume_in_usd_greater_than=abc',
    });
    const malformedTokenThresholdResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?trade_volume_in_usd_greater_than=abc',
    });
    const malformedPoolTokenResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/trades?token=not-an-address',
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

    expect(malformedPoolTokenResponse.statusCode).toBe(400);
    expect(malformedPoolTokenResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid onchain address: not-an-address',
    });
  });

  it('returns pool-level onchain OHLCV with timeframe controls and currency/token semantics', async () => {
    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/ohlcv/hour',
    });
    const aggregatedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/ohlcv/hour?aggregate=2&limit=2',
    });
    const beforeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/ohlcv/hour?before_timestamp=1714741200&limit=2',
    });
    const tokenCurrencyResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/ohlcv/hour?currency=token&token=0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
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
          pool_address: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
          timeframe: 'hour',
          aggregate: 1,
          currency: 'usd',
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

    expect(aggregatedResponse.statusCode).toBe(200);
    expect(aggregatedResponse.json().data.attributes.aggregate).toBe(2);
    expect(aggregatedResponse.json().data.attributes.ohlcv_list).toHaveLength(2);

    expect(beforeResponse.statusCode).toBe(200);
    expect(beforeResponse.json().data.attributes.ohlcv_list).toHaveLength(2);
    expect(beforeResponse.json().data.attributes.ohlcv_list.every((entry: { timestamp: number }) =>
      entry.timestamp <= 1714741200)).toBe(true);

    expect(tokenCurrencyResponse.statusCode).toBe(400);
    expect(tokenCurrencyResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });

    expect(emptyIntervalsResponse.statusCode).toBe(200);
    const emptySeries = emptyIntervalsResponse.json().data.attributes.ohlcv_list;
    expect(emptySeries.length).toBeGreaterThan(1);
    expect(emptySeries.every((entry: { volume_usd: number }) => typeof entry.volume_usd === 'number')).toBe(true);
  });

  it('returns token-level onchain OHLCV aggregated from discoverable token pools', async () => {
    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/ohlcv/hour',
    });
    const aggregateResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/ohlcv/hour?aggregate=2&limit=2&before_timestamp=1714741200',
    });
    const inactiveSourceResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/ohlcv/day?include_inactive_source=true&include_empty_intervals=true',
    });
    const tokenPoolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/pools?page=1',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(baselineResponse.json()).toMatchObject({
      data: {
        type: 'ohlcv',
        attributes: {
          network: 'eth',
          token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          timeframe: 'hour',
          aggregate: 1,
          include_inactive_source: false,
        },
      },
    });
    const baselineBody = baselineResponse.json().data.attributes;
    expect(baselineBody.source_pools).toEqual([
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    ]);
    expect(new Set(baselineBody.source_pools)).toEqual(new Set([
      tokenPoolsResponse.json().data[1].id,
    ]));

    expect(aggregateResponse.statusCode).toBe(200);
    expect(aggregateResponse.json().data.attributes.aggregate).toBe(2);
    expect(aggregateResponse.json().data.attributes.ohlcv_list).toHaveLength(2);
    expect(aggregateResponse.json().data.attributes.ohlcv_list.every((entry: { timestamp: number }) =>
      entry.timestamp <= 1714741200)).toBe(true);

    expect(inactiveSourceResponse.statusCode).toBe(200);
    const inactiveBody = inactiveSourceResponse.json().data.attributes;
    expect(inactiveBody.include_inactive_source).toBe(true);
    expect(inactiveBody.source_pools).toEqual([
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    expect(new Set(inactiveBody.source_pools)).toEqual(new Set(
      tokenPoolsResponse.json().data.map((pool: { id: string }) => pool.id),
    ));
    expect(inactiveBody.ohlcv_list.length).toBeGreaterThan(0);
  });

  it('keeps canonical identity aligned across coin list, search, market, detail, contract, treasury, and registry routes', async () => {
    const [coinsListResponse, searchResponse, marketsResponse, detailResponse, contractResponse, treasuryByCoinResponse, treasuryDetailResponse, exchangesListResponse, exchangeDetailResponse, derivativesListResponse, derivativesDetailResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/coins/list?include_platform=true' }),
      getApp().inject({ method: 'GET', url: '/search?query=eth' }),
      getApp().inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&ids=ethereum,bitcoin' }),
      getApp().inject({ method: 'GET', url: '/coins/ethereum?localization=false&tickers=false&community_data=false&developer_data=false' }),
      getApp().inject({ method: 'GET', url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false' }),
      getApp().inject({ method: 'GET', url: '/companies/public_treasury/bitcoin' }),
      getApp().inject({ method: 'GET', url: '/public_treasury/strategy' }),
      getApp().inject({ method: 'GET', url: '/exchanges/list' }),
      getApp().inject({ method: 'GET', url: '/exchanges/binance' }),
      getApp().inject({ method: 'GET', url: '/derivatives/exchanges/list' }),
      getApp().inject({ method: 'GET', url: '/derivatives/exchanges/binance_futures' }),
    ]);

    expect(coinsListResponse.statusCode).toBe(200);
    expect(searchResponse.statusCode).toBe(200);
    expect(marketsResponse.statusCode).toBe(200);
    expect(detailResponse.statusCode).toBe(200);
    expect(contractResponse.statusCode).toBe(200);
    expect(treasuryByCoinResponse.statusCode).toBe(200);
    expect(treasuryDetailResponse.statusCode).toBe(200);
    expect(exchangesListResponse.statusCode).toBe(200);
    expect(exchangeDetailResponse.statusCode).toBe(200);
    expect(derivativesListResponse.statusCode).toBe(200);
    expect(derivativesDetailResponse.statusCode).toBe(200);

    const coinsListBody = coinsListResponse.json();
    const searchBody = searchResponse.json();
    const marketsBody = marketsResponse.json();
    const detailBody = detailResponse.json();
    const contractBody = contractResponse.json();
    const treasuryByCoinBody = treasuryByCoinResponse.json();
    const treasuryDetailBody = treasuryDetailResponse.json();
    const exchangesListBody = exchangesListResponse.json();
    const exchangeDetailBody = exchangeDetailResponse.json();
    const derivativesListBody = derivativesListResponse.json();
    const derivativesDetailBody = derivativesDetailResponse.json();

    const ethereumListRow = coinsListBody.find((coin: { id: string }) => coin.id === 'ethereum');
    expect(ethereumListRow).toMatchObject({
      id: 'ethereum',
      symbol: 'eth',
      name: 'Ethereum',
    });
    expect(ethereumListRow.platforms).toEqual(expect.any(Object));

    expect(searchBody.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ethereum', symbol: 'eth', name: 'Ethereum' }),
    ]));
    expect(marketsBody).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ethereum', symbol: 'eth', name: 'Ethereum' }),
      expect.objectContaining({ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }),
    ]));
    expect(detailBody).toMatchObject({ id: 'ethereum', symbol: 'eth', name: 'Ethereum' });
    expect(contractBody).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USD Coin' });
    expect(treasuryByCoinBody).toMatchObject({ coin_id: 'bitcoin' });
    expect(treasuryByCoinBody.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_id: 'strategy' }),
    ]));
    expect(treasuryDetailBody).toMatchObject({ id: 'strategy' });
    expect(treasuryDetailBody.holdings).toEqual(expect.arrayContaining([
      expect.objectContaining({ coin_id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }),
    ]));
    expect(exchangesListBody).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'binance', name: 'Binance' }),
    ]));
    expect(exchangeDetailBody).toMatchObject({ id: 'binance', name: 'Binance' });
    expect(derivativesListBody).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'binance_futures', name: 'Binance Futures' }),
    ]));
    expect(derivativesDetailBody).toMatchObject({ id: 'binance_futures', name: 'Binance Futures' });
  });

  it('aligns token lists, contract routes, and address casing with canonical coin identity', async () => {
    const [tokenListResponse, coinsListResponse, lowercaseContractResponse, uppercaseContractResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/token_lists/ethereum/all.json' }),
      getApp().inject({ method: 'GET', url: '/coins/list?include_platform=true' }),
      getApp().inject({ method: 'GET', url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false' }),
      getApp().inject({ method: 'GET', url: '/coins/ethereum/contract/0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48?localization=false&tickers=false&community_data=false&developer_data=false' }),
    ]);

    expect(tokenListResponse.statusCode).toBe(200);
    expect(coinsListResponse.statusCode).toBe(200);
    expect(lowercaseContractResponse.statusCode).toBe(200);
    expect(uppercaseContractResponse.statusCode).toBe(200);

    const tokenListBody = tokenListResponse.json();
    const coinsListBody = coinsListResponse.json();
    const lowercaseContractBody = lowercaseContractResponse.json();
    const uppercaseContractBody = uppercaseContractResponse.json();

    expect(Array.isArray(tokenListBody.tokens)).toBe(true);
    const usdcToken = tokenListBody.tokens.find((token: { extensions?: { geckoId?: string } }) => token.extensions?.geckoId === 'usd-coin');
    expect(usdcToken).toBeDefined();

    const usdcCoin = coinsListBody.find((coin: { id: string }) => coin.id === 'usd-coin');
    expect(usdcCoin).toBeDefined();
    expect(usdcCoin.platforms).toEqual(expect.any(Object));

    expect(lowercaseContractBody).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USD Coin' });
    expect(uppercaseContractBody).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USD Coin' });
    expect(uppercaseContractBody.id).toBe(lowercaseContractBody.id);
    expect(uppercaseContractBody.symbol).toBe(lowercaseContractBody.symbol);
    expect(uppercaseContractBody.name).toBe(lowercaseContractBody.name);
    expect(usdcToken.extensions.geckoId).toBe(lowercaseContractBody.id);
  });

  it('returns token list data for an asset platform', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/token_lists/ethereum/all.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'OpenGecko Ethereum Token List',
      tokens: [
        expect.objectContaining({
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          name: 'USD Coin',
          symbol: 'USDC',
          extensions: { geckoId: 'usd-coin' },
        }),
      ],
    });
  });

  it('returns seeded coins with optional platform data', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/list?include_platform=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(8);
    expect(response.json()).toEqual(expect.arrayContaining([
      {
        id: 'bitcoin',
        name: 'Bitcoin',
        platforms: {},
        symbol: 'btc',
      },
      {
        id: 'ethereum',
        name: 'Ethereum',
        platforms: {},
        symbol: 'eth',
      },
      {
        id: 'usd-coin',
        name: 'USD Coin',
        platforms: {
          ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        },
        symbol: 'usdc',
      },
      {
        id: 'chainlink',
        name: 'Chainlink',
        platforms: {},
        symbol: 'link',
      },
    ]));
  });

  it('negotiates gzip compression for responses above the threshold without changing body semantics', async () => {
    await app?.close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        responseCompressionThresholdBytes: 64,
      },
      startBackgroundJobs: false,
    });

    const compressedResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/list?include_platform=true',
      headers: {
        'accept-encoding': 'gzip',
      },
    });
    const uncompressedResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/list?include_platform=true',
    });

    expect(compressedResponse.statusCode).toBe(200);
    expect(uncompressedResponse.statusCode).toBe(200);
    expect(compressedResponse.headers['content-encoding']).toBe('gzip');
    expect(Number(compressedResponse.headers['content-length'] ?? 0)).toBeGreaterThan(0);
    expect(String(compressedResponse.headers.vary ?? '')).toContain('Accept-Encoding');
    expect(JSON.parse(gunzipSync(compressedResponse.rawPayload).toString('utf8'))).toEqual(uncompressedResponse.json());
  });

  it('keeps unrelated non-hot endpoint bodies stable when compression is not negotiated', async () => {
    await app?.close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    const negotiatedResponse = await getApp().inject({
      method: 'GET',
      url: '/exchange_rates',
      headers: {
        'accept-encoding': 'gzip',
      },
    });
    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/exchange_rates',
    });

    expect(negotiatedResponse.statusCode).toBe(200);
    expect(baselineResponse.statusCode).toBe(200);
    if (negotiatedResponse.headers['content-encoding'] === 'gzip') {
      expect(JSON.parse(gunzipSync(negotiatedResponse.rawPayload).toString('utf8'))).toEqual(baselineResponse.json());
    } else {
      expect(negotiatedResponse.json()).toEqual(baselineResponse.json());
    }
  });

  it('returns market search results', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search?query=eth',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.searchEth);
  });

  it('returns FTS-backed category search results', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search?query=stable',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.searchStable);
  });

  it('returns grouped trending search results with nested coin items', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('coins');
    expect(body).toHaveProperty('nfts');
    expect(body).toHaveProperty('categories');
    expect(Array.isArray(body.coins)).toBe(true);
    expect(Array.isArray(body.nfts)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
    expect(body.coins[0].item.id).toBe('bitcoin');
    expect(typeof body.coins[0].item.coin_id).toBe('number');
    expect(body.coins[0].item.name).toBe('Bitcoin');
    expect(body.coins[0].item.symbol).toBe('btc');
    expect(typeof body.coins[0].item.market_cap_rank === 'number' || body.coins[0].item.market_cap_rank === null).toBe(true);
    expect(body.coins.map((entry: { item: { id: string } }) => entry.item.id)).toContain('ethereum');
    expect(body.nfts).toEqual([]);
    expect(body.categories[0]).toMatchObject(contractFixtures.searchTrending.categories[0]);
    expect(body.categories[1]).toMatchObject(contractFixtures.searchTrending.categories[1]);
    expect(body.coins[0]).toHaveProperty('item');
    expect(Array.isArray(body.nfts)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
  });

  it('supports deterministic show_max truncation for trending search groups', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.coins).toHaveLength(1);
    expect(body.categories).toHaveLength(1);
    expect(body.nfts).toEqual([]);
    expect(body.coins[0].item.id).toBe('bitcoin');
    expect(body.categories[0].name).toBe('Smart Contract Platform');
  });

  it('keeps empty trending groups as arrays when show_max is zero', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=0',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      coins: [],
      nfts: [],
      categories: [],
    });
  });

  it('returns global market aggregates', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        active_cryptocurrencies: 8,
        markets: 4,
        total_market_cap: {
          usd: 0,
        },
        total_volume: expect.objectContaining({
          usd: expect.any(Number),
        }),
      },
    });
  });

  it('returns global defi aggregates in a data envelope with stable finite-or-null fields', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global/decentralized_finance_defi',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(typeof body.data.defi_market_cap).toBe('number');
    expect(typeof body.data.eth_market_cap).toBe('number');
    expect(typeof body.data.trading_volume_24h).toBe('number');
    expect(body.data.top_coin_name === null || typeof body.data.top_coin_name === 'string').toBe(true);
    expect(body.data.defi_to_eth_ratio === null || typeof body.data.defi_to_eth_ratio === 'number').toBe(true);
    expect(body.data.defi_dominance === null || typeof body.data.defi_dominance === 'number').toBe(true);
    expect(body.data.top_coin_defi_dominance === null || typeof body.data.top_coin_defi_dominance === 'number').toBe(true);

    for (const [key, value] of Object.entries(body.data)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value)).toBe(true);
      } else {
        expect(value === null || typeof value === 'string').toBe(true);
      }

      expect(key).not.toBe('');
    }
  });

  it('returns a named global market cap chart series payload for the requested window', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global/market_cap_chart?vs_currency=usd&days=7',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      market_cap_chart: expect.any(Array),
    });
    expect(body.market_cap_chart.length).toBeGreaterThan(0);
    expect(body.market_cap_chart[0]).toHaveLength(2);
    expect(typeof body.market_cap_chart[0][0]).toBe('number');
    expect(typeof body.market_cap_chart[0][1]).toBe('number');
    expect(body.market_cap_chart.at(-1)[0]).toBeGreaterThanOrEqual(body.market_cap_chart[0][0]);
  });

  it('validates missing required params for global market cap chart', async () => {
    const missingVsCurrencyResponse = await getApp().inject({
      method: 'GET',
      url: '/global/market_cap_chart?days=7',
    });
    const missingDaysResponse = await getApp().inject({
      method: 'GET',
      url: '/global/market_cap_chart?vs_currency=usd',
    });

    expect(missingVsCurrencyResponse.statusCode).toBe(400);
    expect(missingVsCurrencyResponse.json()).toMatchObject({
      error: 'invalid_request',
    });

    expect(missingDaysResponse.statusCode).toBe(400);
    expect(missingDaysResponse.json()).toMatchObject({
      error: 'invalid_request',
    });
  });

  it('returns coin market rows', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&sparkline=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({
      id: 'bitcoin',
      current_price: 85000,
      image: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png',
      sparkline_in_7d: {
        price: [85000],
      },
    });
  });

  it('hydrates missing images only for explicit trusted asset identities', async () => {
    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'bitcoin'))
      .run();

    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'usd-coin'))
      .run();

    await getApp().db.db
      .insert(coins)
      .values({
        id: 'wrapped-bitcoin',
        symbol: 'wbtc',
        name: 'Wrapped Bitcoin',
        apiSymbol: 'wrapped-bitcoin',
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: JSON.stringify({ en: 'Wrapped Bitcoin fixture.' }),
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: 99,
        genesisDate: null,
        platformsJson: JSON.stringify({
          ethereum: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
          solana: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
        }),
        status: 'active',
        createdAt: new Date('2026-03-20T00:00:00.000Z'),
        updatedAt: new Date('2026-03-20T00:00:00.000Z'),
      })
      .onConflictDoNothing()
      .run();

    const marketsResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,usd-coin,wrapped-bitcoin',
    });
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/usd-coin',
    });

    expect(marketsResponse.statusCode).toBe(200);
    expect(detailResponse.statusCode).toBe(200);

    expect(marketsResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'bitcoin',
        image: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png',
      }),
      expect.objectContaining({
        id: 'usd-coin',
        image: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
      }),
      expect.objectContaining({
        id: 'wrapped-bitcoin',
        image: null,
      }),
    ]));

    expect(detailResponse.json().image).toEqual({
      thumb: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
      small: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
      large: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
    });
  });

  it('keeps frontend-critical asset images coherent across list and detail surfaces', async () => {
    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'bitcoin'))
      .run();

    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'ripple'))
      .run();

    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'dogecoin'))
      .run();

    const marketsResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ripple,dogecoin',
    });

    const bitcoinDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin',
    });

    const rippleDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/ripple',
    });

    const dogecoinDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/dogecoin',
    });

    expect(marketsResponse.statusCode).toBe(200);
    expect(bitcoinDetailResponse.statusCode).toBe(200);
    expect(rippleDetailResponse.statusCode).toBe(200);
    expect(dogecoinDetailResponse.statusCode).toBe(200);

    expect(marketsResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'bitcoin',
        image: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png',
      }),
      expect.objectContaining({
        id: 'ripple',
        image: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/xrp/info/logo.png',
      }),
      expect.objectContaining({
        id: 'dogecoin',
        image: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/dogecoin/info/logo.png',
      }),
    ]));

    expect(bitcoinDetailResponse.json().image).toEqual({
      thumb: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png',
      small: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png',
      large: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png',
    });
    expect(rippleDetailResponse.json().image).toEqual({
      thumb: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/xrp/info/logo.png',
      small: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/xrp/info/logo.png',
      large: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/xrp/info/logo.png',
    });
    expect(dogecoinDetailResponse.json().image).toEqual({
      thumb: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/dogecoin/info/logo.png',
      small: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/dogecoin/info/logo.png',
      large: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/dogecoin/info/logo.png',
    });
  });

  it('refuses to hydrate assets from unsupported or ambiguous platform mappings', async () => {
    await getApp().db.db
      .insert(coins)
      .values([
        {
          id: 'test-solana-token',
          symbol: 'tst',
          name: 'Test Solana Token',
          apiSymbol: 'test-solana-token',
          hashingAlgorithm: null,
          blockTimeInMinutes: null,
          categoriesJson: '[]',
          descriptionJson: JSON.stringify({ en: 'Unsupported non-EVM token fixture.' }),
          linksJson: '{}',
          imageThumbUrl: null,
          imageSmallUrl: null,
          imageLargeUrl: null,
          marketCapRank: 150,
          genesisDate: null,
          platformsJson: JSON.stringify({
            solana: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
          }),
          status: 'active',
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-20T00:00:00.000Z'),
        },
        {
          id: 'test-multi-platform-token',
          symbol: 'tmpt',
          name: 'Test Multi Platform Token',
          apiSymbol: 'test-multi-platform-token',
          hashingAlgorithm: null,
          blockTimeInMinutes: null,
          categoriesJson: '[]',
          descriptionJson: JSON.stringify({ en: 'Ambiguous multi-platform fixture.' }),
          linksJson: '{}',
          imageThumbUrl: null,
          imageSmallUrl: null,
          imageLargeUrl: null,
          marketCapRank: 151,
          genesisDate: null,
          platformsJson: JSON.stringify({
            ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            solana: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
          }),
          status: 'active',
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-20T00:00:00.000Z'),
        },
      ])
      .onConflictDoNothing()
      .run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=test-solana-token,test-multi-platform-token',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'test-solana-token',
        image: null,
      }),
      expect.objectContaining({
        id: 'test-multi-platform-token',
        image: null,
      }),
    ]));
  });

  it('omits sparkline_in_7d when sparkline is false on coin market rows', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&sparkline=false',
    });

    expect(response.statusCode).toBe(200);
    expect('sparkline_in_7d' in response.json()[0]).toBe(false);
  });

  it('preserves sub-cent current_price values by default', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=btc&ids=usd-coin',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0]).toMatchObject({
      id: 'usd-coin',
    });
    expect(response.json()[0].current_price).toBeGreaterThan(0);
    expect(response.json()[0].current_price).toBeLessThan(0.001);
  });

  it('supports market category filters and extra price change windows', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&category=smart-contract-platform&price_change_percentage=24h,7d',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(0);
    expect(response.json()).toEqual([]);
  });

  it('keeps market filtering and order deterministic across repeated requests', async () => {
    const [firstResponse, secondResponse, pageOneResponse, pageTwoResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=market_cap_desc&ids=bitcoin,cardano,ethereum',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=market_cap_desc&ids=bitcoin,cardano,ethereum',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=2&page=1',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=2&page=2',
      }),
    ]);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(firstResponse.json().map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'cardano', 'ethereum']);
    expect(secondResponse.json()).toEqual(firstResponse.json());

    expect(pageOneResponse.statusCode).toBe(200);
    expect(pageTwoResponse.statusCode).toBe(200);
    expect(pageOneResponse.json().map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'cardano']);
    expect(pageTwoResponse.json().map((row: { id: string }) => row.id)).toEqual(['chainlink', 'dogecoin']);
  });

  it('isolates coins markets cache entries by pagination, ordering, filters, sparkline windows, and precision-sensitive flags', async () => {
    const getMarketRowsSpy = vi.spyOn(catalogModule, 'getMarketRows');
    const marketsCallCount = () => getMarketRowsSpy.mock.calls.filter(
      ([, vsCurrency, filters]) => {
        if (vsCurrency !== 'usd' && vsCurrency !== 'btc') {
          return false;
        }

        return !filters?.status;
      },
    ).length;

    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&ids=bitcoin,cardano,ethereum',
    });
    const baselineCalls = marketsCallCount();
    const repeatedBaselineResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?ids=ethereum,cardano,bitcoin&order=market_cap_desc&vs_currency=usd',
    });
    const pageOneResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=2&page=1',
    });
    const repeatedPageOneResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?order=market_cap_desc&page=1&vs_currency=usd&per_page=2',
    });
    const pageTwoResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=2&page=2',
    });
    const sparklineWindowResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&per_page=1&page=1&sparkline=true&price_change_percentage=24h,7d',
    });
    const noSparklineResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&per_page=1&page=1',
    });
    const precisionResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=btc&ids=usd-coin&precision=2',
    });
    const categoryResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&category=smart-contract-platform&price_change_percentage=24h,7d',
    });
    const repeatedCategoryResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?price_change_percentage=7d,24h&category=smart-contract-platform&vs_currency=usd',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(repeatedBaselineResponse.statusCode).toBe(200);
    expect(pageOneResponse.statusCode).toBe(200);
    expect(repeatedPageOneResponse.statusCode).toBe(200);
    expect(pageTwoResponse.statusCode).toBe(200);
    expect(sparklineWindowResponse.statusCode).toBe(200);
    expect(noSparklineResponse.statusCode).toBe(200);
    expect(precisionResponse.statusCode).toBe(200);
    expect(categoryResponse.statusCode).toBe(200);
    expect(repeatedCategoryResponse.statusCode).toBe(200);

    expect(repeatedBaselineResponse.json()).toEqual(baselineResponse.json());
    expect(baselineResponse.json().map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'cardano', 'ethereum']);
    expect(repeatedPageOneResponse.json()).toEqual(pageOneResponse.json());
    expect(pageOneResponse.json().map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'cardano']);
    expect(pageTwoResponse.json().map((row: { id: string }) => row.id)).toEqual(['chainlink', 'dogecoin']);
    expect(new Set([
      ...pageOneResponse.json().map((row: { id: string }) => row.id),
      ...pageTwoResponse.json().map((row: { id: string }) => row.id),
    ]).size).toBe(4);

    const sparklineRow = sparklineWindowResponse.json()[0];
    const noSparklineRow = noSparklineResponse.json()[0];
    expect(sparklineRow).toHaveProperty('sparkline_in_7d');
    expect(sparklineRow.sparkline_in_7d).toHaveProperty('price');
    expect(sparklineRow).toHaveProperty('price_change_percentage_24h_in_currency');
    expect(sparklineRow).toHaveProperty('price_change_percentage_7d_in_currency');
    expect('sparkline_in_7d' in noSparklineRow).toBe(false);
    expect('price_change_percentage_24h_in_currency' in noSparklineRow).toBe(false);
    expect('price_change_percentage_7d_in_currency' in noSparklineRow).toBe(false);

    expect(precisionResponse.json()).toEqual([
      expect.objectContaining({
        id: 'usd-coin',
        current_price: 0,
      }),
    ]);
    expect(repeatedCategoryResponse.json()).toEqual(categoryResponse.json());
    expect(categoryResponse.json()).toEqual([]);
    expect(baselineCalls).toBeGreaterThan(0);
    expect(marketsCallCount() - baselineCalls).toBe(6);
  });

  it('invalidates simple price and coins markets hot caches together after a shared data revision', async () => {
    const state = getApp().marketDataRuntimeState;
    const getMarketRowsSpy = vi.spyOn(catalogModule, 'getMarketRows');
    await getApp().ready();
    const originalRevision = state.hotDataRevision;

    const countSharedAssetCalls = () => getMarketRowsSpy.mock.calls.filter(
      ([, vsCurrency, filters]) => vsCurrency === 'usd'
        && Array.isArray(filters?.ids)
        && filters.ids.length === 1
        && filters.ids[0] === 'bitcoin',
    ).length;

    const simpleBefore = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const marketsBefore = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });
    const callsAfterWarm = countSharedAssetCalls();

    const simpleCached = await getApp().inject({
      method: 'GET',
      url: '/simple/price?vs_currencies=usd&ids=bitcoin',
    });
    const marketsCached = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?ids=bitcoin&vs_currency=usd',
    });

    expect(simpleBefore.statusCode).toBe(200);
    expect(marketsBefore.statusCode).toBe(200);
    expect(simpleCached.json()).toEqual(simpleBefore.json());
    expect(marketsCached.json()).toEqual(marketsBefore.json());
    expect(countSharedAssetCalls()).toBe(callsAfterWarm);
    expect(state.hotDataRevision).toBe(originalRevision);

    state.hotDataRevision += 1;

    const simpleAfterRevision = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const marketsAfterRevision = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(simpleAfterRevision.statusCode).toBe(200);
    expect(marketsAfterRevision.statusCode).toBe(200);
    expect(simpleAfterRevision.json()).toEqual(simpleBefore.json());
    expect(marketsAfterRevision.json()).toEqual(marketsBefore.json());
    expect(countSharedAssetCalls()).toBe(callsAfterWarm + 4);
  });

  it('invalidates hot caches when onReady bootstrap first makes hot data visible without background runtime', async () => {
    await getApp().close();
    app = undefined;

    const bootstrapApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'bootstrap-only.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    app = bootstrapApp;

    const state = getApp().marketDataRuntimeState;
    const getMarketRowsSpy = vi.spyOn(catalogModule, 'getMarketRows');
    const countSharedAssetCalls = () => getMarketRowsSpy.mock.calls.filter(
      ([, vsCurrency, filters]) => vsCurrency === 'usd'
        && Array.isArray(filters?.ids)
        && filters.ids.length === 1
        && filters.ids[0] === 'bitcoin',
    ).length;

    expect(state.initialSyncCompleted).toBe(false);
    expect(state.hotDataRevision).toBe(0);

    await getApp().ready();

    expect(state.initialSyncCompleted).toBe(true);
    expect(state.hotDataRevision).toBe(1);

    const warmCallCountBeforeRequests = countSharedAssetCalls();

    const simpleAfterBootstrap = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const marketsAfterBootstrap = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(simpleAfterBootstrap.statusCode).toBe(200);
    expect(simpleAfterBootstrap.json()).toEqual({
      bitcoin: {
        usd: marketsAfterBootstrap.json()[0].current_price,
      },
    });
    expect(marketsAfterBootstrap.statusCode).toBe(200);
    expect(marketsAfterBootstrap.json()).toEqual([
      expect.objectContaining({
        id: 'bitcoin',
        current_price: 85000,
      }),
    ]);
    expect(countSharedAssetCalls()).toBe(warmCallCountBeforeRequests + 2);
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
    const { createDatabase } = await import('../src/db/client');
    const { marketSnapshots } = await import('../src/db/schema');
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

    db.client.close();
  });

  it('reuses preloaded chart series for market rows', async () => {
    const getCanonicalCloseSeriesSpy = vi.spyOn(candleStore, 'getCanonicalCloseSeries');
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&per_page=3&page=1&sparkline=true&price_change_percentage=24h,7d',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(3);
    expect(getCanonicalCloseSeriesSpy).toHaveBeenCalledTimes(3);
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
  });

  it('supports mover duration, tolerates trailing-empty mover windows, and validates invalid mover params explicitly', async () => {
    const validResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&duration=24h&top_coins=300&price_change_percentage=24h',
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
    expect(body.coins.length).toBe(8);
    expect(body.coins[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      symbol: expect.any(String),
      name: expect.any(String),
    }));
    const activated = body.coins.map((row: { activated_at: number }) => row.activated_at);
    expect(activated.every((value: number | null) => value === null || Number.isFinite(value))).toBe(true);
    expect(activated).toEqual([...activated].sort((left, right) => right - left));
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
      id: 'bitcoin',
    });

    expect(paginationResponse.statusCode).toBe(200);
    expect(paginationResponse.json()).toHaveLength(1);
    expect(paginationResponse.json()[0]).toMatchObject({
      id: 'cardano',
    });
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
      'dogecoin',
      'cardano',
      'ethereum',
      'bitcoin',
    ]);
  });

  it('keeps representative pagination boundaries deterministic across coin, exchange, and onchain category families', async () => {
    const [
      coinMarketsPageOne,
      coinMarketsPageTwo,
      exchangesPageOne,
      exchangesPageTwo,
      onchainCategoriesPageOne,
      onchainCategoriesPageTwo,
    ] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&per_page=2&page=1' }),
      getApp().inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&per_page=2&page=2' }),
      getApp().inject({ method: 'GET', url: '/exchanges?per_page=1&page=1' }),
      getApp().inject({ method: 'GET', url: '/exchanges?per_page=1&page=2' }),
      getApp().inject({ method: 'GET', url: '/onchain/categories?sort=h24_volume_usd_desc&page=1' }),
      getApp().inject({ method: 'GET', url: '/onchain/categories?sort=h24_volume_usd_desc&page=2' }),
    ]);

    expect(coinMarketsPageOne.statusCode).toBe(200);
    expect(coinMarketsPageTwo.statusCode).toBe(200);
    const coinPageOneIds = coinMarketsPageOne.json().map((coin: { id: string }) => coin.id);
    const coinPageTwoIds = coinMarketsPageTwo.json().map((coin: { id: string }) => coin.id);
    expect(coinPageOneIds).toEqual(['bitcoin', 'cardano']);
    expect(coinPageTwoIds).toEqual(['chainlink', 'dogecoin']);
    expect(new Set([...coinPageOneIds, ...coinPageTwoIds]).size).toBe(4);

    expect(exchangesPageOne.statusCode).toBe(200);
    expect(exchangesPageTwo.statusCode).toBe(200);
    const exchangePageOneIds = exchangesPageOne.json().map((exchange: { id: string }) => exchange.id);
    const exchangePageTwoIds = exchangesPageTwo.json().map((exchange: { id: string }) => exchange.id);
    expect(exchangePageOneIds).toEqual(['binance']);
    expect(exchangePageTwoIds).toEqual(['coinbase']);
    expect(new Set([...exchangePageOneIds, ...exchangePageTwoIds]).size).toBe(2);

    expect(onchainCategoriesPageOne.statusCode).toBe(200);
    expect(onchainCategoriesPageTwo.statusCode).toBe(200);
    expect(onchainCategoriesPageOne.json().data.map((category: { id: string }) => category.id)).toEqual(['stablecoins']);
    expect(onchainCategoriesPageTwo.json().data.map((category: { id: string }) => category.id)).toEqual(['smart-contract-platform']);
  });

  it('returns a detailed coin payload', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.coinDetail);
  });

  it('supports optional coin detail flags and omits market data when requested', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin?market_data=false&localization=false&community_data=false&developer_data=false&sparkline=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      description: {
        en: 'Bitcoin imported from binance market discovery.',
      },
      market_data: null,
      community_data: null,
      developer_data: null,
    });
  });

  it('keeps equivalent compact and rich resources on the same null-vs-omitted policy', async () => {
    const [coinMarketsResponse, coinDetailResponse, exchangeListResponse, exchangeDetailResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&ids=bitcoin' }),
      getApp().inject({
        method: 'GET',
        url: '/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({ method: 'GET', url: '/exchanges?per_page=1&page=2' }),
      getApp().inject({ method: 'GET', url: '/exchanges/binance' }),
    ]);

    const compactCoin = coinMarketsResponse.json()[0];
    const richCoin = coinDetailResponse.json();
    const compactExchange = exchangeListResponse.json()[0];
    const richExchange = exchangeDetailResponse.json();

    expect(compactCoin.current_price).not.toBeNull();
    expect(richCoin.market_data).not.toBeNull();
    expect(compactCoin.roi).toBeNull();
    expect(richCoin.public_notice).toBeNull();

    expect(typeof compactExchange.description).toBe(typeof richExchange.description);
    expect(compactExchange.description).toBe('');
    expect(richExchange.description).toBe('');
    expect(typeof compactExchange.year_established).toBe(typeof richExchange.year_established);
    expect(compactExchange.year_established).toBeNull();
    expect(richExchange.year_established).toBeNull();
    expect(compactExchange).not.toHaveProperty('facebook_url');
    expect(richExchange).toHaveProperty('facebook_url', null);
  });

  it('returns richer default coin detail sections', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum?sparkline=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'ethereum',
      localization: {
        en: 'Ethereum',
      },
      detail_platforms: {},
      community_data: {
        twitter_followers: null,
      },
      developer_data: {
        forks: null,
        code_additions_deletions_4_weeks: {
          additions: null,
          deletions: null,
        },
      },
      community_score: null,
      developer_score: null,
      liquidity_score: null,
      public_interest_score: null,
      public_interest_stats: {
        alexa_rank: null,
        bing_matches: null,
      },
      market_data: {
        high_24h: {
          usd: 2000,
        },
        low_24h: {
          usd: 2000,
        },
        sparkline_7d: {
          price: [2000],
        },
      },
    });
  });

  it('supports category detail flags on coin detail responses', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum?include_categories_details=true&dex_pair_format=symbol',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().categories_details).toEqual([]);
  });

  it('includes seeded tickers in default coin detail responses', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tickers.length).toBeGreaterThanOrEqual(3);
    expect(response.json().tickers[0]).toMatchObject({
      base: 'BTC',
      target: 'USDT',
      market: {
        identifier: 'binance',
      },
      trade_url: 'https://www.binance.com/trade/BTC-USDT',
    });
  });

  it('returns coin tickers with exchange metadata', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/tickers?include_exchange_logo=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'Bitcoin',
    });
    expect(response.json().tickers.length).toBeGreaterThanOrEqual(2);
    expect(response.json().tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        base: 'BTC',
        target: 'USDT',
        coin_id: 'bitcoin',
        last: 85000,
        market: expect.objectContaining({
          name: 'Binance',
          identifier: 'binance',
        }),
      }),
      expect.objectContaining({
        base: 'BTC',
        target: 'USDT',
        coin_id: 'bitcoin',
        last: 85000,
        market: expect.objectContaining({
          name: 'Coinbase',
          identifier: 'coinbase',
        }),
      }),
    ]));
  });

  it('filters and orders coin tickers', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/tickers?exchange_ids=coinbase&order=volume_asc',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tickers).toHaveLength(1);
    expect(response.json().tickers[0]).toMatchObject({
      market: {
        identifier: 'coinbase',
      },
      target: 'USDT',
    });
  });

  it('returns coin history, chart, and ohlc data', async () => {
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
    expect(historyBody.market_data).toBeNull();

    expect(chartResponse.statusCode).toBe(200);
    expect(chartResponse.json()).toEqual({
      prices: [
        [1774483200000, 85000],
      ],
      market_caps: [
        [1774483200000, null],
      ],
      total_volumes: [
        [1774483200000, 425000000],
      ],
    });

    expect(maxChartResponse.statusCode).toBe(200);
    expect(maxChartResponse.json().prices).toEqual([
      [1774483200000, 85000],
    ]);

    expect(rangeChartResponse.statusCode).toBe(200);
    expect(rangeChartResponse.json()).toMatchObject({
      prices: [],
      market_caps: [],
      total_volumes: [],
    });

    expect(ohlcResponse.statusCode).toBe(200);
    expect(ohlcResponse.json()).toEqual([
      [1774483200000, 85000, 85000, 85000, 85000],
    ]);
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
      circulating_supply: expect.any(Array),
    });
    expect(totalBody).toEqual({
      total_supply: expect.any(Array),
    });

    for (const [seriesKey, body] of [
      ['circulating_supply', circulatingBody] as const,
      ['total_supply', totalBody] as const,
    ]) {
      expect(body[seriesKey].length).toBeGreaterThan(0);
      const timestamps = body[seriesKey].map((sample: number[]) => sample[0]);
      expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));

      for (const sample of body[seriesKey]) {
        expect(sample).toHaveLength(2);
        expect(typeof sample[0]).toBe('number');
        expect(typeof sample[1]).toBe('number');
        expect(Number.isFinite(sample[1])).toBe(true);
      }
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

    for (const [seriesKey, body] of [
      ['circulating_supply', circulatingResponse.json()] as const,
      ['total_supply', totalResponse.json()] as const,
    ]) {
      expect(body).toHaveProperty(seriesKey);
      expect(body[seriesKey]).toEqual([]);
    }
  });

  it('returns categories and contract-address variants', async () => {
    const categoriesListResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/categories/list',
    });
    const categoriesResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/categories?order=name_desc',
    });
    const contractResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const contractChartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart?vs_currency=usd&days=7&interval=daily',
    });
    const contractRangeResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800&interval=weekly',
    });

    expect(categoriesListResponse.statusCode).toBe(200);
    expect(categoriesListResponse.json()).toMatchObject(contractFixtures.categoriesList);

    expect(categoriesResponse.statusCode).toBe(200);
    expect(categoriesResponse.json()[0]).toMatchObject({
      id: 'stablecoins',
    });

    expect(contractResponse.statusCode).toBe(200);
    expect(contractResponse.json()).toMatchObject({
      id: 'usd-coin',
      symbol: 'usdc',
      name: 'USD Coin',
      platforms: {
        ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      },
    });

    expect(contractChartResponse.statusCode).toBe(200);
    expect(contractChartResponse.json()).toMatchObject({
      prices: [
        [1774483200000, 1],
      ],
    });

    expect(contractRangeResponse.statusCode).toBe(200);
    expect(contractRangeResponse.json()).toMatchObject({
      prices: [],
      market_caps: [],
      total_volumes: [],
    });
  });

  it('returns not found for unknown chart-style coin routes', async () => {
    const chartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/not-a-coin/market_chart?vs_currency=usd&days=7',
    });
    const ohlcResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/not-a-coin/ohlc?vs_currency=usd&days=7',
    });

    expect(chartResponse.statusCode).toBe(404);
    expect(chartResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });

    expect(ohlcResponse.statusCode).toBe(404);
    expect(ohlcResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });
  });

  it('returns not found for unknown ranged ohlc coin routes', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/not-a-coin/ohlc/range?vs_currency=usd&from=1773792000&to=1774310400',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });
  });
});
