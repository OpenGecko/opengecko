import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { exchanges, exchangeVolumePoints, exchangeVolumeSourcePoints } from '../src/db/schema';

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

describe('exchange routes', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-exchange-routes-'));
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

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns seeded exchanges and exchange detail data', async () => {
    const listResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/list',
    });
    const inactiveListResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/list?status=inactive',
    });
    const exchangesResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges?per_page=2&page=1',
    });
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance',
    });
    const volumeChartResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart?days=7',
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'binance',
        name: 'Binance',
      }),
      expect.objectContaining({
        id: 'coinbase',
      }),
      expect.objectContaining({
        id: 'kraken',
        name: 'Kraken',
      }),
    ]));

    expect(inactiveListResponse.statusCode).toBe(200);
    expect(inactiveListResponse.json()).toEqual([]);

    expect(exchangesResponse.statusCode).toBe(200);
    expect(exchangesResponse.json()).toHaveLength(2);
    expect(exchangesResponse.json().every((exchange: {
      id: string;
      name: string;
      trade_volume_24h_btc: number | null;
    }) => (
      typeof exchange.id === 'string'
      && typeof exchange.name === 'string'
      && (exchange.trade_volume_24h_btc === null || typeof exchange.trade_volume_24h_btc === 'number')
    ))).toBe(true);

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: 'binance',
      name: 'Binance',
      tickers: expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          target: 'USDT',
        }),
        expect.objectContaining({
          coin_id: 'usd-coin',
          target: 'USDT',
        }),
      ]),
    });
    const exchangeDetail = detailResponse.json();
    expect(exchangeDetail.year_established === null || typeof exchangeDetail.year_established === 'number').toBe(true);
    expect(exchangeDetail.country === null || typeof exchangeDetail.country === 'string').toBe(true);
    expect(exchangeDetail.twitter_handle === null || typeof exchangeDetail.twitter_handle === 'string').toBe(true);

    expect(volumeChartResponse.statusCode).toBe(200);
    const volumeChart = volumeChartResponse.json();
    expect(volumeChart.length).toBeGreaterThan(0);
    const timestamps = volumeChart.map((entry: number[]) => entry[0]);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));

    // Each entry is [timestamp, volumeBtc]
    for (const entry of volumeChart) {
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe('number');
      expect(typeof entry[1]).toBe('number');
    }
  });

  it('returns hourly exchange volume buckets for short ranges', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart?days=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBeGreaterThan(0);

    const timestamps = body.map((tuple: number[]) => tuple[0]);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));

    for (const tuple of body) {
      expect(tuple).toHaveLength(2);
      expect(Number.isFinite(tuple[1])).toBe(true);
    }
  });

  it('returns ranged exchange volume tuples in ascending chronological order with finite numerics', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart/range?from=0&to=4102444800',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBeGreaterThan(0);

    const timestamps = body.map((tuple: number[]) => tuple[0]);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));

    for (const tuple of body) {
      expect(tuple).toHaveLength(2);
      expect(typeof tuple[0]).toBe('number');
      expect(typeof tuple[1]).toBe('number');
      expect(Number.isFinite(tuple[1])).toBe(true);
    }
  });

  it('returns not_found for unknown exchange volume routes', async () => {
    const [chartResponse, rangeResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/exchanges/not-an-exchange/volume_chart?days=7',
      }),
      getApp().inject({
        method: 'GET',
        url: '/exchanges/not-an-exchange/volume_chart/range?from=0&to=4102444800',
      }),
    ]);

    expect(chartResponse.statusCode).toBe(404);
    expect(chartResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Exchange not found: not-an-exchange',
    });

    expect(rangeResponse.statusCode).toBe(404);
    expect(rangeResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Exchange not found: not-an-exchange',
    });
  });

  it('preserves live refresh ownership for exchange volume windows and explicit ranges', async () => {
    const now = new Date();
    const appDb = getApp().db;
    appDb.db.insert(exchanges).values({
      id: 'binance',
      name: 'Binance',
      yearEstablished: 2017,
      country: 'Cayman Islands',
      description: 'Temporary seeded exchange row for volume ownership assertions.',
      url: 'https://www.binance.com/',
      imageUrl: 'https://coin-images.coingecko.com/markets/images/52/small/binance.jpg?1706864274',
      hasTradingIncentive: false,
      trustScore: 10,
      trustScoreRank: 1,
      tradeVolume24hBtc: 139508.1218951856,
      tradeVolume24hBtcNormalized: null,
      facebookUrl: 'https://www.facebook.com/binanceexchange',
      redditUrl: 'https://www.reddit.com/r/binance/',
      telegramUrl: '',
      slackUrl: '',
      otherUrlJson: JSON.stringify([
        'https://medium.com/binanceexchange',
        'https://steemit.com/@binanceexchange',
      ]),
      twitterHandle: 'binance',
      centralised: true,
      publicNotice: null,
      alertNotice: null,
      updatedAt: new Date(now.getTime() - (37 * 60 * 60 * 1000)),
    }).onConflictDoNothing().run();

    const cutoff = new Date(now.getTime() - (24 * 60 * 60 * 1000));
    appDb.db.delete(exchangeVolumePoints).where(eq(exchangeVolumePoints.exchangeId, 'binance')).run();
    appDb.db.insert(exchangeVolumePoints).values([
      {
        exchangeId: 'binance',
        timestamp: new Date(now.getTime() - (36 * 60 * 60 * 1000)),
        volumeBtc: 10,
      },
      {
        exchangeId: 'binance',
        timestamp: new Date(now.getTime() - (23 * 60 * 60 * 1000)),
        volumeBtc: 20,
      },
      {
        exchangeId: 'binance',
        timestamp: new Date(now.getTime() - (2 * 60 * 60 * 1000)),
        volumeBtc: 30,
      },
      {
        exchangeId: 'binance',
        timestamp: new Date(now.getTime() - (30 * 60 * 1000)),
        volumeBtc: 40,
      },
    ]).run();

    const [oneDayResponse, sevenDayResponse, rangeResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart?days=1',
      }),
      getApp().inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart?days=7',
      }),
      getApp().inject({
        method: 'GET',
        url: `/exchanges/binance/volume_chart/range?from=${Math.floor((now.getTime() - (3 * 60 * 60 * 1000)) / 1000)}&to=${Math.floor(now.getTime() / 1000)}`,
      }),
    ]);

    expect(oneDayResponse.statusCode).toBe(200);
    expect(oneDayResponse.json()).toEqual(expect.arrayContaining([
      [new Date(now.getTime() - (23 * 60 * 60 * 1000)).getTime(), 20],
      [new Date(now.getTime() - (2 * 60 * 60 * 1000)).getTime(), 30],
      [new Date(now.getTime() - (30 * 60 * 1000)).getTime(), 40],
    ]));
    expect(oneDayResponse.json().every((entry: [number, number]) => entry[0] >= cutoff.getTime())).toBe(true);

    expect(sevenDayResponse.statusCode).toBe(200);
    expect(sevenDayResponse.json()).toEqual(expect.arrayContaining([
      [new Date(now.getTime() - (36 * 60 * 60 * 1000)).getTime(), 10],
      [new Date(now.getTime() - (23 * 60 * 60 * 1000)).getTime(), 20],
      [new Date(now.getTime() - (2 * 60 * 60 * 1000)).getTime(), 30],
      [new Date(now.getTime() - (30 * 60 * 1000)).getTime(), 40],
    ]));
    expect(sevenDayResponse.json().length).toBeGreaterThanOrEqual(4);
    expect(sevenDayResponse.json()).toEqual(
      [...sevenDayResponse.json()].sort((left: [number, number], right: [number, number]) => left[0] - right[0]),
    );

    expect(rangeResponse.statusCode).toBe(200);
    expect(rangeResponse.json()).toEqual(expect.arrayContaining([
      [new Date(now.getTime() - (2 * 60 * 60 * 1000)).getTime(), 30],
      [new Date(now.getTime() - (30 * 60 * 1000)).getTime(), 40],
    ]));
    expect(rangeResponse.json().every((entry: [number, number]) => entry[0] >= now.getTime() - (3 * 60 * 60 * 1000))).toBe(true);
    expect(rangeResponse.json()).toEqual(
      [...rangeResponse.json()].sort((left: [number, number], right: [number, number]) => left[0] - right[0]),
    );
  });

  it('prefers live exchange volume source rows over replay rows at duplicate timestamps', async () => {
    const timestamp = new Date('2026-03-28T05:00:00.000Z');
    const appDb = getApp().db;
    appDb.db.insert(exchanges).values({
      id: 'binance',
      name: 'Binance',
      yearEstablished: 2017,
      country: 'Cayman Islands',
      description: 'Temporary seeded exchange row for volume ownership assertions.',
      url: 'https://www.binance.com/',
      imageUrl: 'https://coin-images.coingecko.com/markets/images/52/small/binance.jpg?1706864274',
      hasTradingIncentive: false,
      trustScore: 10,
      trustScoreRank: 1,
      tradeVolume24hBtc: 139508.1218951856,
      tradeVolume24hBtcNormalized: null,
      facebookUrl: null,
      redditUrl: null,
      telegramUrl: null,
      slackUrl: null,
      otherUrlJson: '[]',
      twitterHandle: 'binance',
      centralised: true,
      publicNotice: null,
      alertNotice: null,
      updatedAt: new Date('2026-03-20T00:00:00.000Z'),
    }).onConflictDoNothing().run();
    appDb.db.delete(exchangeVolumePoints).where(eq(exchangeVolumePoints.exchangeId, 'binance')).run();

    appDb.db.insert(exchangeVolumeSourcePoints).values([
      {
        exchangeId: 'binance',
        timestamp,
        volumeBtc: 10,
        sourceKind: 'replay',
        sourceProvider: 'exchange-volume-replay',
        sourceFetchedAt: new Date('2026-03-28T05:01:00.000Z'),
      },
      {
        exchangeId: 'binance',
        timestamp,
        volumeBtc: 20,
        sourceKind: 'live',
        sourceProvider: 'ccxt.binance',
        sourceFetchedAt: new Date('2026-03-28T05:00:30.000Z'),
      },
    ]).run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart/range?from=1774670400&to=1774677600',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      [timestamp.getTime(), 20],
    ]);
  });

  it('returns exchange tickers and supports coin filters', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?include_exchange_logo=true',
    });
    const filteredResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?coin_ids=ethereum&order=volume_asc',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('Binance');
    expect(response.json().tickers.length).toBeGreaterThanOrEqual(7);
    expect(response.json().tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: 'bitcoin',
        target: 'USDT',
      }),
      expect.objectContaining({
        coin_id: 'ethereum',
        target: 'USDT',
      }),
      expect.objectContaining({
        coin_id: 'usd-coin',
        target: 'USDT',
      }),
    ]));

    expect(filteredResponse.statusCode).toBe(200);
    expect(filteredResponse.json().tickers).toHaveLength(1);
    expect(filteredResponse.json().tickers[0]).toMatchObject({
      coin_id: 'ethereum',
      target: 'USDT',
    });
  });

  it('supports exchange ticker depth and dex pair formatting', async () => {
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance?dex_pair_format=contract_address',
    });
    const tickersResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?coin_ids=usd-coin&depth=true&dex_pair_format=contract_address',
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().tickers.find((ticker: { coin_id: string }) => ticker.coin_id === 'usd-coin')).toMatchObject({
      base: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      coin_id: 'usd-coin',
    });

    expect(tickersResponse.statusCode).toBe(200);
    expect(tickersResponse.json().tickers[0]).toMatchObject({
      base: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      coin_id: 'usd-coin',
    });
  });

  it('documents exchange data divergences in docs analysis', () => {
    const filePath = resolve(process.cwd(), 'docs/analysis/exchange-divergences.md');
    expect(existsSync(filePath)).toBe(true);

    const contents = readFileSync(filePath, 'utf8');
    expect(contents).toContain('| endpoint | field | description |');
    expect(contents).toContain('/exchanges/{id}/tickers');
    expect(contents).toContain('/derivatives');
  });
});
