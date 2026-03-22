import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq, count } from 'drizzle-orm';
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

  it('seeds static reference data without market data', () => {
    seedStaticReferenceData(db);

    // Minimal coins are seeded for FK references (treasury, chartPoints)
    const coinCount = db.db.select({ value: count() }).from(coins).all()[0].value;
    expect(coinCount).toBe(8);

    const platformCount = db.db.select({ value: count() }).from(assetPlatforms).all()[0].value;
    expect(platformCount).toBe(3);

    const categoryCount = db.db.select({ value: count() }).from(categories).all()[0].value;
    expect(categoryCount).toBe(2);

    const treasuryCount = db.db.select({ value: count() }).from(treasuryEntities).all()[0].value;
    expect(treasuryCount).toBe(2);

    // Market data (snapshots, candles, tickers, exchanges) should NOT be seeded
    const snapshotCount = db.db.select({ value: count() }).from(marketSnapshots).all()[0].value;
    expect(snapshotCount).toBe(0);

    const candleCount = db.db.select({ value: count() }).from(ohlcvCandles).all()[0].value;
    expect(candleCount).toBe(0);

    const tickerCount = db.db.select({ value: count() }).from(coinTickers).all()[0].value;
    expect(tickerCount).toBe(0);

    const exchangeCount = db.db.select({ value: count() }).from(exchanges).all()[0].value;
    expect(exchangeCount).toBe(0);
  });

  it('is idempotent', () => {
    seedStaticReferenceData(db);
    seedStaticReferenceData(db);

    const platformCount = db.db.select({ value: count() }).from(assetPlatforms).all()[0].value;
    expect(platformCount).toBe(3);
  });
});
