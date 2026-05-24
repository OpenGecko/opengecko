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
    expect(response.json().data).toMatchObject({
      schema_version: 1,
      generated_at: expect.any(String),
      live_data_rules: {
        only_live_source_state_counts_as_live_evidence: true,
        non_live_states_do_not_count_as_live_freshness_evidence: true,
      },
    });
    expect(response.json().data.budgets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'simple',
        representative_routes: ['/simple/price', '/simple/token_price/:id'],
        target_freshness_seconds: 30,
        degraded_after_seconds: 120,
        budget_basis: 'latest_market_snapshot',
        budget_seconds: 30,
        budget: {
          target_freshness_seconds: 30,
          degraded_after_seconds: 120,
          basis: 'latest_market_snapshot',
        },
        status: expect.stringMatching(/^(fresh|degraded|stale|unbudgeted|unknown)$/),
        reason: expect.any(String),
        source_state: expect.stringMatching(/^(live|seeded)$/),
        counts_as_live_evidence: expect.any(Boolean),
        counts_as_live_freshness_evidence: expect.any(Boolean),
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
        budget: {
          target_freshness_seconds: null,
          degraded_after_seconds: null,
          basis: 'route_interval',
        },
        status: expect.stringMatching(/^(fresh|degraded|stale|unbudgeted|unknown)$/),
        reason: expect.any(String),
      }),
      expect.objectContaining({
        family: 'supply_charts',
        target_freshness_seconds: 86_400,
        degraded_after_seconds: 604_800,
        budget_basis: 'provider_refresh',
      }),
      expect.objectContaining({
        family: 'treasury',
        target_freshness_seconds: 86_400,
        degraded_after_seconds: 604_800,
        budget_basis: 'fixture_or_seeded',
      }),
    ]));

    const budgets = response.json().data.budgets as Array<{
      source_state: string;
      current_age_seconds: number | null;
      age_seconds: number | null;
      last_success_at: string | null;
      budget: Record<string, unknown>;
      status: string;
      reason: string;
      counts_as_live_evidence: boolean;
      counts_as_live_freshness_evidence: boolean;
    }>;
    for (const budget of budgets) {
      expect(budget).toHaveProperty('current_age_seconds');
      expect(budget).toHaveProperty('age_seconds');
      expect(budget).toHaveProperty('last_success_at');
      expect(typeof budget.reason).toBe('string');
      expect(['fresh', 'degraded', 'stale', 'unbudgeted', 'unknown']).toContain(budget.status);
      expect(typeof budget.budget).toBe('object');
      if (budget.current_age_seconds !== null) {
        expect(budget.current_age_seconds).toBeGreaterThanOrEqual(0);
      }
      if (budget.age_seconds !== null) {
        expect(budget.age_seconds).toBeGreaterThanOrEqual(0);
      }
    }
    for (const budget of budgets.filter((entry) => entry.source_state !== 'live')) {
      expect(budget.counts_as_live_evidence).toBe(false);
      expect(budget.counts_as_live_freshness_evidence).toBe(false);
    }
  });

  it('exposes SQLite path classification and validation service profile in runtime diagnostics', async () => {
    await getApp().close();
    const runtimeDbPath = join(tempDir, 'opengecko-runtime.sqlite');
    app = buildApp({
      config: {
        databaseUrl: runtimeDbPath,
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        port: 3100,
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const runtimeResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });

    expect(runtimeResponse.statusCode).toBe(200);
    expect(runtimeResponse.json().data.database).toMatchObject({
      runtime: expect.stringMatching(/^(bun|node)$/),
      driver: expect.stringMatching(/^(bun:sqlite|better-sqlite3)$/),
      configured_url: runtimeDbPath,
      effective_path: runtimeDbPath,
      path_class: 'tmp_validation_file',
      storage_mode: 'file',
      shared_file: true,
      journal_mode: 'wal',
      wal_enabled: true,
      busy_timeout_ms: expect.any(Number),
      status: 'healthy',
      status_reason: 'sqlite_ok',
      lock_contention: {
        status: 'clear',
        total_count: 0,
        busy_count: 0,
        locked_count: 0,
        last_observed_at: null,
        recent_samples: [],
        max_recent_samples: expect.any(Number),
      },
      persistence: {
        status: 'healthy',
        reason_code: 'sqlite_ok',
        fatal_failure_count: 0,
        last_failure_at: null,
        recent_failures: [],
        max_recent_failures: expect.any(Number),
      },
    });
    expect(runtimeResponse.json().data.database.busy_timeout_ms).toBeGreaterThan(0);
    expect(runtimeResponse.json().data.validation_profile).toEqual({
      mission_service_ports: [3100, 3102, 3103],
      current_port: 3100,
      current_port_approved: true,
      service_role: 'api_smoke',
      port_3000_required: false,
      service_backed_validation: {
        serial_required: true,
        explicit_database_url: runtimeDbPath,
        database_path_class: 'tmp_validation_file',
      },
    });

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        port: 3102,
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const controlResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });

    expect(controlResponse.statusCode).toBe(200);
    expect(controlResponse.json().data.database).toMatchObject({
      configured_url: ':memory:',
      effective_path: ':memory:',
      path_class: 'in_memory',
      storage_mode: 'in_memory',
      shared_file: false,
      wal_enabled: false,
      busy_timeout_ms: expect.any(Number),
    });
    expect(controlResponse.json().data.validation_profile).toMatchObject({
      current_port: 3102,
      current_port_approved: true,
      service_role: 'validation_control',
      port_3000_required: false,
      service_backed_validation: {
        serial_required: true,
        explicit_database_url: ':memory:',
        database_path_class: 'in_memory',
      },
    });

    await getApp().close();
    const qualityDbPath = join(tempDir, 'opengecko-quality.sqlite');
    app = buildApp({
      config: {
        databaseUrl: qualityDbPath,
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        port: 3103,
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const qualityResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });

    expect(qualityResponse.statusCode).toBe(200);
    expect(qualityResponse.json().data.database).toMatchObject({
      configured_url: qualityDbPath,
      effective_path: qualityDbPath,
      path_class: 'tmp_validation_file',
      storage_mode: 'file',
      shared_file: true,
      wal_enabled: true,
      busy_timeout_ms: expect.any(Number),
    });
    expect(qualityResponse.json().data.validation_profile).toEqual({
      mission_service_ports: [3100, 3102, 3103],
      current_port: 3103,
      current_port_approved: true,
      service_role: 'data_quality_gate',
      port_3000_required: false,
      service_backed_validation: {
        serial_required: true,
        explicit_database_url: qualityDbPath,
        database_path_class: 'tmp_validation_file',
      },
    });
  });

  it('exposes controlled SQLite contention and fatal persistence diagnostics separately', async () => {
    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        port: 3102,
      },
      startBackgroundJobs: false,
      exposeSchedulerDiagnostics: true,
    });
    await getApp().ready();

    const contentionResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/sqlite_fault_validation',
      payload: {
        mode: 'contention',
        operation: 'market refresh token=super-secret /tmp/opengecko-contention.sqlite',
      },
    });

    expect(contentionResponse.statusCode).toBe(200);
    expect(contentionResponse.json().data.validation_path).toEqual({
      route: '/diagnostics/runtime/sqlite_fault_validation',
      diagnostics_route: '/diagnostics/runtime',
      validation_port: 3102,
      simulated_failure: 'contention',
    });
    expect(contentionResponse.json().data.database).toMatchObject({
      status: 'contention_backoff',
      status_reason: 'sqlite_contention_observed',
      lock_contention: {
        status: 'contention_observed',
        total_count: 1,
        busy_count: 1,
        locked_count: 0,
        last_observed_at: expect.any(String),
      },
      persistence: {
        status: 'contention_backoff',
        reason_code: 'sqlite_contention_backoff',
        fatal_failure_count: 0,
      },
    });
    expect(JSON.stringify(contentionResponse.json().data.database.lock_contention.recent_samples)).not.toContain('super-secret');
    expect(JSON.stringify(contentionResponse.json().data.database.lock_contention.recent_samples)).not.toContain('/tmp/opengecko-contention.sqlite');

    const fatalResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/sqlite_fault_validation',
      payload: {
        mode: 'fatal_persistence',
        operation: 'worker write password=hunter2 /var/lib/opengecko/opengecko.db',
      },
    });

    expect(fatalResponse.statusCode).toBe(200);
    expect(fatalResponse.json().data.database).toMatchObject({
      status: 'fatal_persistence_failure',
      status_reason: 'sqlite_fatal_persistence_failure',
      lock_contention: {
        total_count: 1,
      },
      persistence: {
        status: 'fatal_failure',
        reason_code: 'sqlite_fatal_persistence_failure',
        fatal_failure_count: 1,
        last_failure_at: expect.any(String),
      },
    });
    expect(fatalResponse.json().data.database.persistence.recent_failures).toEqual([
      expect.objectContaining({
        classification: 'fatal_persistence',
        reason_code: 'sqlite_corrupt',
        operation: expect.stringContaining('worker write'),
      }),
    ]);
    expect(JSON.stringify(fatalResponse.json().data.database.persistence.recent_failures)).not.toContain('hunter2');
    expect(JSON.stringify(fatalResponse.json().data.database.persistence.recent_failures)).not.toContain('/var/lib/opengecko');
  });

});
