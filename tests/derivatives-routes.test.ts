import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { derivativeTickers } from '../src/db/schema';
import { ingestDerivativeTickerReplayBatch } from '../src/services/derivatives-ingestion';
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

describe('derivatives routes', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-derivatives-routes-'));
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

  it('returns derivatives exchange registry rows', async () => {
    const listResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/list',
    });
    const exchangesResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges?order=trade_volume_24h_btc_desc&per_page=1&page=1',
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual(expect.arrayContaining(contractFixtures.derivativesExchangesList));
    expect(listResponse.json()).toEqual(expect.arrayContaining([
      { id: 'okx', name: 'OKX' },
      { id: 'bitget', name: 'Bitget' },
    ]));

    expect(exchangesResponse.statusCode).toBe(200);
    const exchangesBody = exchangesResponse.json();
    expect(exchangesBody.data).toHaveLength(1);
    expect(exchangesBody.data[0]).toMatchObject(contractFixtures.derivativesExchanges[0]);
    expect(exchangesBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20' });
  });

  it('returns derivatives exchange detail without tickers by default and includes tickers on request', async () => {
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/binance_futures',
    });
    const includeTickersResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/binance_futures?include_tickers=true',
    });

    expect(detailResponse.statusCode).toBe(200);
    const detailBody = detailResponse.json();
    expect(detailBody.data).toMatchObject({
      id: 'binance_futures',
      name: 'Binance Futures',
      open_interest_btc: 185000,
      trade_volume_24h_btc: 910000,
      number_of_perpetual_pairs: 412,
      number_of_futures_pairs: 38,
      year_established: 2019,
      country: 'Cayman Islands',
      description: "Binance Futures is Binance's derivatives venue for perpetual and dated futures markets.",
      url: 'https://www.binance.com/en/futures',
      image: 'https://assets.coingecko.com/markets/images/52/small/binance.jpg',
      centralized: true,
    });
    expect(detailBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20' });
    expect(detailBody.data).not.toHaveProperty('tickers');

    expect(includeTickersResponse.statusCode).toBe(200);
    const includeTickersBody = includeTickersResponse.json();
    expect(includeTickersBody.data).toMatchObject({
      id: 'binance_futures',
      name: 'Binance Futures',
    });
    expect(includeTickersBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20' });
    expect(includeTickersBody.data).toHaveProperty('tickers');
    expect(includeTickersBody.data.tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        market: 'Binance Futures',
        market_id: 'binance_futures',
        symbol: 'BTCUSDT',
        index_id: 'bitcoin',
        contract_type: 'perpetual',
      }),
    ]));
  });

  it('returns derivatives tickers', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives',
    });

    expect(response.statusCode).toBe(200);
    const derivativesBody = response.json();
    expect(derivativesBody.data).toMatchObject(contractFixtures.derivatives);
    expect(derivativesBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20', source_backed_tickers: 0 });
    expect(derivativesBody.meta.note).toContain('seeded fixture');
    for (const ticker of derivativesBody.data) {
      expect(ticker.funding_rate).not.toBeUndefined();
      expect(ticker.open_interest_btc).not.toBeNull();
      expect(ticker.trade_volume_24h_btc).not.toBeNull();
      expect(ticker.last_traded_at).not.toBeNull();
    }
  });

  it('marks derivative routes as source-backed after live-style ingestion and preserves volume sorting', async () => {
    await getApp().ready();
    getApp().db.db.delete(derivativeTickers).run();
    ingestDerivativeTickerReplayBatch(getApp().db, [
      {
        exchangeId: 'bybit',
        symbol: 'BTC/USDT:USDT',
        market: 'BTCUSDT',
        base: 'BTC',
        quote: 'USDT',
        markPrice: 91_000,
        contractType: 'perpetual',
        tradeVolume24hBtc: 200,
        openInterestBtc: 50,
        timestamp: 1777939200000,
      },
      {
        exchangeId: 'okx',
        symbol: 'ETH/USDT:USDT',
        market: 'ETHUSDT',
        base: 'ETH',
        quote: 'USDT',
        markPrice: 3_200,
        contractType: 'perpetual',
        tradeVolume24hBtc: 500,
        openInterestBtc: 100,
        timestamp: 1777939260000,
      },
    ], {
      sourceKind: 'live',
      sourceProvider: 'ccxt.test',
      sourceFetchedAt: new Date('2026-05-05T00:02:00.000Z'),
    });

    const derivativesResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives',
    });
    const exchangesResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges?per_page=10&page=1&order=open_interest_btc_desc',
    });
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/okx?include_tickers=true',
    });

    expect(derivativesResponse.statusCode).toBe(200);
    const derivativesBody = derivativesResponse.json();
    expect(derivativesBody.meta).toMatchObject({
      fixture: false,
      source: 'ccxt_derivatives',
      source_backed_tickers: 2,
      latest_source_fetched_at: '2026-05-05T00:02:00.000Z',
    });
    expect(derivativesBody.data.map((ticker: { symbol: string }) => ticker.symbol)).toEqual([
      'ETH/USDT:USDT',
      'BTC/USDT:USDT',
    ]);

    expect(exchangesResponse.statusCode).toBe(200);
    expect(exchangesResponse.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: 'okx',
          open_interest_btc: 100,
          trade_volume_24h_btc: 500,
          number_of_perpetual_pairs: 1,
        }),
      ]),
      meta: expect.objectContaining({ fixture: false }),
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      data: {
        id: 'okx',
        tickers: [
          expect.objectContaining({
            market_id: 'okx',
            symbol: 'ETH/USDT:USDT',
            trade_volume_24h_btc: 500,
          }),
        ],
      },
      meta: expect.objectContaining({ fixture: false }),
    });
  });
});
