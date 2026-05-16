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
      targetHistoryDays: 1825,
    }));
    expect(targets).toContainEqual(expect.objectContaining({
      coinId: 'litecoin',
      symbol: 'LTC/USD',
      priorityTier: 'long_tail',
      targetHistoryDays: 1825,
    }));
  });

  it('allows operators to override the default five-year history window per target refresh', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([
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
    ]);

    const targets = await buildOhlcvSyncTargets(database, ['binance'], new Set(['bitcoin']), {
      targetHistoryDays: 365,
    });

    expect(targets).toContainEqual(expect.objectContaining({
      coinId: 'bitcoin',
      symbol: 'BTC/USDT',
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

  it('derives requested priority and history depth from enabled ohlcv coverage targets', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([
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
    ]);

    const targets = await buildOhlcvSyncTargets(database, ['binance'], new Set(), {
      targetHistoryDays: 90,
      coverageTargets: [
        {
          family: 'ohlcv',
          provider: 'binance',
          entityType: 'coin',
          entityId: 'litecoin',
          interval: '1d',
          vsCurrency: 'usd',
          tier: 'B',
          targetHistoryDays: 730,
          freshnessSloSeconds: 86_400,
          productionFreshnessSloSeconds: 3_600,
          enabled: true,
          priority: 25,
        },
      ],
    });

    expect(targets).toEqual([
      expect.objectContaining({
        coinId: 'litecoin',
        exchangeId: 'binance',
        symbol: 'LTC/USDT',
        interval: '1d',
        priorityTier: 'requested',
        targetHistoryDays: 730,
      }),
    ]);
  });

  it('emits both daily and supported intraday targets for prioritized coverage requests', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([
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
    ]);

    const targets = await buildOhlcvSyncTargets(database, ['binance'], new Set(['bitcoin']), {
      targetHistoryDays: 90,
      coverageTargets: [
        {
          family: 'ohlcv',
          provider: 'binance',
          entityType: 'coin',
          entityId: 'bitcoin',
          interval: '1d',
          vsCurrency: 'usd',
          tier: 'S',
          targetHistoryDays: 365,
          freshnessSloSeconds: 86_400,
          productionFreshnessSloSeconds: 3_600,
          enabled: true,
          priority: 1,
        },
        {
          family: 'ohlcv',
          provider: 'binance',
          entityType: 'coin',
          entityId: 'bitcoin',
          interval: '1m',
          vsCurrency: 'usd',
          tier: 'S',
          targetHistoryDays: 7,
          freshnessSloSeconds: 300,
          productionFreshnessSloSeconds: 300,
          enabled: true,
          priority: 2,
        },
      ],
    });

    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        interval: '1d',
        priorityTier: 'top100',
        targetHistoryDays: 365,
      }),
      expect.objectContaining({
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        interval: '1m',
        priorityTier: 'top100',
        targetHistoryDays: 7,
      }),
    ]));
  });

  it('bridges default custom market chart intraday coverage targets into exchange-backed OHLCV targets', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([
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
    ]);

    const targets = await buildOhlcvSyncTargets(database, ['binance'], new Set(), {
      targetHistoryDays: 365,
      coverageTargets: [
        {
          family: 'market_charts',
          provider: 'custom',
          entityType: 'coin',
          entityId: 'bitcoin',
          interval: '1m',
          vsCurrency: 'usd',
          tier: 'S',
          targetHistoryDays: 30,
          freshnessSloSeconds: 300,
          productionFreshnessSloSeconds: 120,
          enabled: true,
          priority: 1010,
        },
      ],
    });

    expect(targets).toContainEqual(expect.objectContaining({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1m',
      priorityTier: 'requested',
      targetHistoryDays: 30,
    }));
  });
});
