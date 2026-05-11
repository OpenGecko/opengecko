import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins, marketSnapshots } from '../src/db/schema';
import { createUnifiedScheduler } from '../src/services/job-scheduler';
import { registerTier1SchedulerJobs } from '../src/services/tier1-jobs';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockImplementation((exchangeId: string) => Promise.resolve([
    { exchangeId, symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId, symbol: 'TST/USDT', base: 'TST', quote: 'USDT', active: true, spot: true, baseName: 'Test Token', raw: {} },
  ])),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string => ['binance', 'okx'].includes(value),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('Tier 1 catalog/global/category aggregators', () => {
  let tempDir: string;
  let database: AppDatabase;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-tier1-aggregators-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database, { includeSeededExchanges: true });
    seedDeterministicMarketInputs(database);
    rebuildSearchIndex(database);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }

    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function getApp() {
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    return app;
  }

  it('runs catalog and exchange rescans through scheduler jobs and exposes endpoint-visible rows', async () => {
    const api = getApp();
    await api.ready();
    seedDeterministicMarketInputs(api.db);
    const scheduler = createUnifiedScheduler({ logger });
    registerTier1SchedulerJobs(scheduler, api.db, {
      ccxtExchanges: ['binance', 'okx'],
      providerFanoutConcurrency: 1,
      defillamaPoolSweepIntervalSeconds: 300,
      defillamaTokenSweepIntervalSeconds: 600,
      subsquidTradeSweepIntervalSeconds: 60,
      coinCatalogRescanIntervalSeconds: 3600,
      exchangeMetadataRescanIntervalSeconds: 21600,
      globalAggregatorIntervalSeconds: 60,
      categoryAggregatorIntervalSeconds: 900,
      defillamaPoolSweepDisabled: true,
      defillamaTokenSweepDisabled: true,
      subsquidTradeSweepDisabled: true,
      coinCatalogRescanDisabled: false,
      exchangeMetadataRescanDisabled: false,
      globalAggregatorDisabled: false,
      categoryAggregatorDisabled: false,
    });

    await scheduler.runNow('coin-catalog-rescan');
    await scheduler.runNow('exchange-metadata-rescan');

    const diagnostics = scheduler.diagnostics();
    expect(diagnostics.find((job) => job.name === 'coin-catalog-rescan')).toMatchObject({
      success_count: 1,
      last_error: null,
    });
    expect(diagnostics.find((job) => job.name === 'exchange-metadata-rescan')).toMatchObject({
      success_count: 1,
      last_error: null,
    });

    const testToken = api.db.db.select().from(coins).all().find((coin) => coin.id === 'test-token');
    expect(testToken).toMatchObject({
      symbol: 'tst',
      name: 'Test Token',
      status: 'active',
    });

    const coinListResponse = await api.inject({ method: 'GET', url: '/coins/list' });
    const newListResponse = await api.inject({ method: 'GET', url: '/coins/list/new' });
    const exchangesResponse = await api.inject({ method: 'GET', url: '/exchanges' });
    const okxResponse = await api.inject({ method: 'GET', url: '/exchanges/okex' });

    expect(coinListResponse.statusCode).toBe(200);
    expect(coinListResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'test-token', symbol: 'tst', name: 'Test Token' }),
    ]));
    expect(newListResponse.statusCode).toBe(200);
    expect(newListResponse.json().coins[0]).toMatchObject({ id: 'test-token', symbol: 'tst' });
    expect(exchangesResponse.statusCode).toBe(200);
    expect(exchangesResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'okex', name: 'OKX' }),
    ]));
    expect(okxResponse.statusCode).toBe(200);
    expect(okxResponse.json()).toMatchObject({ id: 'okex', name: 'OKX' });
  });

  it('runs global and category aggregators from deterministic market snapshots', async () => {
    const api = getApp();
    await api.ready();
    seedDeterministicMarketInputs(api.db);
    const scheduler = createUnifiedScheduler({ logger });
    registerTier1SchedulerJobs(scheduler, api.db, {
      ccxtExchanges: ['binance'],
      providerFanoutConcurrency: 1,
      defillamaPoolSweepIntervalSeconds: 300,
      defillamaTokenSweepIntervalSeconds: 600,
      subsquidTradeSweepIntervalSeconds: 60,
      coinCatalogRescanIntervalSeconds: 3600,
      exchangeMetadataRescanIntervalSeconds: 21600,
      globalAggregatorIntervalSeconds: 60,
      categoryAggregatorIntervalSeconds: 900,
      defillamaPoolSweepDisabled: true,
      defillamaTokenSweepDisabled: true,
      subsquidTradeSweepDisabled: true,
      coinCatalogRescanDisabled: true,
      exchangeMetadataRescanDisabled: true,
      globalAggregatorDisabled: false,
      categoryAggregatorDisabled: false,
    });

    await scheduler.runNow('global-aggregator');
    await scheduler.runNow('category-aggregator');

    const diagnostics = scheduler.diagnostics();
    expect(diagnostics.find((job) => job.name === 'global-aggregator')).toMatchObject({
      success_count: 1,
      last_error: null,
    });
    expect(diagnostics.find((job) => job.name === 'category-aggregator')).toMatchObject({
      success_count: 1,
      last_error: null,
    });

    const globalResponse = await api.inject({ method: 'GET', url: '/global' });
    const chartResponse = await api.inject({ method: 'GET', url: '/global/market_cap_chart?vs_currency=usd&days=1' });
    const categoriesResponse = await api.inject({ method: 'GET', url: '/coins/categories?order=market_cap_desc' });
    const categoryListResponse = await api.inject({ method: 'GET', url: '/coins/categories/list' });

    expect(globalResponse.statusCode).toBe(200);
    expect(globalResponse.json().data.total_market_cap.usd).toBe(2_000);
    expect(globalResponse.json().data.total_volume.usd).toBe(300);
    expect(globalResponse.json().data.market_cap_percentage.btc).toBe(75);

    expect(chartResponse.statusCode).toBe(200);
    expect(chartResponse.json().market_cap_chart).toEqual(expect.arrayContaining([
      [Date.parse('2026-05-01T12:00:00.000Z'), 2_000],
    ]));

    expect(categoriesResponse.statusCode).toBe(200);
    expect(categoriesResponse.json().meta.fixture).toBe(false);
    expect(categoriesResponse.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'layer-1',
        market_cap: 2_000,
        volume_24h: 300,
        top_3_coins_id: ['bitcoin', 'ethereum'],
      }),
      expect.objectContaining({
        id: 'stablecoins',
        market_cap: 500,
        volume_24h: 50,
        top_3_coins_id: ['ethereum'],
      }),
    ]));

    expect(categoryListResponse.statusCode).toBe(200);
    expect(categoryListResponse.json()).toEqual(expect.arrayContaining([
      { category_id: 'layer-1', name: 'Layer 1' },
      { category_id: 'stablecoins', name: 'Stablecoins' },
    ]));
  });
});

