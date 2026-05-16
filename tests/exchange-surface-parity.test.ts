import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';

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
        name: 'Binance',
        coins: 3,
        pairs: 3,
        status_updates: [],
      });
      expect(typeof detail.coins).toBe('number');
      expect(typeof detail.pairs).toBe('number');
      expect(tickersBody).toMatchObject({
        name: 'Binance',
      });

      const detailIdentifiers = new Set(detail.tickers.map((ticker: { market: { identifier: string } }) => ticker.market.identifier));
      const tickerIdentifiers = new Set(tickersBody.tickers.map((ticker: { market: { identifier: string } }) => ticker.market.identifier));
      expect(detailIdentifiers).toEqual(new Set(['binance']));
      expect(tickerIdentifiers).toEqual(new Set(['binance']));

      expect(detail.tickers[0]).toEqual(expect.objectContaining({
        coin_id: 'bitcoin',
        target_coin_id: 'tether',
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
        base: 'BTC',
        target: 'USDT',
        coin_id: 'bitcoin',
        target_coin_id: 'tether',
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

  it('serves legacy and provider exchange aliases through the same canonical ticker identity', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId: string) => {
      if (exchangeId !== 'okx') {
        return [];
      }

      return [
        { exchangeId: 'okx', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
    });
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId: string) => {
      if (exchangeId !== 'okx') {
        return [];
      }

      return [
        { exchangeId: 'okx', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 66234.02, bid: 66230, ask: 66236, high: 67000, low: 65000, baseVolume: 27782.99853, quoteVolume: 1839443608, percentage: 1.8, timestamp: Date.parse('2026-03-28T05:13:15.000Z'), raw: {} as never },
      ];
    });

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'alias-identity.db'),
        ccxtExchanges: ['okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const [canonicalDetail, aliasDetail, canonicalTickers, aliasTickers] = await Promise.all([
        app.inject({ method: 'GET', url: '/exchanges/okex' }),
        app.inject({ method: 'GET', url: '/exchanges/okx' }),
        app.inject({ method: 'GET', url: '/exchanges/okex/tickers?coin_ids=bitcoin' }),
        app.inject({ method: 'GET', url: '/exchanges/okx/tickers?coin_ids=bitcoin' }),
      ]);

      expect(canonicalDetail.statusCode).toBe(200);
      expect(aliasDetail.statusCode).toBe(200);
      expect(canonicalTickers.statusCode).toBe(200);
      expect(aliasTickers.statusCode).toBe(200);

      expect(aliasDetail.json()).toMatchObject({
        id: 'okex',
        name: canonicalDetail.json().name,
        coins: canonicalDetail.json().coins,
        pairs: canonicalDetail.json().pairs,
      });
      expect(aliasTickers.json()).toEqual(canonicalTickers.json());
      expect(aliasTickers.json().tickers[0]).toEqual(expect.objectContaining({
        market: expect.objectContaining({ identifier: 'okex' }),
        coin_id: 'bitcoin',
      }));
    } finally {
      await app.close();
    }
  });

  it('preserves aggregate pair breadth on exchange detail even when serialized tickers dedupe duplicate market rows', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId: string) => {
      if (exchangeId !== 'binance') {
        return [];
      }

      return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin Cash', raw: {} },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
      ];
    });
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId: string) => {
      if (exchangeId !== 'binance') {
        return [];
      }

      const timestamp = Date.parse('2026-03-28T05:13:15.000Z');
      return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 66234.02, bid: 66230, ask: 66236, high: 67000, low: 65000, baseVolume: 27782.99853, quoteVolume: 1839443608, percentage: 1.8, timestamp, raw: {} as never },
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 420.12, bid: 420.05, ask: 420.2, high: 430, low: 410, baseVolume: 25410.12, quoteVolume: 10675265, percentage: 1.2, timestamp, raw: {} as never },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 1989.39, bid: 1989, ask: 1990, high: 2050, low: 1900, baseVolume: 379572.2623, quoteVolume: 754815216, percentage: 2.56, timestamp, raw: {} as never },
      ];
    });

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'duplicate-pairs.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const [detailResponse, tickersResponse] = await Promise.all([
        app.inject({ method: 'GET', url: '/exchanges/binance' }),
        app.inject({ method: 'GET', url: '/exchanges/binance/tickers' }),
      ]);

      expect(detailResponse.statusCode).toBe(200);
      expect(tickersResponse.statusCode).toBe(200);

      const detail = detailResponse.json();
      const tickers = tickersResponse.json().tickers;

      expect(detail.coins).toBe(2);
      expect(detail.pairs).toBe(2);
      expect(detail.tickers).toHaveLength(2);
      expect(tickers).toHaveLength(2);
      expect(new Set(detail.tickers.map((ticker: { base: string; target: string }) => `${ticker.base}/${ticker.target}`))).toEqual(new Set([
        'BTC/USDT',
        'ETH/USDT',
      ]));
      expect(detail.tickers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          target_coin_id: 'tether',
        }),
      ]));
      expect(detail.tickers.filter((ticker: { base: string; target: string }) => ticker.base === 'BTC' && ticker.target === 'USDT')).toHaveLength(1);
      expect(detail.tickers).toEqual(expect.not.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin-cash',
        }),
      ]));
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
        name: 'Binance',
        url: 'https://www.binance.com/',
        coins: 0,
        pairs: 0,
        status_updates: [],
      });
      expect(tickersResponse.json()).toEqual({
        name: 'Binance',
        tickers: [],
      });
    } finally {
      await app.close();
    }
  });

  it('imports persisted Binance tickers into the bootstrap-only validation runtime', async () => {
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
      const tickers = tickersResponse.json();

      expect(app.marketDataRuntimeState.validationOverride).toMatchObject({
        mode: 'seeded_bootstrap',
        reason: 'validation runtime seeded from persistent live snapshots',
      });
      expect(detail.tickers.length).toBeGreaterThan(0);
      expect(tickers.tickers.length).toBeGreaterThan(0);
      expect(detail.tickers[0]).toEqual(expect.objectContaining({
        market: expect.objectContaining({ identifier: 'binance' }),
        coin_id: expect.any(String),
        target: expect.any(String),
        converted_volume: expect.objectContaining({ usd: expect.any(Number) }),
      }));
      expect(tickers.tickers[0]).toEqual(expect.objectContaining({
        market: expect.objectContaining({ identifier: 'binance' }),
        coin_id: expect.any(String),
        target_coin_id: 'tether',
        converted_last: expect.objectContaining({ usd: expect.any(Number) }),
      }));
    } finally {
      await app.close();
    }
  });
});
