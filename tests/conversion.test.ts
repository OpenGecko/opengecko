import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins, marketSnapshots } from '../src/db/schema';
import { HttpError } from '../src/http/errors';
import { buildExchangeRatesPayload, getConversionRate, SUPPORTED_VS_CURRENCIES } from '../src/lib/conversion';
import type { SnapshotAccessPolicy } from '../src/modules/market-freshness';

const seedFriendlyPolicy: SnapshotAccessPolicy = {
  initialSyncCompleted: false,
  allowStaleLiveService: false,
};

const now = new Date();

function seedConversionCoins(database: AppDatabase) {
  for (const coin of [
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', apiSymbol: 'bitcoin' },
    { id: 'ethereum', symbol: 'eth', name: 'Ethereum', apiSymbol: 'ethereum' },
    { id: 'ripple', symbol: 'xrp', name: 'XRP', apiSymbol: 'ripple' },
    { id: 'solana', symbol: 'sol', name: 'Solana', apiSymbol: 'solana' },
  ]) {
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
      platformsJson: '{}',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();
  }

  for (const snapshot of [
    { coinId: 'bitcoin', price: 85_000, marketCap: 1_700_000_000_000, totalVolume: 25_000_000_000 },
    { coinId: 'ethereum', price: 2_000, marketCap: 240_000_000_000, totalVolume: 10_000_000_000 },
    { coinId: 'ripple', price: 2.5, marketCap: 140_000_000_000, totalVolume: 11_000_000_000 },
    { coinId: 'solana', price: 175, marketCap: 84_000_000_000, totalVolume: 9_000_000_000 },
  ]) {
    database.db.insert(marketSnapshots).values({
      ...snapshot,
      vsCurrency: 'usd',
      sourceCount: 1,
      sourceProvidersJson: '["test"]',
      updatedAt: now,
      lastUpdated: now,
    }).run();
  }
}

describe('conversion helpers', () => {
  let database: AppDatabase;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-conversion-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    seedConversionCoins(database);
    rebuildSearchIndex(database);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes the supported vs currencies from one shared module', () => {
    expect([...SUPPORTED_VS_CURRENCIES]).toEqual(['usd', 'eur', 'btc', 'eth']);
  });

  it('returns stable conversion rates for supported currencies', () => {
    expect(getConversionRate(database, 'usd', 300, seedFriendlyPolicy)).toBe(1);
    expect(getConversionRate(database, 'eur', 300, seedFriendlyPolicy)).toBe(0.8627000182076447);
    expect(getConversionRate(database, 'btc', 300, seedFriendlyPolicy)).toBe(1 / 85_000);
    expect(getConversionRate(database, 'eth', 300, seedFriendlyPolicy)).toBe(1 / 2_000);
  });

  it('throws consistently for unsupported currencies', () => {
    expect(() => getConversionRate(database, 'sgd', 300, seedFriendlyPolicy)).toThrowError(HttpError);
    expect(() => getConversionRate(database, 'sgd', 300, seedFriendlyPolicy)).toThrow('Unsupported vs_currency: sgd');
  });

  it('builds the exchange-rates payload from the shared conversion source', () => {
    expect(buildExchangeRatesPayload(database, 300, seedFriendlyPolicy)).toEqual({
      data: {
        btc: {
          name: 'Bitcoin',
          unit: 'BTC',
          value: 1,
          type: 'crypto',
        },
        eth: {
          name: 'Ether',
          unit: 'ETH',
          value: 42.5,
          type: 'crypto',
        },
        usd: {
          name: 'US Dollar',
          unit: '$',
          value: 85_000,
          type: 'fiat',
        },
        eur: {
          name: 'Euro',
          unit: '€',
          value: 73_329.50154764981,
          type: 'fiat',
        },
      },
    });
  });
});
