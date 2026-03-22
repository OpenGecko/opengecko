import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins, marketSnapshots, ohlcvCandles } from '../src/db/schema';
import { getChartSeries, getCoinByContract, getMarketRows } from '../src/modules/catalog';

const now = new Date();

const catalogCoins = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', apiSymbol: 'bitcoin', platformsJson: '{}' },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum', apiSymbol: 'ethereum', platformsJson: '{}' },
  { id: 'ripple', symbol: 'xrp', name: 'XRP', apiSymbol: 'ripple', platformsJson: '{}' },
  { id: 'solana', symbol: 'sol', name: 'Solana', apiSymbol: 'solana', platformsJson: '{}' },
  { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin', apiSymbol: 'dogecoin', platformsJson: '{}' },
  { id: 'usd-coin', symbol: 'usdc', name: 'USDC', apiSymbol: 'usd-coin', platformsJson: JSON.stringify({ ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }) },
  { id: 'cardano', symbol: 'ada', name: 'Cardano', apiSymbol: 'cardano', platformsJson: '{}' },
  { id: 'chainlink', symbol: 'link', name: 'Chainlink', apiSymbol: 'chainlink', platformsJson: '{}' },
];

function seedCatalogData(database: AppDatabase) {
  for (const coin of catalogCoins) {
    database.db.insert(coins).values({
      ...coin,
      hashingAlgorithm: null,
      blockTimeInMinutes: null,
      categoriesJson: '[]',
      descriptionJson: '{}',
      linksJson: '{}',
      imageThumbUrl: null,
      imageSmallUrl: null,
      imageLargeUrl: null,
      marketCapRank: null,
      genesisDate: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: coins.id,
      set: { platformsJson: coin.platformsJson, updatedAt: now },
    }).run();
  }

  for (const coin of catalogCoins) {
    database.db.insert(marketSnapshots).values({
      coinId: coin.id,
      vsCurrency: 'usd',
      price: 1,
      marketCap: 1_000_000_000,
      totalVolume: 100_000_000,
      sourceCount: 0,
      sourceProvidersJson: '[]',
      updatedAt: now,
      lastUpdated: now,
    }).onConflictDoNothing().run();
  }

  const baseDate = Date.parse('2026-03-14T00:00:00.000Z');
  for (const coin of catalogCoins) {
    for (let day = 0; day < 7; day++) {
      const ts = new Date(baseDate + day * 24 * 60 * 60 * 1000);
      database.db.insert(ohlcvCandles).values({
        coinId: coin.id,
        vsCurrency: 'usd',
        source: 'canonical',
        interval: '1d',
        timestamp: ts,
        open: 100 + day,
        high: 105 + day,
        low: 95 + day,
        close: 102 + day,
        volume: 1_000_000,
        marketCap: 1_000_000_000,
        totalVolume: 100_000_000,
      }).onConflictDoNothing().run();
    }
  }
}

describe('catalog repository helpers', () => {
  let database: AppDatabase;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-catalog-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    seedCatalogData(database);
    rebuildSearchIndex(database);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves contract addresses deterministically', () => {
    const coin = getCoinByContract(database, 'ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

    expect(coin?.id).toBe('usd-coin');
  });

  it('filters market rows by ids before other selectors', () => {
    const rows = getMarketRows(database, 'usd', {
      ids: ['bitcoin'],
      symbols: ['eth'],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.coin.id).toBe('bitcoin');
  });

  it('returns deterministic chart ranges', () => {
    const rows = getChartSeries(database, 'bitcoin', 'usd', {
      from: Date.parse('2026-03-16T00:00:00.000Z'),
      to: Date.parse('2026-03-18T00:00:00.000Z'),
    });

    expect(rows.map((row) => row.timestamp.toISOString())).toEqual([
      '2026-03-16T00:00:00.000Z',
      '2026-03-17T00:00:00.000Z',
      '2026-03-18T00:00:00.000Z',
    ]);
  });

  it('supports open-ended chart ranges for history-style reads', () => {
    const rows = getChartSeries(database, 'bitcoin', 'usd', {
      to: Date.parse('2026-03-15T00:00:00.000Z'),
    });

    expect(rows.map((row) => row.timestamp.toISOString())).toEqual([
      '2026-03-14T00:00:00.000Z',
      '2026-03-15T00:00:00.000Z',
    ]);
  });
});
