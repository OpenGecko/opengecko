import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOhlcvRuntime } from '../src/services/ohlcv-runtime';
import { runOhlcvWorkerJob } from '../src/jobs/run-ohlcv-worker';
import { summarizeOhlcvSyncStatus } from '../src/services/ohlcv-runtime';
import { createDatabase, migrateDatabase, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coins } from '../src/db/schema';
import { detectOhlcvGaps, getCanonicalCandles, upsertCanonicalOhlcvCandle } from '../src/services/candle-store';

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

describe('ohlcv runtime', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the ohlcv worker job entrypoint', async () => {
    const createOhlcvRuntime = vi.fn().mockReturnValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      tick: vi.fn().mockResolvedValue(undefined),
    });

    await runOhlcvWorkerJob({
      loadConfig: vi.fn().mockReturnValue({ databaseUrl: ':memory:', ccxtExchanges: ['binance'] }),
      createDatabase: vi.fn().mockReturnValue({ client: { close: vi.fn() } }),
      initializeDatabase: vi.fn(),
      createOhlcvRuntime,
      logger: logger as never,
    });

    expect(createOhlcvRuntime).toHaveBeenCalled();
  });

  it('prioritizes top100 recent catch-up before long-tail historical deepening', async () => {
    const syncRecentOhlcvWindow = vi.fn().mockResolvedValue([{ timestamp: Date.parse('2026-03-22T00:00:00.000Z') }]);
    const deepenHistoricalOhlcvWindow = vi.fn().mockResolvedValue([]);
    const leaseNextOhlcvTarget = vi.fn().mockReturnValue({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
    });
    const runtime = createOhlcvRuntime({} as never, { ccxtExchanges: ['binance'] }, logger, {
      refreshTargets: vi.fn().mockResolvedValue(undefined),
      leaseNextOhlcvTarget,
      syncRecentOhlcvWindow,
      deepenHistoricalOhlcvWindow,
      markOhlcvTargetSuccess: vi.fn(),
      markOhlcvTargetFailure: vi.fn(),
    });

    await runtime.tick(new Date('2026-03-23T00:00:00.000Z'));

    expect(syncRecentOhlcvWindow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ priorityTier: 'top100' }), expect.any(Date));
    expect(deepenHistoricalOhlcvWindow).not.toHaveBeenCalled();
  });

  it('deepens history only after recent coverage is current enough', async () => {
    const syncRecentOhlcvWindow = vi.fn().mockResolvedValue([]);
    const deepenHistoricalOhlcvWindow = vi.fn().mockResolvedValue([]);
    const leaseNextOhlcvTarget = vi.fn().mockReturnValue({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
    });
    const runtime = createOhlcvRuntime({} as never, { ccxtExchanges: ['binance'] }, logger, {
      refreshTargets: vi.fn().mockResolvedValue(undefined),
      leaseNextOhlcvTarget,
      syncRecentOhlcvWindow,
      deepenHistoricalOhlcvWindow,
      markOhlcvTargetSuccess: vi.fn(),
      markOhlcvTargetFailure: vi.fn(),
    });

    await runtime.tick(new Date('2026-03-23T00:00:00.000Z'));

    expect(syncRecentOhlcvWindow).toHaveBeenCalledTimes(1);
    expect(deepenHistoricalOhlcvWindow).toHaveBeenCalledTimes(1);
  });

  it('uses the runtime sync path to repair interior gaps once upstream eventually serves the missing window', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-ohlcv-runtime-'));
    const database: AppDatabase = createDatabase(join(tempDir, 'test.db'));

    try {
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

      for (const [timestamp, close] of [
        ['2026-03-18T00:00:00.000Z', 80_000],
        ['2026-03-20T00:00:00.000Z', 82_000],
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

      mockedFetchExchangeOHLCV.mockImplementation(async (_exchangeId, _symbol, _timeframe, since, limit) => {
        if (limit === undefined && since === Date.parse('2026-03-23T00:00:00.000Z')) {
          return [];
        }

        if (since === Date.parse('2026-03-21T00:00:00.000Z') && limit === 1) {
          return [
            {
              exchangeId: 'binance',
              symbol: 'BTC/USDT',
              timeframe: '1d',
              timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
              open: 83_000,
              high: 83_500,
              low: 82_500,
              close: 83_250,
              volume: 12,
              raw: [],
            },
          ];
        }

        if (since === Date.parse('2026-03-19T00:00:00.000Z') && limit === 2) {
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
            {
              exchangeId: 'binance',
              symbol: 'BTC/USDT',
              timeframe: '1d',
              timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
              open: 83_000,
              high: 83_500,
              low: 82_500,
              close: 83_250,
              volume: 12,
              raw: [],
            },
          ];
        }

        return [];
      });

      const leaseNextOhlcvTarget = vi.fn().mockReturnValue({
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: new Date('2026-03-18T00:00:00.000Z'),
        targetHistoryDays: 365,
      });
      const runtime = createOhlcvRuntime(database, { ccxtExchanges: ['binance'] }, logger, {
        refreshTargets: vi.fn().mockResolvedValue(undefined),
        leaseNextOhlcvTarget,
        markOhlcvTargetSuccess: vi.fn(),
        markOhlcvTargetFailure: vi.fn(),
      });

      expect(detectOhlcvGaps(database, 'bitcoin', 'usd', '1d')).toEqual([
        expect.objectContaining({
          gapEnd: new Date('2026-03-21T00:00:00.000Z'),
        }),
      ]);

      await runtime.tick(new Date('2026-03-23T00:00:00.000Z'));

      expect(detectOhlcvGaps(database, 'bitcoin', 'usd', '1d')).toEqual([]);
      expect(getCanonicalCandles(database, 'bitcoin', 'usd', '1d').map((row) => row.timestamp.toISOString())).toEqual(expect.arrayContaining([
        '2026-03-18T00:00:00.000Z',
        '2026-03-19T00:00:00.000Z',
        '2026-03-20T00:00:00.000Z',
        '2026-03-21T00:00:00.000Z',
        '2026-03-22T00:00:00.000Z',
      ]));
    } finally {
      database.client.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('continues from persisted cursors after restart', async () => {
    const syncRecentOhlcvWindow = vi.fn().mockResolvedValue([{ timestamp: Date.parse('2026-03-23T00:00:00.000Z') }]);
    const target = {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
    };
    const leaseNextOhlcvTarget = vi.fn().mockReturnValue(target);

    const runtime = createOhlcvRuntime({} as never, { ccxtExchanges: ['binance'] }, logger, {
      refreshTargets: vi.fn().mockResolvedValue(undefined),
      leaseNextOhlcvTarget,
      syncRecentOhlcvWindow,
      deepenHistoricalOhlcvWindow: vi.fn().mockResolvedValue([]),
      markOhlcvTargetSuccess: vi.fn(),
      markOhlcvTargetFailure: vi.fn(),
    });

    await runtime.tick(new Date('2026-03-24T00:00:00.000Z'));

    expect(syncRecentOhlcvWindow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ latestSyncedAt: new Date('2026-03-22T00:00:00.000Z') }), expect.any(Date));
  });

  it('leases the next eligible target after a restart when an earlier target is still in backoff', async () => {
    const firstTarget = {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
    };
    const secondTarget = {
      ...firstTarget,
      coinId: 'ethereum',
      symbol: 'ETH/USDT',
    };
    const leaseNextOhlcvTarget = vi.fn()
      .mockReturnValueOnce(firstTarget)
      .mockReturnValueOnce(secondTarget);
    const markOhlcvTargetFailure = vi.fn();
    const syncRecentOhlcvWindow = vi.fn()
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce([{ timestamp: Date.parse('2026-03-24T00:00:00.000Z') }]);

    const runtime = createOhlcvRuntime({} as never, { ccxtExchanges: ['binance'] }, logger, {
      refreshTargets: vi.fn().mockResolvedValue(undefined),
      leaseNextOhlcvTarget,
      syncRecentOhlcvWindow,
      deepenHistoricalOhlcvWindow: vi.fn().mockResolvedValue([]),
      markOhlcvTargetSuccess: vi.fn(),
      markOhlcvTargetFailure,
    });

    await runtime.tick(new Date('2026-03-23T00:00:00.000Z'));
    await runtime.tick(new Date('2026-03-24T00:00:00.000Z'));

    expect(markOhlcvTargetFailure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ coinId: 'bitcoin' }));
    expect(syncRecentOhlcvWindow).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ coinId: 'ethereum' }), expect.any(Date));
  });

  it('does not throw when target refresh fails', async () => {
    const leaseNextOhlcvTarget = vi.fn();
    const runtime = createOhlcvRuntime({} as never, { ccxtExchanges: ['binance'] }, logger, {
      refreshTargets: vi.fn().mockRejectedValue(new Error('ccxt timeout')),
      leaseNextOhlcvTarget,
      syncRecentOhlcvWindow: vi.fn(),
      deepenHistoricalOhlcvWindow: vi.fn(),
      markOhlcvTargetSuccess: vi.fn(),
      markOhlcvTargetFailure: vi.fn(),
    });

    await expect(runtime.tick(new Date('2026-03-23T00:00:00.000Z'))).resolves.toBeUndefined();

    expect(leaseNextOhlcvTarget).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { error: 'ccxt timeout' },
      'ohlcv target refresh failed',
    );
  });

  it('summarizes ohlcv worker lag and failure metrics', () => {
    const summary = summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => [
              {
                coinId: 'bitcoin',
                priorityTier: 'top100',
                status: 'idle',
                latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
                oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
                targetHistoryDays: 365,
                lastError: null,
              },
              {
                coinId: 'some-microcap',
                priorityTier: 'long_tail',
                status: 'failed',
                latestSyncedAt: null,
                oldestSyncedAt: null,
                targetHistoryDays: 365,
                lastError: 'rate limit',
              },
            ],
          }),
        }),
      },
    } as never, new Date('2026-03-23T00:00:00.000Z'));

    expect(summary.top100.ready).toBe(1);
    expect(summary.targets.failed).toBe(1);
    expect(summary.lag.oldest_recent_sync_ms).toBeGreaterThan(0);
    expect(summary.lag.oldest_historical_gap_ms).toBeGreaterThan(0);
  });

  it('reports freshness lag and backfill health counts in diagnostics summary', () => {
    const summary = summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => [
              {
                coinId: 'bitcoin',
                priorityTier: 'top100',
                status: 'idle',
                latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
                oldestSyncedAt: new Date('2025-12-23T00:00:00.000Z'),
                targetHistoryDays: 90,
                failureCount: 0,
                nextRetryAt: null,
              },
              {
                coinId: 'ethereum',
                priorityTier: 'top100',
                status: 'failed',
                latestSyncedAt: new Date('2026-03-20T00:00:00.000Z'),
                oldestSyncedAt: null,
                targetHistoryDays: 180,
                failureCount: 2,
                nextRetryAt: new Date('2026-03-23T00:10:00.000Z'),
              },
              {
                coinId: 'some-microcap',
                priorityTier: 'long_tail',
                status: 'running',
                latestSyncedAt: null,
                oldestSyncedAt: new Date('2026-03-15T00:00:00.000Z'),
                targetHistoryDays: 30,
                failureCount: 0,
                nextRetryAt: null,
              },
            ],
          }),
        }),
      },
    } as never, new Date('2026-03-23T00:00:00.000Z'));

    expect(summary.top100).toEqual({
      total: 2,
      ready: 1,
    });
    expect(summary.targets).toMatchObject({
      waiting: 1,
      running: 1,
      failed: 1,
    });
    expect(summary.lag).toMatchObject({
      oldest_recent_sync_ms: 3 * 24 * 60 * 60 * 1000,
    });
    expect(summary.backfill).toEqual({
      healthy: 1,
      behind: 2,
      retry_scheduled: 1,
      max_target_history_days: 180,
    });
  });
});
