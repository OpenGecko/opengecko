import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins, marketSnapshots } from '../src/db/schema';
import { buildExchangeRatesPayload } from '../src/lib/conversion';
import type { SnapshotAccessPolicy } from '../src/modules/market-freshness';

const seedFriendlyPolicy: SnapshotAccessPolicy = {
  initialSyncCompleted: false,
  allowStaleLiveService: false,
};

const now = new Date('2026-03-28T12:00:00.000Z');

function seedExchangeRateParityData(database: AppDatabase) {
  for (const row of [
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', price: 66_330.91666666667 },
    { id: 'ethereum', symbol: 'eth', name: 'Ethereum', price: 1_995 },
    { id: 'tether', symbol: 'usdt', name: 'Tether', price: 1.0000354100000002 },
  ]) {
    database.db.insert(coins).values({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      apiSymbol: row.id,
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
    }).onConflictDoUpdate({
      target: coins.id,
      set: {
        symbol: row.symbol,
        name: row.name,
        apiSymbol: row.id,
        updatedAt: now,
      },
    }).run();

    database.db.insert(marketSnapshots).values({
      coinId: row.id,
      vsCurrency: 'usd',
      price: row.price,
      marketCap: null,
      totalVolume: null,
      marketCapRank: null,
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
      sourceProvidersJson: '["seed"]',
      sourceCount: 1,
      updatedAt: now,
      lastUpdated: now,
    }).run();
  }
}

describe('exchange rates parity', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-exchange-rates-parity-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    seedExchangeRateParityData(database);
    rebuildSearchIndex(database);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns positive canonical BTC conversion rates aligned with the seeded market baseline', () => {
    const payload = buildExchangeRatesPayload(database, 300, seedFriendlyPolicy);

    expect(payload.data).toMatchObject({
      btc: {
        name: 'Bitcoin',
        unit: 'BTC',
        value: 1,
        type: 'crypto',
      },
      eth: {
        name: 'Ether',
        unit: 'ETH',
        type: 'crypto',
      },
      usd: {
        name: 'US Dollar',
        unit: '$',
        type: 'fiat',
      },
      eur: {
        name: 'Euro',
        unit: '€',
        type: 'fiat',
      },
      usdt: {
        name: 'Tether',
        unit: 'USDT',
        type: 'fiat',
      },
    });

    expect(payload.data.eth.value).toBeCloseTo(32.82873414330967, 8);
    expect(payload.data.usd.value).toBeCloseTo(70_652.6330024624, 10);
    expect(payload.data.eur.value).toBeCloseTo(60_952.02777764236, 8);
    expect(payload.data.usdt.value).toBeCloseTo(70_655.13490078924, 8);
    expect(payload.data.usdt.value).toBeGreaterThan(payload.data.usd.value);
  });
});
