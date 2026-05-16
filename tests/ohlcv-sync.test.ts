import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins } from '../src/db/schema';
import { getCanonicalCandles } from '../src/services/candle-store';
import { deepenHistoricalOhlcvWindow, syncRecentOhlcvWindow } from '../src/services/ohlcv-sync';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeOHLCV } from '../src/providers/ccxt';

const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('ohlcv sync units', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-ohlcv-sync-'));
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

    mockedFetchExchangeOHLCV.mockReset();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('continues recent sync from latestSyncedAt instead of refetching a full year', async () => {
    mockedFetchExchangeOHLCV.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2026-03-22T00:00:00.000Z'),
        open: 82_000,
        high: 83_000,
        low: 81_000,
        close: 82_500,
        volume: 1_200,
        raw: [0, 0, 0, 0, 0, 0],
      },
    ]);

    await syncRecentOhlcvWindow(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(fetchExchangeOHLCV).toHaveBeenCalledWith('binance', 'BTC/USDT', '1d', Date.parse('2026-03-22T00:00:00.000Z'));
  });

  it('deepens historical sync backward from oldestSyncedAt in provider-safe chunks', async () => {
    const oldestSyncedAt = Date.parse('2025-03-22T00:00:00.000Z');
    const expectedSince = oldestSyncedAt - 182 * DAY_MS;
    mockedFetchExchangeOHLCV.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: expectedSince,
        open: 60_000,
        high: 61_000,
        low: 59_500,
        close: 60_500,
        volume: 900,
        raw: [0, 0, 0, 0, 0, 0],
      },
    ]);

    await deepenHistoricalOhlcvWindow(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date(oldestSyncedAt),
      targetHistoryDays: 730,
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(fetchExchangeOHLCV).toHaveBeenCalledWith('binance', 'BTC/USDT', '1d', expectedSince, 182);

    const candles = getCanonicalCandles(database, 'bitcoin', 'usd', '1d', {
      from: expectedSince,
      to: expectedSince,
    });
    expect(candles[0]).toMatchObject({
      open: 60_000,
      close: 60_500,
      totalVolume: 900,
    });
  });

  it('skips historical deepening when the target history window is already covered', async () => {
    const result = await deepenHistoricalOhlcvWindow(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-20T00:00:00.000Z'),
      targetHistoryDays: 365,
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(result).toEqual([]);
    expect(fetchExchangeOHLCV).not.toHaveBeenCalled();
  });

  it('syncs and persists supported intraday targets without coercing them to daily candles', async () => {
    mockedFetchExchangeOHLCV.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1m',
        timestamp: Date.parse('2026-03-22T00:01:00.000Z'),
        open: 82_000,
        high: 82_050,
        low: 81_950,
        close: 82_025,
        volume: 12,
        raw: [0, 0, 0, 0, 0, 0],
      },
    ]);

    await syncRecentOhlcvWindow(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1m',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      targetHistoryDays: 7,
    }, new Date('2026-03-22T00:02:00.000Z'));

    expect(fetchExchangeOHLCV).toHaveBeenCalledWith(
      'binance',
      'BTC/USDT',
      '1m',
      Date.parse('2026-03-22T00:01:00.000Z'),
    );
    expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1m')).toEqual([
      expect.objectContaining({
        timestamp: new Date('2026-03-22T00:01:00.000Z'),
        close: 82_025,
      }),
    ]);
    expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1d', {
      from: Date.parse('2026-03-22T00:01:00.000Z'),
      to: Date.parse('2026-03-22T00:01:00.000Z'),
    })).toEqual([]);
  });

  it('bounds never-synced 1m recent fetches to a near-current provider window', async () => {
    mockedFetchExchangeOHLCV.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1m',
        timestamp: Date.parse('2026-03-22T23:59:00.000Z'),
        open: 82_000,
        high: 82_050,
        low: 81_950,
        close: 82_025,
        volume: 12,
        raw: [0, 0, 0, 0, 0, 0],
      },
    ]);

    await syncRecentOhlcvWindow(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1m',
      priorityTier: 'top100',
      latestSyncedAt: null,
      oldestSyncedAt: null,
      targetHistoryDays: 30,
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(fetchExchangeOHLCV).toHaveBeenCalledWith(
      'binance',
      'BTC/USDT',
      '1m',
      Date.parse('2026-03-22T23:00:00.000Z'),
      60,
    );
    expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1m')).toEqual([
      expect.objectContaining({
        timestamp: new Date('2026-03-22T23:59:00.000Z'),
        close: 82_025,
      }),
    ]);
  });

  it('filters malformed provider OHLCV rows before persistence', async () => {
    database.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();
    mockedFetchExchangeOHLCV.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2026-03-22T00:00:00.000Z'),
        open: 82_000,
        high: 81_000,
        low: 83_000,
        close: 82_500,
        volume: 1_200,
        raw: [0, 0, 0, 0, 0, 0],
      },
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2026-03-23T00:00:00.000Z'),
        open: 83_000,
        high: 84_000,
        low: 82_000,
        close: 83_500,
        volume: 1_300,
        raw: [0, 0, 0, 0, 0, 0],
      },
    ]);

    const result = await syncRecentOhlcvWindow(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      targetHistoryDays: 30,
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(result.rawFetchedCount).toBe(2);
    expect(result.acceptedCount).toBe(1);
    expect(result.persistedCount).toBe(1);
    expect(result.map((candle) => candle.timestamp)).toEqual([Date.parse('2026-03-23T00:00:00.000Z')]);
    expect(result.acceptedCandles.map((candle) => candle.timestamp)).toEqual([Date.parse('2026-03-23T00:00:00.000Z')]);
    expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1d')).toEqual([
      expect.objectContaining({
        timestamp: new Date('2026-03-23T00:00:00.000Z'),
        close: 83_500,
      }),
    ]);
  });

  it('returns no accepted recent candles when every provider OHLCV row is malformed', async () => {
    database.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();
    mockedFetchExchangeOHLCV.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2026-03-22T00:00:00.000Z'),
        open: 82_000,
        high: 81_000,
        low: 83_000,
        close: 82_500,
        volume: 1_200,
        raw: [0, 0, 0, 0, 0, 0],
      },
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2026-03-23T00:00:00.000Z'),
        open: 83_000,
        high: 84_000,
        low: 82_000,
        close: 85_000,
        volume: 1_300,
        raw: [0, 0, 0, 0, 0, 0],
      },
    ]);

    const result = await syncRecentOhlcvWindow(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      targetHistoryDays: 30,
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(result).toEqual([]);
    expect(result.rawFetchedCount).toBe(2);
    expect(result.acceptedCount).toBe(0);
    expect(result.persistedCount).toBe(0);
    expect(result.acceptedCandles).toEqual([]);
    expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1d')).toEqual([]);
  });

  it('returns historical cursor candidates from persisted-valid rows only', async () => {
    const malformedTimestamp = Date.parse('2025-09-22T00:00:00.000Z');
    const validTimestamp = Date.parse('2025-09-23T00:00:00.000Z');
    mockedFetchExchangeOHLCV.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: malformedTimestamp,
        open: 60_000,
        high: 59_000,
        low: 61_000,
        close: 60_500,
        volume: 900,
        raw: [0, 0, 0, 0, 0, 0],
      },
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: validTimestamp,
        open: 61_000,
        high: 62_000,
        low: 60_500,
        close: 61_500,
        volume: 950,
        raw: [0, 0, 0, 0, 0, 0],
      },
    ]);

    const result = await deepenHistoricalOhlcvWindow(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(result.rawFetchedCount).toBe(2);
    expect(result.acceptedCount).toBe(1);
    expect(result[0]?.timestamp).toBe(validTimestamp);
    expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1d', {
      from: malformedTimestamp,
      to: validTimestamp,
    }).map((candle) => candle.timestamp.toISOString())).toEqual(['2025-09-23T00:00:00.000Z']);
  });
});
