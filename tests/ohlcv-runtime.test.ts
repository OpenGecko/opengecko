import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOhlcvRuntime } from '../src/services/ohlcv-runtime';
import { runOhlcvWorkerJob } from '../src/jobs/run-ohlcv-worker';
import { summarizeOhlcvSyncStatus } from '../src/services/ohlcv-runtime';
import { createDatabase, migrateDatabase, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coins, ohlcvSyncTargets } from '../src/db/schema';
import { detectOhlcvGaps, getCanonicalCandles, upsertCanonicalOhlcvCandle } from '../src/services/candle-store';

const DAY_MS = 24 * 60 * 60 * 1000;

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

  it('does not advance target freshness when every provider candle is filtered before persistence', async () => {
    const syncRecentOhlcvWindow = vi.fn().mockResolvedValue([]);
    const deepenHistoricalOhlcvWindow = vi.fn().mockResolvedValue([]);
    const markOhlcvTargetSuccess = vi.fn();
    const leaseNextOhlcvTarget = vi.fn().mockReturnValue({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      targetHistoryDays: 30,
    });
    const runtime = createOhlcvRuntime({} as never, { ccxtExchanges: ['binance'] }, logger, {
      refreshTargets: vi.fn().mockResolvedValue(undefined),
      leaseNextOhlcvTarget,
      syncRecentOhlcvWindow,
      deepenHistoricalOhlcvWindow,
      markOhlcvTargetSuccess,
      markOhlcvTargetFailure: vi.fn(),
    });

    await runtime.tick(new Date('2026-03-23T00:00:00.000Z'));

    expect(markOhlcvTargetSuccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
    }));
  });

  it('advances target freshness using the latest persisted-valid candle rather than the raw provider tail', async () => {
    const syncRecentOhlcvWindow = vi.fn().mockResolvedValue([
      { timestamp: Date.parse('2026-03-22T00:00:00.000Z') },
    ]);
    const deepenHistoricalOhlcvWindow = vi.fn().mockResolvedValue([]);
    const markOhlcvTargetSuccess = vi.fn();
    const leaseNextOhlcvTarget = vi.fn().mockReturnValue({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      targetHistoryDays: 30,
    });
    const runtime = createOhlcvRuntime({} as never, { ccxtExchanges: ['binance'] }, logger, {
      refreshTargets: vi.fn().mockResolvedValue(undefined),
      leaseNextOhlcvTarget,
      syncRecentOhlcvWindow,
      deepenHistoricalOhlcvWindow,
      markOhlcvTargetSuccess,
      markOhlcvTargetFailure: vi.fn(),
    });

    await runtime.tick(new Date('2026-03-23T00:00:00.000Z'));

    expect(markOhlcvTargetSuccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
    }));
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

  it('retries due failed targets and clears retry diagnostics after success', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-ohlcv-runtime-retry-'));
    const database: AppDatabase = createDatabase(join(tempDir, 'test.db'));
    const now = new Date('2026-03-23T00:00:00.000Z');

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
      database.db.insert(ohlcvSyncTargets).values({
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        latestSyncedAt: null,
        oldestSyncedAt: null,
        targetHistoryDays: 365,
        status: 'failed',
        lastAttemptAt: new Date('2026-03-22T23:54:00.000Z'),
        lastSuccessAt: null,
        lastError: 'rate limit',
        failureCount: 1,
        nextRetryAt: new Date('2026-03-22T23:59:00.000Z'),
        lastRequestedAt: null,
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T23:54:00.000Z'),
      }).run();

      expect(summarizeOhlcvSyncStatus(database, now).history.retry_recovery_counts).toEqual({
        due: 1,
        backoff: 0,
      });

      const runtime = createOhlcvRuntime(database, { ccxtExchanges: ['binance'] }, logger, {
        refreshTargets: vi.fn().mockResolvedValue(undefined),
        syncRecentOhlcvWindow: vi.fn().mockResolvedValue([{ timestamp: now.getTime() }]),
        deepenHistoricalOhlcvWindow: vi.fn().mockResolvedValue([]),
      });

      await runtime.tick(now);

      const row = database.db.select().from(ohlcvSyncTargets).all()[0];
      expect(row.status).toBe('idle');
      expect(row.failureCount).toBe(0);
      expect(row.lastError).toBeNull();
      expect(row.nextRetryAt).toBeNull();
      expect(summarizeOhlcvSyncStatus(database, now).history.retry_recovery_counts).toEqual({
        due: 0,
        backoff: 0,
      });
    } finally {
      database.client.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
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
                exchangeId: 'binance',
                symbol: 'SMC/USDT',
                vsCurrency: 'usd',
                interval: '1d',
                priorityTier: 'long_tail',
                status: 'failed',
                latestSyncedAt: null,
                oldestSyncedAt: null,
                targetHistoryDays: 365,
                lastError: 'rate limit',
                failureCount: 1,
                nextRetryAt: new Date('2026-03-23T00:05:00.000Z'),
                lastAttemptAt: new Date('2026-03-23T00:00:00.000Z'),
                lastSuccessAt: null,
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
    expect(summary.history).toMatchObject({
      target_depth_days: 365,
      desired_oldest_at: '2025-03-23T00:00:00.000Z',
      oldest_covered_at: '2025-03-22T00:00:00.000Z',
      newest_covered_at: '2026-03-22T00:00:00.000Z',
      targets_with_any_history: 1,
      targets_at_target_depth: 1,
    });
    expect(summary.history.by_tier.top100).toMatchObject({
      total: 1,
      with_any_history: 1,
      at_target_depth: 1,
      oldest_covered_at: '2025-03-22T00:00:00.000Z',
      remaining_depth_days: 0,
      estimated_remaining_chunks: 0,
      depth_status_counts: {
        complete: 1,
        catching_up: 0,
        blocked: 0,
      },
      retry_recovery_counts: {
        due: 0,
        backoff: 0,
      },
      retry_starvation_counts: {
        starved: 0,
      },
    });
    expect(summary.history.by_tier.long_tail).toMatchObject({
      total: 1,
      with_any_history: 0,
      at_target_depth: 0,
      oldest_covered_at: null,
      remaining_depth_days: 365,
      estimated_remaining_chunks: 3,
      depth_status_counts: {
        complete: 0,
        catching_up: 0,
        blocked: 1,
      },
      retry_recovery_counts: {
        due: 0,
        backoff: 1,
      },
      retry_starvation_counts: {
        starved: 0,
      },
    });
    expect(summary.history.depth_status_counts).toEqual({
      complete: 1,
      catching_up: 0,
      blocked: 1,
    });
    expect(summary.history.retry_recovery_counts).toEqual({
      due: 0,
      backoff: 1,
    });
    expect(summary.history.retry_starvation_counts).toEqual({
      starved: 0,
    });
    expect(summary.history.retry_starvation_thresholds).toEqual({
      due_age_seconds: 120,
    });
    expect(summary.history.queue_priority_summary).toEqual({
      totals: {
        eligible_for_lease: 1,
        retry_due_failed: 0,
        retry_backoff_failed: 1,
        incomplete_depth: 1,
        complete_depth: 1,
        running: 0,
        starved_retry_due: 0,
      },
      by_tier: {
        top100: {
          eligible_for_lease: 1,
          retry_due_failed: 0,
          retry_backoff_failed: 0,
          incomplete_depth: 0,
          complete_depth: 1,
          running: 0,
          starved_retry_due: 0,
        },
        requested: {
          eligible_for_lease: 0,
          retry_due_failed: 0,
          retry_backoff_failed: 0,
          incomplete_depth: 0,
          complete_depth: 0,
          running: 0,
          starved_retry_due: 0,
        },
        long_tail: {
          eligible_for_lease: 0,
          retry_due_failed: 0,
          retry_backoff_failed: 1,
          incomplete_depth: 1,
          complete_depth: 0,
          running: 0,
          starved_retry_due: 0,
        },
      },
    });
    expect(summary.history.depth_alert_thresholds).toEqual({
      complete_remaining_depth_days: 0,
      catching_up_min_remaining_depth_days: 1,
      blocked_statuses: ['failed'],
    });
    expect(summary.history.completion_estimate).toEqual({
      chunk_days: 180,
      overlap_days: 2,
      targets_incomplete: 1,
      remaining_depth_days: 365,
      estimated_remaining_chunks: 3,
      max_remaining_depth_days: 365,
    });
    expect(summary.history.blocked_target_samples.long_tail).toEqual([
      expect.objectContaining({
        coin_id: 'some-microcap',
        exchange_id: 'binance',
        symbol: 'SMC/USDT',
        failure_count: 1,
        next_retry_at: '2026-03-23T00:05:00.000Z',
        retry_in_seconds: 300,
        last_attempt_at: '2026-03-23T00:00:00.000Z',
        last_success_at: null,
        last_error: 'rate limit',
      }),
    ]);
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
                exchangeId: 'binance',
                symbol: 'ETH/USDT',
                vsCurrency: 'usd',
                interval: '1d',
                priorityTier: 'top100',
                status: 'failed',
                latestSyncedAt: new Date('2026-03-20T00:00:00.000Z'),
                oldestSyncedAt: null,
                targetHistoryDays: 180,
                failureCount: 2,
                nextRetryAt: new Date('2026-03-23T00:10:00.000Z'),
                lastAttemptAt: new Date('2026-03-23T00:00:00.000Z'),
                lastSuccessAt: new Date('2026-03-20T00:00:00.000Z'),
                lastError: 'binance GET https://adapter.example/fetch?api_key=secret-token&symbol=ETH failed',
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
                lastAttemptAt: new Date('2026-03-23T00:00:00.000Z'),
                leaseOwner: 'worker-a',
                leaseToken: 'lease-a',
                leaseAcquiredAt: new Date('2026-03-23T00:00:00.000Z'),
                leaseExpiresAt: new Date('2026-03-23T00:15:00.000Z'),
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
    expect(summary.history).toEqual({
      target_depth_days: 180,
      desired_oldest_at: new Date(Date.parse('2026-03-23T00:00:00.000Z') - 180 * DAY_MS).toISOString(),
      oldest_covered_at: '2025-12-23T00:00:00.000Z',
      newest_covered_at: '2026-03-22T00:00:00.000Z',
      targets_with_any_history: 2,
      targets_at_target_depth: 1,
      by_tier: {
        top100: {
          total: 2,
          target_depth_days: 180,
          with_any_history: 1,
          at_target_depth: 1,
          oldest_covered_at: '2025-12-23T00:00:00.000Z',
          coverage_ratio: 0.333333,
          slo_status: 'blocked',
          remaining_depth_days: 180,
          estimated_remaining_chunks: 1,
          depth_status_counts: {
            complete: 1,
            catching_up: 0,
            blocked: 1,
          },
          retry_recovery_counts: {
            due: 0,
            backoff: 1,
          },
          retry_starvation_counts: {
            starved: 0,
          },
        },
        requested: {
          total: 0,
          target_depth_days: 0,
          with_any_history: 0,
          at_target_depth: 0,
          oldest_covered_at: null,
          coverage_ratio: 1,
          slo_status: 'complete',
          remaining_depth_days: 0,
          estimated_remaining_chunks: 0,
          depth_status_counts: {
            complete: 0,
            catching_up: 0,
            blocked: 0,
          },
          retry_recovery_counts: {
            due: 0,
            backoff: 0,
          },
          retry_starvation_counts: {
            starved: 0,
          },
        },
        long_tail: {
          total: 1,
          target_depth_days: 30,
          with_any_history: 1,
          at_target_depth: 0,
          oldest_covered_at: '2026-03-15T00:00:00.000Z',
          coverage_ratio: 0.266667,
          slo_status: 'catching_up',
          remaining_depth_days: 22,
          estimated_remaining_chunks: 1,
          depth_status_counts: {
            complete: 0,
            catching_up: 1,
            blocked: 0,
          },
          retry_recovery_counts: {
            due: 0,
            backoff: 0,
          },
          retry_starvation_counts: {
            starved: 0,
          },
        },
      },
      depth_status_counts: {
        complete: 1,
        catching_up: 1,
        blocked: 1,
      },
      retry_recovery_counts: {
        due: 0,
        backoff: 1,
      },
      retry_starvation_counts: {
        starved: 0,
      },
      retry_starvation_thresholds: {
        due_age_seconds: 120,
      },
      queue_priority_summary: {
        totals: {
          eligible_for_lease: 1,
          retry_due_failed: 0,
          retry_backoff_failed: 1,
          incomplete_depth: 2,
          complete_depth: 1,
          running: 1,
          starved_retry_due: 0,
        },
        by_tier: {
          top100: {
            eligible_for_lease: 1,
            retry_due_failed: 0,
            retry_backoff_failed: 1,
            incomplete_depth: 1,
            complete_depth: 1,
            running: 0,
            starved_retry_due: 0,
          },
          requested: {
            eligible_for_lease: 0,
            retry_due_failed: 0,
            retry_backoff_failed: 0,
            incomplete_depth: 0,
            complete_depth: 0,
            running: 0,
            starved_retry_due: 0,
          },
          long_tail: {
            eligible_for_lease: 0,
            retry_due_failed: 0,
            retry_backoff_failed: 0,
            incomplete_depth: 1,
            complete_depth: 0,
            running: 1,
            starved_retry_due: 0,
          },
        },
      },
      depth_alert_thresholds: {
        complete_remaining_depth_days: 0,
        catching_up_min_remaining_depth_days: 1,
        blocked_statuses: ['failed'],
      },
      completion_estimate: {
        chunk_days: 180,
        overlap_days: 2,
        targets_incomplete: 2,
        remaining_depth_days: 202,
        estimated_remaining_chunks: 2,
        max_remaining_depth_days: 180,
      },
      most_behind_samples: {
        top100: [
          {
            coin_id: 'ethereum',
            exchange_id: 'binance',
            symbol: 'ETH/USDT',
            vs_currency: 'usd',
            interval: '1d',
            status: 'failed',
            target_history_days: 180,
            oldest_synced_at: null,
            latest_synced_at: '2026-03-20T00:00:00.000Z',
            remaining_depth_days: 180,
            estimated_remaining_chunks: 1,
          },
        ],
        requested: [],
        long_tail: [
          {
            coin_id: 'some-microcap',
            exchange_id: undefined,
            symbol: undefined,
            vs_currency: undefined,
            interval: undefined,
            status: 'running',
            target_history_days: 30,
            oldest_synced_at: '2026-03-15T00:00:00.000Z',
            latest_synced_at: null,
            remaining_depth_days: 22,
            estimated_remaining_chunks: 1,
          },
        ],
      },
      blocked_target_samples: {
        top100: [
          {
            coin_id: 'ethereum',
            exchange_id: 'binance',
            symbol: 'ETH/USDT',
            vs_currency: 'usd',
            interval: '1d',
            status: 'failed',
            target_history_days: 180,
            oldest_synced_at: null,
            latest_synced_at: '2026-03-20T00:00:00.000Z',
            remaining_depth_days: 180,
            estimated_remaining_chunks: 1,
            failure_count: 2,
            next_retry_at: '2026-03-23T00:10:00.000Z',
            retry_in_seconds: 600,
            last_attempt_at: '2026-03-23T00:00:00.000Z',
            last_success_at: '2026-03-20T00:00:00.000Z',
            last_error: 'binance GET https://adapter.example/fetch?redacted failed',
          },
        ],
        requested: [],
        long_tail: [],
      },
    });
  });

  it('estimates fewer remaining historical chunks as oldest coverage approaches target depth', () => {
    const now = new Date('2026-03-23T00:00:00.000Z');
    const baseTarget = {
      coinId: 'bitcoin',
      priorityTier: 'top100',
      status: 'idle',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
      failureCount: 0,
      nextRetryAt: null,
    };
    const summarizeWithOldest = (oldestSyncedAt: Date | null) => summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => [{
              ...baseTarget,
              oldestSyncedAt,
            }],
          }),
        }),
      },
    } as never, now);

    const shallowCoverage = summarizeWithOldest(new Date('2026-02-01T00:00:00.000Z'));
    const deeperCoverage = summarizeWithOldest(new Date('2025-07-01T00:00:00.000Z'));
    const completeCoverage = summarizeWithOldest(new Date('2025-03-22T00:00:00.000Z'));

    expect(shallowCoverage.history.completion_estimate).toMatchObject({
      targets_incomplete: 1,
      remaining_depth_days: 315,
      estimated_remaining_chunks: 2,
      max_remaining_depth_days: 315,
    });
    expect(deeperCoverage.history.completion_estimate).toMatchObject({
      targets_incomplete: 1,
      remaining_depth_days: 100,
      estimated_remaining_chunks: 1,
      max_remaining_depth_days: 100,
    });
    expect(completeCoverage.history.completion_estimate).toMatchObject({
      targets_incomplete: 0,
      remaining_depth_days: 0,
      estimated_remaining_chunks: 0,
      max_remaining_depth_days: 0,
    });
  });

  it('derives per-tier depth SLO fields for no data, partial data, and complete coverage', () => {
    const now = new Date('2026-03-23T00:00:00.000Z');
    const summary = summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => [
              {
                coinId: 'bitcoin',
                exchangeId: 'binance',
                symbol: 'BTC/USDT',
                vsCurrency: 'usd',
                interval: '1d',
                priorityTier: 'top100',
                status: 'idle',
                latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
                oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
                targetHistoryDays: 365,
                failureCount: 0,
                nextRetryAt: null,
              },
              {
                coinId: 'solana',
                exchangeId: 'binance',
                symbol: 'SOL/USDT',
                vsCurrency: 'usd',
                interval: '1d',
                priorityTier: 'requested',
                status: 'idle',
                latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
                oldestSyncedAt: new Date('2026-03-13T00:00:00.000Z'),
                targetHistoryDays: 30,
                failureCount: 0,
                nextRetryAt: null,
              },
              {
                coinId: 'some-microcap',
                exchangeId: 'binance',
                symbol: 'SMC/USDT',
                vsCurrency: 'usd',
                interval: '1d',
                priorityTier: 'long_tail',
                status: 'failed',
                latestSyncedAt: null,
                oldestSyncedAt: null,
                targetHistoryDays: 30,
                failureCount: 1,
                nextRetryAt: new Date('2026-03-23T00:10:00.000Z'),
                lastAttemptAt: now,
                lastSuccessAt: null,
                lastError: 'timeout',
              },
            ],
          }),
        }),
      },
    } as never, now);

    expect(summary.history.by_tier.top100).toMatchObject({
      target_depth_days: 365,
      oldest_covered_at: '2025-03-22T00:00:00.000Z',
      coverage_ratio: 1,
      slo_status: 'complete',
    });
    expect(summary.history.by_tier.requested).toMatchObject({
      target_depth_days: 30,
      oldest_covered_at: '2026-03-13T00:00:00.000Z',
      coverage_ratio: 0.333333,
      slo_status: 'catching_up',
    });
    expect(summary.history.by_tier.long_tail).toMatchObject({
      target_depth_days: 30,
      oldest_covered_at: null,
      coverage_ratio: 0,
      slo_status: 'blocked',
    });
  });

  it('derives per-tier historical depth SLO fields for no-data, partial, and complete coverage', () => {
    const now = new Date('2026-03-23T00:00:00.000Z');
    const rows = [
      {
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        status: 'idle',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: null,
        targetHistoryDays: 365,
        failureCount: 0,
        nextRetryAt: null,
      },
      {
        coinId: 'ethereum',
        exchangeId: 'binance',
        symbol: 'ETH/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'requested',
        status: 'idle',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: new Date('2025-09-23T00:00:00.000Z'),
        targetHistoryDays: 365,
        failureCount: 0,
        nextRetryAt: null,
      },
      {
        coinId: 'some-microcap',
        exchangeId: 'binance',
        symbol: 'SMC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'long_tail',
        status: 'idle',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: new Date('2025-03-23T00:00:00.000Z'),
        targetHistoryDays: 365,
        failureCount: 0,
        nextRetryAt: null,
      },
    ];

    const summary = summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => rows,
          }),
        }),
      },
    } as never, now);

    expect(summary.history.by_tier.top100).toMatchObject({
      target_depth_days: 365,
      oldest_covered_at: null,
      coverage_ratio: 0,
      slo_status: 'catching_up',
      depth_status_counts: {
        complete: 0,
        catching_up: 1,
        blocked: 0,
      },
    });
    expect(summary.history.by_tier.requested).toMatchObject({
      target_depth_days: 365,
      oldest_covered_at: '2025-09-23T00:00:00.000Z',
      coverage_ratio: 0.49589,
      slo_status: 'catching_up',
      depth_status_counts: {
        complete: 0,
        catching_up: 1,
        blocked: 0,
      },
    });
    expect(summary.history.by_tier.long_tail).toMatchObject({
      target_depth_days: 365,
      oldest_covered_at: '2025-03-23T00:00:00.000Z',
      coverage_ratio: 1,
      slo_status: 'complete',
      depth_status_counts: {
        complete: 1,
        catching_up: 0,
        blocked: 0,
      },
    });
  });

  it('samples the most-behind ohlcv targets per tier with a fixed cap and deterministic ordering', () => {
    const now = new Date('2026-03-23T00:00:00.000Z');
    const targetRows = [
      ['bitcoin', 'BTC/USDT', '2026-02-01T00:00:00.000Z'],
      ['ethereum', 'ETH/USDT', null],
      ['solana', 'SOL/USDT', '2025-09-01T00:00:00.000Z'],
      ['cardano', 'ADA/USDT', '2025-08-01T00:00:00.000Z'],
      ['dogecoin', 'DOGE/USDT', '2025-07-01T00:00:00.000Z'],
      ['chainlink', 'LINK/USDT', '2025-06-01T00:00:00.000Z'],
      ['ripple', 'XRP/USDT', '2025-05-01T00:00:00.000Z'],
    ].map(([coinId, symbol, oldestSyncedAt]) => ({
      coinId,
      exchangeId: 'binance',
      symbol,
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      status: 'idle',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: oldestSyncedAt ? new Date(oldestSyncedAt) : null,
      targetHistoryDays: 365,
      failureCount: 0,
      nextRetryAt: null,
    }));

    const summary = summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => targetRows,
          }),
        }),
      },
    } as never, now);

    expect(summary.history.most_behind_samples.top100).toHaveLength(5);
    expect(summary.history.most_behind_samples.top100.map((sample) => sample.coin_id)).toEqual([
      'ethereum',
      'bitcoin',
      'solana',
      'cardano',
      'dogecoin',
    ]);
    expect(summary.history.most_behind_samples.top100[0]).toMatchObject({
      coin_id: 'ethereum',
      exchange_id: 'binance',
      symbol: 'ETH/USDT',
      remaining_depth_days: 365,
      estimated_remaining_chunks: 3,
      oldest_synced_at: null,
    });
    expect(summary.history.most_behind_samples.top100[1]).toMatchObject({
      coin_id: 'bitcoin',
      remaining_depth_days: 315,
      estimated_remaining_chunks: 2,
    });
  });

  it('samples blocked ohlcv targets with retry metadata, sanitized errors, and deterministic ordering', () => {
    const now = new Date('2026-03-23T00:00:00.000Z');
    const targetRows = [
      ['bitcoin', 'BTC/USDT', null, '2026-03-23T00:30:00.000Z', 'GET https://adapter.example/ohlcv?api_key=secret&symbol=BTC failed'],
      ['ethereum', 'ETH/USDT', null, '2026-03-23T00:05:00.000Z', 'token=secret-token rate limit'],
      ['solana', 'SOL/USDT', '2026-01-01T00:00:00.000Z', '2026-03-23T00:05:00.000Z', 'temporary upstream error'],
      ['cardano', 'ADA/USDT', null, '2026-03-23T00:10:00.000Z', 'temporary upstream error'],
      ['dogecoin', 'DOGE/USDT', null, '2026-03-23T00:15:00.000Z', 'temporary upstream error'],
      ['chainlink', 'LINK/USDT', null, '2026-03-23T00:20:00.000Z', 'temporary upstream error'],
    ].map(([coinId, symbol, oldestSyncedAt, nextRetryAt, lastError], index) => ({
      coinId,
      exchangeId: 'binance',
      symbol,
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      status: 'failed',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: oldestSyncedAt ? new Date(oldestSyncedAt) : null,
      targetHistoryDays: 365,
      failureCount: index + 1,
      nextRetryAt: nextRetryAt ? new Date(nextRetryAt) : null,
      lastAttemptAt: new Date('2026-03-23T00:00:00.000Z'),
      lastSuccessAt: null,
      lastError,
    }));

    const summary = summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => targetRows,
          }),
        }),
      },
    } as never, now);

    expect(summary.history.blocked_target_samples.top100).toHaveLength(5);
    expect(summary.history.blocked_target_samples.top100.map((sample) => sample.coin_id)).toEqual([
      'ethereum',
      'solana',
      'cardano',
      'dogecoin',
      'chainlink',
    ]);
    expect(summary.history.blocked_target_samples.top100[0]).toMatchObject({
      coin_id: 'ethereum',
      next_retry_at: '2026-03-23T00:05:00.000Z',
      retry_in_seconds: 300,
      failure_count: 2,
      last_error: 'token=redacted rate limit',
    });
    expect(summary.history.blocked_target_samples.top100[1]).toMatchObject({
      coin_id: 'solana',
      next_retry_at: '2026-03-23T00:05:00.000Z',
      remaining_depth_days: 284,
    });
    expect(summary.history.blocked_target_samples.top100.some((sample) =>
      sample.last_error?.includes('secret'))).toBe(false);
  });

  it('splits failed ohlcv targets by retry due and backoff state per tier', () => {
    const now = new Date('2026-03-23T00:00:00.000Z');
    const rows = [
      {
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        status: 'failed',
        latestSyncedAt: null,
        oldestSyncedAt: null,
        targetHistoryDays: 365,
        failureCount: 1,
        nextRetryAt: new Date('2026-03-22T23:59:00.000Z'),
        lastAttemptAt: new Date('2026-03-22T23:54:00.000Z'),
        lastSuccessAt: null,
        lastError: 'rate limit',
      },
      {
        coinId: 'ethereum',
        exchangeId: 'binance',
        symbol: 'ETH/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        status: 'failed',
        latestSyncedAt: null,
        oldestSyncedAt: null,
        targetHistoryDays: 365,
        failureCount: 2,
        nextRetryAt: new Date('2026-03-23T00:10:00.000Z'),
        lastAttemptAt: new Date('2026-03-23T00:00:00.000Z'),
        lastSuccessAt: null,
        lastError: 'rate limit',
      },
      {
        coinId: 'some-microcap',
        exchangeId: 'binance',
        symbol: 'SMC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'long_tail',
        status: 'failed',
        latestSyncedAt: null,
        oldestSyncedAt: null,
        targetHistoryDays: 30,
        failureCount: 1,
        nextRetryAt: null,
        lastAttemptAt: new Date('2026-03-22T23:54:00.000Z'),
        lastSuccessAt: null,
        lastError: 'timeout',
      },
    ];

    const summary = summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => rows,
          }),
        }),
      },
    } as never, now);

    expect(summary.history.retry_recovery_counts).toEqual({
      due: 2,
      backoff: 1,
    });
    expect(summary.history.by_tier.top100.retry_recovery_counts).toEqual({
      due: 1,
      backoff: 1,
    });
    expect(summary.history.by_tier.long_tail.retry_recovery_counts).toEqual({
      due: 1,
      backoff: 0,
    });
    expect(summary.history.retry_starvation_counts).toEqual({
      starved: 1,
    });
    expect(summary.history.by_tier.top100.retry_starvation_counts).toEqual({
      starved: 0,
    });
    expect(summary.history.by_tier.long_tail.retry_starvation_counts).toEqual({
      starved: 1,
    });
  });

  it('summarizes the coarse ohlcv retry and backfill queue by lease-priority buckets', () => {
    const now = new Date('2026-03-23T00:00:00.000Z');
    const rows = [
      {
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        status: 'failed',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: new Date('2026-02-01T00:00:00.000Z'),
        targetHistoryDays: 365,
        failureCount: 2,
        nextRetryAt: new Date('2026-03-22T23:57:00.000Z'),
        lastAttemptAt: new Date('2026-03-22T23:52:00.000Z'),
        lastSuccessAt: null,
        lastError: 'rate limit',
      },
      {
        coinId: 'ethereum',
        exchangeId: 'binance',
        symbol: 'ETH/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        status: 'failed',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: null,
        targetHistoryDays: 365,
        failureCount: 1,
        nextRetryAt: new Date('2026-03-23T00:05:00.000Z'),
        lastAttemptAt: new Date('2026-03-23T00:00:00.000Z'),
        lastSuccessAt: null,
        lastError: 'timeout',
      },
      {
        coinId: 'solana',
        exchangeId: 'binance',
        symbol: 'SOL/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'requested',
        status: 'idle',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: new Date('2026-01-01T00:00:00.000Z'),
        targetHistoryDays: 365,
        failureCount: 0,
        nextRetryAt: null,
        lastAttemptAt: null,
        lastSuccessAt: new Date('2026-03-22T00:00:00.000Z'),
        lastError: null,
      },
      {
        coinId: 'cardano',
        exchangeId: 'binance',
        symbol: 'ADA/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'long_tail',
        status: 'running',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
        targetHistoryDays: 365,
        failureCount: 0,
        nextRetryAt: null,
        lastAttemptAt: new Date('2026-03-23T00:00:00.000Z'),
        lastSuccessAt: new Date('2026-03-22T00:00:00.000Z'),
        lastError: null,
        leaseOwner: 'worker-a',
        leaseToken: 'lease-a',
        leaseAcquiredAt: new Date('2026-03-23T00:00:00.000Z'),
        leaseExpiresAt: new Date('2026-03-23T00:15:00.000Z'),
      },
    ];

    const summary = summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => rows,
          }),
        }),
      },
    } as never, now);

    expect(summary.history.queue_priority_summary).toEqual({
      totals: {
        eligible_for_lease: 2,
        retry_due_failed: 1,
        retry_backoff_failed: 1,
        incomplete_depth: 3,
        complete_depth: 1,
        running: 1,
        starved_retry_due: 1,
      },
      by_tier: {
        top100: {
          eligible_for_lease: 1,
          retry_due_failed: 1,
          retry_backoff_failed: 1,
          incomplete_depth: 2,
          complete_depth: 0,
          running: 0,
          starved_retry_due: 1,
        },
        requested: {
          eligible_for_lease: 1,
          retry_due_failed: 0,
          retry_backoff_failed: 0,
          incomplete_depth: 1,
          complete_depth: 0,
          running: 0,
          starved_retry_due: 0,
        },
        long_tail: {
          eligible_for_lease: 0,
          retry_due_failed: 0,
          retry_backoff_failed: 0,
          incomplete_depth: 0,
          complete_depth: 1,
          running: 1,
          starved_retry_due: 0,
        },
      },
    });
  });

  it('counts retry-due failed targets as starvation risk only after the due-age threshold', () => {
    const now = new Date('2026-03-23T00:00:00.000Z');
    const rows = [
      {
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        status: 'failed',
        latestSyncedAt: null,
        oldestSyncedAt: null,
        targetHistoryDays: 365,
        failureCount: 1,
        nextRetryAt: new Date('2026-03-22T23:57:59.000Z'),
        lastAttemptAt: new Date('2026-03-22T23:52:59.000Z'),
        lastSuccessAt: null,
        lastError: 'rate limit',
      },
      {
        coinId: 'ethereum',
        exchangeId: 'binance',
        symbol: 'ETH/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        status: 'failed',
        latestSyncedAt: null,
        oldestSyncedAt: null,
        targetHistoryDays: 365,
        failureCount: 2,
        nextRetryAt: new Date('2026-03-22T23:59:00.000Z'),
        lastAttemptAt: new Date('2026-03-22T23:54:00.000Z'),
        lastSuccessAt: null,
        lastError: 'rate limit',
      },
      {
        coinId: 'some-microcap',
        exchangeId: 'binance',
        symbol: 'SMC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'long_tail',
        status: 'failed',
        latestSyncedAt: null,
        oldestSyncedAt: null,
        targetHistoryDays: 30,
        failureCount: 2,
        nextRetryAt: new Date('2026-03-23T00:10:00.000Z'),
        lastAttemptAt: new Date('2026-03-23T00:00:00.000Z'),
        lastSuccessAt: null,
        lastError: 'rate limit',
      },
    ];

    const summary = summarizeOhlcvSyncStatus({
      db: {
        select: () => ({
          from: () => ({
            all: () => rows,
          }),
        }),
      },
    } as never, now);

    expect(summary.history.retry_starvation_thresholds).toEqual({
      due_age_seconds: 120,
    });
    expect(summary.history.retry_starvation_counts).toEqual({
      starved: 1,
    });
    expect(summary.history.by_tier.top100.retry_starvation_counts).toEqual({
      starved: 1,
    });
    expect(summary.history.by_tier.long_tail.retry_starvation_counts).toEqual({
      starved: 0,
    });
  });
});
