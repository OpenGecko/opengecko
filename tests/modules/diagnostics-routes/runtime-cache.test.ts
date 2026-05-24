import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../../src/app';
import {
  chartPoints,
  coinTickers,
  exchanges,
  exchangeVolumeSourcePoints,
  marketChartSourcePoints,
  marketSnapshots,
  ohlcvCandles,
  ohlcvSyncTargets,
} from '../../../src/db/schema';
import { upsertCanonicalOhlcvCandle } from '../../../src/services/candle-store';
import * as ccxtProvider from '../../../src/providers/ccxt';
import * as defillamaProvider from '../../../src/providers/defillama';
import * as sqdProvider from '../../../src/providers/sqd';
import { resetCurrencyApiSnapshotForTests } from '../../../src/services/currency-rates';
import {
  COINS_MARKETS_ROUTE_CACHE_POLICY,
  SIMPLE_PRICE_ROUTE_CACHE_POLICY,
} from '../../../src/modules/route-cache-policies';
import {
  ingestCoinHistoryReplay,
  type RawCoinHistoryReplay,
} from '../../../src/services/coin-history-ingestion';
import { syncCoinHistorySnapshots } from '../../../src/services/coin-history-sync';
import {
  ingestExchangeVolumeReplay,
  type RawExchangeVolumeReplay,
} from '../../../src/services/exchange-volume-ingestion';
import { syncExchangeVolumes } from '../../../src/services/exchange-volume-sync';
import {
  ingestMarketChartReplay,
  type RawMarketChartReplay,
} from '../../../src/services/market-chart-ingestion';
import { buildMarketChartProviderDiagnostics } from '../../../src/services/market-chart-diagnostics';
import { syncMarketCharts } from '../../../src/services/market-chart-sync';
import {
  ingestOnchainAnalyticsReplay,
  type RawOnchainAnalyticsReplay,
} from '../../../src/services/onchain-analytics-ingestion';
import { syncOnchainAnalytics } from '../../../src/services/onchain-analytics-sync';
import {
  ingestOnchainTradeReplay,
  type RawOnchainTradeReplay,
} from '../../../src/services/onchain-trade-ingestion';
import { syncOnchainTrades } from '../../../src/services/onchain-trade-sync';
import {
  ingestSupplyChartReplay,
  type RawSupplyChartReplay,
} from '../../../src/services/supply-chart-ingestion';
import { syncSupplyCharts } from '../../../src/services/supply-chart-sync';

const REQUIRED_RUNTIME_PROVIDER_FIELDS = [
  'id',
  'state',
  'last_success_at',
  'last_failure_at',
  'last_failure_reason',
  'failure_count',
  'next_retry_at',
  'alert_status',
] as const;

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
  ]);
  mockedFetchExchangeTickers.mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
  ]);
  mockedFetchExchangeDerivativeTickers.mockResolvedValue([]);
  mockedFetchExchangeOHLCV.mockResolvedValue([]);
  mockedFetchExchangeNetworks.mockResolvedValue([]);
  mockedCloseExchangePool.mockResolvedValue(undefined);
}

