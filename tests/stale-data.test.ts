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
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('stale market snapshot behavior', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;
  let database: AppDatabase | undefined;
  let databaseUrl: string;
  let mockedFetchExchangeTickers: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedFetchExchangeTickers = fetchExchangeTickers as unknown as ReturnType<typeof vi.fn>;
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
    app!.marketDataRuntimeState.hotDataRevision += 1;

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

  it('serves stale live fallback coherently with diagnostics when runtime fallback is enabled', async () => {
    await app!.inject({ method: 'GET', url: '/ping' });

    database!.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();

    app!.marketDataRuntimeState.allowStaleLiveService = true;
    app!.marketDataRuntimeState.syncFailureReason = 'provider timeout';
    app!.marketDataRuntimeState.hotDataRevision += 1;

    const diagnosticsResponse = await app!.inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });

    const [simplePriceResponse, marketsResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin',
      }),
    ]);

    expect(simplePriceResponse.statusCode).toBe(200);
    expect(simplePriceResponse.json()).toEqual({
      bitcoin: {
        usd: 85000,
      },
    });

    expect(marketsResponse.statusCode).toBe(200);
    expect(marketsResponse.json()[0]).toMatchObject({
      id: 'bitcoin',
      current_price: 85000,
      last_updated: '2026-03-19T00:00:00.000Z',
      total_volume: 425000000,
      price_change_percentage_24h: 1.8,
    });

    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json()).toMatchObject({
      data: {
        readiness: {
          state: 'degraded',
        },
        degraded: {
          active: true,
          stale_live_enabled: true,
          reason: 'provider timeout',
        },
        hot_paths: {
          shared_market_snapshot: {
            available: true,
            source_class: 'fresh_live',
            last_successful_live_refresh_at: expect.any(String),
            freshness: {
              is_stale: false,
            },
            providers: expect.arrayContaining(['binance']),
            provider_count: expect.any(Number),
          },
        },
      },
    });
  });

  it('reports degraded seeded bootstrap source class while serving seeded residual snapshots consistently after failed boot', async () => {
    await app!.inject({ method: 'GET', url: '/ping' });

    const bootstrapSourceTime = new Date('2026-03-20T00:00:00.000Z');
    database!.db
      .update(marketSnapshots)
      .set({
        price: 77777,
        marketCap: null,
        totalVolume: null,
        priceChange24h: null,
        priceChangePercentage24h: null,
        sourceProvidersJson: JSON.stringify([]),
        sourceCount: 0,
        lastUpdated: bootstrapSourceTime,
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    database!.db
      .update(marketSnapshots)
      .set({
        price: 2000,
        marketCap: null,
        totalVolume: null,
        priceChange24h: null,
        priceChangePercentage24h: null,
        sourceProvidersJson: JSON.stringify([]),
        sourceCount: 0,
        lastUpdated: bootstrapSourceTime,
      })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();
    app!.marketDataRuntimeState.initialSyncCompleted = false;
    app!.marketDataRuntimeState.allowStaleLiveService = true;
    app!.marketDataRuntimeState.syncFailureReason = 'bootstrap upstream unavailable';
    app!.marketDataRuntimeState.startupPrewarm = {
      enabled: false,
      budgetMs: 0,
      readyWithinBudget: true,
      firstRequestWarmBenefitsObserved: false,
      firstRequestWarmBenefitPending: false,
      targets: [],
      completedAt: null,
      totalDurationMs: null,
      targetResults: [],
    };
    app!.marketDataRuntimeState.hotDataRevision += 1;

    const [simplePriceResponse, marketsResponse, diagnosticsResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h',
      }),
      app!.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      }),
    ]);

    expect(simplePriceResponse.statusCode).toBe(200);
    expect(simplePriceResponse.json()).toEqual({
      bitcoin: {
        usd: 77777,
      },
    });

    expect(marketsResponse.statusCode).toBe(200);
    expect(marketsResponse.json()[0]).toMatchObject({
      id: 'bitcoin',
      current_price: 77777,
      market_cap: null,
      total_volume: null,
      high_24h: null,
      low_24h: null,
      price_change_24h: null,
      price_change_percentage_24h: null,
      last_updated: bootstrapSourceTime.toISOString(),
    });
    expect(marketsResponse.json()[0]).toMatchObject({
      price_change_percentage_24h_in_currency: null,
    });
    expect(marketsResponse.json()[0].price_change_percentage_24h_in_currency).toBeNull();

    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json()).toMatchObject({
      data: {
        readiness: {
          state: 'degraded',
          initial_sync_completed: false,
        },
        degraded: {
          active: true,
          stale_live_enabled: true,
          reason: 'bootstrap upstream unavailable',
        },
        hot_paths: {
          shared_market_snapshot: {
            available: true,
            source_class: 'degraded_seeded_bootstrap',
            last_successful_live_refresh_at: null,
            freshness: {
              is_stale: true,
            },
            providers: [],
            provider_count: 0,
          },
        },
      },
    });
  });

  it('returns fresh live price after background bootstrap completes', async () => {
    await app!.inject({ method: 'GET', url: '/ping' });

    await app!.close();
    app = undefined;
    database?.client.close();
    database = undefined;

    const bootstrapSourceTime = new Date('2026-03-20T00:00:00.000Z');
    let releaseTickerFetch!: () => void;
    const blockedTickerFetch = new Promise<Awaited<ReturnType<typeof fetchExchangeTickers>>>((resolve) => {
      releaseTickerFetch = () => resolve([
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
      ]);
    });
    mockedFetchExchangeTickers.mockReturnValueOnce(blockedTickerFetch);
    app = buildApp({
      config: {
        databaseUrl,
        logLevel: 'silent',
        marketFreshnessThresholdSeconds: 60,
      },
      startBackgroundJobs: true,
    });

    database = createDatabase(databaseUrl);

    database.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: bootstrapSourceTime,
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();

    releaseTickerFetch();
    await app.ready();

    const readyResponse = await app.inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });

    expect(readyResponse.statusCode).toBe(200);
    expect(readyResponse.json()).toEqual({
      bitcoin: {
        usd: 85000,
      },
    });
  });
});