function seedDeterministicMarketInputs(database: AppDatabase) {
  const now = new Date('2026-05-01T12:00:00.000Z');
  const rows = [
    {
      coinId: 'bitcoin',
      categoriesJson: JSON.stringify(['layer-1']),
      price: 100,
      marketCap: 1_500,
      totalVolume: 250,
      marketCapRank: 1,
      priceChangePercentage24h: 50,
    },
    {
      coinId: 'ethereum',
      categoriesJson: JSON.stringify(['layer-1', 'stablecoins']),
      price: 50,
      marketCap: 500,
      totalVolume: 50,
      marketCapRank: 2,
      priceChangePercentage24h: 0,
    },
  ];

  for (const row of rows) {
    database.client.prepare('UPDATE coins SET categories_json = ?, updated_at = ? WHERE id = ?')
      .run(row.categoriesJson, now.getTime(), row.coinId);
    database.db
      .insert(marketSnapshots)
      .values({
        coinId: row.coinId,
        vsCurrency: 'usd',
        price: row.price,
        marketCap: row.marketCap,
        totalVolume: row.totalVolume,
        marketCapRank: row.marketCapRank,
        fullyDilutedValuation: null,
        circulatingSupply: null,
        totalSupply: null,
        maxSupply: null,
        ath: null,
        athChangePercentage: null,
        athDate: null,
        atl: null,
        atlChangePercentage: null,
        atlDate: null,
        priceChange24h: null,
        priceChangePercentage24h: row.priceChangePercentage24h,
        sourceProvidersJson: '["test"]',
        sourceCount: 1,
        updatedAt: now,
        lastUpdated: now,
      })
      .onConflictDoUpdate({
        target: [marketSnapshots.coinId, marketSnapshots.vsCurrency],
        set: {
          price: row.price,
          marketCap: row.marketCap,
          totalVolume: row.totalVolume,
          marketCapRank: row.marketCapRank,
          priceChangePercentage24h: row.priceChangePercentage24h,
          sourceProvidersJson: '["test"]',
          sourceCount: 1,
          updatedAt: now,
          lastUpdated: now,
        },
      })
      .run();
  }
}