vi.mock('../../../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeDerivativeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn(),
  closeExchangePool: vi.fn(),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('diagnostics routes', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  function loadOnchainAnalyticsFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/onchain-analytics/eth-usdc-token-analytics.json'),
      'utf8',
    )) as RawOnchainAnalyticsReplay;
  }

  function loadCoinHistoryFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/coin-history/bitcoin-2026-03-20.json'),
      'utf8',
    )) as RawCoinHistoryReplay;
  }

  function loadExchangeVolumeFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/exchange-volumes/binance-volume.json'),
      'utf8',
    )) as RawExchangeVolumeReplay;
  }

  function loadMarketChartFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/market-charts/bitcoin-chart.json'),
      'utf8',
    )) as RawMarketChartReplay;
  }

  function loadOnchainTradeFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/onchain-trades/eth-usdc-weth-pool-trades.json'),
      'utf8',
    )) as RawOnchainTradeReplay;
  }

  function loadSupplyChartFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/supply-charts/bitcoin-supply.json'),
      'utf8',
    )) as RawSupplyChartReplay;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-diagnostics-'));
    vi.restoreAllMocks();
    resetCurrencyApiSnapshotForTests();
    resetCcxtProviderMocks();
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);
    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);

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
    const runtimeProviders = response.json().data.providers;
    expect(runtimeProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'binance',
        state: 'closed',
        last_success_at: expect.any(String),
        last_failure_at: null,
        last_failure_reason: null,
        failure_kind: null,
        failure_count: 0,
        next_retry_at: null,
      }),
    ]));
    expect(runtimeProviders.map((provider: { id: string }) => provider.id)).not.toEqual(expect.arrayContaining([
      'currency-api',
      'defillama',
      'subsquid',
    ]));

    for (const provider of runtimeProviders) {
      expect(Object.keys(provider)).toEqual(expect.arrayContaining([...REQUIRED_RUNTIME_PROVIDER_FIELDS]));
      expect(['closed', 'open', 'half_open']).toContain(provider.state);
      expect(typeof provider.failure_count).toBe('number');
      expect(provider.last_success_at === null || typeof provider.last_success_at === 'string').toBe(true);
      expect(provider.last_failure_at === null || typeof provider.last_failure_at === 'string').toBe(true);
      expect(provider.last_failure_reason === null || typeof provider.last_failure_reason === 'string').toBe(true);
      expect(provider.next_retry_at === null || typeof provider.next_retry_at === 'string').toBe(true);
      expect(['healthy', 'degraded', 'failing']).toContain(provider.alert_status);
    }
  });

  it('exposes cache attribution diagnostics for market smoke evidence', async () => {
    await getApp().ready();

    const coinsMarketsResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum',
    });
    await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum',
    });
    const simplePriceResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
    });

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/cache',
    });

    expect(COINS_MARKETS_ROUTE_CACHE_POLICY).toMatchObject({
      ttlSeconds: 5,
      httpCache: {
        maxAgeSeconds: 5,
        staleWhileRevalidateSeconds: 5,
      },
    });
    expect(SIMPLE_PRICE_ROUTE_CACHE_POLICY).toMatchObject({
      ttlSeconds: 5,
      httpCache: {
        maxAgeSeconds: 5,
        staleWhileRevalidateSeconds: 5,
      },
    });
    expect(coinsMarketsResponse.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=5');
    expect(simplePriceResponse.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=5');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      hot_data_revision: getApp().marketDataRuntimeState.hotDataRevision,
      freshness: {
        market_snapshot_threshold_seconds: expect.any(Number),
      },
      surfaces: {
        coins_markets: {
          ttl_seconds: COINS_MARKETS_ROUTE_CACHE_POLICY.ttlSeconds,
          http_cache: {
            max_age_seconds: COINS_MARKETS_ROUTE_CACHE_POLICY.httpCache.maxAgeSeconds,
            stale_while_revalidate_seconds: COINS_MARKETS_ROUTE_CACHE_POLICY.httpCache.staleWhileRevalidateSeconds,
            validators: ['etag', 'if-none-match'],
          },
          invalidated_by: ['hot_data_revision', 'validation_override', 'snapshot_access_policy'],
          events: {
            hit: expect.any(Number),
            miss: expect.any(Number),
          },
          operator_evidence: expect.arrayContaining([
            '/coins/markets cache headers (cache-control, etag, 304)',
            '/diagnostics/runtime hot_paths.cache_revision',
            '/metrics opengecko_cache_events_total{surface="coins_markets",outcome="hit|miss"}',
          ]),
        },
        simple_price: {
          ttl_seconds: SIMPLE_PRICE_ROUTE_CACHE_POLICY.ttlSeconds,
          http_cache: {
            max_age_seconds: SIMPLE_PRICE_ROUTE_CACHE_POLICY.httpCache.maxAgeSeconds,
            stale_while_revalidate_seconds: SIMPLE_PRICE_ROUTE_CACHE_POLICY.httpCache.staleWhileRevalidateSeconds,
            validators: ['etag', 'if-none-match'],
          },
          invalidated_by: ['hot_data_revision'],
          events: {
            hit: expect.any(Number),
            miss: expect.any(Number),
          },
        },
      },
    });
    expect(response.json().data.surfaces.coins_markets.events.hit).toBeGreaterThanOrEqual(1);
    expect(response.json().data.surfaces.coins_markets.events.miss).toBeGreaterThanOrEqual(1);
  });

  it('derives runtime provider capabilities from ticker, exchange, and chart storage evidence', async () => {
    await getApp().ready();
    const seedTimestamp = new Date('2026-03-20T00:00:00.000Z');
    const tickerFetchedAt = new Date('2026-05-05T00:10:00.000Z');
    const exchangeSyncedAt = new Date('2026-05-05T00:20:00.000Z');
    const ohlcvSyncedAt = new Date('2026-05-05T00:30:00.000Z');
    const chartSourceFetchedAt = new Date('2026-05-05T00:40:00.000Z');

    getApp().db.db.update(marketSnapshots).set({
      sourceProvidersJson: '[]',
      sourceCount: 0,
      updatedAt: seedTimestamp,
      lastUpdated: seedTimestamp,
    }).run();
    getApp().db.db.delete(coinTickers).run();
    getApp().db.db.delete(ohlcvSyncTargets).run();
    getApp().db.db.delete(marketChartSourcePoints).run();

    for (const exchange of [
      { id: 'binance', name: 'Binance', updatedAt: seedTimestamp },
      { id: 'coinbase', name: 'Coinbase Exchange', updatedAt: exchangeSyncedAt },
      { id: 'kraken', name: 'Kraken', updatedAt: seedTimestamp },
      { id: 'okex', name: 'OKX', updatedAt: seedTimestamp },
    ]) {
      getApp().db.db.insert(exchanges).values({
        id: exchange.id,
        name: exchange.name,
        description: '',
        url: `https://${exchange.id}.example`,
        hasTradingIncentive: false,
        centralised: true,
        otherUrlJson: '[]',
        updatedAt: exchange.updatedAt,
      }).onConflictDoUpdate({
        target: exchanges.id,
        set: {
          name: exchange.name,
          updatedAt: exchange.updatedAt,
        },
      }).run();
    }

    getApp().db.db.insert(coinTickers).values({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      base: 'BTC',
      target: 'USDT',
      marketName: 'BTC/USDT',
      last: 90_000,
      convertedLastUsd: 90_000,
      lastFetchAt: tickerFetchedAt,
      lastTradedAt: tickerFetchedAt,
      isAnomaly: false,
      isStale: false,
    }).run();
    getApp().db.db.insert(ohlcvSyncTargets).values({
      coinId: 'bitcoin',
      exchangeId: 'kraken',
      symbol: 'BTC/USD',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      targetHistoryDays: 30,
      status: 'idle',
      lastAttemptAt: ohlcvSyncedAt,
      lastSuccessAt: ohlcvSyncedAt,
      createdAt: ohlcvSyncedAt,
      updatedAt: ohlcvSyncedAt,
    }).run();
    getApp().db.db.insert(marketChartSourcePoints).values({
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
      timestamp: chartSourceFetchedAt,
      price: 90_000,
      open: 89_000,
      high: 91_000,
      low: 88_000,
      close: 90_000,
      sourceKind: 'live',
      sourceProvider: 'ccxt.okx',
      sourceFetchedAt: chartSourceFetchedAt,
    }).run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });

    expect(response.statusCode).toBe(200);
    const providers = response.json().data.providers as Array<{
      id: string;
      capabilities: Array<{
        surface: string;
        ownership: string;
        state: string;
        last_contribution_at: string | null;
      }>;
    }>;
    const capability = (providerId: string, surface: string) =>
      providers.find((provider) => provider.id === providerId)?.capabilities.find((entry) => entry.surface === surface);

    expect(capability('binance', 'ticker')).toMatchObject({
      ownership: 'latest_contributor',
      state: 'contributed',
      last_contribution_at: tickerFetchedAt.toISOString(),
    });
    expect(capability('binance', 'exchange')).toMatchObject({
      ownership: 'configured',
      state: 'unavailable',
      last_contribution_at: null,
    });
    expect(capability('coinbase', 'exchange')).toMatchObject({
      ownership: 'latest_contributor',
      state: 'contributed',
      last_contribution_at: exchangeSyncedAt.toISOString(),
    });
    expect(capability('coinbase', 'ticker')).toMatchObject({
      ownership: 'configured',
      state: 'unavailable',
      last_contribution_at: null,
    });
    expect(capability('kraken', 'chart')).toMatchObject({
      ownership: 'latest_contributor',
      state: 'contributed',
      last_contribution_at: ohlcvSyncedAt.toISOString(),
    });
    expect(capability('okx', 'chart')).toMatchObject({
      ownership: 'latest_contributor',
      state: 'contributed',
      last_contribution_at: chartSourceFetchedAt.toISOString(),
    });
    expect(capability('okx', 'exchange')).toMatchObject({
      ownership: 'configured',
      state: 'unavailable',
      last_contribution_at: null,
    });
  });

});
