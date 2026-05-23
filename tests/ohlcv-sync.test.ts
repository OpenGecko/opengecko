import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins, ohlcvSyncTargets } from '../src/db/schema';
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

  function seedLeasedTarget(values: Partial<typeof ohlcvSyncTargets.$inferInsert> = {}) {
    database.db.insert(ohlcvSyncTargets).values({
      coinId: values.coinId ?? 'bitcoin',
      exchangeId: values.exchangeId ?? 'binance',
      symbol: values.symbol ?? 'BTC/USDT',
      vsCurrency: values.vsCurrency ?? 'usd',
      interval: values.interval ?? '1d',
      priorityTier: values.priorityTier ?? 'top100',
      latestSyncedAt: values.latestSyncedAt ?? new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: values.oldestSyncedAt ?? new Date('2026-03-21T00:00:00.000Z'),
      targetHistoryDays: values.targetHistoryDays ?? 30,
      status: values.status ?? 'running',
      lastAttemptAt: values.lastAttemptAt ?? new Date('2026-03-22T23:55:00.000Z'),
      lastSuccessAt: values.lastSuccessAt ?? null,
      lastError: values.lastError ?? null,
      failureCount: values.failureCount ?? 0,
      nextRetryAt: values.nextRetryAt ?? null,
      lastRequestedAt: values.lastRequestedAt ?? null,
      leaseOwner: values.leaseOwner ?? 'worker-a',
      leaseToken: values.leaseToken ?? 'lease-a',
      leaseAcquiredAt: values.leaseAcquiredAt ?? new Date('2026-03-22T23:55:00.000Z'),
      leaseExpiresAt: values.leaseExpiresAt ?? new Date('2026-03-23T00:10:00.000Z'),
      leaseRecoveryCount: values.leaseRecoveryCount ?? 0,
      lastLeaseRecoveredAt: values.lastLeaseRecoveredAt ?? null,
      lastLeaseRecoveryReason: values.lastLeaseRecoveryReason ?? null,
      createdAt: values.createdAt ?? new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: values.updatedAt ?? new Date('2026-03-22T23:55:00.000Z'),
    }).onConflictDoNothing().run();
  }

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

  it('does not persist accepted candles after the worker lease is recovered by another owner', async () => {
    database.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();
    seedLeasedTarget();
    mockedFetchExchangeOHLCV.mockImplementation(async () => {
      database.client.prepare(`
        UPDATE ohlcv_sync_targets
        SET lease_owner = 'worker-b',
            lease_token = 'lease-b',
            lease_acquired_at = ?,
            lease_expires_at = ?,
            lease_recovery_count = lease_recovery_count + 1,
            last_lease_recovered_at = ?,
            last_lease_recovery_reason = 'expired_lease_deadline'
        WHERE coin_id = 'bitcoin'
      `).run(
        Date.parse('2026-03-23T00:00:00.000Z'),
        Date.parse('2026-03-23T00:15:00.000Z'),
        Date.parse('2026-03-23T00:00:00.000Z'),
      );

      return [
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
      ];
    });

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
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a',
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(result.rawFetchedCount).toBe(1);
    expect(result.acceptedCount).toBe(1);
    expect(result.persistedCount).toBe(0);
    expect(result).toEqual([]);
    expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1d')).toEqual([]);
  });

  it('does not persist accepted candles when provider work outlives the lease ttl without owner recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T00:00:00.000Z'));

    try {
      database.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();
      seedLeasedTarget({
        leaseExpiresAt: new Date('2026-03-23T00:00:30.000Z'),
      });
      mockedFetchExchangeOHLCV.mockImplementation(async () => {
        vi.setSystemTime(new Date('2026-03-23T00:01:00.000Z'));

        return [
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
        ];
      });

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
        leaseOwner: 'worker-a',
        leaseToken: 'lease-a',
      }, new Date('2026-03-23T00:00:00.000Z'));

      expect(result.rawFetchedCount).toBe(1);
      expect(result.acceptedCount).toBe(1);
      expect(result.persistedCount).toBe(0);
      expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1d')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not repair route-visible OHLCV gaps after lease recovery races', async () => {
    database.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();
    seedLeasedTarget({
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-18T00:00:00.000Z'),
    });
    for (const [timestamp, close] of [
      ['2026-03-18T00:00:00.000Z', 80_000],
      ['2026-03-20T00:00:00.000Z', 82_000],
    ] as const) {
      database.client.prepare(`
        INSERT INTO ohlcv_candles (
          coin_id, vs_currency, source, interval, timestamp, open, high, low, close, volume, market_cap, total_volume
        ) VALUES (?, 'usd', 'canonical', '1d', ?, ?, ?, ?, ?, 10, NULL, 10)
      `).run('bitcoin', Date.parse(timestamp), close, close + 100, close - 100, close);
    }
    mockedFetchExchangeOHLCV.mockImplementation(async (_exchangeId, _symbol, _timeframe, since, limit) => {
      if (limit === undefined && since === Date.parse('2026-03-23T00:00:00.000Z')) {
        return [];
      }

      database.client.prepare(`
        UPDATE ohlcv_sync_targets
        SET lease_owner = 'worker-b',
            lease_token = 'lease-b',
            lease_acquired_at = ?,
            lease_expires_at = ?,
            lease_recovery_count = lease_recovery_count + 1,
            last_lease_recovered_at = ?,
            last_lease_recovery_reason = 'expired_lease_deadline'
        WHERE coin_id = 'bitcoin'
      `).run(
        Date.parse('2026-03-23T00:00:00.000Z'),
        Date.parse('2026-03-23T00:15:00.000Z'),
        Date.parse('2026-03-23T00:00:00.000Z'),
      );

      return [
        {
          exchangeId: 'binance',
          symbol: 'BTC/USDT',
          timeframe: '1d',
          timestamp: Date.parse('2026-03-19T00:00:00.000Z'),
          open: 81_000,
          high: 81_500,
          low: 80_500,
          close: 81_250,
          volume: 11,
          raw: [],
        },
      ];
    });

    const result = await syncRecentOhlcvWindow(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-18T00:00:00.000Z'),
      targetHistoryDays: 30,
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a',
    }, new Date('2026-03-23T00:00:00.000Z'));

    expect(result.persistedCount).toBe(0);
    expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1d').map((row) => row.timestamp.toISOString())).toEqual([
      '2026-03-18T00:00:00.000Z',
      '2026-03-20T00:00:00.000Z',
    ]);
  });

  it('does not repair route-visible OHLCV gaps when gap repair work outlives the lease ttl without owner recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T00:00:00.000Z'));

    try {
      database.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();
      seedLeasedTarget({
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: new Date('2026-03-18T00:00:00.000Z'),
        leaseExpiresAt: new Date('2026-03-23T00:00:30.000Z'),
      });
      for (const [timestamp, close] of [
        ['2026-03-18T00:00:00.000Z', 80_000],
        ['2026-03-20T00:00:00.000Z', 82_000],
      ] as const) {
        database.client.prepare(`
          INSERT INTO ohlcv_candles (
            coin_id, vs_currency, source, interval, timestamp, open, high, low, close, volume, market_cap, total_volume
          ) VALUES (?, 'usd', 'canonical', '1d', ?, ?, ?, ?, ?, 10, NULL, 10)
        `).run('bitcoin', Date.parse(timestamp), close, close + 100, close - 100, close);
      }
      mockedFetchExchangeOHLCV.mockImplementation(async (_exchangeId, _symbol, _timeframe, since, limit) => {
        if (limit === undefined && since === Date.parse('2026-03-23T00:00:00.000Z')) {
          return [];
        }

        vi.setSystemTime(new Date('2026-03-23T00:01:00.000Z'));

        return [
          {
            exchangeId: 'binance',
            symbol: 'BTC/USDT',
            timeframe: '1d',
            timestamp: Date.parse('2026-03-19T00:00:00.000Z'),
            open: 81_000,
            high: 81_500,
            low: 80_500,
            close: 81_250,
            volume: 11,
            raw: [],
          },
        ];
      });

      const result = await syncRecentOhlcvWindow(database, {
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: new Date('2026-03-18T00:00:00.000Z'),
        targetHistoryDays: 30,
        leaseOwner: 'worker-a',
        leaseToken: 'lease-a',
      }, new Date('2026-03-23T00:00:00.000Z'));

      expect(result.persistedCount).toBe(0);
      expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1d').map((row) => row.timestamp.toISOString())).toEqual([
        '2026-03-18T00:00:00.000Z',
        '2026-03-20T00:00:00.000Z',
      ]);
    } finally {
      vi.useRealTimers();
    }
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
