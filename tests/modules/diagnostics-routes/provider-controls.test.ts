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
        failure_kind: null,
        failure_count: 0,
        next_retry_at: null,
        alert_status: 'healthy',
        capabilities: [
          expect.objectContaining({
            surface: 'market_price',
            ownership: 'configured',
            state: 'pending',
          }),
          expect.objectContaining({
            surface: 'ticker',
            ownership: 'configured',
            state: 'pending',
          }),
          expect.objectContaining({
            surface: 'exchange',
            ownership: 'configured',
            state: 'pending',
          }),
          expect.objectContaining({
            surface: 'chart',
            ownership: 'configured',
            state: 'pending',
          }),
        ],
      },
    ]);
  });

  it('allows validation-control provider fault controls to trigger and reset deterministic scenarios', async () => {
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
    });
    await getApp().ready();

    const triggerResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fault_control',
      payload: {
        provider: 'ccxt.binance',
        family: 'ticker',
        mode: 'timeout',
        reason: 'validator timeout api_key=super-secret',
      },
    });

    expect(triggerResponse.statusCode).toBe(200);
    expect(triggerResponse.json().data.fault_controls).toEqual([
      expect.objectContaining({
        provider: 'binance',
        family: 'ticker',
        mode: 'timeout',
        reason: expect.not.stringContaining('super-secret'),
      }),
    ]);

    const unimplementedFamilyResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fault_control',
      payload: {
        provider: 'ccxt.binance',
        family: 'market',
        mode: 'timeout',
      },
    });

    expect(unimplementedFamilyResponse.statusCode).toBe(400);
    expect(unimplementedFamilyResponse.json().allowed.family).toEqual(['ticker', 'onchain']);

    const onchainTriggerResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fault_control',
      payload: {
        provider: 'defillama',
        family: 'onchain',
        mode: 'failure',
        reason: 'validator controlled onchain failure',
      },
    });

    expect(onchainTriggerResponse.statusCode).toBe(200);
    expect(onchainTriggerResponse.json().data.fault_controls).toEqual([
      expect.objectContaining({
        provider: 'binance',
        family: 'ticker',
        mode: 'timeout',
      }),
      expect.objectContaining({
        provider: 'defillama',
        family: 'onchain',
        mode: 'failure',
      }),
    ]);

    const diagnosticsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });
    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json().data.provider_attempts.fault_controls).toEqual([
      expect.objectContaining({
        provider: 'binance',
        family: 'ticker',
        mode: 'timeout',
      }),
      expect.objectContaining({
        provider: 'defillama',
        family: 'onchain',
        mode: 'failure',
      }),
    ]);

    const resetResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fault_control',
      payload: {
        reset: true,
      },
    });
    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json().data.fault_controls).toEqual([]);

    const resetDiagnosticsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });
    expect(resetDiagnosticsResponse.statusCode).toBe(200);
    expect(resetDiagnosticsResponse.json().data.provider_attempts).toEqual({
      in_flight_count: 0,
      in_flight: [],
      recent_outcomes: [],
      outcome_counts: [],
      fault_controls: [],
    });
  });

  it('actively triggers ticker fanout validation outcomes without cached public route reads', async () => {
    await getApp().close();
    app = buildApp({
      config: {
        host: '127.0.0.1',
        port: 3102,
        databaseUrl: ':memory:',
        disableRemoteCurrencyRefresh: true,
        logLevel: 'silent',
        ccxtExchanges: ['binance', 'coinbase'],
        providerFanoutConcurrency: 2,
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    for (const control of [
      {
        provider: 'ccxt.binance',
        family: 'ticker',
        mode: 'timeout',
        reason: 'validator timeout api_key=super-secret',
      },
      {
        provider: 'coinbase',
        family: 'ticker',
        mode: 'canceled',
        reason: 'validator canceled secret=hidden',
      },
    ]) {
      const response = await getApp().inject({
        method: 'POST',
        url: '/diagnostics/runtime/provider_fault_control',
        payload: control,
      });
      expect(response.statusCode).toBe(200);
    }

    const triggerResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fanout_validation',
      payload: {
        providers: ['ccxt.binance', 'coinbase'],
        budget_ms: 50,
        concurrency: 2,
      },
    });

    expect(triggerResponse.statusCode).toBe(200);
    expect(triggerResponse.json().data.validation_path).toMatchObject({
      route: '/diagnostics/runtime/provider_fanout_validation',
      cache_independent: true,
      scheduler_independent: true,
      public_route_read_required: false,
    });
    expect(triggerResponse.json().data.results).toEqual([
      expect.objectContaining({
        provider: 'binance',
        status: 'rejected',
        outcome: 'timed_out',
        reason: 'provider request timed out',
      }),
      expect.objectContaining({
        provider: 'coinbase',
        status: 'rejected',
        outcome: 'canceled',
        reason: 'provider request canceled',
      }),
    ]);
    expect(triggerResponse.json().data.provider_attempts).toMatchObject({
      in_flight_count: 0,
      outcome_counts: expect.arrayContaining([
        expect.objectContaining({
          provider: 'binance',
          family: 'ticker',
          outcome: 'timed_out',
          delta: 1,
        }),
        expect.objectContaining({
          provider: 'coinbase',
          family: 'ticker',
          outcome: 'canceled',
          delta: 1,
        }),
      ]),
    });
    expect(triggerResponse.json().data.metric_deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: 'opengecko_provider_attempts_total',
        provider: 'binance',
        family: 'ticker',
        outcome: 'timed_out',
        delta: 1,
      }),
      expect.objectContaining({
        metric: 'opengecko_provider_attempts_total',
        provider: 'coinbase',
        family: 'ticker',
        outcome: 'canceled',
        delta: 1,
      }),
    ]));

    const metricsResponse = await getApp().inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.body).toContain('opengecko_provider_attempts_total{family="ticker",outcome="timed_out",provider="binance"} 1');
    expect(metricsResponse.body).toContain('opengecko_provider_attempts_total{family="ticker",outcome="canceled",provider="coinbase"} 1');
    expect(metricsResponse.body).toContain('opengecko_provider_in_flight{family="ticker",provider="binance"} 0');
    expect(metricsResponse.body).toContain('opengecko_provider_in_flight{family="ticker",provider="coinbase"} 0');
  });

  it('uses the fanout validation trigger to prove breaker-open, recovery, and success metrics', async () => {
    await getApp().close();
    app = buildApp({
      config: {
        host: '127.0.0.1',
        port: 3102,
        databaseUrl: ':memory:',
        disableRemoteCurrencyRefresh: true,
        logLevel: 'silent',
        ccxtExchanges: ['binance', 'coinbase'],
        providerFanoutConcurrency: 2,
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const failureControlResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fault_control',
      payload: {
        provider: 'binance',
        family: 'ticker',
        mode: 'failure',
        reason: 'validator controlled failure token=secret',
      },
    });
    expect(failureControlResponse.statusCode).toBe(200);

    const failureTriggerResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fanout_validation',
      payload: {
        providers: ['binance'],
        allow_breaker_probe: true,
      },
    });
    expect(failureTriggerResponse.statusCode).toBe(200);
    expect(failureTriggerResponse.json().data.results).toEqual([
      expect.objectContaining({
        provider: 'binance',
        outcome: 'failed',
        reason: 'provider failed',
      }),
    ]);
    expect(failureTriggerResponse.json().data.breaker_summary).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'binance',
        status: 'open',
        failure_count: 1,
      }),
    ]));

    const breakerOpenResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fanout_validation',
      payload: {
        providers: ['binance'],
      },
    });
    expect(breakerOpenResponse.statusCode).toBe(200);
    expect(breakerOpenResponse.json().data.results).toEqual([
      expect.objectContaining({
        provider: 'binance',
        outcome: 'breaker_open',
        reason: 'provider breaker open',
      }),
    ]);
    expect(breakerOpenResponse.json().data.metric_deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: 'provider_blocked_by_breaker_total',
        provider: 'binance',
        delta: 1,
      }),
    ]));

    const clearFailureControlResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fault_control',
      payload: {
        provider: 'binance',
        family: 'ticker',
        mode: 'off',
      },
    });
    expect(clearFailureControlResponse.statusCode).toBe(200);

    const recoveryResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_fanout_validation',
      payload: {
        providers: ['binance', 'coinbase'],
        allow_breaker_probe: true,
        concurrency: 2,
      },
    });
    expect(recoveryResponse.statusCode).toBe(200);
    expect(recoveryResponse.json().data.results).toEqual([
      expect.objectContaining({
        provider: 'binance',
        status: 'fulfilled',
        outcome: 'recovered',
      }),
      expect.objectContaining({
        provider: 'coinbase',
        status: 'fulfilled',
        outcome: 'successful',
      }),
    ]);
    expect(recoveryResponse.json().data.metric_deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: 'opengecko_provider_attempts_total',
        provider: 'binance',
        family: 'ticker',
        outcome: 'recovered',
        delta: 1,
      }),
      expect.objectContaining({
        metric: 'provider_recovery_total',
        provider: 'binance',
        delta: 1,
      }),
      expect.objectContaining({
        metric: 'opengecko_provider_attempts_total',
        provider: 'coinbase',
        family: 'ticker',
        outcome: 'successful',
        delta: 1,
      }),
    ]));

    const diagnosticsResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });
    expect(diagnosticsResponse.statusCode).toBe(200);
    const binanceProvider = diagnosticsResponse.json().data.providers.find((provider: { id: string }) => provider.id === 'binance');
    expect(binanceProvider).toMatchObject({
      id: 'binance',
      state: 'closed',
      failure_count: 0,
      last_failure_reason: null,
    });
    expect(binanceProvider.last_success_at).not.toBeNull();
    expect(diagnosticsResponse.json().data.provider_attempts.recent_outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'binance',
        family: 'ticker',
        outcome: 'recovered',
      }),
      expect.objectContaining({
        provider: 'coinbase',
        family: 'ticker',
        outcome: 'successful',
      }),
      expect.objectContaining({
        provider: 'binance',
        family: 'ticker',
        outcome: 'breaker_open',
      }),
      expect.objectContaining({
        provider: 'binance',
        family: 'ticker',
        outcome: 'failed',
      }),
    ]));

    const metricsResponse = await getApp().inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.body).toContain('provider_blocked_by_breaker_total{provider="binance"} 1');
    expect(metricsResponse.body).toContain('provider_recovery_total{provider="binance"} 1');
    expect(metricsResponse.body).toContain('opengecko_provider_attempts_total{family="ticker",outcome="failed",provider="binance"} 1');
    expect(metricsResponse.body).toContain('opengecko_provider_attempts_total{family="ticker",outcome="breaker_open",provider="binance"} 1');
    expect(metricsResponse.body).toContain('opengecko_provider_attempts_total{family="ticker",outcome="recovered",provider="binance"} 1');
    expect(metricsResponse.body).toContain('opengecko_provider_attempts_total{family="ticker",outcome="successful",provider="coinbase"} 1');
  });
});
