import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins } from '../src/db/schema';
import {
  createSqliteHistoricalOhlcvStore,
  getCanonicalCandles,
  toMinuteBucket,
  upsertCanonicalCandle,
  type HistoricalOhlcvStore,
} from '../src/services/candle-store';

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

  it('exposes the SQLite-backed historical OHLCV store through a backend-neutral interface', async () => {
    const store: HistoricalOhlcvStore = createSqliteHistoricalOhlcvStore(database);
    const now = new Date();
    const coinId = 'historical-interface-coin';
    database.db.insert(coins).values({
      id: coinId, symbol: 'hic', name: 'Historical Interface Coin', apiSymbol: 'historical-interface-coin',
      hashingAlgorithm: null, blockTimeInMinutes: null,
      categoriesJson: '[]', descriptionJson: '{}', linksJson: '{}',
      imageThumbUrl: null, imageSmallUrl: null, imageLargeUrl: null,
      marketCapRank: null, genesisDate: null, platformsJson: '{}',
      status: 'active', createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run();
    const first = new Date('2026-03-21T00:00:00.000Z');
    const third = new Date('2026-03-23T00:00:00.000Z');

    store.upsertCanonicalOhlcvCandle({
      coinId,
      vsCurrency: 'usd',
      interval: '1d',
      timestamp: first,
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 1_000,
      totalVolume: 1_000,
      replaceExisting: true,
    });
    store.upsertCanonicalOhlcvCandle({
      coinId,
      vsCurrency: 'usd',
      interval: '1d',
      timestamp: third,
      open: 120,
      high: 125,
      low: 115,
      close: 122,
      volume: 1_200,
      totalVolume: 1_200,
      replaceExisting: true,
    });

    expect(store.getCanonicalCandles(coinId, 'usd', '1d', {
      from: first.getTime(),
      to: third.getTime(),
    })).toHaveLength(2);
    expect(store.detectOhlcvGaps(coinId, 'usd', '1d')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        gapStart: new Date('2026-03-22T00:00:00.000Z'),
        missingSlotCount: 1,
      }),
    ]));

    const repairResult = await store.repairOhlcvGaps({
      coinId,
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
    }, async () => [
      {
        timestamp: Date.parse('2026-03-22T00:00:00.000Z'),
        open: 106,
        high: 121,
        low: 104,
        close: 120,
        volume: 1_100,
      },
    ]);

    expect(repairResult).toMatchObject({
      gapsRepaired: 1,
      candlesRepaired: 1,
      intervalMs: 86_400_000,
    });
    expect(store.detectOhlcvGaps(coinId, 'usd', '1d')).toEqual([]);
    expect(store.getCanonicalCloseSeries(coinId, 'usd', '1d', {
      from: first.getTime(),
      to: third.getTime(),
    }).map((point) => point.price)).toEqual(expect.arrayContaining([105, 120, 122]));
    expect(store.enforceOhlcvRetention({
      coinId,
      vsCurrency: 'usd',
      interval: '1d',
      retentionDays: 1,
      now: third,
    })).toBe(2);
    expect(store.getCanonicalCandles(coinId, 'usd', '1d')).toHaveLength(1);
    expect(store.enforceOhlcvRetention({
      coinId: 'missing-interface-coin',
      vsCurrency: 'usd',
      interval: '1d',
      retentionDays: 1,
    })).toBe(0);
  });
});
