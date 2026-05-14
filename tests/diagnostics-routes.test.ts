import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { chartPoints, marketChartSourcePoints, marketSnapshots, ohlcvCandles } from '../src/db/schema';
import { upsertCanonicalOhlcvCandle } from '../src/services/candle-store';
import * as ccxtProvider from '../src/providers/ccxt';
import * as defillamaProvider from '../src/providers/defillama';
import * as sqdProvider from '../src/providers/sqd';
import { resetCurrencyApiSnapshotForTests } from '../src/services/currency-rates';
import {
  ingestCoinHistoryReplay,
  type RawCoinHistoryReplay,
} from '../src/services/coin-history-ingestion';
import { syncCoinHistorySnapshots } from '../src/services/coin-history-sync';
import {
  ingestExchangeVolumeReplay,
  type RawExchangeVolumeReplay,
} from '../src/services/exchange-volume-ingestion';
import { syncExchangeVolumes } from '../src/services/exchange-volume-sync';
import {
  ingestMarketChartReplay,
  type RawMarketChartReplay,
} from '../src/services/market-chart-ingestion';
import { buildMarketChartProviderDiagnostics } from '../src/services/market-chart-diagnostics';
import { syncMarketCharts } from '../src/services/market-chart-sync';
import {
  ingestOnchainAnalyticsReplay,
  type RawOnchainAnalyticsReplay,
} from '../src/services/onchain-analytics-ingestion';
import { syncOnchainAnalytics } from '../src/services/onchain-analytics-sync';
import {
  ingestOnchainTradeReplay,
  type RawOnchainTradeReplay,
} from '../src/services/onchain-trade-ingestion';
import { syncOnchainTrades } from '../src/services/onchain-trade-sync';
import {
  ingestSupplyChartReplay,
  type RawSupplyChartReplay,
} from '../src/services/supply-chart-ingestion';
import { syncSupplyCharts } from '../src/services/supply-chart-sync';

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

