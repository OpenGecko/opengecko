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
        allowed_job_statuses: [
          'idle',
          'blocked',
          'retrying',
          'failed',
          'skipped',
          'partial-failure',
          'lagging',
          'stale-run',
        ],
        stale_data_fallback: expect.objectContaining({
          active: expect.any(Boolean),
          status: expect.stringMatching(/^(clear|active)$/),
          disclosure_surfaces: [
            '/diagnostics/freshness_budgets',
            '/diagnostics/data_quality',
            '/diagnostics/coverage_matrix',
          ],
        }),
      },
      jobs: expect.arrayContaining([
        expect.objectContaining({
          name: 'market-refresh',
          status: 'idle',
          status_reason: 'waiting_for_next_scheduled_run',
          interval_seconds: 60,
          last_run_at: null,
          last_success_at: null,
          last_duration_ms: null,
          last_error: null,
          error_count: 0,
          lag_seconds: null,
          observed_lag_seconds: null,
          next_scheduled_at: null,
          next_retry_at: null,
          retry_attempt_count: 0,
          backoff: {
            active: false,
            attempt_count: 0,
            next_retry_at: null,
          },
          stale_run: {
            is_stale: false,
            owning_job: null,
            started_at: null,
            heartbeat_at: null,
            stale_after_seconds: expect.any(Number),
            stale_duration_seconds: null,
            recovery_eligible: false,
            recovery_reason: null,
          },
        }),
        expect.objectContaining({
          name: 'currency-rates',
          interval_seconds: 300,
          disabled: true,
          status: 'blocked',
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

  it('allows validation-control scheduler backoff triggers to prove /diagnostics/jobs retry fields', async () => {
    const hiddenResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/scheduler_backoff_validation',
      payload: {
        reason: 'validator hidden route check',
      },
    });
    expect(hiddenResponse.statusCode).toBe(404);

    await getApp().close();
    app = buildApp({
      config: {
        host: '127.0.0.1',
        port: 3102,
        databaseUrl: ':memory:',
        disableRemoteCurrencyRefresh: true,
        logLevel: 'silent',
        ccxtExchanges: ['binance'],
      },
      startBackgroundJobs: false,
      exposeSchedulerDiagnostics: true,
    });
    await getApp().ready();

    const triggerResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/scheduler_backoff_validation',
      payload: {
        reason: 'scheduler validation forced refresh failure token=super-secret /tmp/opengecko-validation-secret.sqlite',
      },
    });

    expect(triggerResponse.statusCode).toBe(200);
    expect(triggerResponse.json().data.validation_path).toEqual({
      route: '/diagnostics/runtime/scheduler_backoff_validation',
      diagnostics_route: '/diagnostics/jobs',
      validation_port: 3102,
      cache_independent: true,
      public_route_read_required: false,
      forced_job_failure: true,
    });
    expect(triggerResponse.json().data.job).toMatchObject({
      name: 'validation-scheduler-backoff',
      status: 'retrying',
      status_reason: 'retry_backoff_active',
      running: false,
      retry_attempt_count: 1,
      error_count: 1,
      backoff: {
        active: true,
        attempt_count: 1,
      },
    });
    expect(triggerResponse.json().data.job.next_retry_at).toEqual(expect.any(String));
    expect(triggerResponse.json().data.job.backoff.next_retry_at).toBe(triggerResponse.json().data.job.next_retry_at);
    expect(triggerResponse.json().data.job.last_error).toContain('scheduler validation forced refresh failure');
    expect(triggerResponse.json().data.job.last_error).not.toContain('super-secret');
    expect(triggerResponse.json().data.job.last_error).not.toContain('/tmp/opengecko-validation-secret.sqlite');

    const jobsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/jobs',
    });

    expect(jobsResponse.statusCode).toBe(200);
    expect(jobsResponse.json().data.scheduler.allowed_job_statuses).toContain('retrying');
    expect(jobsResponse.json().data.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'validation-scheduler-backoff',
        status: 'retrying',
        status_reason: 'retry_backoff_active',
        retry_attempt_count: 1,
        next_retry_at: triggerResponse.json().data.job.next_retry_at,
        backoff: expect.objectContaining({
          active: true,
          attempt_count: 1,
          next_retry_at: triggerResponse.json().data.job.next_retry_at,
        }),
        last_error: triggerResponse.json().data.job.last_error,
      }),
    ]));
  });

  it('discloses stale public-route fallback pressure through job diagnostics', async () => {
    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'scheduler-stale-fallback.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: true,
    });
    await getApp().ready();

    getApp().db.db.update(marketSnapshots).set({
      sourceProvidersJson: JSON.stringify(['binance']),
      sourceCount: 1,
      lastUpdated: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }).where(eq(marketSnapshots.vsCurrency, 'usd')).run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/jobs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.scheduler.stale_data_fallback).toMatchObject({
      active: true,
      status: 'active',
      reason_codes: expect.arrayContaining(['freshness_stale']),
      affected_families: expect.arrayContaining([
        expect.objectContaining({
          family: 'simple',
          status: 'stale',
          public_routes: expect.arrayContaining(['/simple/price']),
          scheduler_correlation: expect.objectContaining({
            refresh_job: 'market-refresh',
            disclosure: 'public route may be serving cached or stale data until the scheduler refresh succeeds',
          }),
        }),
        expect.objectContaining({
          family: 'coins_markets',
          status: 'stale',
          public_routes: expect.arrayContaining(['/coins/markets']),
        }),
      ]),
      disclosure_surfaces: [
        '/diagnostics/freshness_budgets',
        '/diagnostics/data_quality',
        '/diagnostics/coverage_matrix',
      ],
    });
  });

  it('exposes exchange coverage aliases and live ticker ingestion diagnostics', async () => {
    const [coverageResponse, exchangeDiagnosticsResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/diagnostics/coverage',
      }),
      getApp().inject({
        method: 'GET',
        url: '/diagnostics/exchanges',
      }),
    ]);

    expect(coverageResponse.statusCode).toBe(200);
    expect(coverageResponse.json().data.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'exchanges',
        ownership_class: expect.stringMatching(/^(hybrid|seeded)$/),
      }),
    ]));

    expect(exchangeDiagnosticsResponse.statusCode).toBe(200);
    expect(exchangeDiagnosticsResponse.json().data.provider_coverage).toMatchObject({
      configured_exchange_ids: ['binance', 'coinbase', 'kraken', 'okx'],
      configured_exchange_count: 4,
      attempted_exchange_count: 4,
      promotion_attempted_exchange_count: 4,
      live_backed_exchange_ids: expect.arrayContaining(['binance']),
      live_backed_exchange_count: expect.any(Number),
      minimum_promotion_attempt_count: 12,
    });
    expect(exchangeDiagnosticsResponse.json().data.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'binance',
        attempted: true,
        live_backed: true,
        failure_kind: null,
      }),
    ]));
    expect(exchangeDiagnosticsResponse.json().data.exchanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'binance',
        evidence_class: 'live_ticker',
        ticker_evidence: expect.objectContaining({
          live_row_count: expect.any(Number),
          seeded_row_count: expect.any(Number),
          last_live_ticker_at: expect.any(String),
        }),
        ingestion: expect.objectContaining({
          accepted_ticker_rows: expect.any(Number),
          rejected_ticker_rows: expect.any(Number),
          rejection_reasons: expect.any(Object),
          failed_kind: null,
        }),
      }),
    ]));
  });

  it('keeps seeded and replay-only exchange diagnostics distinct from live evidence', async () => {
    const appDb = getApp().db;
    appDb.db.insert(exchanges).values({
      id: 'replay-only',
      name: 'Replay Only',
      yearEstablished: null,
      country: null,
      description: '',
      url: 'https://example.com',
      imageUrl: null,
      hasTradingIncentive: false,
      trustScore: null,
      trustScoreRank: 999,
      tradeVolume24hBtc: null,
      tradeVolume24hBtcNormalized: null,
      facebookUrl: null,
      redditUrl: null,
      telegramUrl: null,
      slackUrl: null,
      otherUrlJson: '[]',
      twitterHandle: null,
      centralised: true,
      publicNotice: null,
      alertNotice: null,
      updatedAt: new Date('2026-03-20T00:00:00.000Z'),
    }).run();
    appDb.db.insert(exchangeVolumeSourcePoints).values({
      exchangeId: 'replay-only',
      timestamp: new Date('2026-05-14T00:00:00.000Z'),
      volumeBtc: 12,
      sourceKind: 'replay',
      sourceProvider: 'exchange-volume-replay',
      sourceFetchedAt: new Date('2026-05-14T00:01:00.000Z'),
    }).run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/exchanges',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.exchanges.find((exchange: { id: string }) => exchange.id === 'replay-only')).toMatchObject({
      evidence_class: 'replay_only',
      ticker_evidence: {
        live_row_count: 0,
        seeded_row_count: 0,
        last_live_ticker_at: null,
      },
      volume_evidence: {
        live_row_count: 0,
        replay_row_count: 1,
        last_live_volume_at: null,
        last_replay_volume_at: '2026-05-14T00:01:00.000Z',
      },
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

});
