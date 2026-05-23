import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { createDatabase, initializeDatabase } from '../src/db/client';
import { supplyChartPoints } from '../src/db/schema';
import {
  createConfiguredOptionalProviderSyncJobs,
  createOptionalProviderSyncScheduler,
  type OptionalProviderScheduledJobResult,
  type OptionalProviderScheduledJob,
} from '../src/services/optional-provider-scheduler';
import { createOptionalProviderJobRegistry } from '../src/services/optional-provider-jobs';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: 1773964800000, raw: {} as never },
  ]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string => ['binance'].includes(value),
}));

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('optional provider sync scheduler', () => {
  it('stays disabled by default and does not schedule interval work', () => {
    const logger = createLogger();
    const registry = createOptionalProviderJobRegistry();
    const run = vi.fn().mockResolvedValue({ targetsAttempted: 1, rowsWritten: 1 });
    const scheduler = createOptionalProviderSyncScheduler({
      enabled: false,
      intervalSeconds: 60,
      jobs: [{
        id: 'market_charts',
        configuredTargetCount: () => 1,
        run,
      }],
      registry,
      logger,
    });

    scheduler.start();

    expect(scheduler.isScheduled()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('registers interval work when enabled', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const registry = createOptionalProviderJobRegistry();
    const run = vi.fn().mockResolvedValue({ targetsAttempted: 1, rowsWritten: 2 });
    const scheduler = createOptionalProviderSyncScheduler({
      enabled: true,
      intervalSeconds: 30,
      jobs: [{
        id: 'market_charts',
        configuredTargetCount: () => 1,
        run,
      }],
      registry,
      logger,
    });

    try {
      scheduler.start();
      expect(scheduler.isScheduled()).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(run).toHaveBeenCalledTimes(1);
      expect(registry.get('market_charts')).toMatchObject({
        status: 'succeeded',
        targetsAttempted: 1,
        rowsWritten: 2,
      });
    } finally {
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it('serializes overlapping runs and records failures without throwing', async () => {
    const logger = createLogger();
    const registry = createOptionalProviderJobRegistry();
    let resolveRun!: (value: { targetsAttempted: number; rowsWritten: number }) => void;
    const slowJob: OptionalProviderScheduledJob = {
      id: 'market_charts',
      configuredTargetCount: () => 1,
      run: vi.fn((): Promise<{ targetsAttempted: number; rowsWritten: number }> => new Promise((resolve) => {
        resolveRun = resolve;
      })),
    };
    const failingJob: OptionalProviderScheduledJob = {
      id: 'exchange_volumes',
      configuredTargetCount: () => 1,
      run: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const scheduler = createOptionalProviderSyncScheduler({
      enabled: true,
      intervalSeconds: 60,
      jobs: [slowJob, failingJob],
      registry,
      logger,
    });

    const firstRun = scheduler.runOnce();
    const overlappingRun = scheduler.runOnce();

    expect(slowJob.run).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    resolveRun({ targetsAttempted: 1, rowsWritten: 3 });
    await firstRun;
    await overlappingRun;

    expect(failingJob.run).toHaveBeenCalledTimes(1);
    expect(registry.get('market_charts')).toMatchObject({
      status: 'succeeded',
      rowsWritten: 3,
    });
    expect(registry.get('exchange_volumes')).toMatchObject({
      status: 'failed',
      error: 'provider down',
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('bounds shutdown when an optional provider run does not settle', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const registry = createOptionalProviderJobRegistry();
    const scheduler = createOptionalProviderSyncScheduler({
      enabled: true,
      intervalSeconds: 60,
      jobs: [{
        id: 'market_charts',
        configuredTargetCount: () => 1,
        run: vi.fn(() => new Promise<OptionalProviderScheduledJobResult>(() => undefined)),
      }],
      registry,
      logger,
    });

    void scheduler.runOnce();
    await vi.advanceTimersByTimeAsync(0);

    const stopped = scheduler.stop({ inFlightTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await stopped;

    expect(scheduler.isRunning()).toBe(true);
    expect(scheduler.isScheduled()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout_ms: 50,
      }),
      'optional provider sync stopped with a job still active after shutdown timeout',
    );
    vi.useRealTimers();
  });

  it('persists scheduler success outcomes for diagnostics after app restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-scheduler-jobs-'));
    const databaseUrl = join(tempDir, 'jobs.db');
    const database = createDatabase(databaseUrl);

    try {
      initializeDatabase(database);
      const logger = createLogger();
      const registry = createOptionalProviderJobRegistry();
      const scheduler = createOptionalProviderSyncScheduler({
        enabled: true,
        intervalSeconds: 60,
        jobs: [{
          id: 'market_charts',
          configuredTargetCount: () => 1,
          run: vi.fn().mockResolvedValue({ targetsAttempted: 1, rowsWritten: 4 }),
        }],
        registry,
        logger,
        database,
      });

      await scheduler.runOnce();
      database.client.close();

      const app = buildApp({
        config: {
          databaseUrl,
          marketChartTargets: 'mock.chart=bitcoin:1d:usd',
          logLevel: 'silent',
        },
        startBackgroundJobs: false,
      });

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/diagnostics/jobs',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data.jobs).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'market_charts',
            status: 'succeeded',
            configured_target_count: 1,
            last_targets_attempted: 1,
            last_rows_written: 4,
            last_failure_reason: null,
            last_partial_failure_reason: null,
            last_partial_failure_samples: [],
            last_partial_failure_retry_targets_template: null,
          }),
        ]));
      } finally {
        await app.close();
      }
    } finally {
      try {
        database.client.close();
      } catch {
        // The database may already be closed before the restart-level diagnostics check.
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs append-table retention through configured optional provider scheduler jobs after successful writes', async () => {
    const database = createDatabase(':memory:');
    const logger = createLogger();
    const registry = createOptionalProviderJobRegistry();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      captured_at: '2026-05-05T00:14:00.000Z',
      points: [{
        timestamp: '1774051200',
        circulating_supply: '19815000',
        total_supply: '21000000',
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);

    try {
      initializeDatabase(database);
      database.db.insert(supplyChartPoints).values({
        coinId: 'bitcoin',
        supplyType: 'total',
        timestamp: new Date('2024-01-01T00:00:00.000Z'),
        value: 21_000_000,
        sourceKind: 'live',
        sourceProvider: 'old-provider',
        sourceFetchedAt: new Date('2024-01-01T00:00:00.000Z'),
      }).run();

      const scheduler = createOptionalProviderSyncScheduler({
        enabled: true,
        intervalSeconds: 60,
        jobs: createConfiguredOptionalProviderSyncJobs(database, {
          coinHistoryTargets: '',
          exchangeVolumeTargets: '',
          marketChartTargets: '',
          onchainAnalyticsTargets: '',
          onchainTradeTargets: '',
          supplyChartTargets: 'mock.supply=bitcoin',
        }, {
          SUPPLY_CHART_BASE_URL: 'https://supply.example',
        } as NodeJS.ProcessEnv),
        registry,
        logger,
        database,
      });

      await scheduler.runOnce();

      expect(registry.get('supply_charts')).toMatchObject({
        status: 'succeeded',
        rowsWritten: 2,
      });
      expect(database.db.select().from(supplyChartPoints)
        .where(eq(supplyChartPoints.sourceProvider, 'old-provider'))
        .all()).toHaveLength(0);
      expect(database.db.select().from(supplyChartPoints)
        .where(eq(supplyChartPoints.sourceProvider, 'mock.supply'))
        .all()).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      database.client.close();
    }
  });

  it('persists scheduler partial failure outcomes for diagnostics after app restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-scheduler-jobs-'));
    const databaseUrl = join(tempDir, 'jobs.db');
    const database = createDatabase(databaseUrl);

    try {
      initializeDatabase(database);
      const logger = createLogger();
      const registry = createOptionalProviderJobRegistry();
      const scheduler = createOptionalProviderSyncScheduler({
        enabled: true,
        intervalSeconds: 60,
        jobs: [{
          id: 'market_charts',
          configuredTargetCount: () => 2,
          run: vi.fn().mockResolvedValue({
            targetsAttempted: 2,
            rowsWritten: 1,
            partialFailureReason: '1 market chart target(s) failed; first failure: provider timeout for bitcoin',
            partialFailureSamples: [{
              provider: 'mock.chart',
              coin_id: 'bitcoin',
              vs_currency: 'usd',
              interval: '1d',
              error: 'provider timeout for bitcoin',
            }],
          }),
        }],
        registry,
        logger,
        database,
      });

      await scheduler.runOnce();
      database.client.close();

      const app = buildApp({
        config: {
          databaseUrl,
          marketChartTargets: 'mock.chart=bitcoin:1d:usd,mock.chart=solana:1d:usd',
          logLevel: 'silent',
        },
        startBackgroundJobs: false,
      });

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/diagnostics/jobs',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data).toMatchObject({
          summary: {
            succeeded: 1,
            failed: 0,
            partial_failure: 1,
          },
          jobs: expect.arrayContaining([
            expect.objectContaining({
              id: 'market_charts',
              status: 'succeeded',
              configured_target_count: 2,
              last_targets_attempted: 2,
              last_rows_written: 1,
              last_failure_reason: null,
              last_partial_failure_reason: '1 market chart target(s) failed; first failure: provider timeout for bitcoin',
              last_partial_failure_samples: [
                {
                  provider: 'mock.chart',
                  coin_id: 'bitcoin',
                  vs_currency: 'usd',
                  interval: '1d',
                  error: 'provider timeout for bitcoin',
                },
              ],
              last_partial_failure_retry_targets_template: 'mock.chart=bitcoin:1d:usd',
            }),
          ]),
        });
      } finally {
        await app.close();
      }
    } finally {
      try {
        database.client.close();
      } catch {
        // The database may already be closed before the restart-level diagnostics check.
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('persists scheduler failure outcomes for diagnostics after app restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-scheduler-jobs-'));
    const databaseUrl = join(tempDir, 'jobs.db');
    const database = createDatabase(databaseUrl);

    try {
      initializeDatabase(database);
      const logger = createLogger();
      const registry = createOptionalProviderJobRegistry();
      const scheduler = createOptionalProviderSyncScheduler({
        enabled: true,
        intervalSeconds: 60,
        jobs: [{
          id: 'exchange_volumes',
          configuredTargetCount: () => 1,
          run: vi.fn(async () => {
            throw new Error('provider unavailable');
          }),
        }],
        registry,
        logger,
        database,
      });

      await scheduler.runOnce();
      database.client.close();

      const app = buildApp({
        config: {
          databaseUrl,
          exchangeVolumeTargets: 'mock.volume=binance',
          logLevel: 'silent',
        },
        startBackgroundJobs: false,
      });

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/diagnostics/jobs',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data.jobs).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'exchange_volumes',
            status: 'failed',
            configured_target_count: 1,
            last_targets_attempted: 1,
            last_rows_written: null,
            last_failure_reason: 'provider unavailable',
          }),
        ]));
      } finally {
        await app.close();
      }
    } finally {
      try {
        database.client.close();
      } catch {
        // The database may already be closed before the restart-level diagnostics check.
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