vi.mock('../src/providers/ccxt', () => ({
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

  it('returns in-memory scheduler diagnostics for background runtime jobs', async () => {
    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'scheduler.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: true,
    });

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/jobs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      scheduler: {
        enabled: true,
        job_count: 15,
      },
      jobs: expect.arrayContaining([
        expect.objectContaining({
          name: 'market-refresh',
          interval_seconds: 60,
          last_run_at: null,
          last_success_at: null,
          last_duration_ms: null,
          last_error: null,
          error_count: 0,
          lag_seconds: null,
        }),
        expect.objectContaining({
          name: 'currency-rates',
          interval_seconds: 300,
          disabled: true,
        }),
        expect.objectContaining({
          name: 'search-rebuild',
          interval_seconds: 900,
        }),
        expect.objectContaining({
          name: 'ohlcv-tick',
          interval_seconds: 60,
        }),
        expect.objectContaining({
          name: 'cache-eviction',
          interval_seconds: 60,
        }),
        expect.objectContaining({
          name: 'defillama-pool-sweep',
          interval_seconds: 300,
          disabled: false,
        }),
        expect.objectContaining({
          name: 'defillama-token-sweep',
          interval_seconds: 600,
          disabled: false,
        }),
        expect.objectContaining({
          name: 'subsquid-trade-sweep',
          interval_seconds: 60,
          disabled: false,
        }),
        expect.objectContaining({
          name: 'coin-catalog-rescan',
          interval_seconds: 3600,
          disabled: false,
        }),
        expect.objectContaining({
          name: 'exchange-metadata-rescan',
          interval_seconds: 21600,
          disabled: false,
        }),
        expect.objectContaining({
          name: 'global-aggregator',
          interval_seconds: 60,
          disabled: false,
        }),
        expect.objectContaining({
          name: 'category-aggregator',
          interval_seconds: 900,
          disabled: false,
        }),
        expect.objectContaining({
          name: 'derivatives-refresh',
          interval_seconds: 120,
          disabled: false,
        }),
        expect.objectContaining({
          name: 'supply-aggregator',
          interval_seconds: 900,
          disabled: false,
        }),
        expect.objectContaining({
          name: 'treasury-sweep',
          interval_seconds: 86400,
          disabled: false,
        }),
      ]),
    });
  });

  it('honors Tier 1 disable flags without disabling unrelated jobs', async () => {
    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'scheduler-disabled-tier1.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
        defillamaPoolSweepDisabled: true,
        defillamaTokenSweepDisabled: true,
        subsquidTradeSweepDisabled: true,
        coinCatalogRescanDisabled: true,
        exchangeMetadataRescanDisabled: true,
        globalAggregatorDisabled: true,
        categoryAggregatorDisabled: true,
      },
      startBackgroundJobs: true,
    });

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/jobs',
    });

    expect(response.statusCode).toBe(200);
    const jobs = response.json().data.jobs as Array<{
      name: string;
      disabled: boolean;
      run_count: number;
      last_run_at: string | null;
      last_success_at: string | null;
    }>;
    for (const jobName of [
      'defillama-pool-sweep',
      'defillama-token-sweep',
      'subsquid-trade-sweep',
      'coin-catalog-rescan',
      'exchange-metadata-rescan',
      'global-aggregator',
      'category-aggregator',
    ]) {
      expect(jobs.find((job) => job.name === jobName)).toMatchObject({
        disabled: true,
        run_count: 0,
        last_run_at: null,
        last_success_at: null,
      });
    }
    expect(jobs.find((job) => job.name === 'market-refresh')).toMatchObject({
      disabled: false,
    });
  });

  it('honors Tier 2 and Tier 3 disable flags without disabling unrelated jobs', async () => {
    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'scheduler-disabled-tier23.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
        derivativesRefreshDisabled: true,
        supplyAggregatorDisabled: true,
        treasurySweepDisabled: true,
      },
      startBackgroundJobs: true,
    });

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/jobs',
    });

    expect(response.statusCode).toBe(200);
    const jobs = response.json().data.jobs as Array<{
      name: string;
      disabled: boolean;
      run_count: number;
      last_run_at: string | null;
      last_success_at: string | null;
    }>;

    for (const jobName of ['derivatives-refresh', 'supply-aggregator', 'treasury-sweep']) {
      expect(jobs.find((job) => job.name === jobName)).toMatchObject({
        disabled: true,
        run_count: 0,
        last_run_at: null,
        last_success_at: null,
      });
    }

    expect(jobs.find((job) => job.name === 'market-refresh')).toMatchObject({
      disabled: false,
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

  it('returns endpoint-family freshness budgets', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/freshness_budgets',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.budgets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'simple',
        representative_routes: ['/simple/price', '/simple/token_price/:id'],
        target_freshness_seconds: 30,
        degraded_after_seconds: 120,
        budget_basis: 'latest_market_snapshot',
      }),
      expect.objectContaining({
        family: 'coins_markets',
        representative_routes: ['/coins/markets'],
        target_freshness_seconds: 60,
        degraded_after_seconds: 300,
        budget_basis: 'latest_market_snapshot',
      }),
      expect.objectContaining({
        family: 'historical_charts',
        target_freshness_seconds: null,
        degraded_after_seconds: null,
        budget_basis: 'route_interval',
      }),
    ]));
  });

  it('returns endpoint-family coverage ownership matrix', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coverage_matrix',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        generated_at: expect.any(String),
        entries: expect.arrayContaining([
          expect.objectContaining({
            family: 'simple',
            representative_routes: ['/simple/price', '/simple/token_price/:id'],
            ownership_class: expect.stringMatching(/^(live|seeded)$/),
            providers: expect.arrayContaining(['CCXT']),
            freshness: expect.objectContaining({
              target_freshness_seconds: 30,
              degraded_after_seconds: 120,
              state: expect.any(String),
            }),
            evidence: expect.objectContaining({
              tests: expect.arrayContaining(['tests/simple-price-parity.test.ts']),
            }),
          }),
          expect.objectContaining({
            family: 'onchain',
            ownership_class: expect.stringMatching(/^(hybrid|fixture)$/),
            providers: expect.arrayContaining(['DeFiLlama', 'Subsquid']),
            evidence: expect.objectContaining({
              notes: expect.stringContaining('fixture'),
            }),
          }),
          expect.objectContaining({
            family: 'derivatives',
            ownership_class: 'fixture',
            evidence: expect.objectContaining({
              notes: expect.stringContaining('fixtures'),
            }),
          }),
          expect.objectContaining({
            family: 'treasury',
            ownership_class: 'fixture',
          }),
        ]),
      },
    });
  });

  it('promotes coverage matrix only from source-backed fresh snapshots and historical rows', async () => {
    await getApp().ready();
    const now = new Date('2026-05-14T12:00:00.000Z');
    getApp().db.db.update(marketSnapshots).set({
      sourceProvidersJson: JSON.stringify([]),
      sourceCount: 0,
      lastUpdated: now,
      updatedAt: now,
    }).run();
    getApp().db.db.delete(ohlcvCandles).run();
    getApp().db.db.delete(marketChartSourcePoints).run();

    const fixtureOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coverage_matrix',
    });
    const fixtureOnlyEntries = fixtureOnlyResponse.json().data.entries as Array<{ family: string; ownership_class: string }>;

    expect(fixtureOnlyEntries.find((entry) => entry.family === 'simple')?.ownership_class).toBe('seeded');
    expect(fixtureOnlyEntries.find((entry) => entry.family === 'coins_markets')?.ownership_class).toBe('seeded');

    getApp().db.db.update(marketSnapshots).set({
      sourceProvidersJson: JSON.stringify(['binance']),
      sourceCount: 1,
      lastUpdated: now,
      updatedAt: now,
    }).where(and(
      eq(marketSnapshots.coinId, 'bitcoin'),
      eq(marketSnapshots.vsCurrency, 'usd'),
    )).run();
    upsertCanonicalOhlcvCandle(getApp().db, {
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
      timestamp: now,
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 10,
      source: 'canonical',
      replaceExisting: true,
    });

    const promotedResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coverage_matrix',
    });
    const promotedEntries = promotedResponse.json().data.entries as Array<{
      family: string;
      ownership_class: string;
      last_successful_refresh_at: string | null;
      evidence: { notes: string };
    }>;

    expect(promotedEntries.find((entry) => entry.family === 'simple')).toMatchObject({
      ownership_class: 'live',
      last_successful_refresh_at: now.toISOString(),
    });
    expect(promotedEntries.find((entry) => entry.family === 'coins_markets')).toMatchObject({
      ownership_class: 'live',
      last_successful_refresh_at: now.toISOString(),
    });
    expect(promotedEntries.find((entry) => entry.family === 'historical_charts')).toMatchObject({
      ownership_class: 'hybrid',
      last_successful_refresh_at: now.toISOString(),
    });
    expect(promotedEntries.find((entry) => entry.family === 'historical_charts')?.evidence.notes).toContain(
      'Future live classification requires documented breadth/depth thresholds',
    );
  });

  it('keeps coverage matrix entries complete enough to support release claims', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coverage_matrix',
    });

    expect(response.statusCode).toBe(200);
    const entries = response.json().data.entries as Array<{
      family: string;
      representative_routes: string[];
      ownership_class: string;
      providers: string[];
      last_successful_refresh_at: string | null;
      freshness: {
        target_freshness_seconds: number | null;
        degraded_after_seconds: number | null;
        current_age_seconds: number | null;
        state: string;
      };
      evidence: {
        tests: string[];
        notes: string;
      };
    }>;
    const expectedFamilies = [
      'simple',
      'coins_markets',
      'coin_detail',
      'exchanges',
      'onchain',
      'derivatives',
      'historical_charts',
      'supply_charts',
      'treasury',
      'stable_catalog',
    ];

    expect(entries.map((entry) => entry.family).sort()).toEqual([...expectedFamilies].sort());
    expect(new Set(entries.map((entry) => entry.family)).size).toBe(entries.length);

    for (const entry of entries) {
      expect(entry.representative_routes.length).toBeGreaterThan(0);
      expect(entry.representative_routes.every((route) => route.startsWith('/'))).toBe(true);
      expect(entry.ownership_class).toMatch(/^(live|hybrid|seeded|synthetic|fixture|unavailable)$/);
      expect(entry.providers.length).toBeGreaterThan(0);
      expect(entry.providers.every((provider) => provider.trim().length > 0)).toBe(true);
      expect(entry).toHaveProperty('last_successful_refresh_at');
      expect(entry.freshness.state).toMatch(/^(fresh|degraded|stale|unbudgeted|unknown)$/);
      expect(entry.freshness).toHaveProperty('current_age_seconds');
      expect(entry.evidence.tests.length).toBeGreaterThan(0);
      expect(entry.evidence.notes.trim().length).toBeGreaterThan(0);

      for (const testPath of entry.evidence.tests) {
        expect(testPath).toMatch(/^tests\/.+\.test\.ts$/);
        expect(existsSync(testPath)).toBe(true);
      }

      if (entry.freshness.state === 'unbudgeted') {
        expect(entry.freshness.target_freshness_seconds).toBeNull();
        expect(entry.freshness.degraded_after_seconds).toBeNull();
      } else {
        expect(entry.freshness.target_freshness_seconds).toEqual(expect.any(Number));
        expect(entry.freshness.degraded_after_seconds).toEqual(expect.any(Number));
      }
    }

    const evidenceByFamily = new Map(entries.map((entry) => [entry.family, entry.evidence.tests]));
    expect(evidenceByFamily.get('onchain')).toEqual(expect.arrayContaining(['tests/provider-replay-defillama.test.ts']));
    expect(evidenceByFamily.get('derivatives')).toEqual(expect.arrayContaining(['tests/provider-replay-derivatives.test.ts']));
    expect(evidenceByFamily.get('treasury')).toEqual(expect.arrayContaining(['tests/provider-replay-treasury.test.ts']));
  });

  it('returns derivatives provider gap diagnostics for fixture-only and configured-pending venues', async () => {
    await getApp().ready();
    const fixtureOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/derivatives',
    });

    expect(fixtureOnlyResponse.statusCode).toBe(200);
    expect(fixtureOnlyResponse.json().data).toMatchObject({
      configured_venues: expect.arrayContaining([
        {
          exchange_id: 'binance_futures',
          provider_exchange_id: 'binanceusdm',
          source_provider: 'ccxt.binanceusdm',
        },
        {
          exchange_id: 'okx',
          provider_exchange_id: 'okx',
          source_provider: 'ccxt.okx',
        },
        {
          exchange_id: 'bitget',
          provider_exchange_id: 'bitget',
          source_provider: 'ccxt.bitget',
        },
      ]),
      exchanges: expect.arrayContaining([
        expect.objectContaining({
          exchange_id: 'binance_futures',
          status: 'configured_pending',
          configured_provider_exchange_id: 'binanceusdm',
          enabled: true,
          ticker_counts: expect.objectContaining({
            source_backed: 0,
          }),
        }),
      ]),
      gaps: expect.objectContaining({
        configured_without_source_rows: expect.arrayContaining(['binance_futures', 'okx', 'bitget']),
      }),
    });

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'configured.db'),
        ccxtExchanges: ['binance'],
        derivativesCcxtExchanges: 'binance_futures=binanceusdm',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const configuredResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/derivatives',
    });

    expect(configuredResponse.statusCode).toBe(200);
    expect(configuredResponse.json().data).toMatchObject({
      configured_venues: [{
        exchange_id: 'binance_futures',
        provider_exchange_id: 'binanceusdm',
        source_provider: 'ccxt.binanceusdm',
      }],
      exchanges: expect.arrayContaining([
        expect.objectContaining({
          exchange_id: 'binance_futures',
          status: 'configured_pending',
          configured_provider_exchange_id: 'binanceusdm',
        }),
      ]),
      gaps: expect.objectContaining({
        configured_without_source_rows: ['binance_futures'],
      }),
    });
  });

  it('returns exchange volume provider gap diagnostics for fixture, configured, replay, and live states', async () => {
    await getApp().ready();
    const fixtureOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/exchange_volumes',
    });

    expect(fixtureOnlyResponse.statusCode).toBe(200);
    expect(fixtureOnlyResponse.json().data).toMatchObject({
      configured_targets: [],
      exchanges: expect.arrayContaining([
        expect.objectContaining({
          exchange_id: 'binance',
          status: 'fixture_only',
          row_counts: { total: 0, live: 0, replay: 0 },
        }),
      ]),
      gaps: expect.objectContaining({
        fixture_only_exchanges: expect.arrayContaining(['binance']),
      }),
      notes: expect.stringContaining('fixture-only exchanges must not be advertised as live'),
    });

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'configured-exchange-volumes.db'),
        ccxtExchanges: ['binance'],
        exchangeVolumeTargets: 'mock.volume=binance',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const configuredResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/exchange_volumes',
    });

    expect(configuredResponse.statusCode).toBe(200);
    expect(configuredResponse.json().data).toMatchObject({
      configured_targets: [{
        provider: 'mock.volume',
        exchange_id: 'binance',
        source_provider: 'mock.volume',
      }],
      exchanges: expect.arrayContaining([
        expect.objectContaining({
          exchange_id: 'binance',
          status: 'configured_pending',
          configured_provider: 'mock.volume',
          latest_source_fetched_at: null,
        }),
      ]),
      gaps: expect.objectContaining({
        configured_without_source_rows: ['binance'],
      }),
    });

    const fixture = loadExchangeVolumeFixture();
    ingestExchangeVolumeReplay(getApp().db, fixture);

    const replayResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/exchange_volumes',
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().data.exchanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        exchange_id: fixture.exchange_id,
        status: 'replay_backed',
        source_providers: ['exchange-volume-replay'],
        row_counts: { total: 3, live: 0, replay: 3 },
        latest_source_fetched_at: '2026-05-05T00:20:00.000Z',
      }),
    ]));

    await syncExchangeVolumes(getApp().db, {
      targets: [{
        provider: 'mock.volume',
        exchangeId: fixture.exchange_id,
      }],
      now: new Date('2026-05-05T00:44:00.000Z'),
      fetcher: async () => fixture,
    });

    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/exchange_volumes',
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json().data.exchanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        exchange_id: fixture.exchange_id,
        status: 'live_backed',
        source_providers: ['exchange-volume-replay', 'mock.volume'],
        row_counts: { total: 6, live: 3, replay: 3 },
        latest_source_fetched_at: '2026-05-05T00:44:00.000Z',
      }),
    ]));
  });

  it('returns onchain analytics provider gap diagnostics for fixture, configured, replay, and live states', async () => {
    await getApp().ready();
    const fixtureOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/onchain_analytics',
    });

    expect(fixtureOnlyResponse.statusCode).toBe(200);
    expect(fixtureOnlyResponse.json().data).toMatchObject({
      configured_targets: [],
      tokens: expect.arrayContaining([
        expect.objectContaining({
          network_id: 'eth',
          token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          status: 'fixture_only',
          row_counts: expect.objectContaining({
            holders: { total: 0, live: 0, replay: 0 },
          }),
        }),
      ]),
      gaps: expect.objectContaining({
        fixture_only_tokens: expect.arrayContaining(['eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']),
      }),
      notes: expect.stringContaining('fixture-only tokens must not be advertised as live'),
    });

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'configured-onchain-analytics.db'),
        ccxtExchanges: ['binance'],
        onchainAnalyticsTargets: 'mock.analytics=eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const configuredResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/onchain_analytics',
    });

    expect(configuredResponse.statusCode).toBe(200);
    expect(configuredResponse.json().data).toMatchObject({
      configured_targets: [{
        provider: 'mock.analytics',
        network_id: 'eth',
        token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        source_provider: 'mock.analytics',
      }],
      tokens: expect.arrayContaining([
        expect.objectContaining({
          network_id: 'eth',
          token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          status: 'configured_pending',
          configured_provider: 'mock.analytics',
          latest_source_fetched_at: null,
        }),
      ]),
      gaps: expect.objectContaining({
        configured_without_source_rows: ['eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
      }),
    });

    const fixture = loadOnchainAnalyticsFixture();
    ingestOnchainAnalyticsReplay(getApp().db, fixture);

    const replayResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/onchain_analytics',
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().data.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({
        token_address: fixture.token_address,
        status: 'replay_backed',
        source_providers: ['etherscan-token-analytics-replay'],
        row_counts: {
          holders: { total: 2, live: 0, replay: 2 },
          traders: { total: 2, live: 0, replay: 2 },
          holder_counts: { total: 3, live: 0, replay: 3 },
        },
        latest_source_fetched_at: '2026-05-05T00:03:00.000Z',
      }),
    ]));

    await syncOnchainAnalytics(getApp().db, {
      targets: [{
        provider: 'mock.analytics',
        networkId: fixture.network_id,
        tokenAddress: fixture.token_address,
      }],
      now: new Date('2026-05-05T00:08:00.000Z'),
      fetcher: async () => fixture,
    });

    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/onchain_analytics',
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json().data.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({
        token_address: fixture.token_address,
        status: 'live_backed',
        source_providers: ['mock.analytics'],
        row_counts: {
          holders: { total: 2, live: 2, replay: 0 },
          traders: { total: 2, live: 2, replay: 0 },
          holder_counts: { total: 3, live: 3, replay: 0 },
        },
        latest_source_fetched_at: '2026-05-05T00:08:00.000Z',
      }),
    ]));
  });

  it('returns onchain trade provider gap diagnostics for fixture, configured, replay, and live states', async () => {
    await getApp().ready();
    const fixtureOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/onchain_trades',
    });

    expect(fixtureOnlyResponse.statusCode).toBe(200);
    expect(fixtureOnlyResponse.json().data).toMatchObject({
      configured_targets: [],
      pools: expect.arrayContaining([
        expect.objectContaining({
          network_id: 'eth',
          pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          status: 'fixture_only',
          row_counts: { total: 0, live: 0, replay: 0 },
          tokens: [],
        }),
      ]),
      gaps: expect.objectContaining({
        fixture_only_pools: expect.arrayContaining(['eth:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640']),
      }),
      notes: expect.stringContaining('fixture-only pools must not be advertised as live'),
    });

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'configured-onchain-trades.db'),
        ccxtExchanges: ['binance'],
        onchainTradeTargets: 'mock.trades=eth:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const configuredResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/onchain_trades',
    });

    expect(configuredResponse.statusCode).toBe(200);
    expect(configuredResponse.json().data).toMatchObject({
      configured_targets: [{
        provider: 'mock.trades',
        network_id: 'eth',
        pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        source_provider: 'mock.trades',
      }],
      pools: expect.arrayContaining([
        expect.objectContaining({
          network_id: 'eth',
          pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          status: 'configured_pending',
          configured_provider: 'mock.trades',
          latest_source_fetched_at: null,
        }),
      ]),
      gaps: expect.objectContaining({
        configured_without_source_rows: ['eth:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'],
      }),
    });

    const fixture = loadOnchainTradeFixture();
    ingestOnchainTradeReplay(getApp().db, fixture);

    const replayResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/onchain_trades',
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().data.pools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pool_address: fixture.pool_address,
        status: 'replay_backed',
        source_providers: ['sqd-swap-replay'],
        row_counts: { total: 2, live: 0, replay: 2 },
        tokens: expect.arrayContaining([
          {
            token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            row_counts: { total: 1, live: 0, replay: 1 },
          },
        ]),
        latest_source_fetched_at: '2026-05-05T00:09:00.000Z',
      }),
    ]));

    await syncOnchainTrades(getApp().db, {
      targets: [{
        provider: 'mock.trades',
        networkId: fixture.network_id,
        poolAddress: fixture.pool_address,
      }],
      now: new Date('2026-05-05T00:14:00.000Z'),
      fetcher: async () => fixture,
    });

    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/onchain_trades',
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json().data.pools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pool_address: fixture.pool_address,
        status: 'live_backed',
        source_providers: ['mock.trades'],
        row_counts: { total: 2, live: 2, replay: 0 },
        tokens: expect.arrayContaining([
          {
            token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            row_counts: { total: 1, live: 1, replay: 0 },
          },
        ]),
        latest_source_fetched_at: '2026-05-05T00:14:00.000Z',
      }),
    ]));
  });

  it('returns coin history provider gap diagnostics for fallback, configured, replay, and live states', async () => {
    await getApp().ready();
    const fallbackOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coin_history',
    });

    expect(fallbackOnlyResponse.statusCode).toBe(200);
    expect(fallbackOnlyResponse.json().data).toMatchObject({
      configured_targets: [],
      histories: [],
      gaps: expect.objectContaining({
        fallback_only_coins: expect.arrayContaining(['bitcoin']),
      }),
      notes: expect.stringContaining('fallback-only coin history uses seeded chart/current snapshot blending'),
    });

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'configured-coin-history.db'),
        ccxtExchanges: ['binance'],
        coinHistoryTargets: 'mock.history=bitcoin:2026-03-20',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const configuredResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coin_history',
    });

    expect(configuredResponse.statusCode).toBe(200);
    expect(configuredResponse.json().data).toMatchObject({
      configured_targets: [{
        provider: 'mock.history',
        coin_id: 'bitcoin',
        date: '2026-03-20',
        source_provider: 'mock.history',
      }],
      histories: expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          date: '2026-03-20',
          status: 'configured_pending',
          configured_provider: 'mock.history',
          latest_source_fetched_at: null,
        }),
      ]),
      gaps: expect.objectContaining({
        configured_without_source_rows: ['bitcoin:2026-03-20'],
      }),
    });

    const fixture = loadCoinHistoryFixture();
    ingestCoinHistoryReplay(getApp().db, fixture);

    const replayResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coin_history',
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().data.histories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: fixture.coin_id,
        date: fixture.date,
        status: 'replay_backed',
        source_providers: ['coin-history-replay'],
        row_counts: { total: 1, live: 0, replay: 1 },
        latest_source_fetched_at: '2026-05-05T00:40:00.000Z',
      }),
    ]));

    await syncCoinHistorySnapshots(getApp().db, {
      targets: [{
        provider: 'mock.history',
        coinId: fixture.coin_id,
        date: fixture.date,
      }],
      now: new Date('2026-05-05T00:54:00.000Z'),
      fetcher: async () => fixture,
    });

    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coin_history',
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json().data.histories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: fixture.coin_id,
        date: fixture.date,
        status: 'live_backed',
        source_providers: ['coin-history-replay', 'mock.history'],
        row_counts: { total: 2, live: 1, replay: 1 },
        latest_source_fetched_at: '2026-05-05T00:54:00.000Z',
      }),
    ]));
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

  it('reports public chart and ohlc response source counters without changing route payloads', async () => {
    await getApp().ready();

    const canonicalChartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily',
    });
    expect(canonicalChartResponse.statusCode).toBe(200);
    const canonicalChartPayload = canonicalChartResponse.json();
    expect(canonicalChartPayload).toMatchObject({
      prices: expect.any(Array),
      market_caps: expect.any(Array),
      total_volumes: expect.any(Array),
    });
    expect(canonicalChartPayload).not.toHaveProperty('response_source_counts');

    const fixture = loadMarketChartFixture();
    ingestMarketChartReplay(getApp().db, fixture);
    const sourceChartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773792000&to=1773964800',
    });
    expect(sourceChartResponse.statusCode).toBe(200);
    const sourceChartPayload = sourceChartResponse.json();
    expect(sourceChartPayload).toMatchObject({
      prices: expect.any(Array),
      market_caps: expect.any(Array),
      total_volumes: expect.any(Array),
    });
    expect(sourceChartPayload).not.toHaveProperty('response_source_counts');

    getApp().db.db.delete(chartPoints).where(eq(chartPoints.coinId, 'bitcoin')).run();
    getApp().db.db.delete(marketChartSourcePoints).where(eq(marketChartSourcePoints.coinId, 'bitcoin')).run();
    getApp().db.db.delete(ohlcvCandles).where(eq(ohlcvCandles.coinId, 'bitcoin')).run();
    const mockedFetchExchangeOHLCV = ccxtProvider.fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
    mockedFetchExchangeOHLCV.mockResolvedValueOnce([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: 1775001600000,
        open: 91_000,
        high: 92_500,
        low: 90_250,
        close: 92_000,
        volume: 1_234,
        raw: [1775001600000, 91_000, 92_500, 90_250, 92_000, 1_234],
      },
    ]);
    const providerOhlcResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1775001600&to=1775001600&interval=daily',
    });
    expect(providerOhlcResponse.statusCode).toBe(200);
    const providerOhlcPayload = providerOhlcResponse.json();
    expect(providerOhlcPayload).toEqual([
      [1775001600000, 91_000, 92_500, 90_250, 92_000],
    ]);
    expect(providerOhlcPayload).not.toHaveProperty('response_source_counts');
    expect(providerOhlcPayload).not.toHaveProperty('response_source_fallback_alert');
    expect(providerOhlcPayload).not.toHaveProperty('response_source_target_suggestion_overflow');
    expect(providerOhlcPayload).not.toHaveProperty('response_source_target_suggestion_batch_previews');

    const emptyChartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1775088000&to=1775088000&interval=daily',
    });
    expect(emptyChartResponse.statusCode).toBe(200);
    const emptyChartPayload = emptyChartResponse.json();
    expect(emptyChartPayload).toEqual({
      prices: [],
      market_caps: [],
      total_volumes: [],
    });
    expect(emptyChartPayload).not.toHaveProperty('response_source_recent_events');
    expect(emptyChartPayload).not.toHaveProperty('response_source_fallback_alert');
    expect(emptyChartPayload).not.toHaveProperty('response_source_target_suggestion_overflow');
    expect(emptyChartPayload).not.toHaveProperty('response_source_target_suggestion_batch_previews');

    getApp().chartResponseSources.record('market_chart_range', 'empty', {
      coinId: 'ethereum',
      vsCurrency: 'usd',
      interval: 'daily',
      request: { kind: 'range', from: Date.UTC(2026, 3, 3), to: Date.UTC(2026, 3, 3) },
    });
    getApp().chartResponseSources.record('ohlc_range', 'provider_filled', {
      coinId: 'ethereum',
      vsCurrency: 'usd',
      interval: 'daily',
      request: { kind: 'range', from: Date.UTC(2026, 3, 4), to: Date.UTC(2026, 3, 4) },
    });
    getApp().chartResponseSources.record('market_chart_days', 'empty', {
      coinId: 'ethereum',
      vsCurrency: 'usd',
      interval: 'daily',
      request: { kind: 'days', days: '30' },
    });
    getApp().chartResponseSources.record('market_chart_range', 'empty', {
      coinId: 'solana',
      vsCurrency: 'usd',
      interval: 'hourly',
      request: { kind: 'range', from: Date.UTC(2026, 3, 5, 0), to: Date.UTC(2026, 3, 5, 1) },
    });

    const diagnosticsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
    });

    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json().data.response_source_counts).toMatchObject({
      market_chart_days: {
        canonical: 1,
        empty: 1,
        source_backed: 0,
        provider_filled: 0,
      },
      market_chart_range: {
        source_backed: 1,
        canonical: 0,
        provider_filled: 0,
        empty: 3,
      },
      ohlc_range: {
        provider_filled: 2,
        source_backed: 0,
        canonical: 0,
        empty: 0,
      },
    });
    expect(diagnosticsResponse.json().data.response_source_recent_events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: 'ohlc_range',
        source: 'provider_filled',
        coin_id: 'bitcoin',
        vs_currency: 'usd',
        interval: 'daily',
        request: {
          kind: 'range',
          days: null,
          from: '2026-04-01T00:00:00.000Z',
          to: '2026-04-01T00:00:00.000Z',
        },
      }),
      expect.objectContaining({
        route: 'market_chart_range',
        source: 'empty',
        coin_id: 'bitcoin',
        vs_currency: 'usd',
        interval: 'daily',
        request: {
          kind: 'range',
          days: null,
          from: '2026-04-02T00:00:00.000Z',
          to: '2026-04-02T00:00:00.000Z',
        },
      }),
      expect.objectContaining({
        route: 'market_chart_days',
        source: 'empty',
        coin_id: 'ethereum',
        vs_currency: 'usd',
        interval: 'daily',
        request: {
          kind: 'days',
          days: '30',
          from: null,
          to: null,
        },
      }),
      expect.objectContaining({
        route: 'market_chart_range',
        source: 'empty',
        coin_id: 'solana',
        vs_currency: 'usd',
        interval: 'hourly',
        request: {
          kind: 'range',
          days: null,
          from: '2026-04-05T00:00:00.000Z',
          to: '2026-04-05T01:00:00.000Z',
        },
      }),
    ]));
    expect(diagnosticsResponse.json().data.response_source_recent_events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'canonical' }),
      expect.objectContaining({ source: 'source_backed' }),
    ]));
    expect(diagnosticsResponse.json().data.response_source_recent_event_rollups).toMatchObject({
      total_events: 6,
      by_route: {
        market_chart_days: {
          provider_filled: 0,
          empty: 1,
        },
        market_chart_range: {
          provider_filled: 0,
          empty: 3,
        },
        ohlc_range: {
          provider_filled: 2,
          empty: 0,
        },
      },
      by_coin: [
        {
          coin_id: 'ethereum',
          vs_currency: 'usd',
          total: 3,
          provider_filled: 1,
          empty: 2,
          routes: {
            market_chart_days: {
              provider_filled: 0,
              empty: 1,
            },
            market_chart_range: {
              provider_filled: 0,
              empty: 1,
            },
            ohlc_range: {
              provider_filled: 1,
              empty: 0,
            },
          },
        },
        {
          coin_id: 'bitcoin',
          vs_currency: 'usd',
          total: 2,
          provider_filled: 1,
          empty: 1,
          routes: {
            market_chart_range: {
              provider_filled: 0,
              empty: 1,
            },
            ohlc_range: {
              provider_filled: 1,
              empty: 0,
            },
          },
        },
        {
          coin_id: 'solana',
          vs_currency: 'usd',
          total: 1,
          provider_filled: 0,
          empty: 1,
          routes: {
            market_chart_range: {
              provider_filled: 0,
              empty: 1,
            },
          },
        },
      ],
    });
    expect(diagnosticsResponse.json().data.response_source_target_suggestions).toEqual([
      expect.objectContaining({
        coin_id: 'ethereum',
        vs_currency: 'usd',
        interval: '1d',
        target_template: '<provider>=ethereum:1d:usd',
        event_counts: {
          total: 3,
          provider_filled: 1,
          empty: 2,
        },
        priority: {
          rank: 1,
          pressure_score: 3,
          latest_observed_at: expect.any(String),
        },
        route_pressure: {
          dominant_route: 'market_chart_days',
          totals: {
            market_chart_days: 1,
            market_chart_range: 1,
            ohlc_days: 0,
            ohlc_range: 1,
          },
        },
        request_kind_pressure: {
          dominant_kind: 'range',
          totals: {
            days: 1,
            range: 2,
          },
        },
        range_span_pressure: {
          dominant_bucket: 'single_day',
          range_requests: 2,
          buckets: {
            intraday: 0,
            single_day: 2,
            multi_day: 0,
          },
          min_span_seconds: 0,
          max_span_seconds: 0,
        },
        coverage_target_hint: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          request_pattern: 'range',
          range_window: 'single_day',
        },
        sample_requests: expect.arrayContaining([
          expect.objectContaining({
            route: 'market_chart_days',
            source: 'empty',
            request: { kind: 'days', days: '30', from: null, to: null },
          }),
        ]),
      }),
      expect.objectContaining({
        coin_id: 'bitcoin',
        vs_currency: 'usd',
        interval: '1d',
        target_template: '<provider>=bitcoin:1d:usd',
        reason: 'recent provider-filled or empty public chart/OHLC fallback events',
        event_counts: {
          total: 2,
          provider_filled: 1,
          empty: 1,
        },
        priority: {
          rank: 2,
          pressure_score: 2,
          latest_observed_at: expect.any(String),
        },
        route_pressure: {
          dominant_route: 'market_chart_range',
          totals: {
            market_chart_days: 0,
            market_chart_range: 1,
            ohlc_days: 0,
            ohlc_range: 1,
          },
        },
        request_kind_pressure: {
          dominant_kind: 'range',
          totals: {
            days: 0,
            range: 2,
          },
        },
        range_span_pressure: {
          dominant_bucket: 'single_day',
          range_requests: 2,
          buckets: {
            intraday: 0,
            single_day: 2,
            multi_day: 0,
          },
          min_span_seconds: 0,
          max_span_seconds: 0,
        },
        coverage_target_hint: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          request_pattern: 'range',
          range_window: 'single_day',
        },
        routes: expect.objectContaining({
          market_chart_range: {
            provider_filled: 0,
            empty: 1,
          },
          ohlc_range: {
            provider_filled: 1,
            empty: 0,
          },
        }),
      }),
      expect.objectContaining({
        coin_id: 'solana',
        vs_currency: 'usd',
        interval: '1m',
        target_template: '<provider>=solana:1m:usd',
        event_counts: {
          total: 1,
          provider_filled: 0,
          empty: 1,
        },
        priority: {
          rank: 3,
          pressure_score: 1,
          latest_observed_at: expect.any(String),
        },
        route_pressure: {
          dominant_route: 'market_chart_range',
          totals: {
            market_chart_days: 0,
            market_chart_range: 1,
            ohlc_days: 0,
            ohlc_range: 0,
          },
        },
        request_kind_pressure: {
          dominant_kind: 'range',
          totals: {
            days: 0,
            range: 1,
          },
        },
        range_span_pressure: {
          dominant_bucket: 'intraday',
          range_requests: 1,
          buckets: {
            intraday: 1,
            single_day: 0,
            multi_day: 0,
          },
          min_span_seconds: 3_600,
          max_span_seconds: 3_600,
        },
        coverage_target_hint: {
          target_history: 'intraday_history',
          suggested_action: 'expand_intraday_history',
          request_pattern: 'range',
          range_window: 'intraday',
        },
      }),
    ]);
    expect(diagnosticsResponse.json().data.response_source_fallback_alert).toEqual({
      status: 'action_needed',
      reason: 'unresolved_recent_fallback_pressure',
      recent_events_total: 6,
      events_eligible_for_suggestion: 6,
      suggestions_returned: 3,
      stale_events_ignored: 0,
      source_backed_events_suppressed: 0,
    });
    expect(diagnosticsResponse.json().data.response_source_target_suggestion_operator_summary).toEqual({
      total_suggestions: 3,
      target_history_counts: {
        daily_history: 2,
        intraday_history: 1,
      },
      suggested_action_counts: {
        expand_daily_history: 2,
        expand_intraday_history: 1,
      },
      request_pattern_counts: {
        days: 0,
        range: 3,
        none: 0,
      },
      range_window_counts: {
        intraday: 1,
        single_day: 2,
        multi_day: 0,
        none: 0,
      },
    });
    expect(diagnosticsResponse.json().data.response_source_target_suggestion_overflow).toEqual({
      basis: 'eligible_unique_targets_after_stale_and_source_backed_filtering',
      suggestions_limit: 20,
      eligible_targets: 3,
      returned_suggestions: 3,
      omitted_by_suggestion_cap: 0,
      target_history_counts: {
        daily_history: {
          eligible_targets: 2,
          returned_suggestions: 2,
          omitted_by_suggestion_cap: 0,
        },
        intraday_history: {
          eligible_targets: 1,
          returned_suggestions: 1,
          omitted_by_suggestion_cap: 0,
        },
      },
    });
    expect(diagnosticsResponse.json().data.response_source_target_suggestion_batch_previews).toEqual({
      provider_placeholder: '<provider>',
      total_suggestions: 3,
      cap: {
        preview_source: 'response_source_target_suggestions',
        suggestions_returned: 3,
        suggestions_limit: 20,
      },
      groups: {
        daily_history: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          target_count: 2,
          target_templates: [
            '<provider>=ethereum:1d:usd',
            '<provider>=bitcoin:1d:usd',
          ],
          market_chart_targets_template: '<provider>=ethereum:1d:usd,<provider>=bitcoin:1d:usd',
        },
        intraday_history: {
          target_history: 'intraday_history',
          suggested_action: 'expand_intraday_history',
          target_count: 1,
          target_templates: ['<provider>=solana:1m:usd'],
          market_chart_targets_template: '<provider>=solana:1m:usd',
        },
      },
    });
    expect(diagnosticsResponse.headers.etag).toEqual(expect.any(String));
    const cachedDiagnosticsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
      headers: {
        'if-none-match': diagnosticsResponse.headers.etag,
      },
    });
    expect(cachedDiagnosticsResponse.statusCode).toBe(304);
    expect(cachedDiagnosticsResponse.headers.etag).toBe(diagnosticsResponse.headers.etag);
    expect(cachedDiagnosticsResponse.headers['cache-control']).toBe(diagnosticsResponse.headers['cache-control']);

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const restartedDiagnosticsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
    });
    expect(restartedDiagnosticsResponse.statusCode).toBe(200);
    expect(restartedDiagnosticsResponse.json().data.response_source_counts).toMatchObject({
      market_chart_days: {
        canonical: 1,
        empty: 1,
      },
      market_chart_range: {
        source_backed: 1,
        empty: 3,
      },
      ohlc_range: {
        provider_filled: 2,
      },
    });
    expect(restartedDiagnosticsResponse.json().data.response_source_recent_events).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: 'ohlc_range', source: 'provider_filled', coin_id: 'bitcoin' }),
      expect.objectContaining({ route: 'market_chart_range', source: 'empty', coin_id: 'bitcoin' }),
      expect.objectContaining({ route: 'market_chart_days', source: 'empty', coin_id: 'ethereum' }),
      expect.objectContaining({ route: 'market_chart_range', source: 'empty', coin_id: 'solana', interval: 'hourly' }),
    ]));
    expect(restartedDiagnosticsResponse.json().data.response_source_recent_event_rollups).toMatchObject({
      total_events: 6,
      by_coin: [
        {
          coin_id: 'ethereum',
          total: 3,
          provider_filled: 1,
          empty: 2,
        },
        {
          coin_id: 'bitcoin',
          total: 2,
          provider_filled: 1,
          empty: 1,
        },
        {
          coin_id: 'solana',
          total: 1,
          provider_filled: 0,
          empty: 1,
        },
      ],
    });
    expect(restartedDiagnosticsResponse.json().data.response_source_target_suggestions).toEqual([
      expect.objectContaining({
        coin_id: 'ethereum',
        interval: '1d',
        target_template: '<provider>=ethereum:1d:usd',
        event_counts: {
          total: 3,
          provider_filled: 1,
          empty: 2,
        },
        priority: {
          rank: 1,
          pressure_score: 3,
          latest_observed_at: expect.any(String),
        },
        route_pressure: {
          dominant_route: 'market_chart_days',
          totals: {
            market_chart_days: 1,
            market_chart_range: 1,
            ohlc_days: 0,
            ohlc_range: 1,
          },
        },
        request_kind_pressure: {
          dominant_kind: 'range',
          totals: {
            days: 1,
            range: 2,
          },
        },
        range_span_pressure: {
          dominant_bucket: 'single_day',
          range_requests: 2,
          buckets: {
            intraday: 0,
            single_day: 2,
            multi_day: 0,
          },
          min_span_seconds: 0,
          max_span_seconds: 0,
        },
        coverage_target_hint: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          request_pattern: 'range',
          range_window: 'single_day',
        },
      }),
      expect.objectContaining({
        coin_id: 'bitcoin',
        interval: '1d',
        target_template: '<provider>=bitcoin:1d:usd',
        event_counts: {
          total: 2,
          provider_filled: 1,
          empty: 1,
        },
        priority: {
          rank: 2,
          pressure_score: 2,
          latest_observed_at: expect.any(String),
        },
        route_pressure: {
          dominant_route: 'market_chart_range',
          totals: {
            market_chart_days: 0,
            market_chart_range: 1,
            ohlc_days: 0,
            ohlc_range: 1,
          },
        },
        request_kind_pressure: {
          dominant_kind: 'range',
          totals: {
            days: 0,
            range: 2,
          },
        },
        range_span_pressure: {
          dominant_bucket: 'single_day',
          range_requests: 2,
          buckets: {
            intraday: 0,
            single_day: 2,
            multi_day: 0,
          },
          min_span_seconds: 0,
          max_span_seconds: 0,
        },
        coverage_target_hint: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          request_pattern: 'range',
          range_window: 'single_day',
        },
      }),
      expect.objectContaining({
        coin_id: 'solana',
        interval: '1m',
        target_template: '<provider>=solana:1m:usd',
        event_counts: {
          total: 1,
          provider_filled: 0,
          empty: 1,
        },
        priority: {
          rank: 3,
          pressure_score: 1,
          latest_observed_at: expect.any(String),
        },
        route_pressure: {
          dominant_route: 'market_chart_range',
          totals: {
            market_chart_days: 0,
            market_chart_range: 1,
            ohlc_days: 0,
            ohlc_range: 0,
          },
        },
        request_kind_pressure: {
          dominant_kind: 'range',
          totals: {
            days: 0,
            range: 1,
          },
        },
        range_span_pressure: {
          dominant_bucket: 'intraday',
          range_requests: 1,
          buckets: {
            intraday: 1,
            single_day: 0,
            multi_day: 0,
          },
          min_span_seconds: 3_600,
          max_span_seconds: 3_600,
        },
        coverage_target_hint: {
          target_history: 'intraday_history',
          suggested_action: 'expand_intraday_history',
          request_pattern: 'range',
          range_window: 'intraday',
        },
      }),
    ]);
    expect(restartedDiagnosticsResponse.json().data.response_source_fallback_alert).toEqual({
      status: 'action_needed',
      reason: 'unresolved_recent_fallback_pressure',
      recent_events_total: 6,
      events_eligible_for_suggestion: 6,
      suggestions_returned: 3,
      stale_events_ignored: 0,
      source_backed_events_suppressed: 0,
    });
    expect(restartedDiagnosticsResponse.json().data.response_source_target_suggestion_operator_summary).toEqual({
      total_suggestions: 3,
      target_history_counts: {
        daily_history: 2,
        intraday_history: 1,
      },
      suggested_action_counts: {
        expand_daily_history: 2,
        expand_intraday_history: 1,
      },
      request_pattern_counts: {
        days: 0,
        range: 3,
        none: 0,
      },
      range_window_counts: {
        intraday: 1,
        single_day: 2,
        multi_day: 0,
        none: 0,
      },
    });
    expect(restartedDiagnosticsResponse.json().data.response_source_target_suggestion_overflow).toEqual({
      basis: 'eligible_unique_targets_after_stale_and_source_backed_filtering',
      suggestions_limit: 20,
      eligible_targets: 3,
      returned_suggestions: 3,
      omitted_by_suggestion_cap: 0,
      target_history_counts: {
        daily_history: {
          eligible_targets: 2,
          returned_suggestions: 2,
          omitted_by_suggestion_cap: 0,
        },
        intraday_history: {
          eligible_targets: 1,
          returned_suggestions: 1,
          omitted_by_suggestion_cap: 0,
        },
      },
    });
    expect(restartedDiagnosticsResponse.json().data.response_source_target_suggestion_batch_previews).toEqual({
      provider_placeholder: '<provider>',
      total_suggestions: 3,
      cap: {
        preview_source: 'response_source_target_suggestions',
        suggestions_returned: 3,
        suggestions_limit: 20,
      },
      groups: {
        daily_history: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          target_count: 2,
          target_templates: [
            '<provider>=ethereum:1d:usd',
            '<provider>=bitcoin:1d:usd',
          ],
          market_chart_targets_template: '<provider>=ethereum:1d:usd,<provider>=bitcoin:1d:usd',
        },
        intraday_history: {
          target_history: 'intraday_history',
          suggested_action: 'expand_intraday_history',
          target_count: 1,
          target_templates: ['<provider>=solana:1m:usd'],
          market_chart_targets_template: '<provider>=solana:1m:usd',
        },
      },
    });
  });

  it('reports capped market chart suggestion overflow counters through route cache and restart', async () => {
    await getApp().ready();

    getApp().chartResponseSources.record('market_chart_range', 'empty', {
      coinId: 'zz-intraday-capped',
      vsCurrency: 'usd',
      interval: 'hourly',
      request: { kind: 'range', from: Date.UTC(2026, 3, 5, 0), to: Date.UTC(2026, 3, 5, 1) },
    });
    for (let index = 0; index < 20; index += 1) {
      getApp().chartResponseSources.record('market_chart_range', 'empty', {
        coinId: `daily-${index.toString().padStart(2, '0')}`,
        vsCurrency: 'usd',
        interval: 'daily',
        request: { kind: 'range', from: Date.UTC(2026, 3, 5), to: Date.UTC(2026, 3, 5) },
      });
    }

    const diagnosticsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
    });
    const diagnosticsPayload = diagnosticsResponse.json().data;

    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsPayload.response_source_target_suggestion_summary).toEqual(expect.objectContaining({
      unique_eligible_targets: 21,
      suggestions_returned: 20,
      suggestions_limit: 20,
    }));
    expect(diagnosticsPayload.response_source_target_suggestion_overflow).toEqual({
      basis: 'eligible_unique_targets_after_stale_and_source_backed_filtering',
      suggestions_limit: 20,
      eligible_targets: 21,
      returned_suggestions: 20,
      omitted_by_suggestion_cap: 1,
      target_history_counts: {
        daily_history: {
          eligible_targets: 20,
          returned_suggestions: 20,
          omitted_by_suggestion_cap: 0,
        },
        intraday_history: {
          eligible_targets: 1,
          returned_suggestions: 0,
          omitted_by_suggestion_cap: 1,
        },
      },
    });
    expect(diagnosticsPayload.response_source_target_suggestion_overflow.eligible_targets).toBe(
      diagnosticsPayload.response_source_target_suggestion_summary.unique_eligible_targets,
    );
    expect(diagnosticsPayload.response_source_target_suggestion_overflow.returned_suggestions).toBe(
      diagnosticsPayload.response_source_target_suggestion_summary.suggestions_returned,
    );
    expect(diagnosticsPayload.response_source_target_suggestion_overflow.suggestions_limit).toBe(
      diagnosticsPayload.response_source_target_suggestion_summary.suggestions_limit,
    );
    expect(diagnosticsPayload.response_source_target_suggestion_overflow.omitted_by_suggestion_cap).toBe(
      diagnosticsPayload.response_source_target_suggestion_summary.unique_eligible_targets
        - diagnosticsPayload.response_source_target_suggestion_summary.suggestions_returned,
    );
    expect(diagnosticsPayload.response_source_target_suggestion_batch_previews).toEqual(expect.objectContaining({
      total_suggestions: 20,
      groups: {
        daily_history: expect.objectContaining({
          target_count: 20,
        }),
        intraday_history: expect.objectContaining({
          target_count: 0,
          target_templates: [],
          market_chart_targets_template: null,
        }),
      },
    }));
    expect(diagnosticsPayload.response_source_target_suggestion_overflow.target_history_counts.daily_history.returned_suggestions).toBe(
      diagnosticsPayload.response_source_target_suggestion_batch_previews.groups.daily_history.target_count,
    );
    expect(diagnosticsPayload.response_source_target_suggestion_overflow.target_history_counts.intraday_history.returned_suggestions).toBe(
      diagnosticsPayload.response_source_target_suggestion_batch_previews.groups.intraday_history.target_count,
    );
    expect(diagnosticsPayload.response_source_target_suggestions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ target_template: '<provider>=zz-intraday-capped:1m:usd' }),
    ]));
    expect(diagnosticsResponse.headers.etag).toEqual(expect.any(String));

    const cachedDiagnosticsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
      headers: {
        'if-none-match': diagnosticsResponse.headers.etag,
      },
    });
    expect(cachedDiagnosticsResponse.statusCode).toBe(304);
    expect(cachedDiagnosticsResponse.headers.etag).toBe(diagnosticsResponse.headers.etag);
    expect(cachedDiagnosticsResponse.headers['cache-control']).toBe(diagnosticsResponse.headers['cache-control']);

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const restartedDiagnosticsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/market_charts',
    });
    const restartedDiagnosticsPayload = restartedDiagnosticsResponse.json().data;
    expect(restartedDiagnosticsResponse.statusCode).toBe(200);
    expect(restartedDiagnosticsPayload.response_source_target_suggestion_overflow).toEqual(
      diagnosticsPayload.response_source_target_suggestion_overflow,
    );
    expect(restartedDiagnosticsPayload.response_source_target_suggestion_overflow.eligible_targets).toBe(
      restartedDiagnosticsPayload.response_source_target_suggestion_summary.unique_eligible_targets,
    );
    expect(restartedDiagnosticsPayload.response_source_target_suggestion_overflow.returned_suggestions).toBe(
      restartedDiagnosticsPayload.response_source_target_suggestion_summary.suggestions_returned,
    );
    expect(restartedDiagnosticsPayload.response_source_target_suggestion_overflow.suggestions_limit).toBe(
      restartedDiagnosticsPayload.response_source_target_suggestion_summary.suggestions_limit,
    );
    expect(restartedDiagnosticsPayload.response_source_target_suggestion_batch_previews.groups.intraday_history).toEqual(
      diagnosticsPayload.response_source_target_suggestion_batch_previews.groups.intraday_history,
    );
    expect(restartedDiagnosticsPayload.response_source_target_suggestion_overflow.target_history_counts.daily_history.returned_suggestions).toBe(
      restartedDiagnosticsPayload.response_source_target_suggestion_batch_previews.groups.daily_history.target_count,
    );
    expect(restartedDiagnosticsPayload.response_source_target_suggestion_overflow.target_history_counts.intraday_history.returned_suggestions).toBe(
      restartedDiagnosticsPayload.response_source_target_suggestion_batch_previews.groups.intraday_history.target_count,
    );
  });

  it('returns supply chart provider gap diagnostics for fixture, configured, replay, and live states', async () => {
    await getApp().ready();
    const fixtureOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/supply_charts',
    });

    expect(fixtureOnlyResponse.statusCode).toBe(200);
    expect(fixtureOnlyResponse.json().data).toMatchObject({
      configured_targets: [],
      coins: expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          status: 'fixture_only',
          row_counts: {
            circulating: { total: 0, live: 0, replay: 0 },
            total: { total: 0, live: 0, replay: 0 },
          },
        }),
      ]),
      gaps: expect.objectContaining({
        fixture_only_coins: expect.arrayContaining(['bitcoin']),
      }),
      notes: expect.stringContaining('fixture-only coins must not be advertised as live'),
    });

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'configured-supply-charts.db'),
        ccxtExchanges: ['binance'],
        supplyChartTargets: 'mock.supply=bitcoin',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const configuredResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/supply_charts',
    });

    expect(configuredResponse.statusCode).toBe(200);
    expect(configuredResponse.json().data).toMatchObject({
      configured_targets: [{
        provider: 'mock.supply',
        coin_id: 'bitcoin',
        source_provider: 'mock.supply',
      }],
      coins: expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          status: 'configured_pending',
          configured_provider: 'mock.supply',
          latest_source_fetched_at: null,
        }),
      ]),
      gaps: expect.objectContaining({
        configured_without_source_rows: ['bitcoin'],
      }),
    });

    const fixture = loadSupplyChartFixture();
    ingestSupplyChartReplay(getApp().db, fixture);

    const replayResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/supply_charts',
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().data.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: fixture.coin_id,
        status: 'replay_backed',
        source_providers: ['supply-replay'],
        row_counts: {
          circulating: { total: 3, live: 0, replay: 3 },
          total: { total: 3, live: 0, replay: 3 },
        },
        latest_source_fetched_at: '2026-05-05T00:12:00.000Z',
      }),
    ]));

    await syncSupplyCharts(getApp().db, {
      targets: [{
        provider: 'mock.supply',
        coinId: fixture.coin_id,
      }],
      now: new Date('2026-05-05T00:18:00.000Z'),
      fetcher: async () => fixture,
    });

    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/supply_charts',
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json().data.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: fixture.coin_id,
        status: 'live_backed',
        source_providers: ['mock.supply', 'supply-replay'],
        row_counts: {
          circulating: { total: 6, live: 3, replay: 3 },
          total: { total: 6, live: 3, replay: 3 },
        },
        latest_source_fetched_at: '2026-05-05T00:18:00.000Z',
      }),
    ]));
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

  it('exposes configured provider diagnostics under the validation boot config before real breaker events', async () => {
    await getApp().close();
    app = buildApp({
      config: {
        host: '127.0.0.1',
        port: 3102,
        databaseUrl: ':memory:',
        disableRemoteCurrencyRefresh: true,
        logLevel: 'silent',
        ccxtExchanges: ['binance'],
        providerFanoutConcurrency: 1,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
      exposeSchedulerDiagnostics: true,
    });

    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.providers).toEqual([
      {
        id: 'binance',
        state: 'closed',
        last_success_at: null,
        last_failure_at: null,
        last_failure_reason: null,
        failure_count: 0,
        next_retry_at: null,
        alert_status: 'healthy',
      },
    ]);
  });
});
