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

describe('exchange surface parity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-exchange-surface-parity-'));
    mockedFetchExchangeMarkets.mockReset();
    mockedFetchExchangeTickers.mockReset();
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId: string) => {
      if (exchangeId === 'binance') {
        return [
          { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
          { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
          { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
        ];
      }

      return [];
    });
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId: string) => {
      if (exchangeId === 'binance') {
        const timestamp = Date.parse('2026-03-28T05:13:15.000Z');
        return [
          { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 66234.02, bid: 66230, ask: 66236, high: 67000, low: 65000, baseVolume: 27782.99853, quoteVolume: 1839443608, percentage: 1.8, timestamp, raw: {} as never },
          { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 1989.39, bid: 1989, ask: 1990, high: 2050, low: 1900, baseVolume: 379572.2623, quoteVolume: 754815216, percentage: 2.56, timestamp, raw: {} as never },
          { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0005, bid: 1.0004, ask: 1.0006, high: 1.001, low: 0.999, baseVolume: 1327840829, quoteVolume: 1327973348, percentage: 0.01, timestamp, raw: {} as never },
        ];
      }

      return [];
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves canonical venue identity across registry, detail, and ticker routes while populating live ticker metadata', async () => {
    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'app.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const [registryResponse, detailResponse, tickersResponse] = await Promise.all([
        app.inject({ method: 'GET', url: '/exchanges?per_page=5&page=1' }),
        app.inject({ method: 'GET', url: '/exchanges/binance' }),
        app.inject({ method: 'GET', url: '/exchanges/binance/tickers' }),
      ]);

      expect(registryResponse.statusCode).toBe(200);
      expect(detailResponse.statusCode).toBe(200);
      expect(tickersResponse.statusCode).toBe(200);

      const registry = registryResponse.json();
      const detail = detailResponse.json();
      const tickersBody = tickersResponse.json();

      expect(registry).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'binance',
          name: 'Binance',
          trust_score_rank: expect.any(Number),
          trade_volume_24h_btc: expect.any(Number),
        }),
      ]));
      expect(detail).toMatchObject({
        id: 'binance',
        name: 'Binance',
      });
      expect(tickersBody).toMatchObject({
        name: 'Binance',
      });

      const detailIdentifiers = new Set(detail.tickers.map((ticker: { market: { identifier: string } }) => ticker.market.identifier));
      const tickerIdentifiers = new Set(tickersBody.tickers.map((ticker: { market: { identifier: string } }) => ticker.market.identifier));
      expect(detailIdentifiers).toEqual(new Set(['binance']));
      expect(tickerIdentifiers).toEqual(new Set(['binance']));

      expect(detail.tickers[0]).toEqual(expect.objectContaining({
        coin_id: 'bitcoin',
        base: 'BTC',
        target: 'USDT',
        volume: expect.any(Number),
        converted_volume: expect.objectContaining({ usd: expect.any(Number) }),
        trust_score: 'green',
        timestamp: Date.parse('2026-03-28T05:13:15.000Z'),
        last_traded_at: '2026-03-28T05:13:15.000Z',
        last_fetch_at: '2026-03-28T05:13:15.000Z',
      }));
      expect(tickersBody.tickers[0]).toEqual(expect.objectContaining({
        coin_id: 'bitcoin',
        target_coin_id: null,
        market: expect.objectContaining({
          identifier: 'binance',
        }),
        converted_last: expect.objectContaining({ usd: expect.any(Number) }),
        converted_volume: expect.objectContaining({ usd: expect.any(Number) }),
        trust_score: 'green',
        timestamp: Date.parse('2026-03-28T05:13:15.000Z'),
      }));
    } finally {
      await app.close();
    }
  });

  it('exposes canonical seeded venues on exchange registry and detail routes before live refresh data is available', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async () => []);
    mockedFetchExchangeTickers.mockImplementation(async () => []);

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'seeded-app.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const [registryResponse, detailResponse, tickersResponse] = await Promise.all([
        app.inject({ method: 'GET', url: '/exchanges?per_page=5&page=1' }),
        app.inject({ method: 'GET', url: '/exchanges/binance' }),
        app.inject({ method: 'GET', url: '/exchanges/binance/tickers?page=1' }),
      ]);

      expect(registryResponse.statusCode).toBe(200);
      expect(detailResponse.statusCode).toBe(200);
      expect(tickersResponse.statusCode).toBe(200);

      expect(registryResponse.json().slice(0, 5).map((venue: { id: string }) => venue.id)).toEqual([
        'binance',
        'bybit_spot',
        'gdax',
        'gate',
        'okex',
      ]);
      expect(detailResponse.json()).toMatchObject({
        id: 'binance',
        name: 'Binance',
        url: 'https://www.binance.com/',
      });
      expect(tickersResponse.json()).toEqual({
        name: 'Binance',
        tickers: [],
      });
    } finally {
      await app.close();
    }
  });
});
