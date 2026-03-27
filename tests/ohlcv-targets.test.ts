import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins } from '../src/db/schema';
import { buildOhlcvSyncTargets } from '../src/services/ohlcv-targets';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeMarkets } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;

describe('ohlcv targets', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-ohlcv-targets-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);

    database.db.insert(coins).values([
      {
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
      },
      {
        id: 'litecoin',
        symbol: 'ltc',
        name: 'Litecoin',
        apiSymbol: 'litecoin',
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: '{}',
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: 200,
        genesisDate: null,
        platformsJson: '{}',
        status: 'active',
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
      },
    ]).onConflictDoNothing().run();

    mockedFetchExchangeMarkets.mockReset();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('prefers USDT over USD and marks top-100 targets first', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      if (exchangeId !== 'binance') {
        return [];
      }

      return [
        {
          exchangeId: 'binance',
          symbol: 'BTC/USD',
          base: 'BTC',
          quote: 'USD',
          active: true,
          spot: true,
          baseName: 'Bitcoin',
          raw: {},
        },
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
          symbol: 'LTC/USD',
          base: 'LTC',
          quote: 'USD',
          active: true,
          spot: true,
          baseName: 'Litecoin',
          raw: {},
        },
      ];
    });

    const targets = await buildOhlcvSyncTargets(database, ['binance'], new Set(['bitcoin']));

    expect(targets).toContainEqual(expect.objectContaining({
      coinId: 'bitcoin',
      symbol: 'BTC/USDT',
      priorityTier: 'top100',
      targetHistoryDays: 365,
    }));
    expect(targets).toContainEqual(expect.objectContaining({
      coinId: 'litecoin',
      symbol: 'LTC/USD',
      priorityTier: 'long_tail',
      targetHistoryDays: 365,
    }));
  });

  it('continues building targets when one exchange market fetch fails', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') {
        throw new Error('timeout');
      }

      if (exchangeId === 'okx') {
        return [
          {
            exchangeId: 'okx',
            symbol: 'BTC/USDT',
            base: 'BTC',
            quote: 'USDT',
            active: true,
            spot: true,
            baseName: 'Bitcoin',
            raw: {},
          },
        ];
      }

      return [];
    });

    await expect(buildOhlcvSyncTargets(database, ['binance', 'okx'], new Set(['bitcoin']))).resolves.toContainEqual(
      expect.objectContaining({
        coinId: 'bitcoin',
        exchangeId: 'okx',
        symbol: 'BTC/USDT',
        priorityTier: 'top100',
      }),
    );
  });
});
