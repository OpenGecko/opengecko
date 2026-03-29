import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData } from '../src/db/client';
import { assetPlatforms, categories, coins, marketSnapshots, treasuryEntities, ohlcvCandles, coinTickers, exchanges } from '../src/db/schema';

describe('seedStaticReferenceData', () => {
  let tempDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-seed-split-'));
    db = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(db);
  });

  afterEach(() => {
    db.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds static reference data without hot market data', () => {
    seedStaticReferenceData(db);

    // Minimal coins are seeded for FK references (treasury, chartPoints)
    const coinCount = db.db.select().from(coins).all().length;
    expect(coinCount).toBe(8);

    const platformCount = db.db.select().from(assetPlatforms).all().length;
    expect(platformCount).toBe(3);

    const categoryCount = db.db.select().from(categories).all().length;
    expect(categoryCount).toBe(2);

    const treasuryCount = db.db.select().from(treasuryEntities).all().length;
    expect(treasuryCount).toBe(2);

    // Hot/live market data (snapshots, tickers, exchanges) should NOT be seeded
    const snapshotCount = db.db.select().from(marketSnapshots).all().length;
    expect(snapshotCount).toBe(0);

    const candleRows = db.db.select().from(ohlcvCandles).all();
    expect(candleRows.length).toBe(56);
    expect(candleRows.every((row) => row.interval === '1d' && row.source === 'canonical')).toBe(true);

    const bitcoinFirstCandle = db.db
      .select()
      .from(ohlcvCandles)
      .where(eq(ohlcvCandles.coinId, 'bitcoin'))
      .all()
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())[0];
    expect(bitcoinFirstCandle).toMatchObject({
      open: 69_621.00966809,
      high: 72_377.57756358,
      low: 68_702.15370293,
      close: 70_681.22808943377,
      marketCap: 1_413_000_000_000,
      totalVolume: 47_657_767_940,
    });

    const tickerCount = db.db.select().from(coinTickers).all().length;
    expect(tickerCount).toBe(0);

    const exchangeCount = db.db.select().from(exchanges).all().length;
    expect(exchangeCount).toBe(0);
  });

  it('is idempotent', () => {
    seedStaticReferenceData(db);
    seedStaticReferenceData(db);

    const platformCount = db.db.select().from(assetPlatforms).all().length;
    expect(platformCount).toBe(3);
  });
});
