import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import contractFixtures from './fixtures/contract-fixtures.json';

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

describe('treasury routes', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-treasury-routes-'));
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

  it('returns treasury entities and grouped public treasury rows', async () => {
    const entitiesResponse = await getApp().inject({
      method: 'GET',
      url: '/entities/list?entity_type=companies&page=1&per_page=10',
    });
    const groupedResponse = await getApp().inject({
      method: 'GET',
      url: '/companies/public_treasury/bitcoin?order=value_desc',
    });
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy',
    });

    expect(entitiesResponse.statusCode).toBe(200);
    expect(entitiesResponse.json()).toMatchObject({
      data: [contractFixtures.treasuryEntities[1]],
      meta: expect.objectContaining({ fixture: true }),
    });

    expect(groupedResponse.statusCode).toBe(200);
    expect(groupedResponse.json()).toMatchObject({
      data: contractFixtures.companyTreasuryBitcoin,
      meta: expect.objectContaining({ fixture: true }),
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      data: contractFixtures.treasuryEntityDetail,
      meta: expect.objectContaining({ fixture: true }),
    });
  });

  it('returns treasury holding charts and transaction history', async () => {
    const chartResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/bitcoin/holding_chart?days=7',
    });
    const chartWithIntervalsResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/bitcoin/holding_chart?days=7&include_empty_intervals=true',
    });
    const transactionsResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/transaction_history?order=date_desc',
    });

    expect(chartResponse.statusCode).toBe(200);
    expect(chartResponse.json()).toMatchObject({
      data: {
        holdings: expect.any(Array),
        holding_value_in_usd: expect.any(Array),
      },
      meta: expect.objectContaining({ fixture: true }),
    });
    expect(chartResponse.json().data.holdings.length).toBeGreaterThan(0);
    expect(chartResponse.json().data.holding_value_in_usd.length).toBeGreaterThan(0);

    expect(chartWithIntervalsResponse.statusCode).toBe(200);
    expect(chartWithIntervalsResponse.json()).toMatchObject({
      data: {
        holdings: expect.any(Array),
        holding_value_in_usd: expect.any(Array),
      },
      meta: expect.objectContaining({ fixture: true }),
    });
    expect(chartWithIntervalsResponse.json().data.holdings.length).toBeGreaterThan(0);
    expect(chartWithIntervalsResponse.json().data.holding_value_in_usd.length).toBeGreaterThan(0);

    expect(transactionsResponse.statusCode).toBe(200);
    expect(transactionsResponse.json()).toEqual({
      data: contractFixtures.treasuryTransactionHistory,
      meta: expect.objectContaining({ fixture: true }),
    });
  });
});
