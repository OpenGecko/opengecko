import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins } from '../src/db/schema';
import { getCanonicalCandles, upsertCanonicalOhlcvCandle } from '../src/services/candle-store';
import { detectOhlcvGaps, enforceOhlcvRetention, repairOhlcvGaps } from '../src/services/ohlcv-sync';

describe('ohlcv gap detection and repair', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-ohlcv-gap-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);

    database.db.insert(coins).values({
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
    }).onConflictDoNothing().run();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('identifies interior missing windows with correct boundaries and slot counts', () => {
    for (const timestamp of [
      '2026-03-18T00:00:00.000Z',
      '2026-03-19T00:00:00.000Z',
      '2026-03-22T00:00:00.000Z',
      '2026-03-24T00:00:00.000Z',
    ]) {
      upsertCanonicalOhlcvCandle(database, {
        coinId: 'bitcoin',
        vsCurrency: 'usd',
        interval: '1d',
        timestamp: new Date(timestamp),
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        replaceExisting: true,
      });
    }

    const gaps = detectOhlcvGaps(database, 'bitcoin', 'usd', '1d');

    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({
      gapStart: new Date('2026-03-21T00:00:00.000Z'),
      gapEnd: new Date('2026-03-21T00:00:00.000Z'),
      missingSlotCount: 1,
    });
    expect(gaps[0]?.missingTimestamps.map((value) => value.toISOString())).toEqual(['2026-03-21T00:00:00.000Z']);
    expect(gaps[1]).toMatchObject({
      gapStart: new Date('2026-03-23T00:00:00.000Z'),
      gapEnd: new Date('2026-03-23T00:00:00.000Z'),
      missingSlotCount: 1,
    });
  });

  it('repairs gaps by fetching and persisting missing candles so re-detection is clean', async () => {
    for (const [timestamp, close] of [
      ['2026-03-18T00:00:00.000Z', 80_000],
      ['2026-03-19T00:00:00.000Z', 81_000],
      ['2026-03-22T00:00:00.000Z', 84_000],
    ] as const) {
      upsertCanonicalOhlcvCandle(database, {
        coinId: 'bitcoin',
        vsCurrency: 'usd',
        interval: '1d',
        timestamp: new Date(timestamp),
        open: close,
        high: close + 500,
        low: close - 500,
        close,
        volume: 10,
        replaceExisting: true,
      });
    }

    const fetchCandles = vi.fn(async (since: number) => {
      if (since === Date.parse('2026-03-21T00:00:00.000Z')) {
        return [
          {
            timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
            open: 83_000,
            high: 83_500,
            low: 82_500,
            close: 83_250,
            volume: 12,
          },
        ];
      }

      return [];
    });

    const result = await repairOhlcvGaps(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
    }, fetchCandles);

    expect(fetchCandles).toHaveBeenCalledWith(Date.parse('2026-03-21T00:00:00.000Z'), 1);
    expect(result).toMatchObject({
      gapsRepaired: 1,
      candlesRepaired: 1,
    });
    expect(detectOhlcvGaps(database, 'bitcoin', 'usd', '1d')).toEqual([]);

    const candles = getCanonicalCandles(database, 'bitcoin', 'usd', '1d', {
      from: Date.parse('2026-03-18T00:00:00.000Z'),
      to: Date.parse('2026-03-22T00:00:00.000Z'),
    });
    expect(candles.map((row) => row.timestamp.toISOString())).toEqual([
      '2026-03-18T00:00:00.000Z',
      '2026-03-19T00:00:00.000Z',
      '2026-03-20T00:00:00.000Z',
      '2026-03-21T00:00:00.000Z',
      '2026-03-22T00:00:00.000Z',
    ]);
  });

  it('prunes candles older than the configured retention window', () => {
    for (let index = 0; index < 500; index += 1) {
      const timestamp = new Date(Date.parse('2026-03-27T00:00:00.000Z') - ((499 - index) * 24 * 60 * 60 * 1000));
      const price = 50_000 + index;
      upsertCanonicalOhlcvCandle(database, {
        coinId: 'bitcoin',
        vsCurrency: 'usd',
        interval: '1d',
        timestamp,
        open: price,
        high: price,
        low: price,
        close: price,
        replaceExisting: true,
      });
    }

    const removed = enforceOhlcvRetention(database, {
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
      retentionDays: 365,
      now: new Date('2026-03-27T00:00:00.000Z'),
    });

    expect(removed).toBeGreaterThan(0);
    const remaining = getCanonicalCandles(database, 'bitcoin', 'usd', '1d');
    expect(remaining[0]?.timestamp.toISOString()).toBe('2025-03-28T00:00:00.000Z');
    expect(remaining).toHaveLength(365);
  });
});
