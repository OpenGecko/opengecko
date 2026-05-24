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

});
