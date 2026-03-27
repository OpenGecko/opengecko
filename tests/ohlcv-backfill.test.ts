import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins } from '../src/db/schema';
import { getCanonicalCandles } from '../src/services/candle-store';
import { runOhlcvBackfillOnce } from '../src/services/ohlcv-backfill';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeMarkets, fetchExchangeOHLCV } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;

const now = new Date();

const backfillCoins = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', apiSymbol: 'bitcoin' },
  { id: 'litecoin', symbol: 'ltc', name: 'Litecoin', apiSymbol: 'litecoin' },
];

describe('ohlcv backfill service', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-backfill-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    for (const coin of backfillCoins) {
      database.db.insert(coins).values({
        ...coin,
        hashingAlgorithm: null, blockTimeInMinutes: null,
        categoriesJson: '[]', descriptionJson: '{}', linksJson: '{}',
        imageThumbUrl: null, imageSmallUrl: null, imageLargeUrl: null,
        marketCapRank: null, genesisDate: null, platformsJson: '{}',
        status: 'active', createdAt: now, updatedAt: now,
      }).onConflictDoNothing().run();
    }
    rebuildSearchIndex(database);
    mockedFetchExchangeMarkets.mockReset();
    mockedFetchExchangeOHLCV.mockReset();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes fetched daily candles into the canonical store for dynamically discovered Binance pairs', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      if (exchangeId !== 'binance') {
        return [];
      }

      return [
        {
          exchangeId: 'binance',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          active: true,
          spot: true,
          baseName: 'Bitcoin',
          raw: {},
        },
        {
          exchangeId: 'binance',
          symbol: 'LTC/USDT',
          base: 'LTC',
          quote: 'USDT',
          active: true,
          spot: true,
          baseName: 'Litecoin',
          raw: {},
        },
      ];
    });
    mockedFetchExchangeOHLCV.mockImplementation(async (_exchangeId, symbol) => {
      if (symbol === 'BTC/USDT') {
        return [
          {
            exchangeId: 'binance',
            symbol: 'BTC/USDT',
            timeframe: '1d',
            timestamp: Date.parse('2026-03-19T00:00:00.000Z'),
            open: 81000,
            high: 82000,
            low: 80000,
            close: 81500,
            volume: 12345,
            raw: [0, 0, 0, 0, 0, 0],
          },
        ];
      }

      if (symbol === 'LTC/USDT') {
        return [
          {
            exchangeId: 'binance',
            symbol: 'LTC/USDT',
            timeframe: '1d',
            timestamp: Date.parse('2026-03-19T00:00:00.000Z'),
            open: 120,
            high: 126,
            low: 118,
            close: 124,
            volume: 4567,
            raw: [0, 0, 0, 0, 0, 0],
          },
        ];
      }

      return [];
    });

    await runOhlcvBackfillOnce(database, { ccxtExchanges: ['binance'] }, { lookbackDays: 30 });

    const bitcoinRows = getCanonicalCandles(database, 'bitcoin', 'usd', '1d', {
      from: Date.parse('2026-03-19T00:00:00.000Z'),
      to: Date.parse('2026-03-19T00:00:00.000Z'),
    });
    const litecoinRows = getCanonicalCandles(database, 'litecoin', 'usd', '1d', {
      from: Date.parse('2026-03-19T00:00:00.000Z'),
      to: Date.parse('2026-03-19T00:00:00.000Z'),
    });

    expect(bitcoinRows[0]).toMatchObject({
      open: 81000,
      high: 82000,
      low: 80000,
      close: 81500,
      totalVolume: 12345,
    });
    expect(litecoinRows[0]).toMatchObject({
      open: 120,
      high: 126,
      low: 118,
      close: 124,
      totalVolume: 4567,
    });
  });
});
