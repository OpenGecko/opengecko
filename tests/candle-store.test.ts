import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins } from '../src/db/schema';
import { getCanonicalCandles, toMinuteBucket, upsertCanonicalCandle } from '../src/services/candle-store';

describe('candle store', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-candles-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    const now = new Date();
    database.db.insert(coins).values({
      id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', apiSymbol: 'bitcoin',
      hashingAlgorithm: null, blockTimeInMinutes: null,
      categoriesJson: '[]', descriptionJson: '{}', linksJson: '{}',
      imageThumbUrl: null, imageSmallUrl: null, imageLargeUrl: null,
      marketCapRank: null, genesisDate: null, platformsJson: '{}',
      status: 'active', createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run();
    rebuildSearchIndex(database);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates canonical minute candles with rolling OHLC values', () => {
    const bucket = toMinuteBucket(Date.parse('2026-03-21T00:00:10.000Z'));

    upsertCanonicalCandle(database, {
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1m',
      timestamp: bucket,
      price: 100,
      totalVolume: 10,
    });
    upsertCanonicalCandle(database, {
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1m',
      timestamp: bucket,
      price: 105,
      totalVolume: 12,
    });
    upsertCanonicalCandle(database, {
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1m',
      timestamp: bucket,
      price: 98,
      totalVolume: 9,
    });

    const [candle] = getCanonicalCandles(database, 'bitcoin', 'usd', '1m', {
      from: bucket.getTime(),
      to: bucket.getTime(),
    });

    expect(candle).toMatchObject({
      open: 100,
      high: 105,
      low: 98,
      close: 98,
      totalVolume: 9,
    });
  });
});
