import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildApp, getDatabaseStartupLogContext } from '../src/app';
import { coins, exchanges, exchangeVolumePoints, marketSnapshots } from '../src/db/schema';
import type { MetricsRegistry } from '../src/services/metrics';
import type { MarketDataRuntimeState } from '../src/services/market-runtime-state';
import * as candleStore from '../src/services/candle-store';
import * as catalogModule from '../src/modules/catalog';
import * as ccxtProvider from '../src/providers/ccxt';
import * as defillamaProvider from '../src/providers/defillama';
import * as sqdProvider from '../src/providers/sqd';
import * as startupPrewarmModule from '../src/services/startup-prewarm';
import * as currencyRatesModule from '../src/services/currency-rates';
import { resetCurrencyApiSnapshotForTests } from '../src/services/currency-rates';
import contractFixtures from './fixtures/contract-fixtures.json';

const currentDailyBucket = () => candleStore.toDailyBucket(Date.now()).getTime();
const defaultDefillamaTokenPriceMock = () => vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
const defaultDefillamaOnchainCatalogMocks = () => {
  vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
};

function resetCcxtProviderMocks() {
  const mockedFetchExchangeMarkets = ccxtProvider.fetchExchangeMarkets as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeTickers = ccxtProvider.fetchExchangeTickers as ReturnType<typeof vi.fn>;
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
  mockedFetchExchangeOHLCV.mockResolvedValue([]);
  mockedFetchExchangeNetworks.mockResolvedValue([]);
  mockedCloseExchangePool.mockResolvedValue(undefined);
}

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

  async function expectSeededBootstrapRuntimeSnapshot(
    targetApp: FastifyInstance,
    expectedReason: string,
  ) {
    const [simplePriceResponse, marketsResponse, detailResponse, diagnosticsResponse] = await Promise.all([
      targetApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      }),
      targetApp.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
      }),
      targetApp.inject({
        method: 'GET',
        url: '/coins/bitcoin?community_data=false&developer_data=false&localization=false&market_data=true&sparkline=false&tickers=false',
      }),
      targetApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      }),
    ]);

    expect(simplePriceResponse.statusCode).toBe(200);
    expect(simplePriceResponse.json()).toEqual({
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
          market_cap: null,
          total_volume: expect.any(Number),
          last_updated: expect.any(String),
        }),
      ]),
    );

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: 'bitcoin',
      market_data: {
        current_price: { usd: expect.any(Number) },
        market_cap: { usd: null },
        total_volume: { usd: expect.any(Number) },
        last_updated: expect.any(String),
      },
    });

    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json().data).toMatchObject({
      readiness: {
        state: 'starting',
        initial_sync_completed: false,
      },
      degraded: {
        active: false,
        stale_live_enabled: true,
        reason: expectedReason,
        validation_override: {
          active: true,
          mode: 'seeded_bootstrap',
          reason: expectedReason,
        },
      },
      hot_paths: {
        shared_market_snapshot: {
          source_class: 'seeded_bootstrap',
        },
      },
    });

    const simplePriceUsd = simplePriceResponse.json().bitcoin.usd;
    const bitcoinMarketRow = marketsResponse.json().find((entry: { id: string }) => entry.id === 'bitcoin');
    expect(bitcoinMarketRow).toMatchObject({
      current_price: expect.any(Number),
      last_updated: expect.any(String),
    });
    expect(bitcoinMarketRow.current_price).toBe(simplePriceUsd);
    expect(detailResponse.json().market_data.current_price.usd).toBe(simplePriceUsd);
    expect(detailResponse.json().market_data.last_updated).toBe(bitcoinMarketRow.last_updated);
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

  it('serves the CoinGecko-compatible ping response', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/ping',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(contractFixtures.ping);
  });

  it('serves /health with the same canonical liveness payload as /ping', async () => {
    const [healthResponse, pingResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/health',
      }),
      getApp().inject({
        method: 'GET',
        url: '/ping',
      }),
    ]);

    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toEqual(contractFixtures.ping);
    expect(healthResponse.json()).toEqual(pingResponse.json());
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
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/chain_coverage',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data.platform_counts.total');
    expect(body).toHaveProperty('data.confidence.exact');
    expect(body).toHaveProperty('data.confidence.heuristic');
    expect(body).toHaveProperty('data.confidence.unresolved');
    expect(body).toHaveProperty('data.contract_mapping.active_coins');
    expect(typeof body.data.platform_counts.total).toBe('number');
    expect(typeof body.data.confidence.exact).toBe('number');
    expect(typeof body.data.confidence.heuristic).toBe('number');
    expect(typeof body.data.confidence.unresolved).toBe('number');
    expect(typeof body.data.contract_mapping.active_coins).toBe('number');
  });

  it('returns ohlcv worker lag and failure metrics', async () => {
    await getApp().ready();
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
    await getApp().ready();
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
          degraded: false,
          zero_live_completed_boot: false,
          validation_override_active: false,
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

  it('returns simple prices with optional market fields', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      bitcoin: {
        usd: 85000,
        eur: expect.any(Number),
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

  it('returns explicit fresh-boot price errors when no usable live snapshots exist', async () => {
    const freshBootApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'fresh-boot-simple-price.db'),
        ccxtExchanges: [],
        logLevel: 'silent',
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
    });

    try {
      const [simplePriceResponse, tokenPriceResponse] = await Promise.all([
        freshBootApp.inject({
          method: 'GET',
          url: '/simple/price?ids=bitcoin&vs_currencies=usd',
        }),
        freshBootApp.inject({
          method: 'GET',
          url: '/simple/token_price/eth?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
        }),
      ]);

      expect(simplePriceResponse.statusCode).toBe(503);
      expect(simplePriceResponse.json()).toEqual({
        error: 'service_unavailable',
        message: 'No usable live market snapshots are available for simple/price.',
      });
      expect(freshBootApp.marketDataRuntimeState.initialSyncCompleted).toBe(true);
      expect(freshBootApp.marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots).toBe(true);

      expect(tokenPriceResponse.statusCode).toBe(503);
      expect(tokenPriceResponse.json()).toEqual({
        error: 'service_unavailable',
        message: 'No usable live market snapshots are available for simple/token_price.',
      });

      const diagnosticsResponse = await freshBootApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data.readiness).toMatchObject({
        state: 'ready',
        initial_sync_completed: true,
        degraded: false,
        zero_live_completed_boot: true,
        validation_override_active: false,
      });
    } finally {
      await freshBootApp.close();
    }
  });

  it('keeps direct simple-price cache warming non-fatal for fresh zero-live startup prewarm paths', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'fresh-boot-prewarm.db'),
        ccxtExchanges: [],
        logLevel: 'silent',
        startupPrewarmBudgetMs: 5_000,
      },
      startBackgroundJobs: false,
    });

    try {
      const pingResponse = await prewarmApp.inject({
        method: 'GET',
        url: '/ping',
      });

      expect(pingResponse.statusCode).toBe(200);
      expect(prewarmApp.marketDataRuntimeState.initialSyncCompleted).toBe(true);
      expect(prewarmApp.marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots).toBe(true);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.targetResults).toEqual([
        expect.objectContaining({
          id: 'simple_price_bitcoin_usd',
          status: 'completed',
          cacheSurface: 'simple_price',
        }),
      ]);

      const simplePriceResponse = await prewarmApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      });

      expect(simplePriceResponse.statusCode).toBe(503);
      expect(simplePriceResponse.json()).toEqual({
        error: 'service_unavailable',
        message: 'No usable live market snapshots are available for simple/price.',
      });
    } finally {
      await prewarmApp.close();
    }
  });

  it('accepts canonical platform aliases for token-price, contract, and token-list routes', async () => {
    const [tokenPriceResponse, contractResponse, tokenListResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/simple/token_price/eth?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/eth/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({
        method: 'GET',
        url: '/token_lists/eth/all.json',
      }),
    ]);

    expect(tokenPriceResponse.statusCode).toBe(200);
    expect(tokenPriceResponse.json()).toEqual(contractFixtures.tokenPrice);
    expect(contractResponse.statusCode).toBe(200);
    expect(contractResponse.json()).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USDC' });
    expect(tokenListResponse.statusCode).toBe(200);
    expect(tokenListResponse.json()).toMatchObject({
      name: 'OpenGecko Ethereum Token List',
      keywords: ['opengecko', 'ethereum'],
      tokens: [
        expect.objectContaining({
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          extensions: { geckoId: 'usd-coin' },
        }),
      ],
    });
  });

  it('accepts multiple alias variants for contract routes and returns 404 for truly unknown platforms', async () => {
    const [ethResponse, ethereumResponse, erc20Response, missingResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/coins/eth/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/erc20/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/nonexistent-chain/contract/0x0000000000000000000000000000000000000000?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
    ]);

    expect(ethResponse.statusCode).toBe(200);
    expect(ethereumResponse.statusCode).toBe(200);
    expect(erc20Response.statusCode).toBe(200);
    expect(ethResponse.json()).toMatchObject({ id: 'usd-coin' });
    expect(ethereumResponse.json()).toMatchObject({ id: 'usd-coin' });
    expect(erc20Response.json()).toMatchObject({ id: 'usd-coin' });
    expect(ethResponse.json()).toEqual(ethereumResponse.json());
    expect(erc20Response.json()).toEqual(ethereumResponse.json());

    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({
      error: 'not_found',
      message: 'Contract not found: 0x0000000000000000000000000000000000000000',
    });
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

  it('returns canonical asset platforms without legacy alias ids', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/asset_platforms',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'ethereum',
        chain_identifier: 1,
        name: 'Ethereum',
        shortname: 'eth',
      }),
      expect.objectContaining({
        id: 'solana',
        chain_identifier: 101,
        name: 'Solana',
        shortname: 'sol',
      }),
    ]));

    const ids = new Set(body.map((row: { id: string }) => row.id));
    expect(ids.has('eth')).toBe(false);
    expect(ids.has('bsc')).toBe(false);
    expect(ids.has('sol')).toBe(false);
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
      expect.objectContaining({
        id: 'binance',
        name: 'Binance',
      }),
      expect.objectContaining({
        id: 'coinbase',
      }),
      expect.objectContaining({
        id: 'kraken',
        name: 'Kraken',
      }),
    ]));

    expect(inactiveListResponse.statusCode).toBe(200);
    expect(inactiveListResponse.json()).toEqual([]);

    expect(exchangesResponse.statusCode).toBe(200);
    expect(exchangesResponse.json()).toHaveLength(2);
    expect(exchangesResponse.json().every((exchange: {
      id: string;
      name: string;
      trade_volume_24h_btc: number | null;
    }) => (
      typeof exchange.id === 'string'
      && typeof exchange.name === 'string'
      && (exchange.trade_volume_24h_btc === null || typeof exchange.trade_volume_24h_btc === 'number')
    ))).toBe(true);

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: 'binance',
      name: 'Binance',
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
    const exchangeDetail = detailResponse.json();
    expect(exchangeDetail.year_established === null || typeof exchangeDetail.year_established === 'number').toBe(true);
    expect(exchangeDetail.country === null || typeof exchangeDetail.country === 'string').toBe(true);
    expect(exchangeDetail.twitter_handle === null || typeof exchangeDetail.twitter_handle === 'string').toBe(true);

    expect(volumeChartResponse.statusCode).toBe(200);
    const volumeChart = volumeChartResponse.json();
    expect(volumeChart.length).toBeGreaterThan(0);
    const timestamps = volumeChart.map((entry: number[]) => entry[0]);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));

    // Each entry is [timestamp, volumeBtc]
    for (const entry of volumeChart) {
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe('number');
      expect(typeof entry[1]).toBe('number');
    }
  });

  it('returns hourly exchange volume buckets for short ranges', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart?days=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBeGreaterThan(0);

    const timestamps = body.map((tuple: number[]) => tuple[0]);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));

    for (const tuple of body) {
      expect(tuple).toHaveLength(2);
      expect(Number.isFinite(tuple[1])).toBe(true);
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

  it('returns not_found for unknown exchange volume routes', async () => {
    const [chartResponse, rangeResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/exchanges/not-an-exchange/volume_chart?days=7',
      }),
      getApp().inject({
        method: 'GET',
        url: '/exchanges/not-an-exchange/volume_chart/range?from=0&to=4102444800',
      }),
    ]);

    expect(chartResponse.statusCode).toBe(404);
    expect(chartResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Exchange not found: not-an-exchange',
    });

    expect(rangeResponse.statusCode).toBe(404);
    expect(rangeResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Exchange not found: not-an-exchange',
    });
  });

  it('preserves live refresh ownership for exchange volume windows and explicit ranges', async () => {
    const now = new Date();
    const appDb = getApp().db;
    appDb.db.insert(exchanges).values({
      id: 'binance',
      name: 'Binance',
      yearEstablished: 2017,
      country: 'Cayman Islands',
      description: 'Temporary seeded exchange row for volume ownership assertions.',
      url: 'https://www.binance.com/',
      imageUrl: 'https://coin-images.coingecko.com/markets/images/52/small/binance.jpg?1706864274',
      hasTradingIncentive: false,
      trustScore: 10,
      trustScoreRank: 1,
      tradeVolume24hBtc: 139508.1218951856,
      tradeVolume24hBtcNormalized: null,
      facebookUrl: 'https://www.facebook.com/binanceexchange',
      redditUrl: 'https://www.reddit.com/r/binance/',
      telegramUrl: '',
      slackUrl: '',
      otherUrlJson: JSON.stringify([
        'https://medium.com/binanceexchange',
        'https://steemit.com/@binanceexchange',
      ]),
      twitterHandle: 'binance',
      centralised: true,
      publicNotice: null,
      alertNotice: null,
      updatedAt: new Date(now.getTime() - (37 * 60 * 60 * 1000)),
    }).onConflictDoNothing().run();

    const cutoff = new Date(now.getTime() - (24 * 60 * 60 * 1000));
    appDb.db.delete(exchangeVolumePoints).where(eq(exchangeVolumePoints.exchangeId, 'binance')).run();
    appDb.db.insert(exchangeVolumePoints).values([
      {
        exchangeId: 'binance',
        timestamp: new Date(now.getTime() - (36 * 60 * 60 * 1000)),
        volumeBtc: 10,
      },
      {
        exchangeId: 'binance',
        timestamp: new Date(now.getTime() - (23 * 60 * 60 * 1000)),
        volumeBtc: 20,
      },
      {
        exchangeId: 'binance',
        timestamp: new Date(now.getTime() - (2 * 60 * 60 * 1000)),
        volumeBtc: 30,
      },
      {
        exchangeId: 'binance',
        timestamp: new Date(now.getTime() - (30 * 60 * 1000)),
        volumeBtc: 40,
      },
    ]).run();

    const [oneDayResponse, sevenDayResponse, rangeResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart?days=1',
      }),
      getApp().inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart?days=7',
      }),
      getApp().inject({
        method: 'GET',
        url: `/exchanges/binance/volume_chart/range?from=${Math.floor((now.getTime() - (3 * 60 * 60 * 1000)) / 1000)}&to=${Math.floor(now.getTime() / 1000)}`,
      }),
    ]);

    expect(oneDayResponse.statusCode).toBe(200);
    expect(oneDayResponse.json()).toEqual(expect.arrayContaining([
      [new Date(now.getTime() - (23 * 60 * 60 * 1000)).getTime(), 20],
      [new Date(now.getTime() - (2 * 60 * 60 * 1000)).getTime(), 30],
      [new Date(now.getTime() - (30 * 60 * 1000)).getTime(), 40],
    ]));
    expect(oneDayResponse.json().every((entry: [number, number]) => entry[0] >= cutoff.getTime())).toBe(true);

    expect(sevenDayResponse.statusCode).toBe(200);
    expect(sevenDayResponse.json()).toEqual(expect.arrayContaining([
      [new Date(now.getTime() - (36 * 60 * 60 * 1000)).getTime(), 10],
      [new Date(now.getTime() - (23 * 60 * 60 * 1000)).getTime(), 20],
      [new Date(now.getTime() - (2 * 60 * 60 * 1000)).getTime(), 30],
      [new Date(now.getTime() - (30 * 60 * 1000)).getTime(), 40],
    ]));
    expect(sevenDayResponse.json().length).toBeGreaterThanOrEqual(4);
    expect(sevenDayResponse.json()).toEqual(
      [...sevenDayResponse.json()].sort((left: [number, number], right: [number, number]) => left[0] - right[0]),
    );

    expect(rangeResponse.statusCode).toBe(200);
    expect(rangeResponse.json()).toEqual(expect.arrayContaining([
      [new Date(now.getTime() - (2 * 60 * 60 * 1000)).getTime(), 30],
      [new Date(now.getTime() - (30 * 60 * 1000)).getTime(), 40],
    ]));
    expect(rangeResponse.json().every((entry: [number, number]) => entry[0] >= now.getTime() - (3 * 60 * 60 * 1000))).toBe(true);
    expect(rangeResponse.json()).toEqual(
      [...rangeResponse.json()].sort((left: [number, number], right: [number, number]) => left[0] - right[0]),
    );
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
    const exchangesBody = exchangesResponse.json();
    expect(exchangesBody.data).toHaveLength(1);
    expect(exchangesBody.data[0]).toMatchObject(contractFixtures.derivativesExchanges[0]);
    expect(exchangesBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20' });
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
    const detailBody = detailResponse.json();
    expect(detailBody.data).toMatchObject({
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
    expect(detailBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20' });
    expect(detailBody.data).not.toHaveProperty('tickers');

    expect(includeTickersResponse.statusCode).toBe(200);
    const includeTickersBody = includeTickersResponse.json();
    expect(includeTickersBody.data).toMatchObject({
      id: 'binance_futures',
      name: 'Binance Futures',
    });
    expect(includeTickersBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20' });
    expect(includeTickersBody.data).toHaveProperty('tickers');
    expect(includeTickersBody.data.tickers).toEqual(expect.arrayContaining([
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
    const derivativesBody = response.json();
    expect(derivativesBody.data).toMatchObject(contractFixtures.derivatives);
    expect(derivativesBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20', note: 'Derivatives data is seeded fixture, not live' });
    for (const ticker of derivativesBody.data) {
      expect(ticker.funding_rate).not.toBeUndefined();
      expect(ticker.open_interest_btc).not.toBeNull();
      expect(ticker.trade_volume_24h_btc).not.toBeNull();
      expect(ticker.last_traded_at).not.toBeNull();
    }
  });

  it('documents exchange data divergences in docs analysis', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const filePath = resolve(process.cwd(), 'docs/analysis/exchange-divergences.md');
    expect(existsSync(filePath)).toBe(true);

    const contents = readFileSync(filePath, 'utf8');
    expect(contents).toContain('| endpoint | field | description |');
    expect(contents).toContain('/exchanges/{id}/tickers');
    expect(contents).toContain('/derivatives');
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
    expect(entitiesResponse.json()).toMatchObject({
      data: [contractFixtures.treasuryEntities[1]],
      meta: expect.objectContaining({ fixture: true }),
    });

    expect(groupedResponse.statusCode).toBe(200);
    expect(groupedResponse.json()).toMatchObject({
      data: contractFixtures.companyTreasuryBitcoin,
      meta: expect.objectContaining({ fixture: true }),
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      data: contractFixtures.treasuryEntityDetail,
      meta: expect.objectContaining({ fixture: true }),
    });
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
    expect(chartResponse.json()).toMatchObject({
      data: {
        holdings: expect.any(Array),
        holding_value_in_usd: expect.any(Array),
      },
      meta: expect.objectContaining({ fixture: true }),
    });
    expect(chartResponse.json().data.holdings.length).toBeGreaterThan(0);
    expect(chartResponse.json().data.holding_value_in_usd.length).toBeGreaterThan(0);

    expect(chartWithIntervalsResponse.statusCode).toBe(200);
    expect(chartWithIntervalsResponse.json()).toMatchObject({
      data: {
        holdings: expect.any(Array),
        holding_value_in_usd: expect.any(Array),
      },
      meta: expect.objectContaining({ fixture: true }),
    });
    expect(chartWithIntervalsResponse.json().data.holdings.length).toBeGreaterThan(0);
    expect(chartWithIntervalsResponse.json().data.holding_value_in_usd.length).toBeGreaterThan(0);

    expect(transactionsResponse.statusCode).toBe(200);
    expect(transactionsResponse.json()).toEqual({
      data: contractFixtures.treasuryTransactionHistory,
      meta: expect.objectContaining({ fixture: true }),
    });
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
    expect(poolDataSpy).toHaveBeenCalledTimes(poolCallCountBeforeRequest);
    expect(dexVolumesSpy).toHaveBeenCalledTimes(dexVolumeCallCountBeforeRequest);
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
    expect(tokenDetailIncludedResponse.json().data.attributes.price_usd).toBe(1);
    expect(tokenDetailIncludedResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        attributes: {
          top_pools: [
            '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
            '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          ],
          inactive_source: false,
          composition: {
            pools: expect.arrayContaining([
              expect.objectContaining({
                pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
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
          id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
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
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);
    expect(tokenPoolsResponse.json().data.every((pool: { attributes: { base_token_address: string; quote_token_address: string } }) =>
      pool.attributes.base_token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      || pool.attributes.quote_token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true);
  });

  it('proves the token detail route surfaces live defillama pricing and falls back to seeded pricing when live pricing fails', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValueOnce({
      'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
        price: 1.234567,
        symbol: 'USDC',
        decimals: 6,
        confidence: 0.99,
        timestamp: 1710000000,
      },
    });

    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token',
        attributes: expect.objectContaining({
          price_usd: 1.234567,
        }),
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

    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValueOnce(null);

    const fallbackResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });

    expect(fallbackResponse.statusCode).toBe(200);
    expect(fallbackResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token',
        attributes: expect.objectContaining({
          price_usd: 1,
        }),
      },
    });
    expect(fallbackResponse.json().data.attributes.top_pools).toEqual([
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);
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
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue({
      'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
        price: 1.0025,
        symbol: 'USDC',
        decimals: 6,
        confidence: 0.99,
        timestamp: 1710000000,
      },
      'ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': {
        price: 85250,
        symbol: 'WBTC',
        decimals: 8,
        confidence: 0.98,
        timestamp: 1710000000,
      },
    });

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
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1.0025',
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
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1.0025',
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
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1.0025',
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

  it('prefers live aggregate fields for onchain simple token prices when live pricing succeeds', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue({
      'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
        price: 1.1111,
        symbol: 'USDC',
        decimals: 6,
        confidence: 0.99,
        timestamp: 1710000000,
      },
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'USDC-WETH',
          tvlUsd: 123456789,
          pool: 'live-usdc-weth',
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          ],
          volumeUsd1d: 22222222,
          volumeUsd7d: 0,
        },
        {
          chain: 'Ethereum',
          project: 'curve',
          symbol: 'USDC-USDT',
          tvlUsd: 98765432,
          pool: 'live-usdc-usdt',
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xdac17f958d2ee523a2206206994597c13d831ec7',
          ],
          volumeUsd1d: 33333333,
          volumeUsd7d: 0,
        },
      ],
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      total24h: 166666665,
      total7d: null,
      total30d: null,
      totalAllTime: null,
      protocols: [
        {
          name: 'Uniswap V3',
          total24h: 88888888,
        },
        {
          name: 'Curve',
          total24h: 77777777,
        },
      ],
    });

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?include_market_cap=true&include_24hr_vol=true&include_total_reserve_in_usd=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: 'eth',
        type: 'simple_token_price',
        attributes: {
          token_prices: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1.1111',
          },
          market_cap_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '222222221',
          },
          h24_volume_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '55555555',
          },
          total_reserve_in_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '222222221',
          },
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
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
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
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue({
      'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
        price: 1.0025,
        symbol: 'USDC',
        decimals: 6,
        confidence: 0.99,
        timestamp: 1710000000,
      },
      'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': {
        price: 3495.12,
        symbol: 'WETH',
        decimals: 18,
        confidence: 0.97,
        timestamp: 1710000000,
      },
    });

    const tokenInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
    });
    const poolInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/info',
    });
    const poolInfoIncludedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/info?include=pool',
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
          price_usd: 1.0025,
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
    expect(poolInfoResponse.json().data.map((entry: { id: string }) => entry.id)).toContain('eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
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
        address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        symbol: 'WETH',
      },
    });

    expect(poolInfoIncludedResponse.statusCode).toBe(200);
    expect(poolInfoIncludedResponse.json()).toMatchObject({
      data: expect.any(Array),
      included: [
        expect.objectContaining({
          id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
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
        price_usd: 1.0025,
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

  it('proves token info falls back to seeded metadata pricing when defillama live pricing is unavailable', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: 'eth_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token_info',
        attributes: {
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
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
  });

  it('surfaces live pricing for a non-hardcoded ethereum token info route and keeps seeded fallback when live pricing is unavailable', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices')
      .mockResolvedValueOnce({
        'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7': {
          price: 1.0099,
          symbol: 'USDT',
          decimals: 6,
          confidence: 0.98,
          timestamp: 1710000000,
        },
      })
      .mockResolvedValueOnce(null);

    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xdac17f958d2ee523a2206206994597c13d831ec7/info',
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json()).toMatchObject({
      data: {
        id: 'eth_0xdac17f958d2ee523a2206206994597c13d831ec7',
        type: 'token_info',
        attributes: {
          address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
          symbol: 'USDT',
          coingecko_coin_id: 'tether',
          price_usd: 1.0099,
        },
      },
    });

    const fallbackResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xdac17f958d2ee523a2206206994597c13d831ec7/info',
    });

    expect(fallbackResponse.statusCode).toBe(200);
    expect(fallbackResponse.json()).toMatchObject({
      data: {
        id: 'eth_0xdac17f958d2ee523a2206206994597c13d831ec7',
        type: 'token_info',
        attributes: {
          address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
          symbol: 'USDT',
          coingecko_coin_id: 'tether',
          price_usd: 1,
        },
      },
    });
  });

  it('validates onchain token info and recently updated token info parameters explicitly', async () => {
    const unknownTokenInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0x0000000000000000000000000000000000000001/info',
    });
    const invalidPoolInfoIncludeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/info?include=dex',
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
    const originalVitest = process.env.VITEST;
    process.env.VITEST = 'false';

    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockImplementation(async (poolAddress) => {
      const normalized = poolAddress.toLowerCase();
      if (normalized === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640') {
        return [
          {
            blockNumber: 100,
            blockTimestamp: 1710000100,
            txHash: '0xlivetx1',
            amount0: '-220000',
            amount1: '220500',
            sqrtPriceX96: '0',
            liquidity: '0',
            tick: 0,
          },
          {
            blockNumber: 99,
            blockTimestamp: 1710000000,
            txHash: '0xlivetx2',
            amount0: '-151000',
            amount1: '151000',
            sqrtPriceX96: '0',
            liquidity: '0',
            tick: 0,
          },
        ];
      }

      if (normalized === '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7') {
        return [
          {
            blockNumber: 98,
            blockTimestamp: 1709999200,
            txHash: '0xlivetx3',
            amount0: '-180000',
            amount1: '180050',
            sqrtPriceX96: '0',
            liquidity: '0',
            tick: 0,
          },
        ];
      }

      return null;
    });
    const poolTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades',
    });
    const filteredPoolTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?trade_volume_in_usd_greater_than=150000&token=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const pagedPoolTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?limit=1&before_timestamp=1710000000',
    });
    const tokenTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades',
    });
    const filteredTokenTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?trade_volume_in_usd_greater_than=150000',
    });
    const pagedTokenTradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?limit=1&before_timestamp=1709999200',
    });

    expect(poolTradesResponse.statusCode).toBe(200);
    expect(poolTradesResponse.json().meta).toEqual({
      network: 'eth',
      pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      source: 'live',
    });
    expect(poolTradesResponse.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'trade',
          relationships: expect.objectContaining({
            pool: {
              data: {
                type: 'pool',
                id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
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
    expect(poolTradesResponse.json().data.map((trade: { attributes: { tx_hash: string } }) => trade.attributes.tx_hash)).toEqual([
      '0xlivetx1',
      '0xlivetx2',
    ]);
    expect(poolTradesResponse.json().data.every((trade: { relationships: { pool: { data: { id: string } } } }) =>
      trade.relationships.pool.data.id === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640')).toBe(true);

    expect(filteredPoolTradesResponse.statusCode).toBe(200);
    expect(filteredPoolTradesResponse.json().data.length).toBeGreaterThan(0);
    expect(filteredPoolTradesResponse.json().data.every((trade: {
      attributes: { volume_in_usd: string; token_address: string };
      relationships: { pool: { data: { id: string } } };
    }) =>
      Number(trade.attributes.volume_in_usd) > 150000
      && trade.attributes.token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      && trade.relationships.pool.data.id === '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640')).toBe(true);

    expect(pagedPoolTradesResponse.statusCode).toBe(200);
    expect(pagedPoolTradesResponse.json().data).toHaveLength(1);
    expect(pagedPoolTradesResponse.json().data[0].attributes.block_timestamp).toBe(1710000000);

    expect(tokenTradesResponse.statusCode).toBe(200);
    expect(tokenTradesResponse.json().meta).toEqual({
      network: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      source: 'live',
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
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]));
    expect(tokenTradesResponse.json().data.every((trade: { attributes: { token_address: string } }) =>
      trade.attributes.token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true);

    expect(filteredTokenTradesResponse.statusCode).toBe(200);
    expect(filteredTokenTradesResponse.json().data.length).toBeGreaterThan(0);
    expect(filteredTokenTradesResponse.json().data.every((trade: { attributes: { volume_in_usd: string } }) =>
      Number(trade.attributes.volume_in_usd) > 150000)).toBe(true);

    expect(pagedTokenTradesResponse.statusCode).toBe(200);
    expect(pagedTokenTradesResponse.json().data).toHaveLength(1);
    expect(pagedTokenTradesResponse.json().data[0].attributes.block_timestamp).toBe(1709999200);
    process.env.VITEST = originalVitest;
  });

  it('caps SQD-backed pool trade route fetches to a route-scoped recent swap budget', async () => {
    const originalVitest = process.env.VITEST;
    process.env.VITEST = 'false';

    const sqdSpy = vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue([
      {
        blockNumber: 100,
        blockTimestamp: 1710000100,
        txHash: '0xlivetx1',
        amount0: '-220000',
        amount1: '220500',
        sqrtPriceX96: '0',
        liquidity: '0',
        tick: 0,
      },
    ]);
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?limit=20',
    });

    expect(response.statusCode).toBe(200);
    expect(sqdSpy).toHaveBeenCalledWith(
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      expect.objectContaining({
        toBlock: undefined,
        maxResults: 128,
      }),
    );

    process.env.VITEST = originalVitest;
  });

  it('rejects malformed onchain trade parameters explicitly', async () => {
    const invalidPoolTokenResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?token=0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });
    const malformedPoolThresholdResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?trade_volume_in_usd_greater_than=abc',
    });
    const malformedTokenThresholdResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?trade_volume_in_usd_greater_than=abc',
    });
    const malformedPoolLimitResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?limit=0',
    });
    const malformedTokenBeforeTimestampResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?before_timestamp=bad',
    });
    const malformedPoolTokenResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?token=not-an-address',
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

    expect(malformedPoolLimitResponse.statusCode).toBe(400);
    expect(malformedPoolLimitResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid limit value: 0',
    });

    expect(malformedTokenBeforeTimestampResponse.statusCode).toBe(400);
    expect(malformedTokenBeforeTimestampResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid before_timestamp value: bad',
    });

    expect(malformedPoolTokenResponse.statusCode).toBe(400);
    expect(malformedPoolTokenResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid onchain address: not-an-address',
    });
  });

  it('returns pool-level onchain OHLCV with timeframe controls and currency/token semantics', async () => {
    const originalVitest = process.env.VITEST;
    process.env.VITEST = 'false';

    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockImplementation(async (poolAddress) => {
      if (poolAddress.toLowerCase() !== '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640') {
        return null;
      }

      return [
        {
          blockNumber: 1,
          blockTimestamp: 1714737600,
          txHash: '0xohlcvtx1',
          amount0: '-1000',
          amount1: '1000',
          sqrtPriceX96: '0',
          liquidity: '0',
          tick: 0,
        },
        {
          blockNumber: 2,
          blockTimestamp: 1714741200,
          txHash: '0xohlcvtx2',
          amount0: '-1200',
          amount1: '1200',
          sqrtPriceX96: '0',
          liquidity: '0',
          tick: 0,
        },
        {
          blockNumber: 3,
          blockTimestamp: 1714744800,
          txHash: '0xohlcvtx3',
          amount0: '-1500',
          amount1: '1500',
          sqrtPriceX96: '0',
          liquidity: '0',
          tick: 0,
        },
        {
          blockNumber: 4,
          blockTimestamp: 1714748400,
          txHash: '0xohlcvtx4',
          amount0: '900',
          amount1: '-900',
          sqrtPriceX96: '0',
          liquidity: '0',
          tick: 0,
        },
      ];
    });
    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour',
    });
    const aggregatedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?aggregate=2&limit=2',
    });
    const beforeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?before_timestamp=1714741200&limit=2',
    });
    const tokenCurrencyResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?currency=token&token=0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
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
          pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          timeframe: 'hour',
          aggregate: 1,
          currency: 'usd',
          source: 'live',
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
    expect(baselineSeries.every((entry: { high: number; low: number; open: number; close: number; volume_usd: number }, index: number, arr: Array<{ timestamp: number }>) =>
      entry.high >= Math.max(entry.open, entry.close)
      && entry.low <= Math.min(entry.open, entry.close)
      && entry.volume_usd >= 0
      && (index === 0 || arr[index - 1]!.timestamp <= arr[index]!.timestamp))).toBe(true);

    expect(aggregatedResponse.statusCode).toBe(200);
    expect(aggregatedResponse.json().data.attributes.aggregate).toBe(2);
    expect(aggregatedResponse.json().data.attributes.ohlcv_list).toHaveLength(2);

    expect(beforeResponse.statusCode).toBe(200);
    expect(beforeResponse.json().data.attributes.ohlcv_list).toHaveLength(2);
    expect(beforeResponse.json().data.attributes.ohlcv_list.every((entry: { timestamp: number }) =>
      entry.timestamp <= 1714741200)).toBe(true);

    expect(tokenCurrencyResponse.statusCode).toBe(200);
    expect(tokenCurrencyResponse.json().data.attributes.currency).toBe('token');

    expect(emptyIntervalsResponse.statusCode).toBe(200);
    const emptySeries = emptyIntervalsResponse.json().data.attributes.ohlcv_list;
    expect(emptySeries.length).toBeGreaterThan(1);
    expect(emptySeries.every((entry: { volume_usd: number }) => typeof entry.volume_usd === 'number')).toBe(true);
    process.env.VITEST = originalVitest;
  });

  it('falls back to explicit fixture JSON for canonical pool trades and ohlcv when SQD returns null', async () => {
    const originalVitest = process.env.VITEST;
    process.env.VITEST = 'false';

    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);
    const tradesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades',
    });
    const ohlcvResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour',
    });

    expect(tradesResponse.statusCode).toBe(200);
    expect(tradesResponse.headers['content-type']).toContain('application/json');
    expect(tradesResponse.json()).toMatchObject({
      meta: {
        network: 'eth',
        pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        source: 'fixture',
      },
    });
    expect(Array.isArray(tradesResponse.json().data)).toBe(true);
    expect(tradesResponse.json().data.length).toBeGreaterThan(0);

    expect(ohlcvResponse.statusCode).toBe(200);
    expect(ohlcvResponse.headers['content-type']).toContain('application/json');
    expect(ohlcvResponse.json()).toMatchObject({
      data: {
        type: 'ohlcv',
        attributes: {
          network: 'eth',
          pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          timeframe: 'hour',
          source: 'fixture',
        },
      },
    });
    expect(ohlcvResponse.json().data.attributes.ohlcv_list.length).toBeGreaterThan(0);

    process.env.VITEST = originalVitest;
  });

  it('proves token ohlcv falls back to the degraded seeded pool set when live swaps are unavailable', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/ohlcv/day?include_inactive_source=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: 'eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:day',
        type: 'ohlcv',
        attributes: {
          network: 'eth',
          token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          timeframe: 'day',
          aggregate: 1,
          include_inactive_source: true,
          source_pools: [
            '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
            '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
          ],
        },
      },
    });
    const fallbackSeries = response.json().data.attributes.ohlcv_list;
    expect(fallbackSeries.length).toBeGreaterThan(1);
    expect(fallbackSeries.every((entry: { high: number; low: number; open: number; close: number; volume_usd: number }, index: number, arr: Array<{ timestamp: number }>) =>
      entry.high >= Math.max(entry.open, entry.close)
      && entry.low <= Math.min(entry.open, entry.close)
      && entry.volume_usd >= 0
      && (index === 0 || arr[index - 1]!.timestamp <= arr[index]!.timestamp))).toBe(true);
    expect(fallbackSeries[0]).toMatchObject({
      timestamp: expect.any(Number),
      open: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      close: expect.any(Number),
      volume_usd: expect.any(Number),
    });
  }, 15_000);

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
    expect(contractBody).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USDC' });
    expect(treasuryByCoinBody).toMatchObject({
      data: { coin_id: 'bitcoin' },
      meta: expect.objectContaining({ fixture: true }),
    });
    expect(treasuryByCoinBody.data.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_id: 'strategy' }),
    ]));
    expect(treasuryDetailBody).toMatchObject({
      data: { id: 'strategy' },
      meta: expect.objectContaining({ fixture: true }),
    });
    expect(treasuryDetailBody.data.holdings).toEqual(expect.arrayContaining([
      expect.objectContaining({ coin_id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }),
    ]));
    expect(exchangesListBody).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'binance', name: 'Binance' }),
    ]));
    expect(exchangeDetailBody).toMatchObject({ id: 'binance', name: 'Binance' });
    expect(derivativesListBody).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'binance_futures', name: 'Binance Futures' }),
    ]));
    expect(derivativesDetailBody.data).toMatchObject({ id: 'binance_futures', name: 'Binance Futures' });
    expect(derivativesDetailBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20' });
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

    expect(lowercaseContractBody).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USDC' });
    expect(uppercaseContractBody).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USDC' });
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
          name: 'USDC',
          symbol: 'USDC',
          extensions: { geckoId: 'usd-coin' },
        }),
      ],
    });
  });

  it('accepts canonical platform aliases for token lists and contract chart/detail routes', async () => {
    const [canonicalTokenListResponse, aliasTokenListResponse, aliasContractDetailResponse, aliasContractChartResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/token_lists/ethereum/all.json' }),
      getApp().inject({ method: 'GET', url: '/token_lists/eth/all.json' }),
      getApp().inject({ method: 'GET', url: '/coins/eth/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false' }),
      getApp().inject({ method: 'GET', url: '/coins/erc20/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart?vs_currency=usd&days=7' }),
    ]);

    expect(canonicalTokenListResponse.statusCode).toBe(200);
    expect(aliasTokenListResponse.statusCode).toBe(200);
    expect(aliasTokenListResponse.json()).toEqual(canonicalTokenListResponse.json());
    expect(aliasContractDetailResponse.statusCode).toBe(200);
    expect(aliasContractDetailResponse.json()).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USDC' });
    expect(aliasContractChartResponse.statusCode).toBe(200);
    expect(aliasContractChartResponse.json()).toEqual(expect.objectContaining({
      prices: expect.any(Array),
      market_caps: expect.any(Array),
      total_volumes: expect.any(Array),
    }));
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
        name: 'USDC',
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

  it('keeps large onchain trade responses readable when gzip compression is negotiated', async () => {
    const sqdSpy = vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(
      Array.from({ length: 20_000 }, (_, index) => ({
        blockNumber: 20_000_000 + index,
        blockTimestamp: 1_710_000_000 + index,
        txHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
        amount0: '-1000000',
        amount1: '285714285714285',
        sqrtPriceX96: '0',
        liquidity: '0',
        tick: 0,
      })),
    );
    const compressedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades',
      headers: {
        'accept-encoding': 'gzip',
      },
    });

    expect(compressedResponse.statusCode).toBe(200);
    expect(compressedResponse.headers['content-encoding']).toBe('gzip');

    const parsedBody = JSON.parse(gunzipSync(compressedResponse.rawPayload).toString('utf8'));
    expect(parsedBody.meta).toMatchObject({
      network: 'eth',
      pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    });
    expect(parsedBody.data.length).toBeGreaterThan(0);
    expect(parsedBody.data[0]).toMatchObject({
      type: 'trade',
      attributes: {
        tx_hash: expect.any(String),
        block_timestamp: expect.any(Number),
      },
    });
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

  it('keeps search response families bounded to 10 results each', async () => {
    await getApp().ready();

    for (let index = 0; index < 12; index += 1) {
      getApp().db.db
        .insert(exchanges)
        .values({
          id: `eth-exchange-${index}`,
          name: `ETH Exchange ${index}`,
          yearEstablished: null,
          country: null,
          description: '',
          url: `https://eth-exchange-${index}.example.com`,
          imageUrl: null,
          facebookUrl: null,
          redditUrl: null,
          telegramUrl: null,
          slackUrl: null,
          otherUrlJson: '[]',
          twitterHandle: null,
          hasTradingIncentive: false,
          centralised: true,
          publicNotice: null,
          alertNotice: null,
          trustScore: 1,
          trustScoreRank: 100 + index,
          tradeVolume24hBtc: null,
          tradeVolume24hBtcNormalized: null,
          updatedAt: new Date(`2026-03-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
        })
        .onConflictDoNothing()
        .run();
    }

    const response = await getApp().inject({
      method: 'GET',
      url: '/search?query=eth',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().coins.length).toBeLessThanOrEqual(10);
    expect(response.json().exchanges.length).toBeLessThanOrEqual(10);
    expect(response.json().categories.length).toBeLessThanOrEqual(10);
    expect(response.json().icos).toEqual([]);
    expect(response.json().nfts).toEqual([]);
  });

  it('returns FTS-backed category search results', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search?query=stable',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.searchStable);
  });

  it('keeps newly listed canonical coin ids propagated across search, list, and detail surfaces', async () => {
    const [newListingsResponse, coinsListResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/coins/list/new' }),
      getApp().inject({ method: 'GET', url: '/coins/list?include_platform=true' }),
    ]);

    expect(newListingsResponse.statusCode).toBe(200);
    expect(coinsListResponse.statusCode).toBe(200);

    const listings = newListingsResponse.json().coins as Array<{
      id: string;
      symbol: string;
      name: string;
      activated_at: number;
    }>;
    expect(listings.length).toBeGreaterThan(0);

    const newestListing = listings[0]!;
    const discoveredId = newestListing.id;
    const [searchResponse, detailResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: `/search?query=${encodeURIComponent(discoveredId)}` }),
      getApp().inject({ method: 'GET', url: `/coins/${discoveredId}?localization=false&tickers=false&community_data=false&developer_data=false` }),
    ]);

    expect(searchResponse.statusCode).toBe(200);
    expect(detailResponse.statusCode).toBe(200);
    expect(searchResponse.json().coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: newestListing.id,
        symbol: newestListing.symbol,
        name: newestListing.name,
      }),
    ]));
    expect(coinsListResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: newestListing.id,
        symbol: newestListing.symbol,
        name: newestListing.name,
      }),
    ]));
    expect(detailResponse.json()).toMatchObject({
      id: newestListing.id,
      symbol: newestListing.symbol,
      name: newestListing.name,
    });
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
    expect(body.coins[0].item.score).toBe(body.coins[0].item.market_cap_rank ?? 0);
    expect(typeof body.coins[0].item.data.market_cap === 'number' || body.coins[0].item.data.market_cap === null).toBe(true);
    expect(body.coins.map((entry: { item: { id: string } }) => entry.item.id)).toContain('ethereum');
    expect(body.coins.map((entry: { item: { market_cap_rank: number | null } }) => entry.item.market_cap_rank)).toEqual(
      [...body.coins.map((entry: { item: { market_cap_rank: number | null } }) => entry.item.market_cap_rank)]
        .sort((left, right) => {
          const rankDelta = (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);

          if (rankDelta !== 0) {
            return rankDelta;
          }

          return 0;
        }),
    );
    body.coins.forEach((entry: { item: { market_cap_rank: number | null; score: number } }) => {
      expect(entry.item.score).toBe(entry.item.market_cap_rank ?? 0);
    });
    expect(body.nfts).toEqual([]);
    expect(body.categories[0]).toMatchObject(contractFixtures.searchTrending.categories[0]);
    expect(body.categories[1]).toMatchObject(contractFixtures.searchTrending.categories[1]);
    expect(body.coins[0]).toHaveProperty('item');
    expect(Array.isArray(body.nfts)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
  });

  it('serializes trending coins in ascending runtime market_cap_rank order with nulls last', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=20',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rankedCoins = body.coins.map((entry: { item: { id: string; market_cap_rank: number | null; score: number } }) => entry.item);

    expect(rankedCoins.length).toBeGreaterThan(1);
    expect(rankedCoins).toEqual(
      [...rankedCoins].sort((left, right) => {
        const rankDelta = (left.market_cap_rank ?? Number.MAX_SAFE_INTEGER) - (right.market_cap_rank ?? Number.MAX_SAFE_INTEGER);

        if (rankDelta !== 0) {
          return rankDelta;
        }

        return left.id.localeCompare(right.id);
      }),
    );
    rankedCoins.forEach((item: { market_cap_rank: number | null; score: number }) => {
      expect(item.score).toBe(item.market_cap_rank ?? 0);
    });

    const firstNullRankIndex = rankedCoins.findIndex((item: { market_cap_rank: number | null }) => item.market_cap_rank === null);

    if (firstNullRankIndex !== -1) {
      expect(rankedCoins.slice(firstNullRankIndex).every((item: { market_cap_rank: number | null }) => item.market_cap_rank === null)).toBe(true);
    }
  });

  it('keeps runtime ordering deterministic when multiple trending coins share the same market_cap_rank', async () => {
    await getApp().ready();
    const sharedRank = 42;

    getApp().db.db
      .update(marketSnapshots)
      .set({ marketCapRank: sharedRank })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();

    getApp().db.db
      .update(marketSnapshots)
      .set({ marketCapRank: sharedRank })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=20',
    });

    expect(response.statusCode).toBe(200);
    const rankedCoins = response.json().coins.map((entry: { item: { id: string; market_cap_rank: number | null; score: number } }) => entry.item);
    const sharedRankIds = rankedCoins
      .filter((item: { market_cap_rank: number | null }) => item.market_cap_rank === sharedRank)
      .map((item: { id: string }) => item.id);

    expect(sharedRankIds).toEqual(['bitcoin', 'ethereum']);
    rankedCoins
      .filter((item: { market_cap_rank: number | null }) => item.market_cap_rank === sharedRank)
      .forEach((item: { market_cap_rank: number | null; score: number }) => {
        expect(item.score).toBe(sharedRank);
      });
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
        markets: expect.any(Number),
        total_market_cap: {
          usd: 0,
        },
        total_volume: expect.objectContaining({
          usd: expect.any(Number),
        }),
      },
    });
    expect(response.json().data.markets).toBeGreaterThan(0);
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
      error: 'invalid_parameter',
    });

    expect(missingDaysResponse.statusCode).toBe(400);
    expect(missingDaysResponse.json()).toMatchObject({
      error: 'invalid_parameter',
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
      current_price: expect.any(Number),
      image: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
    });
    expect(Array.isArray(response.json()[0].sparkline_in_7d.price)).toBe(true);
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
        activatedAt: new Date('2026-03-20T00:00:00.000Z'),
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
        image: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
      }),
      expect.objectContaining({
        id: 'usd-coin',
        image: 'http://localhost:3001/assets/chains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
      }),
      expect.objectContaining({
        id: 'wrapped-bitcoin',
        image: null,
      }),
    ]));

    expect(detailResponse.json().image).toEqual({
      thumb: 'http://localhost:3001/assets/chains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
      small: 'http://localhost:3001/assets/chains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
      large: 'http://localhost:3001/assets/chains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
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
        image: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
      }),
      expect.objectContaining({
        id: 'ripple',
        image: 'http://localhost:3001/assets/chains/xrp/logo.png',
      }),
      expect.objectContaining({
        id: 'dogecoin',
        image: 'http://localhost:3001/assets/chains/dogecoin/logo.png',
      }),
    ]));

    expect(bitcoinDetailResponse.json().image).toEqual({
      thumb: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
      small: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
      large: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
    });
    expect(rippleDetailResponse.json().image).toEqual({
      thumb: 'http://localhost:3001/assets/chains/xrp/logo.png',
      small: 'http://localhost:3001/assets/chains/xrp/logo.png',
      large: 'http://localhost:3001/assets/chains/xrp/logo.png',
    });
    expect(dogecoinDetailResponse.json().image).toEqual({
      thumb: 'http://localhost:3001/assets/chains/dogecoin/logo.png',
      small: 'http://localhost:3001/assets/chains/dogecoin/logo.png',
      large: 'http://localhost:3001/assets/chains/dogecoin/logo.png',
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
          activatedAt: new Date('2026-03-20T00:00:00.000Z'),
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
          activatedAt: new Date('2026-03-20T00:00:00.000Z'),
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
    expect(countSharedAssetCalls()).toBeGreaterThan(callsAfterWarm);
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
    expect(countSharedAssetCalls()).toBeGreaterThan(warmCallCountBeforeRequests);
  });

  it('seeds validation bootstrap-only in-memory runtime from persistent live snapshots before zero-live policy evaluation', async () => {
    await getApp().close();
    app = undefined;

    const sourceDatabasePath = join(tempDir, 'opengecko.db');
    const seededValidationApp = buildApp({
      config: {
        databaseUrl: sourceDatabasePath,
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await seededValidationApp.ready();

      const bitcoinSnapshotBefore = seededValidationApp.db.db
        .select()
        .from(marketSnapshots)
        .where(eq(marketSnapshots.coinId, 'bitcoin'))
        .get();
      const usdcCoinBefore = seededValidationApp.db.db
        .select()
        .from(coins)
        .where(eq(coins.id, 'usd-coin'))
        .get();

      expect(bitcoinSnapshotBefore?.sourceCount).toBeGreaterThan(0);
      expect(usdcCoinBefore?.platformsJson).toContain('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

      const validationApp = buildApp({
        config: {
          databaseUrl: ':memory:',
          ccxtExchanges: [],
          logLevel: 'silent',
          host: '127.0.0.1',
          port: 3102,
        },
        startBackgroundJobs: false,
      });

      try {
        await validationApp.ready();

        const bitcoinSnapshotAfter = validationApp.db.db
          .select()
          .from(marketSnapshots)
          .where(eq(marketSnapshots.coinId, 'bitcoin'))
          .get();
        const usdcCoinAfter = validationApp.db.db
          .select()
          .from(coins)
          .where(eq(coins.id, 'usd-coin'))
          .get();

        expect(bitcoinSnapshotAfter).toBeDefined();
        expect(bitcoinSnapshotAfter?.sourceCount).toBeGreaterThan(0);
        expect(usdcCoinAfter?.platformsJson).toContain('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
        expect(validationApp.marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots).toBe(false);
        expect(validationApp.marketDataRuntimeState.validationOverride).toMatchObject({
          mode: 'seeded_bootstrap',
          reason: 'validation runtime seeded from persistent live snapshots',
          snapshotSourceCountOverride: expect.any(Number),
        });

        const canonicalMarketsResponse = await validationApp.inject({
          method: 'GET',
          url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
        });

        expect(canonicalMarketsResponse.statusCode).toBe(200);
        const canonicalMarketsBody = canonicalMarketsResponse.json();
        expect(canonicalMarketsBody).toMatchObject([
          expect.objectContaining({ id: 'bitcoin', market_cap_rank: null }),
          expect.objectContaining({ id: 'ethereum', market_cap_rank: null }),
          expect.objectContaining({ id: 'solana', market_cap_rank: null }),
        ]);
        expect(canonicalMarketsResponse.json()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'solana',
            current_price: expect.any(Number),
            market_cap: null,
            total_volume: null,
          }),
        ]));
        const solanaVolume = canonicalMarketsResponse.json().find((row: { id?: string; total_volume?: number | null }) => row.id === 'solana')?.total_volume;
        expect(solanaVolume).toBeNull();

        const [simplePriceResponse, tokenPriceResponse, diagnosticsResponse] = await Promise.all([
          validationApp.inject({
            method: 'GET',
            url: '/simple/price?ids=bitcoin&vs_currencies=usd',
          }),
          validationApp.inject({
            method: 'GET',
            url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
          }),
          validationApp.inject({
            method: 'GET',
            url: '/diagnostics/runtime',
          }),
        ]);

        expect(simplePriceResponse.statusCode).toBe(200);
        expect(simplePriceResponse.json()).toEqual({
          bitcoin: {
            usd: expect.any(Number),
          },
        });
        expect(tokenPriceResponse.statusCode).toBe(200);
        expect(tokenPriceResponse.json()).toMatchObject({
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
            usd: expect.any(Number),
            usd_24h_vol: expect.any(Number),
            usd_24h_change: expect.any(Number),
            last_updated_at: expect.any(Number),
          },
        });
        expect(diagnosticsResponse.statusCode).toBe(200);
        expect(diagnosticsResponse.json().data).toMatchObject({
          readiness: {
            state: 'starting',
            initial_sync_completed: false,
          },
          degraded: {
            active: false,
            stale_live_enabled: true,
            reason: 'validation runtime seeded from persistent live snapshots',
            validation_override: {
              active: true,
              mode: 'seeded_bootstrap',
              reason: 'validation runtime seeded from persistent live snapshots',
            },
          },
          hot_paths: {
            shared_market_snapshot: {
              source_class: 'seeded_bootstrap',
            },
          },
        });
      } finally {
        await validationApp.close();
      }
    } finally {
      await seededValidationApp.close();
    }
  });

  it('uses bootstrap-only validation startup semantics for the port-3102 server profile', async () => {
    const validationServerApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: [],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3102,
      },
      startBackgroundJobs: false,
    });

    try {
      await validationServerApp.ready();

      expect(validationServerApp.marketRuntime).toBeNull();
      expect(validationServerApp.marketDataRuntimeState.validationOverride).toMatchObject({
        mode: 'seeded_bootstrap',
        reason: 'validation runtime seeded from persistent live snapshots',
      });
      expect(validationServerApp.marketDataRuntimeState.listenerBindDeferred).toBe(false);

      const diagnosticsResponse = await validationServerApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data.degraded.validation_override).toMatchObject({
        active: true,
        mode: 'seeded_bootstrap',
        reason: 'validation runtime seeded from persistent live snapshots',
      });
      expect(diagnosticsResponse.json().data.hot_paths.shared_market_snapshot.source_class).toBe('seeded_bootstrap');
    } finally {
      await validationServerApp.close();
    }
  });

  it('falls back to the canonical validation snapshot when the default persistent database is malformed', async () => {
    const originalDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db');
    const backupDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db.backup');
    let restoredDefaultDatabase = false;

    if (existsSync(originalDefaultDatabasePath)) {
      copyFileSync(originalDefaultDatabasePath, backupDefaultDatabasePath);
    }

    writeFileSync(originalDefaultDatabasePath, 'not a sqlite database');

    try {
      const freshBootApp = buildApp({
        config: {
          databaseUrl: './data/opengecko.db',
          ccxtExchanges: [],
          logLevel: 'silent',
          host: '127.0.0.1',
          port: 3001,
        },
        startBackgroundJobs: false,
      });

      try {
        await freshBootApp.ready();

        const diagnosticsResponse = await freshBootApp.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        });

        expect(diagnosticsResponse.statusCode).toBe(200);
        expect(freshBootApp.marketDataRuntimeState.validationOverride).toMatchObject({
          mode: 'off',
          reason: null,
        });
        expect(diagnosticsResponse.json().data).toMatchObject({
          readiness: {
            state: 'ready',
            initial_sync_completed: true,
            degraded: false,
            validation_override_active: false,
          },
          degraded: {
            active: false,
            stale_live_enabled: false,
            reason: null,
            validation_override: {
              active: false,
              mode: 'off',
              reason: null,
            },
          },
          hot_paths: {
            shared_market_snapshot: {
              available: false,
              source_class: 'unavailable',
              provider_count: expect.any(Number),
            },
          },
        });
        expect(existsSync(originalDefaultDatabasePath)).toBe(true);
      } finally {
        await freshBootApp.close();
      }
    } finally {
      if (existsSync(originalDefaultDatabasePath)) {
        unlinkSync(originalDefaultDatabasePath);
      }
      if (existsSync(`${originalDefaultDatabasePath}-wal`)) {
        unlinkSync(`${originalDefaultDatabasePath}-wal`);
      }
      if (existsSync(`${originalDefaultDatabasePath}-shm`)) {
        unlinkSync(`${originalDefaultDatabasePath}-shm`);
      }
      if (existsSync(backupDefaultDatabasePath)) {
        copyFileSync(backupDefaultDatabasePath, originalDefaultDatabasePath);
        unlinkSync(backupDefaultDatabasePath);
        restoredDefaultDatabase = true;
      }

      if (!restoredDefaultDatabase && existsSync(originalDefaultDatabasePath)) {
        unlinkSync(originalDefaultDatabasePath);
      }
    }
  });

  it('keeps a deterministic zero-live completed-boot contract on the isolated validation surface when no persisted live snapshots exist', { timeout: 20_000 }, async () => {
    const originalDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db');
    const backupDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db.backup');
    let restoredDefaultDatabase = false;

    if (existsSync(originalDefaultDatabasePath)) {
      copyFileSync(originalDefaultDatabasePath, backupDefaultDatabasePath);
      unlinkSync(originalDefaultDatabasePath);
    }

    try {
      const zeroLiveValidationApp = buildApp({
        config: {
          databaseUrl: ':memory:',
          ccxtExchanges: [],
          logLevel: 'silent',
          host: '127.0.0.1',
          port: 3102,
          startupPrewarmBudgetMs: 0,
        },
        startBackgroundJobs: false,
      });

      try {
        const [simplePriceResponse, tokenPriceResponse, marketsResponse, coinDetailResponse, diagnosticsResponse] = await Promise.all([
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/simple/price?ids=bitcoin&vs_currencies=usd',
          }),
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
          }),
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/coins/markets?vs_currency=usd&ids=bitcoin',
          }),
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/coins/bitcoin?tickers=false&community_data=false&developer_data=false&localization=false',
          }),
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/diagnostics/runtime',
          }),
        ]);

        expect(simplePriceResponse.statusCode).toBe(200);
        expect(simplePriceResponse.json()).toEqual({
          bitcoin: {
            usd: expect.any(Number),
          },
        });
        expect(tokenPriceResponse.statusCode).toBe(200);
        expect(tokenPriceResponse.json()).toEqual({
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
            usd: expect.any(Number),
          },
        });
        expect(marketsResponse.statusCode).toBe(200);
        expect(marketsResponse.json()).toEqual([
          expect.objectContaining({
            id: 'bitcoin',
            symbol: 'btc',
            current_price: expect.any(Number),
            market_cap: null,
            market_cap_rank: null,
            total_volume: null,
            price_change_24h: null,
            price_change_percentage_24h: null,
            last_updated: null,
          }),
        ]);
        expect(coinDetailResponse.statusCode).toBe(200);
        expect(coinDetailResponse.json()).toMatchObject({
          id: 'bitcoin',
          symbol: 'btc',
          market_data: {
            current_price: { usd: expect.any(Number) },
            total_volume: { usd: expect.any(Number) },
            last_updated: expect.any(String),
          },
          tickers: [],
          community_data: null,
          developer_data: null,
        });

        expect(zeroLiveValidationApp.marketDataRuntimeState.initialSyncCompleted).toBe(false);
        expect(zeroLiveValidationApp.marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots).toBe(false);
        expect(zeroLiveValidationApp.marketDataRuntimeState.validationOverride.mode).toBe('seeded_bootstrap');

        expect(diagnosticsResponse.statusCode).toBe(200);
        expect(diagnosticsResponse.json().data).toMatchObject({
          readiness: {
            state: 'starting',
            initial_sync_completed: false,
            degraded: false,
            zero_live_completed_boot: false,
            validation_override_active: true,
          },
          degraded: {
            active: false,
            stale_live_enabled: true,
            reason: 'validation runtime seeded from persistent live snapshots',
            validation_override: {
              active: true,
              mode: 'seeded_bootstrap',
              reason: 'validation runtime seeded from persistent live snapshots',
            },
          },
          hot_paths: {
            shared_market_snapshot: {
              available: true,
              source_class: 'seeded_bootstrap',
              provider_count: expect.any(Number),
            },
          },
        });
      } finally {
        await zeroLiveValidationApp.close();
      }
    } finally {
      if (existsSync(backupDefaultDatabasePath)) {
        renameSync(backupDefaultDatabasePath, originalDefaultDatabasePath);
        restoredDefaultDatabase = true;
      }

      if (!restoredDefaultDatabase && existsSync(originalDefaultDatabasePath) === false && existsSync(backupDefaultDatabasePath)) {
        renameSync(backupDefaultDatabasePath, originalDefaultDatabasePath);
      }
    }
  });

  it('accepts seeded-bootstrap and zero-live completed-boot override scenarios on the validation surface with success envelopes', async () => {
    const validationApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: [],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3102,
      },
      startBackgroundJobs: false,
    });

    try {
      await validationApp.ready();
      validationApp.marketDataRuntimeState.listenerBound = true;

      const seededBootstrapOverride = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'seeded_bootstrap',
          reason: 'validator seeded bootstrap',
        },
      });

      expect(seededBootstrapOverride.statusCode).toBe(200);
      expect(seededBootstrapOverride.json()).toEqual({
        data: {
          mode: 'seeded_bootstrap',
          reason: 'validator seeded bootstrap',
          cache_revision: expect.any(Number),
        },
      });

      const seededBootstrapDiagnostics = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(seededBootstrapDiagnostics.statusCode).toBe(200);
      expect(seededBootstrapDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'starting',
          initial_sync_completed: false,
          validation_override_active: true,
          zero_live_completed_boot: false,
        },
        degraded: {
          active: false,
          validation_override: {
            active: true,
            mode: 'seeded_bootstrap',
            reason: 'validator seeded bootstrap',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'seeded_bootstrap',
          },
        },
      });

      const zeroLiveOverride = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'zero_live_completed_boot',
          reason: 'validator zero live completed boot',
        },
      });

      expect(zeroLiveOverride.statusCode).toBe(200);
      expect(zeroLiveOverride.json()).toEqual({
        data: {
          mode: 'zero_live_completed_boot',
          reason: 'validator zero live completed boot',
          cache_revision: expect.any(Number),
        },
      });

      const [simplePriceResponse, zeroLiveDiagnostics] = await Promise.all([
        validationApp.inject({
          method: 'GET',
          url: '/simple/price?ids=bitcoin&vs_currencies=usd',
        }),
        validationApp.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        }),
      ]);

      expect(simplePriceResponse.statusCode).toBe(503);
      expect(simplePriceResponse.json()).toEqual({
        error: 'service_unavailable',
        message: 'No usable live market snapshots are available for simple/price.',
      });
      expect(zeroLiveDiagnostics.statusCode).toBe(200);
      expect(zeroLiveDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'ready',
          initial_sync_completed: true,
          zero_live_completed_boot: true,
          validation_override_active: true,
        },
        degraded: {
          active: false,
          stale_live_enabled: false,
          validation_override: {
            active: true,
            mode: 'zero_live_completed_boot',
            reason: 'validator zero live completed boot',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'unavailable',
          },
        },
      });
    } finally {
      await validationApp.close();
    }
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
            market_cap: null,
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

    const initialSyncModule = await import('../src/services/initial-sync');
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
    const initialSyncModule = await import('../src/services/initial-sync');
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

  it('allows background-runtime startup when fastify plugin timeout is disabled', async () => {
    const initialSyncModule = await import('../src/services/initial-sync');
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
    const startupProgressModule = await import('../src/services/startup-progress');
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
  });

  it('keeps the full trust slice coherent across stale-live transitions, cache revisions, and timestamps', async () => {
    const state = getApp().marketDataRuntimeState;
    const { createDatabase } = await import('../src/db/client');
    const { marketSnapshots } = await import('../src/db/schema');
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
      'bitcoin',
      'ethereum',
      'cardano',
      'dogecoin',
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
    expect(exchangePageOneIds).toHaveLength(1);
    expect(exchangePageTwoIds).toHaveLength(1);
    expect(exchangePageOneIds).not.toEqual(exchangePageTwoIds);
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
    expect(typeof compactExchange.description).toBe('string');
    expect(typeof richExchange.description).toBe('string');
    expect(compactExchange.year_established === null || typeof compactExchange.year_established === 'number').toBe(true);
    expect(richExchange.year_established === null || typeof richExchange.year_established === 'number').toBe(true);
    expect(compactExchange).not.toHaveProperty('facebook_url');
    expect(richExchange).toHaveProperty('facebook_url');
    expect(richExchange.facebook_url === null || typeof richExchange.facebook_url === 'string').toBe(true);
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
          usd: expect.any(Number),
        },
        low_24h: {
          usd: expect.any(Number),
        },
        sparkline_7d: {
          price: expect.any(Array),
        },
      },
    });
    expect(response.json().market_data.sparkline_7d.price.length).toBeGreaterThan(0);
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
        last: expect.any(Number),
        market: expect.objectContaining({
          name: 'Coinbase Exchange',
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
      data: [],
      meta: {
        fixture: true,
        coin_id: 'bitcoin',
        note: 'Circulating supply chart data is not available',
      },
    });
    expect(totalBody).toEqual({
      data: [],
      meta: {
        fixture: true,
        coin_id: 'bitcoin',
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
          note: expectedNote,
        },
      });
    }
  });

  it('returns categories and contract-address variants', async () => {
    const expectedDailyBucket = currentDailyBucket();

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
    expect(categoriesResponse.json().data[0]).toMatchObject({
      id: 'stablecoins',
    });

    expect(contractResponse.statusCode).toBe(200);
    expect(contractResponse.json()).toMatchObject({
      id: 'usd-coin',
      symbol: 'usdc',
      name: 'USDC',
      platforms: {
        ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      },
    });

    expect(contractChartResponse.statusCode).toBe(200);
    expect(contractChartResponse.json()).toMatchObject({
      prices: expect.any(Array),
      market_caps: expect.any(Array),
      total_volumes: expect.any(Array),
    });
    expect(contractChartResponse.json().prices.length).toBeGreaterThan(0);

    expect(contractRangeResponse.statusCode).toBe(200);
    expect(contractRangeResponse.json()).toMatchObject({
      prices: expect.arrayContaining([
        [1773446400000, 0.999],
        [1773964800000, 1],
      ]),
      market_caps: expect.arrayContaining([
        [1773446400000, 59_700_000_000],
        [1773964800000, 60_000_000_000],
      ]),
      total_volumes: expect.arrayContaining([
        [1773446400000, 5_500_000_000],
        [1773964800000, 6_000_000_000],
      ]),
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
