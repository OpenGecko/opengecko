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

  it('returns market chart provider gap diagnostics for fallback, configured, replay, and live states', async () => {
    await getApp().ready();
    const fallbackOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
    });

    expect(fallbackOnlyResponse.statusCode).toBe(200);
    expect(fallbackOnlyResponse.json().data).toMatchObject({
      configured_targets: [],
      coins: expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          vs_currency: 'usd',
          interval: '1d',
          status: 'fallback_only',
          row_counts: { total: 0, live: 0, replay: 0 },
        }),
      ]),
      gaps: expect.objectContaining({
        fallback_only_coins: expect.arrayContaining(['bitcoin:usd:1d']),
      }),
      notes: expect.stringContaining('fallback-only market charts use seeded OHLCV/current snapshot blending'),
    });

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'configured-market-charts.db'),
        ccxtExchanges: ['binance'],
        marketChartTargets: 'mock.chart=bitcoin:1d:usd',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const configuredResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
    });

    expect(configuredResponse.statusCode).toBe(200);
    expect(configuredResponse.json().data).toMatchObject({
      configured_targets: [{
        provider: 'mock.chart',
        coin_id: 'bitcoin',
        vs_currency: 'usd',
        interval: '1d',
        source_provider: 'mock.chart',
      }],
      coins: expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          vs_currency: 'usd',
          interval: '1d',
          status: 'configured_pending',
          configured_provider: 'mock.chart',
          latest_source_fetched_at: null,
          coverage: {
            oldest_point_at: null,
            newest_point_at: null,
            source_age_seconds: null,
            freshness_threshold_seconds: 129600,
            freshness: 'unknown',
            production_freshness_threshold_seconds: 7200,
            production_freshness: 'unknown',
            source_coverage_days: 0,
            depth_threshold_days: 30,
            depth: 'empty',
          },
        }),
      ]),
      summary: {
        configured_targets: 1,
        source_backed_configured_targets: 0,
        live_backed_configured_targets: 0,
        replay_backed_configured_targets: 0,
        status_counts: {
          configured_pending: 1,
          live_backed: 0,
          replay_backed: 0,
          fallback_only: 0,
          missing: 0,
        },
        freshness_counts: {
          fresh: 0,
          stale: 0,
          unknown: 1,
        },
        production_freshness_counts: {
          fresh: 0,
          stale: 0,
          unknown: 1,
        },
        depth_counts: {
          deep: 0,
          shallow: 0,
          empty: 1,
        },
      },
      gaps: expect.objectContaining({
        configured_without_source_rows: ['bitcoin:usd:1d'],
      }),
    });

    const fixture = loadMarketChartFixture();
    ingestMarketChartReplay(getApp().db, fixture);

    const replayResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().data.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: fixture.coin_id,
        vs_currency: fixture.vs_currency,
        interval: fixture.interval,
        status: 'replay_backed',
        source_providers: ['market-chart-replay'],
        row_counts: { total: 3, live: 0, replay: 3 },
        latest_source_fetched_at: '2026-05-05T01:00:00.000Z',
        coverage: expect.objectContaining({
          oldest_point_at: '2026-03-18T00:00:00.000Z',
          newest_point_at: '2026-03-20T00:00:00.000Z',
          source_coverage_days: 3,
          depth_threshold_days: 30,
          depth: 'shallow',
        }),
      }),
    ]));

    await syncMarketCharts(getApp().db, {
      targets: [{
        provider: 'mock.chart',
        coinId: fixture.coin_id,
        vsCurrency: fixture.vs_currency ?? 'usd',
        interval: fixture.interval ?? '1d',
      }],
      now: new Date('2026-05-05T01:12:00.000Z'),
      fetcher: async () => fixture,
    });
    await syncMarketCharts(getApp().db, {
      targets: [{
        provider: 'mock.chart',
        coinId: 'ethereum',
        vsCurrency: 'usd',
        interval: '1d',
      }],
      now: new Date('2026-05-05T01:18:00.000Z'),
      fetcher: async () => ({
        provider: 'mock.chart',
        captured_at: '2026-05-05T01:18:00.000Z',
        coin_id: 'ethereum',
        vs_currency: 'usd',
        interval: '1d',
        points: [
          { timestamp: 1771459200, price: 2700 },
          { timestamp: 1774051200, price: 2850 },
        ],
      }),
    });

    vi.useFakeTimers({ now: new Date('2026-05-05T01:20:00.000Z') });
    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
    });
    vi.useRealTimers();

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json().data.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: fixture.coin_id,
        vs_currency: fixture.vs_currency,
        interval: fixture.interval,
        status: 'live_backed',
        source_providers: ['market-chart-replay', 'mock.chart'],
        row_counts: { total: 6, live: 3, replay: 3 },
        latest_source_fetched_at: '2026-05-05T01:12:00.000Z',
        coverage: expect.objectContaining({
          freshness_threshold_seconds: 129600,
          source_coverage_days: 3,
          depth_threshold_days: 30,
          depth: 'shallow',
        }),
      }),
    ]));
    expect(liveResponse.json().data.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: 'ethereum',
        status: 'live_backed',
        coverage: expect.objectContaining({
          source_coverage_days: 31,
          depth: 'deep',
        }),
      }),
    ]));

    const freshDiagnostics = buildMarketChartProviderDiagnostics(
      getApp().db,
      'mock.chart=bitcoin:1d:usd,mock.chart=ethereum:1d:usd',
      new Date('2026-05-05T01:20:00.000Z'),
    );
    expect(freshDiagnostics.summary).toEqual({
      configured_targets: 2,
      source_backed_configured_targets: 2,
      live_backed_configured_targets: 2,
      replay_backed_configured_targets: 0,
      status_counts: {
        configured_pending: 0,
        live_backed: 2,
        replay_backed: 0,
        fallback_only: 0,
        missing: 0,
      },
      freshness_counts: {
        fresh: 2,
        stale: 0,
        unknown: 0,
      },
      production_freshness_counts: {
        fresh: 2,
        stale: 0,
        unknown: 0,
      },
      depth_counts: {
        deep: 1,
        shallow: 1,
        empty: 0,
      },
      ohlcv_sync: {
        target_count: 0,
        active_leases: 0,
        stale_leases: 0,
        recovered_stale_total: 0,
        stale_targets: [],
        recovered_targets: [],
        lease_ttl_seconds: 900,
      },
    });
    expect(freshDiagnostics.gaps.shallow_source_targets).toContain('bitcoin:usd:1d');
    expect(freshDiagnostics.gaps.shallow_source_targets).not.toContain('ethereum:usd:1d');
    expect(freshDiagnostics.gaps.production_stale_source_targets).toEqual([]);

    const productionStaleDiagnostics = buildMarketChartProviderDiagnostics(
      getApp().db,
      'mock.chart=bitcoin:1d:usd,mock.chart=ethereum:1d:usd',
      new Date('2026-05-05T04:00:00.000Z'),
    );
    expect(productionStaleDiagnostics.summary.freshness_counts).toMatchObject({
      fresh: 2,
      stale: 0,
      unknown: 0,
    });
    expect(productionStaleDiagnostics.summary.production_freshness_counts).toMatchObject({
      fresh: 0,
      stale: 2,
      unknown: 0,
    });
    expect(productionStaleDiagnostics.gaps.stale_source_targets).toEqual([]);
    expect(productionStaleDiagnostics.gaps.production_stale_source_targets).toEqual(expect.arrayContaining([
      'bitcoin:usd:1d',
      'ethereum:usd:1d',
    ]));

    const staleDiagnostics = buildMarketChartProviderDiagnostics(
      getApp().db,
      'mock.chart=bitcoin:1d:usd,mock.chart=ethereum:1d:usd',
      new Date('2026-05-07T14:00:00.000Z'),
    );
    expect(staleDiagnostics.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: 'bitcoin',
        coverage: expect.objectContaining({
          freshness: 'stale',
        }),
      }),
    ]));
    expect(staleDiagnostics.gaps.stale_source_targets).toEqual(expect.arrayContaining([
      'bitcoin:usd:1d',
      'ethereum:usd:1d',
    ]));
    expect(staleDiagnostics.summary.freshness_counts).toMatchObject({
      fresh: 0,
      stale: 2,
      unknown: 0,
    });
    expect(staleDiagnostics.summary.production_freshness_counts).toMatchObject({
      fresh: 0,
      stale: 2,
      unknown: 0,
    });
  });

  it('exposes documented daily and intraday market chart freshness thresholds through diagnostics', async () => {
    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'market-chart-thresholds.db'),
        ccxtExchanges: ['binance'],
        marketChartTargets: 'mock.chart=bitcoin:1d:usd,mock.chart=ethereum:1m:usd',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: 'bitcoin',
        interval: '1d',
        configured_provider: 'mock.chart',
        coverage: expect.objectContaining({
          freshness_threshold_seconds: 129600,
          production_freshness_threshold_seconds: 7200,
          depth_threshold_days: 30,
        }),
      }),
      expect.objectContaining({
        coin_id: 'ethereum',
        interval: '1m',
        configured_provider: 'mock.chart',
        coverage: expect.objectContaining({
          freshness_threshold_seconds: 1800,
          production_freshness_threshold_seconds: 300,
          depth_threshold_days: 1,
        }),
      }),
    ]));
  });

});
