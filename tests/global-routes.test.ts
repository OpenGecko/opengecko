import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { marketSnapshots } from '../src/db/schema';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', active: true, spot: true, baseName: 'Ripple', raw: {} },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', active: true, spot: true, baseName: 'Dogecoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', active: true, spot: true, baseName: 'Cardano', raw: {} },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', active: true, spot: true, baseName: 'Chainlink', raw: {} },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', last: 2.5, bid: 2.49, ask: 2.51, high: 2.55, low: 2.45, baseVolume: 1000000, quoteVolume: 2500000, percentage: 3.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', last: 0.28, bid: 0.279, ask: 0.281, high: 0.29, low: 0.27, baseVolume: 10000000, quoteVolume: 2800000, percentage: 5.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', last: 1.05, bid: 1.049, ask: 1.051, high: 1.08, low: 1.02, baseVolume: 5000000, quoteVolume: 5250000, percentage: 2.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', last: 24, bid: 23.9, ask: 24.1, high: 25, low: 23, baseVolume: 500000, quoteVolume: 12000000, percentage: 3.5, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
  ]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('global routes', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-global-routes-'));
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns global market aggregates', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        active_cryptocurrencies: 8,
        markets: expect.any(Number),
        total_market_cap: {
          usd: 0,
        },
        total_volume: expect.objectContaining({
          usd: expect.any(Number),
        }),
      },
    });
    expect(response.json().data.markets).toBeGreaterThan(0);
  });

  it('keeps /global aggregate payloads wrapped in data with the required compatibility fields', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: expect.objectContaining({
        active_cryptocurrencies: expect.any(Number),
        markets: expect.any(Number),
        updated_at: expect.any(Number),
        total_market_cap: expect.any(Object),
        total_volume: expect.any(Object),
        market_cap_percentage: expect.any(Object),
        market_cap_change_percentage_24h_usd: expect.any(Number),
        volume_change_percentage_24h_usd: expect.any(Number),
      }),
    });
  });

  it('keeps /global market_cap_percentage finite when persisted live snapshots have no usable market caps', async () => {
    getApp().db.db
      .update(marketSnapshots)
      .set({
        marketCap: null,
      })
      .run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/global',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.market_cap_percentage).toEqual(expect.objectContaining({
      btc: 0,
      eth: 0,
      usdc: 0,
      xrp: 0,
      sol: 0,
    }));
  });

  it('returns global defi aggregates in a data envelope with stable finite-or-null fields', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global/decentralized_finance_defi',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(typeof body.data.defi_market_cap).toBe('number');
    expect(typeof body.data.eth_market_cap).toBe('number');
    expect(typeof body.data.trading_volume_24h).toBe('number');
    expect(body.data.top_coin_name === null || typeof body.data.top_coin_name === 'string').toBe(true);
    expect(body.data.defi_to_eth_ratio === null || typeof body.data.defi_to_eth_ratio === 'number').toBe(true);
    expect(body.data.defi_dominance === null || typeof body.data.defi_dominance === 'number').toBe(true);
    expect(body.data.top_coin_defi_dominance === null || typeof body.data.top_coin_defi_dominance === 'number').toBe(true);

    for (const [key, value] of Object.entries(body.data)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value)).toBe(true);
      } else {
        expect(value === null || typeof value === 'string').toBe(true);
      }

      expect(key).not.toBe('');
    }
  });

  it('returns a named global market cap chart series payload for the requested window', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global/market_cap_chart?vs_currency=usd&days=7',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      market_cap_chart: expect.any(Array),
      meta: {
        fixture: expect.any(Boolean),
        source: expect.any(String),
        updated_at: expect.any(String),
        point_count: expect.any(Number),
        note: expect.any(String),
      },
    });
    expect(body.market_cap_chart.length).toBeGreaterThan(0);
    expect(body.market_cap_chart[0]).toHaveLength(2);
    expect(typeof body.market_cap_chart[0][0]).toBe('number');
    expect(typeof body.market_cap_chart[0][1]).toBe('number');
    expect(body.market_cap_chart.at(-1)[0]).toBeGreaterThanOrEqual(body.market_cap_chart[0][0]);
  });

  it('validates missing required params for global market cap chart', async () => {
    const missingVsCurrencyResponse = await getApp().inject({
      method: 'GET',
      url: '/global/market_cap_chart?days=7',
    });
    const missingDaysResponse = await getApp().inject({
      method: 'GET',
      url: '/global/market_cap_chart?vs_currency=usd',
    });

    expect(missingVsCurrencyResponse.statusCode).toBe(400);
    expect(missingVsCurrencyResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });

    expect(missingDaysResponse.statusCode).toBe(400);
    expect(missingDaysResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });
  });

  it('keeps category list CoinGecko-compatible as a bare category_id/name array', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/categories/list',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toEqual({
      category_id: expect.any(String),
      name: expect.any(String),
    });
    expect(body[0].category_id).not.toBe('');
    expect(body[0].name).not.toBe('');
  });

  it('exposes top mover freshness metadata without changing the paired arrays contract', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&duration=24h&top_coins=100&price_change_percentage=24h',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.top_gainers)).toBe(true);
    expect(Array.isArray(body.top_losers)).toBe(true);
    expect(body.meta).toMatchObject({
      fixture: expect.any(Boolean),
      source: 'market_snapshots',
      snapshot_source: expect.stringMatching(/^(live|mixed|fixture|empty)$/),
      fallback: expect.any(Boolean),
      live_snapshot_count: expect.any(Number),
      fallback_snapshot_count: expect.any(Number),
      candidate_count: expect.any(Number),
      mover_count: body.top_gainers.length + body.top_losers.length,
      top_coins: 100,
      duration: '24h',
      price_change_percentage: expect.arrayContaining(['24h']),
    });
    expect(body.meta.fixture).toBe(body.meta.snapshot_source !== 'live');
    expect(body.meta.fallback).toBe(body.meta.fixture);
    expect(body.meta.live_snapshot_count + body.meta.fallback_snapshot_count).toBe(body.meta.candidate_count);
    expect(body.meta.updated_at === null || typeof body.meta.updated_at === 'string').toBe(true);
  });
});
