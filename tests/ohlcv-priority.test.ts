import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins, marketSnapshots, ohlcvSyncTargets } from '../src/db/schema';
import { refreshOhlcvPriorityTiers, selectTopOhlcvCoins } from '../src/services/ohlcv-priority';

describe('ohlcv priority', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-ohlcv-priority-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);

    database.db.insert(coins).values([
      {
        id: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        apiSymbol: 'bitcoin',
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: '{}',
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: 1,
        genesisDate: null,
        platformsJson: '{}',
        status: 'active',
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
      },
      {
        id: 'chainlink',
        symbol: 'link',
        name: 'Chainlink',
        apiSymbol: 'chainlink',
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: '{}',
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: 50,
        genesisDate: null,
        platformsJson: '{}',
        status: 'active',
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
      },
      {
        id: 'some-microcap',
        symbol: 'smc',
        name: 'Some Microcap',
        apiSymbol: 'some-microcap',
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: '{}',
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: 999,
        genesisDate: null,
        platformsJson: '{}',
        status: 'active',
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
      },
    ]).onConflictDoNothing().run();

    database.db.insert(marketSnapshots).values([
      {
        coinId: 'bitcoin',
        vsCurrency: 'usd',
        price: 85_000,
        marketCap: 1_600_000_000_000,
        totalVolume: 10_000_000,
        marketCapRank: 1,
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
        priceChangePercentage24h: null,
        sourceProvidersJson: '[]',
        sourceCount: 1,
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
        lastUpdated: new Date('2026-03-22T00:00:00.000Z'),
      },
      {
        coinId: 'chainlink',
        vsCurrency: 'usd',
        price: 24,
        marketCap: 15_000_000_000,
        totalVolume: 1_000_000,
        marketCapRank: 50,
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
        priceChangePercentage24h: null,
        sourceProvidersJson: '[]',
        sourceCount: 1,
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
        lastUpdated: new Date('2026-03-22T00:00:00.000Z'),
      },
      {
        coinId: 'some-microcap',
        vsCurrency: 'usd',
        price: 0.1,
        marketCap: 1_000_000,
        totalVolume: 10_000,
        marketCapRank: 999,
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
        priceChangePercentage24h: null,
        sourceProvidersJson: '[]',
        sourceCount: 1,
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
        lastUpdated: new Date('2026-03-22T00:00:00.000Z'),
      },
    ]).run();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('computes a deterministic top-ranked set from market snapshots', () => {
    const topIds = selectTopOhlcvCoins(database, 2);

    expect(topIds).toEqual(['bitcoin', 'chainlink']);
  });

  it('promotes ranked coins into the top100 worker tier without losing cursors', () => {
    database.db.insert(ohlcvSyncTargets).values({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'long_tail',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
      status: 'idle',
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      failureCount: 0,
      nextRetryAt: null,
      lastRequestedAt: null,
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z'),
    }).run();

    refreshOhlcvPriorityTiers(database, new Date('2026-03-23T00:00:00.000Z'), 1);

    const row = database.db.select().from(ohlcvSyncTargets).all()[0];
    expect(row.priorityTier).toBe('top100');
    expect(row.latestSyncedAt?.toISOString()).toBe('2026-03-22T00:00:00.000Z');
    expect(row.oldestSyncedAt?.toISOString()).toBe('2025-03-22T00:00:00.000Z');
  });
});
