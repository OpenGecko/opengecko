import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { seedStaticReferenceData } from '../src/db/client';
import { coinTickers } from '../src/db/schema';
import { runInitialMarketSync } from '../src/services/initial-sync';
import { runMarketRefreshOnce } from '../src/services/market-refresh';
import { createMarketDataRuntimeState } from '../src/services/market-runtime-state';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeMarkets, fetchExchangeTickers } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeTickers = fetchExchangeTickers as ReturnType<typeof vi.fn>;

describe('exchange live fidelity contracts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-exchange-fidelity-'));
    mockedFetchExchangeMarkets.mockReset();
    mockedFetchExchangeTickers.mockReset();
    mockedFetchExchangeMarkets.mockResolvedValue([]);
    mockedFetchExchangeTickers.mockResolvedValue([]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns seeded exchange registry when live exchange discovery is unavailable', async () => {
    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'app.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const exchangesListResponse = await app.inject({
        method: 'GET',
        url: '/exchanges/list',
      });
      expect(exchangesListResponse.statusCode).toBe(200);
      expect(exchangesListResponse.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'binance', name: 'Binance' }),
      ]));
    } finally {
      await app.close();
    }
  });

  it('returns non-null derivative venue and contract freshness fields', async () => {
    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'derivatives.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const exchangesResponse = await app.inject({
        method: 'GET',
        url: '/derivatives/exchanges',
      });
      const derivativesResponse = await app.inject({
        method: 'GET',
        url: '/derivatives',
      });

      expect(exchangesResponse.statusCode).toBe(200);
      for (const venue of exchangesResponse.json().data) {
        expect(venue.open_interest_btc).not.toBeNull();
        expect(venue.trade_volume_24h_btc).not.toBeNull();
      }

      expect(derivativesResponse.statusCode).toBe(200);
      for (const ticker of derivativesResponse.json().data) {
        expect(ticker.open_interest_btc).not.toBeNull();
        expect(ticker.trade_volume_24h_btc).not.toBeNull();
        expect(ticker.funding_rate).not.toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it('keeps canonical Binance detail/ticker breadth aligned with the stored baseline fields', async () => {
    const app = buildApp({
      config: {
        host: '127.0.0.1',
        port: 3102,
        databaseUrl: ':memory:',
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const [detailResponse, tickersResponse] = await Promise.all([
        app.inject({ method: 'GET', url: '/exchanges/binance' }),
        app.inject({ method: 'GET', url: '/exchanges/binance/tickers?page=1' }),
      ]);

      expect(detailResponse.statusCode).toBe(200);
      expect(tickersResponse.statusCode).toBe(200);

      const detail = detailResponse.json();
      const tickers = tickersResponse.json().tickers;

      expect(detail.name).toBe('Binance');
      expect(detail.status_updates).toEqual([]);
      expect(typeof detail.trade_volume_24h_btc).toBe('number');
      expect(detail).toHaveProperty('trade_volume_24h_btc_normalized');
      expect(typeof detail.coins).toBe('number');
      expect(typeof detail.pairs).toBe('number');
      expect(detail.coins).toBeGreaterThan(100);
      expect(detail.pairs).toBeGreaterThan(100);
      const canonicalStableTicker = tickers.find((ticker: { base: string; target: string; coin_id: string | null; target_coin_id: string | null }) => (
        ticker.base === 'USDC'
        && ticker.target === 'USDT'
        && ticker.coin_id === 'usd-coin'
        && ticker.target_coin_id === 'tether'
      ));
      expect(canonicalStableTicker).toBeDefined();
      expect(tickers[0]).toHaveProperty('timestamp');
      expect(tickers[0]).toHaveProperty('last_fetch_at');
      expect(tickers[0]).toHaveProperty('trade_url');
      expect(tickers.some((ticker: { trade_url?: string | null; last_fetch_at?: string | null }) => (
        typeof ticker.trade_url === 'string' && typeof ticker.last_fetch_at === 'string'
      ))).toBe(true);
      expect(
        tickers.find((ticker: { base: string; target: string }) => ticker.base === 'USDT' && ticker.target === 'USD')?.target_coin_id ?? null,
      ).toBeNull();
      expect(
        tickers.find((ticker: { base: string; target: string }) => ticker.base === 'USD1' && ticker.target === 'USDT')?.coin_id,
      ).toBe('world-liberty-financial-usd');
      const leadingPairs = new Set(tickers.slice(0, 6).map((ticker: { base: string; target: string }) => `${ticker.base}/${ticker.target}`));
      expect(leadingPairs).toEqual(new Set([
        'BTC/USDT',
        'USDC/USDT',
        'NIGHT/USDT',
        'ETH/USDT',
        'SOL/USDT',
        'XRP/USDT',
      ]));
      expect(tickers.find((ticker: { base: string; target: string }) => ticker.base === 'BNB' && ticker.target === 'USDT')).toEqual(
        expect.objectContaining({
          coin_id: 'binancecoin',
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('keeps live-backed exchange detail and ticker routes aligned for filtering and canonical errors', async () => {
    const timestamp = Date.parse('2026-03-28T05:13:15.000Z');
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId: string) => {
      if (exchangeId !== 'binance') {
        return [];
      }

      return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
        { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
      ];
    });
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId: string) => {
      if (exchangeId !== 'binance') {
        return [];
      }

      return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 66234.02, bid: 66230, ask: 66236, high: 67000, low: 65000, baseVolume: 27782.99853, quoteVolume: 1839443608, percentage: 1.8, timestamp, raw: {} as never },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 1989.39, bid: 1989, ask: 1990, high: 2050, low: 1900, baseVolume: 379572.2623, quoteVolume: 754815216, percentage: 2.56, timestamp, raw: {} as never },
        { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0005, bid: 1.0004, ask: 1.0006, high: 1.001, low: 0.999, baseVolume: 1327840829, quoteVolume: 1327973348, percentage: 0.01, timestamp, raw: {} as never },
      ];
    });

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'live-fidelity.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const [detailResponse, tickersResponse, filteredResponse, badOrderResponse, missingResponse] = await Promise.all([
        app.inject({ method: 'GET', url: '/exchanges/binance' }),
        app.inject({ method: 'GET', url: '/exchanges/binance/tickers?page=1' }),
        app.inject({ method: 'GET', url: '/exchanges/binance/tickers?coin_ids=bitcoin' }),
        app.inject({ method: 'GET', url: '/exchanges/binance/tickers?order=unsupported' }),
        app.inject({ method: 'GET', url: '/exchanges/not-an-exchange/tickers' }),
      ]);

      expect(detailResponse.statusCode).toBe(200);
      expect(tickersResponse.statusCode).toBe(200);
      expect(filteredResponse.statusCode).toBe(200);
      expect(badOrderResponse.statusCode).toBe(400);
      expect(missingResponse.statusCode).toBe(404);

      const detailTickers = detailResponse.json().tickers;
      const tickerBody = tickersResponse.json().tickers;
      const filteredTickers = filteredResponse.json().tickers;

      expect(tickerBody.length).toBeGreaterThan(0);
      expect(tickerBody[0]).toEqual(expect.objectContaining({
        coin_id: 'bitcoin',
        target_coin_id: 'tether',
        base: 'BTC',
        target: 'USDT',
        market: expect.objectContaining({ identifier: 'binance' }),
        last: expect.any(Number),
        converted_last: expect.objectContaining({ usd: expect.any(Number) }),
        converted_volume: expect.objectContaining({ usd: expect.any(Number) }),
        is_stale: false,
        timestamp,
        last_fetch_at: '2026-03-28T05:13:15.000Z',
      }));
      expect(detailTickers[0]).toMatchObject({
        coin_id: tickerBody[0].coin_id,
        target_coin_id: tickerBody[0].target_coin_id,
        converted_last: tickerBody[0].converted_last,
        converted_volume: tickerBody[0].converted_volume,
        is_stale: tickerBody[0].is_stale,
        market: expect.objectContaining({ identifier: 'binance' }),
      });
      expect(new Set(filteredTickers.map((ticker: { coin_id: string }) => ticker.coin_id))).toEqual(new Set(['bitcoin']));

      expect(badOrderResponse.json()).toEqual({
        error: 'invalid_parameter',
        message: 'Unsupported order value: unsupported',
      });
      expect(missingResponse.json()).toEqual({
        error: 'not_found',
        message: 'Exchange not found: not-an-exchange',
      });
    } finally {
      await app.close();
    }
  });

  it('keeps coin ticker query semantics aligned with exchange ticker payloads', async () => {
    const timestamp = Date.parse('2026-03-28T05:13:15.000Z');
    mockedFetchExchangeMarkets.mockResolvedValue([
      { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
      { exchangeId: 'binance', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    ]);
    mockedFetchExchangeTickers.mockResolvedValue([
      { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0005, bid: 1.0004, ask: 1.0006, high: 1.001, low: 0.999, baseVolume: 1327840829, quoteVolume: 1327973348, percentage: 0.01, timestamp, raw: {} as never },
      { exchangeId: 'binance', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', last: 66234.02, bid: 66230, ask: 66236, high: 67000, low: 65000, baseVolume: 27782.99853, quoteVolume: 1839443608, percentage: 1.8, timestamp, raw: {} as never },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'coin-ticker-contract.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const [coinTickersResponse, exchangeTickersResponse, noLogoResponse, invalidOrderResponse] = await Promise.all([
        app.inject({ method: 'GET', url: '/coins/usd-coin/tickers?exchange_ids=binance&include_exchange_logo=true&depth=true&dex_pair_format=contract_address' }),
        app.inject({ method: 'GET', url: '/exchanges/binance/tickers?coin_ids=usd-coin&include_exchange_logo=true&depth=true&dex_pair_format=contract_address' }),
        app.inject({ method: 'GET', url: '/coins/usd-coin/tickers?exchange_ids=binance&include_exchange_logo=false' }),
        app.inject({ method: 'GET', url: '/coins/usd-coin/tickers?order=unsupported' }),
      ]);

      expect(coinTickersResponse.statusCode).toBe(200);
      expect(exchangeTickersResponse.statusCode).toBe(200);
      expect(noLogoResponse.statusCode).toBe(200);
      expect(invalidOrderResponse.statusCode).toBe(400);

      const coinTicker = coinTickersResponse.json().tickers[0];
      const exchangeTicker = exchangeTickersResponse.json().tickers[0];

      expect(coinTicker).toMatchObject({
        base: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        target: 'USDT',
        coin_id: 'usd-coin',
        target_coin_id: 'tether',
        market: expect.objectContaining({
          identifier: 'binance',
          logo: expect.any(String),
        }),
        cost_to_move_up_usd: expect.any(Number),
        cost_to_move_down_usd: expect.any(Number),
      });
      expect(coinTicker).toEqual(expect.objectContaining({
        base: exchangeTicker.base,
        target: exchangeTicker.target,
        market: exchangeTicker.market,
        converted_last: exchangeTicker.converted_last,
        converted_volume: exchangeTicker.converted_volume,
        is_stale: exchangeTicker.is_stale,
      }));
      expect(noLogoResponse.json().tickers[0].market).not.toHaveProperty('logo');
      expect(invalidOrderResponse.json()).toEqual({
        error: 'invalid_parameter',
        message: 'Unsupported order value: unsupported',
      });
    } finally {
      await app.close();
    }
  });

  it('preserves existing live ticker rows when a later provider refresh fails', async () => {
    const timestamp = Date.parse('2026-03-28T05:13:15.000Z');
    mockedFetchExchangeMarkets.mockResolvedValue([
      { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    ]);
    mockedFetchExchangeTickers.mockResolvedValueOnce([
      { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 66234.02, bid: 66230, ask: 66236, high: 67000, low: 65000, baseVolume: 27782.99853, quoteVolume: 1839443608, percentage: 1.8, timestamp, raw: {} as never },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'failure-preserves.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      const beforeRows = app.db.db.select().from(coinTickers).all();
      const beforeResponse = await app.inject({ method: 'GET', url: '/exchanges/binance/tickers?coin_ids=bitcoin' });

      mockedFetchExchangeTickers.mockRejectedValueOnce(new Error('simulated provider timeout'));
      await expect(runMarketRefreshOnce(app.db, app.appConfig, undefined, app.marketDataRuntimeState, app.metrics)).rejects.toThrow('provider failure cooldown active');

      const afterRows = app.db.db.select().from(coinTickers).all();
      const afterResponse = await app.inject({ method: 'GET', url: '/exchanges/binance/tickers?coin_ids=bitcoin' });

      expect(beforeRows).toHaveLength(1);
      expect(afterRows).toEqual(beforeRows);
      expect(beforeResponse.statusCode).toBe(200);
      expect(afterResponse.statusCode).toBe(200);
      expect(afterResponse.json()).toEqual(beforeResponse.json());
    } finally {
      await app.close();
    }
  });

  it('persists reachable provider ticker rows under CoinGecko-compatible exchange identities', async () => {
    const timestamp = Date.parse('2026-03-28T05:13:15.000Z');
    mockedFetchExchangeMarkets.mockResolvedValue([
      { exchangeId: 'okx', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    ]);
    mockedFetchExchangeTickers.mockResolvedValue([
      { exchangeId: 'okx', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 66234.02, bid: 66230, ask: 66236, high: 67000, low: 65000, baseVolume: 27782.99853, quoteVolume: 1839443608, percentage: 1.8, timestamp, raw: {} as never },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'canonical-provider-identity.db'),
        ccxtExchanges: ['okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      seedStaticReferenceData(app.db, { includeSeededExchanges: true });
      await app.ready();
      const rows = app.db.db.select().from(coinTickers).all();
      const response = await app.inject({ method: 'GET', url: '/exchanges/okex/tickers?coin_ids=bitcoin' });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        exchangeId: 'okex',
        coinId: 'bitcoin',
        base: 'BTC',
        target: 'USDT',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().tickers[0]).toEqual(expect.objectContaining({
        coin_id: 'bitcoin',
        market: expect.objectContaining({ identifier: 'okex' }),
        last: 66234.02,
      }));
    } finally {
      await app.close();
    }
  });

  it('keeps a prioritized exchange eligible for ticker bootstrap after startup metadata budget failures', async () => {
    const timestamp = Date.parse('2026-03-28T05:13:15.000Z');
    let marketCallCount = 0;
    mockedFetchExchangeMarkets.mockImplementation(async () => {
      marketCallCount += 1;
      if (marketCallCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
    });
    mockedFetchExchangeTickers.mockResolvedValue([
      { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 66234.02, bid: 66230, ask: 66236, high: 67000, low: 65000, baseVolume: 27782.99853, quoteVolume: 1839443608, percentage: 1.8, timestamp, raw: {} as never },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'metadata-budget-live-row.db'),
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      seedStaticReferenceData(app.db, { includeSeededExchanges: true });
      const runtimeState = createMarketDataRuntimeState(['binance']);

      await runInitialMarketSync(
        app.db,
        {
          ccxtExchanges: ['binance'],
          marketFreshnessThresholdSeconds: 300,
          providerFanoutConcurrency: 1,
        },
        undefined,
        {
          startupExchangeMetadataBudgetMs: 1,
          startupTickerFetchBudgetMs: 50,
        },
        runtimeState,
      );

      const rows = app.db.db.select().from(coinTickers).all();
      const response = await app.inject({ method: 'GET', url: '/exchanges/binance/tickers?coin_ids=bitcoin' });

      expect(rows.some((row) => row.exchangeId === 'binance' && row.coinId === 'bitcoin')).toBe(true);
      expect(response.statusCode).toBe(200);
      expect(response.json().tickers).toEqual([
        expect.objectContaining({
          coin_id: 'bitcoin',
          last: 66234.02,
        }),
      ]);
      expect(runtimeState.providerBreakers?.providers.binance.lastSuccessAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('rejects malformed ticker candidates while keeping healthy exchange tickers route-visible', async () => {
    const timestamp = Date.parse('2026-03-28T05:13:15.000Z');
    mockedFetchExchangeMarkets.mockResolvedValue([
      { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
      { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
    ]);
    mockedFetchExchangeTickers.mockResolvedValue([
      { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 66234.02, bid: 66230, ask: 66236, high: 67000, low: 65000, baseVolume: 27782.99853, quoteVolume: 1839443608, percentage: 1.8, timestamp, raw: {} as never },
      { exchangeId: 'binance', symbol: 'ETH/USDT', base: '', quote: 'USDT', last: 1989.39, bid: 1989, ask: 1990, high: 2050, low: 1900, baseVolume: 379572.2623, quoteVolume: 754815216, percentage: 2.56, timestamp, raw: {} as never },
      { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: Number.POSITIVE_INFINITY, bid: 1989, ask: 1990, high: 2050, low: 1900, baseVolume: 379572.2623, quoteVolume: 754815216, percentage: 2.56, timestamp, raw: {} as never },
      { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 1989.39, bid: 1991, ask: 1990, high: 2050, low: 1900, baseVolume: 379572.2623, quoteVolume: 754815216, percentage: 2.56, timestamp, raw: {} as never },
      { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'ETH', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp, raw: {} as never },
      { exchangeId: 'binance', symbol: 'DOGE/JPY', base: 'DOGE', quote: 'JPY', last: 43, bid: 42, ask: 44, high: 45, low: 40, baseVolume: 10000000, quoteVolume: 430000000, percentage: 5.0, timestamp, raw: {} as never },
      { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', last: 1.05, bid: 1.049, ask: 1.051, high: 1.08, low: 1.02, baseVolume: 5000000, quoteVolume: 5250000, percentage: 2.0, timestamp: Number.NaN, raw: {} as never },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'malformed-rejected.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      const rows = app.db.db.select().from(coinTickers).all();
      const tickersResponse = await app.inject({ method: 'GET', url: '/exchanges/binance/tickers?page=1' });
      const diagnosticsResponse = await app.inject({ method: 'GET', url: '/diagnostics/exchanges' });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        coinId: 'bitcoin',
        base: 'BTC',
        target: 'USDT',
      });
      expect(tickersResponse.statusCode).toBe(200);
      const tickers = tickersResponse.json().tickers;
      expect(tickers).toHaveLength(1);
      expect(tickers[0]).toEqual(expect.objectContaining({
        coin_id: 'bitcoin',
        base: 'BTC',
        target: 'USDT',
        last: 66234.02,
      }));
      expect(JSON.stringify(tickers)).not.toContain('Infinity');
      expect(JSON.stringify(tickers)).not.toContain('NaN');
      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data.exchanges.find((exchange: { id: string }) => exchange.id === 'binance')).toMatchObject({
        evidence_class: 'live_ticker',
        ingestion: {
          accepted_ticker_rows: 1,
          rejected_ticker_rows: expect.any(Number),
          rejection_reasons: expect.objectContaining({
            malformed_ticker_candidate: expect.any(Number),
            unsupported_or_unmapped_symbol: expect.any(Number),
          }),
        },
      });
    } finally {
      await app.close();
    }
  });

});
