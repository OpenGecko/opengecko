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

});
