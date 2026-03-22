import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeOHLCV: vi.fn(),
  isSupportedExchangeId: (value: string): value is 'binance' | 'coinbase' | 'kraken' =>
    ['binance', 'coinbase', 'kraken'].includes(value),
  SUPPORTED_EXCHANGE_IDS: ['binance', 'coinbase', 'kraken'],
}));

import { fetchExchangeMarkets, fetchExchangeTickers, fetchExchangeOHLCV } from '../src/providers/ccxt';

describe('live data integration', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(async () => {
    vi.mocked(fetchExchangeMarkets).mockReset();
    vi.mocked(fetchExchangeTickers).mockReset();
    vi.mocked(fetchExchangeOHLCV).mockReset();

    vi.mocked(fetchExchangeMarkets).mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'SOL/USD', base: 'SOL', quote: 'USD', active: true, spot: true, baseName: 'Solana', raw: {} },
      ];
      return [];
    });

    vi.mocked(fetchExchangeTickers).mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 90_000, bid: 89_950, ask: 90_050, high: 91_000, low: 89_000, baseVolume: 5_000, quoteVolume: 450_000_000, percentage: 3.5, timestamp: Date.now(), raw: {} as never },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2_100, bid: 2_099, ask: 2_101, high: 2_150, low: 2_050, baseVolume: 50_000, quoteVolume: 105_000_000, percentage: 2.1, timestamp: Date.now(), raw: {} as never },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'SOL/USD', base: 'SOL', quote: 'USD', last: 180, bid: 179.5, ask: 180.5, high: 185, low: 175, baseVolume: 100_000, quoteVolume: 18_000_000, percentage: 5.2, timestamp: Date.now(), raw: {} as never },
      ];
      return [];
    });

    vi.mocked(fetchExchangeOHLCV).mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', timeframe: '1d', timestamp: Date.parse('2026-03-20T00:00:00Z'), open: 88_000, high: 91_000, low: 87_000, close: 90_000, volume: 1_500, raw: [0, 0, 0, 0, 0, 0] },
        { exchangeId: 'binance', symbol: 'BTC/USDT', timeframe: '1d', timestamp: Date.parse('2026-03-21T00:00:00Z'), open: 90_000, high: 92_000, low: 89_000, close: 91_000, volume: 1_600, raw: [0, 0, 0, 0, 0, 0] },
      ];
      return [];
    });

    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-live-'));
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
        marketFreshnessThresholdSeconds: 300,
      },
      startBackgroundJobs: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves live data from /simple/price after boot', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.bitcoin.usd).toBe(90_000);
  });

  it('serves live data from /coins/markets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body[0].id).toBe('bitcoin');
    expect(body[0].current_price).toBe(90_000);
  });

  it('serves live data from /coins/:id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/bitcoin',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe('bitcoin');
    expect(body.market_data).not.toBeNull();
    expect(body.market_data.current_price.usd).toBe(90_000);
  });

  it('serves exchange records created from CCXT metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/exchanges/binance',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe('Binance');
  });

  it('serves OHLCV data from backfill', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc?vs_currency=usd&days=30',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBeGreaterThan(0);
    // Each OHLC entry should be [timestamp, open, high, low, close]
    expect(body[0]).toHaveLength(5);
  });

  it('returns live bitcoin price in /exchange_rates', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/exchange_rates',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rates.usd.value).toBe(90_000);
  });
});
