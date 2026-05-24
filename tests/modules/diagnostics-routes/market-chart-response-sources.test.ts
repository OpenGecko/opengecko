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
    mockedFetchExchangeOHLCV.mockClear();
    const emptyOhlcResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1775001600&to=1775001600&interval=daily',
    });
    expect(emptyOhlcResponse.statusCode).toBe(200);
    const emptyOhlcPayload = emptyOhlcResponse.json();
    expect(emptyOhlcPayload).toEqual([]);
    expect(mockedFetchExchangeOHLCV).not.toHaveBeenCalled();
    expect(emptyOhlcPayload).not.toHaveProperty('response_source_counts');
    expect(emptyOhlcPayload).not.toHaveProperty('response_source_fallback_alert');
    expect(emptyOhlcPayload).not.toHaveProperty('response_source_target_suggestion_overflow');
    expect(emptyOhlcPayload).not.toHaveProperty('response_source_target_suggestion_batch_previews');

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
        provider_filled: 1,
        source_backed: 0,
        canonical: 0,
        empty: 1,
      },
    });
    expect(diagnosticsResponse.json().data.response_source_recent_events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        route: 'ohlc_range',
        source: 'empty',
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
          provider_filled: 1,
          empty: 1,
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
          provider_filled: 0,
          empty: 2,
          routes: {
            market_chart_range: {
              provider_filled: 0,
              empty: 1,
            },
            ohlc_range: {
              provider_filled: 0,
              empty: 1,
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
          provider_filled: 0,
          empty: 2,
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
            provider_filled: 0,
            empty: 1,
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
        provider_filled: 1,
        empty: 1,
      },
    });
    expect(restartedDiagnosticsResponse.json().data.response_source_recent_events).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: 'ohlc_range', source: 'empty', coin_id: 'bitcoin' }),
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
          provider_filled: 0,
          empty: 2,
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
          provider_filled: 0,
          empty: 2,
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

});
