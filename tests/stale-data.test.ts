import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { createDatabase, type AppDatabase } from '../src/db/client';
import { marketSnapshots } from '../src/db/schema';
import { fetchExchangeTickers } from '../src/providers/ccxt';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
  ]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('stale market snapshot behavior', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;
  let database: AppDatabase | undefined;
  let databaseUrl: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-stale-'));
    databaseUrl = join(tempDir, 'test.db');
    app = buildApp({
      config: {
        databaseUrl,
        logLevel: 'silent',
        marketFreshnessThresholdSeconds: 60,
      },
      startBackgroundJobs: false,
    });
    database = createDatabase(databaseUrl);
  });

  afterEach(async () => {
    if (database) {
      database.client.close();
    }

    if (app) {
      await app.close();
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('treats stale live snapshots as unavailable in market-facing endpoints', async () => {
    // First trigger onReady to run initial-sync, then age the snapshots
    await app!.inject({ method: 'GET', url: '/ping' });

    // Now age the live snapshots to be stale
    database!.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();

    const simplePriceResponse = await app!.inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const coinDetailResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin',
    });
    const marketsResponse = await app!.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(simplePriceResponse.statusCode).toBe(200);
    expect(simplePriceResponse.json()).toEqual({});

    expect(coinDetailResponse.statusCode).toBe(200);
    expect(coinDetailResponse.json().market_data).toBeNull();

    expect(marketsResponse.statusCode).toBe(200);
    expect(marketsResponse.json()[0]).toMatchObject({
      id: 'bitcoin',
      current_price: null,
      market_cap: null,
      total_volume: null,
    });
  });

  it('returns live price after initial sync', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      bitcoin: {
        usd: 85000,
      },
    });
  });

  it('serves stale live snapshots during background bootstrap until fresh data arrives', async () => {
    await app!.inject({ method: 'GET', url: '/ping' });

    await app!.close();
    app = undefined;
    database?.client.close();
    database = undefined;

    const bootstrapSourceTime = new Date('2026-03-20T00:00:00.000Z');
    let releaseTickerFetch!: () => void;
    const blockedTickerFetch = new Promise<Awaited<ReturnType<typeof fetchExchangeTickers>>>((resolve) => {
      releaseTickerFetch = () => resolve([]);
    });
    vi.mocked(fetchExchangeTickers).mockReturnValueOnce(blockedTickerFetch);
    app = buildApp({
      config: {
        databaseUrl,
        logLevel: 'silent',
        marketFreshnessThresholdSeconds: 60,
      },
      startBackgroundJobs: true,
    });

    database = createDatabase(databaseUrl);

    await app.inject({ method: 'GET', url: '/ping' });

    database.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: bootstrapSourceTime,
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      bitcoin: {
        usd: 85000,
      },
    });

    releaseTickerFetch();
  });
});
