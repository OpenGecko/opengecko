import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';

const mockedFetchExchangeMarkets = vi.fn();
const mockedFetchExchangeTickers = vi.fn();

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: mockedFetchExchangeMarkets,
  fetchExchangeTickers: mockedFetchExchangeTickers,
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

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
      for (const venue of exchangesResponse.json()) {
        expect(venue.open_interest_btc).not.toBeNull();
        expect(venue.trade_volume_24h_btc).not.toBeNull();
      }

      expect(derivativesResponse.statusCode).toBe(200);
      for (const ticker of derivativesResponse.json()) {
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
      expect(tickers[0]).toEqual(expect.objectContaining({
        base: 'BTC',
        target: 'USDT',
        target_coin_id: 'tether',
      }));
      expect(tickers[0]).toHaveProperty('timestamp');
      expect(tickers[0]).toHaveProperty('last_fetch_at');
      expect(tickers[0]).toHaveProperty('trade_url');
      expect(tickers[0].coin_mcap_usd).toEqual(expect.any(Number));
      expect(
        tickers.find((ticker: { base: string; target: string }) => ticker.base === 'USDT' && ticker.target === 'USD')?.target_coin_id ?? null,
      ).toBeNull();
      expect(
        tickers.find((ticker: { base: string; target: string }) => ticker.base === 'USD1' && ticker.target === 'USDT')?.coin_id,
      ).toBe('world-liberty-financial-usd');
      expect(tickers.slice(0, 6).map((ticker: { base: string; target: string }) => `${ticker.base}/${ticker.target}`)).toEqual([
        'BTC/USDT',
        'NIGHT/USDT',
        'USDC/USDT',
        'ETH/USDT',
        'SOL/USDT',
        'BNB/USDT',
      ]);
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

});
