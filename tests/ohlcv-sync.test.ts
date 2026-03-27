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

  it('deepens historical sync backward from oldestSyncedAt until target depth is reached', async () => {
    mockedFetchExchangeOHLCV.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2025-03-20T00:00:00.000Z'),
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
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(fetchExchangeOHLCV).toHaveBeenCalledWith('binance', 'BTC/USDT', '1d', Date.parse('2025-03-20T00:00:00.000Z'));

    const candles = getCanonicalCandles(database, 'bitcoin', 'usd', '1d', {
      from: Date.parse('2025-03-20T00:00:00.000Z'),
      to: Date.parse('2025-03-20T00:00:00.000Z'),
    });
    expect(candles[0]).toMatchObject({
      open: 60_000,
      close: 60_500,
      totalVolume: 900,
    });
  });
});
