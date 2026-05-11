import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { exchanges, marketSnapshots } from '../src/db/schema';
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

describe('search routes', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-search-routes-'));
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

  it('returns market search results', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search?query=eth',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.searchEth);
  });

  it('keeps search response families bounded to 10 results each', async () => {
    await getApp().ready();

    for (let index = 0; index < 12; index += 1) {
      getApp().db.db
        .insert(exchanges)
        .values({
          id: `eth-exchange-${index}`,
          name: `ETH Exchange ${index}`,
          yearEstablished: null,
          country: null,
          description: '',
          url: `https://eth-exchange-${index}.example.com`,
          imageUrl: null,
          facebookUrl: null,
          redditUrl: null,
          telegramUrl: null,
          slackUrl: null,
          otherUrlJson: '[]',
          twitterHandle: null,
          hasTradingIncentive: false,
          centralised: true,
          publicNotice: null,
          alertNotice: null,
          trustScore: 1,
          trustScoreRank: 100 + index,
          tradeVolume24hBtc: null,
          tradeVolume24hBtcNormalized: null,
          updatedAt: new Date(`2026-03-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
        })
        .onConflictDoNothing()
        .run();
    }

    const response = await getApp().inject({
      method: 'GET',
      url: '/search?query=eth',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().coins.length).toBeLessThanOrEqual(10);
    expect(response.json().exchanges.length).toBeLessThanOrEqual(10);
    expect(response.json().categories.length).toBeLessThanOrEqual(10);
    expect(response.json().icos).toEqual([]);
    expect(response.json().nfts).toEqual([]);
  });

  it('returns FTS-backed category search results', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search?query=stable',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.searchStable);
  });

  it('rejects blank search queries with the invalid_parameter contract envelope', async () => {
    const [missingQueryResponse, blankQueryResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/search',
      }),
      getApp().inject({
        method: 'GET',
        url: '/search?query=',
      }),
    ]);

    expect(missingQueryResponse.statusCode).toBe(400);
    expect(missingQueryResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });

    expect(blankQueryResponse.statusCode).toBe(400);
    expect(blankQueryResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });
  });

  it('keeps newly listed canonical coin ids propagated across search, list, and detail surfaces', async () => {
    const [newListingsResponse, coinsListResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/coins/list/new' }),
      getApp().inject({ method: 'GET', url: '/coins/list?include_platform=true' }),
    ]);

    expect(newListingsResponse.statusCode).toBe(200);
    expect(coinsListResponse.statusCode).toBe(200);

    const listings = newListingsResponse.json().coins as Array<{
      id: string;
      symbol: string;
      name: string;
      activated_at: number;
    }>;
    expect(listings.length).toBeGreaterThan(0);

    const newestListing = listings[0]!;
    const discoveredId = newestListing.id;
    const [searchResponse, detailResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: `/search?query=${encodeURIComponent(discoveredId)}` }),
      getApp().inject({ method: 'GET', url: `/coins/${discoveredId}?localization=false&tickers=false&community_data=false&developer_data=false` }),
    ]);

    expect(searchResponse.statusCode).toBe(200);
    expect(detailResponse.statusCode).toBe(200);
    expect(searchResponse.json().coins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: newestListing.id,
        symbol: newestListing.symbol,
        name: newestListing.name,
      }),
    ]));
    expect(coinsListResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: newestListing.id,
        symbol: newestListing.symbol,
        name: newestListing.name,
      }),
    ]));
    expect(detailResponse.json()).toMatchObject({
      id: newestListing.id,
      symbol: newestListing.symbol,
      name: newestListing.name,
    });
  });

  it('returns grouped trending search results with nested coin items', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('coins');
    expect(body).toHaveProperty('nfts');
    expect(body).toHaveProperty('categories');
    expect(body.meta).toMatchObject({
      approximation: true,
      source: 'market_snapshots',
      ranking_method: 'market_cap_rank_with_volume_price_change_context',
    });
    expect(Array.isArray(body.coins)).toBe(true);
    expect(Array.isArray(body.nfts)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
    expect(body.coins[0].item.id).toBe('bitcoin');
    expect(typeof body.coins[0].item.coin_id).toBe('number');
    expect(body.coins[0].item.name).toBe('Bitcoin');
    expect(body.coins[0].item.symbol).toBe('btc');
    expect(typeof body.coins[0].item.market_cap_rank === 'number' || body.coins[0].item.market_cap_rank === null).toBe(true);
    expect(body.coins[0].item.score).toBe(body.coins[0].item.market_cap_rank ?? 0);
    expect(typeof body.coins[0].item.data.market_cap === 'number' || body.coins[0].item.data.market_cap === null).toBe(true);
    expect(body.coins.map((entry: { item: { id: string } }) => entry.item.id)).toContain('ethereum');
    expect(body.coins.map((entry: { item: { market_cap_rank: number | null } }) => entry.item.market_cap_rank)).toEqual(
      [...body.coins.map((entry: { item: { market_cap_rank: number | null } }) => entry.item.market_cap_rank)]
        .sort((left, right) => {
          const rankDelta = (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);

          if (rankDelta !== 0) {
            return rankDelta;
          }

          return 0;
        }),
    );
    body.coins.forEach((entry: { item: { market_cap_rank: number | null; score: number } }) => {
      expect(entry.item.score).toBe(entry.item.market_cap_rank ?? 0);
    });
    expect(body.nfts).toEqual([]);
    expect(body.categories[0]).toMatchObject(contractFixtures.searchTrending.categories[0]);
    expect(body.categories[1]).toMatchObject(contractFixtures.searchTrending.categories[1]);
    expect(body.coins[0]).toHaveProperty('item');
    expect(Array.isArray(body.nfts)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
  });

  it('serializes trending coins in ascending runtime market_cap_rank order with nulls last', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=20',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rankedCoins = body.coins.map((entry: { item: { id: string; market_cap_rank: number | null; score: number } }) => entry.item);

    expect(rankedCoins.length).toBeGreaterThan(1);
    expect(rankedCoins).toEqual(
      [...rankedCoins].sort((left, right) => {
        const rankDelta = (left.market_cap_rank ?? Number.MAX_SAFE_INTEGER) - (right.market_cap_rank ?? Number.MAX_SAFE_INTEGER);

        if (rankDelta !== 0) {
          return rankDelta;
        }

        return left.id.localeCompare(right.id);
      }),
    );
    rankedCoins.forEach((item: { market_cap_rank: number | null; score: number }) => {
      expect(item.score).toBe(item.market_cap_rank ?? 0);
    });

    const firstNullRankIndex = rankedCoins.findIndex((item: { market_cap_rank: number | null }) => item.market_cap_rank === null);

    if (firstNullRankIndex !== -1) {
      expect(rankedCoins.slice(firstNullRankIndex).every((item: { market_cap_rank: number | null }) => item.market_cap_rank === null)).toBe(true);
    }
  });

  it('keeps runtime ordering deterministic when multiple trending coins share the same market_cap_rank', async () => {
    await getApp().ready();
    const sharedRank = 42;

    getApp().db.db
      .update(marketSnapshots)
      .set({ marketCapRank: sharedRank })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();

    getApp().db.db
      .update(marketSnapshots)
      .set({ marketCapRank: sharedRank })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=20',
    });

    expect(response.statusCode).toBe(200);
    const rankedCoins = response.json().coins.map((entry: { item: { id: string; market_cap_rank: number | null; score: number } }) => entry.item);
    const sharedRankIds = rankedCoins
      .filter((item: { market_cap_rank: number | null }) => item.market_cap_rank === sharedRank)
      .map((item: { id: string }) => item.id);

    expect(sharedRankIds).toEqual(['bitcoin', 'ethereum']);
    rankedCoins
      .filter((item: { market_cap_rank: number | null }) => item.market_cap_rank === sharedRank)
      .forEach((item: { market_cap_rank: number | null; score: number }) => {
        expect(item.score).toBe(sharedRank);
      });
  });

  it('supports deterministic show_max truncation for trending search groups', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.coins).toHaveLength(1);
    expect(body.categories).toHaveLength(1);
    expect(body.meta.show_max).toBe(1);
    expect(body.nfts).toEqual([]);
    expect(body.coins[0].item.id).toBe('bitcoin');
    expect(body.categories[0].name).toBe('Smart Contract Platform');
  });

  it('keeps empty trending groups as arrays when show_max is zero', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=0',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      coins: [],
      nfts: [],
      categories: [],
      meta: expect.objectContaining({
        approximation: true,
        show_max: 0,
      }),
    });
  });
});
