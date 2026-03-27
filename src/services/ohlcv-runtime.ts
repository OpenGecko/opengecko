import type { FastifyBaseLogger } from 'fastify';

import type { AppDatabase } from '../db/client';
import { ohlcvSyncTargets } from '../db/schema';
import { refreshOhlcvPriorityTiers } from './ohlcv-priority';
import { buildOhlcvSyncTargets } from './ohlcv-targets';
import { deepenHistoricalOhlcvWindow, syncRecentOhlcvWindow } from './ohlcv-sync';
import {
  leaseNextOhlcvTarget,
  markOhlcvTargetFailure,
  markOhlcvTargetSuccess,
  upsertOhlcvSyncTargets,
} from './ohlcv-worker-state';

type RuntimeLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug' | 'child'>;

type OhlcvRuntimeConfig = {
  ccxtExchanges: string[];
  ohlcvRefreshIntervalSeconds?: number;
  ohlcvTargetHistoryDays?: number;
  ohlcvRetentionDays?: number;
};

type OhlcvRuntimeOverrides = {
  refreshTargets?: (now: Date) => Promise<void>;
  leaseNextOhlcvTarget?: typeof leaseNextOhlcvTarget;
  syncRecentOhlcvWindow?: typeof syncRecentOhlcvWindow;
  deepenHistoricalOhlcvWindow?: typeof deepenHistoricalOhlcvWindow;
  markOhlcvTargetSuccess?: typeof markOhlcvTargetSuccess;
  markOhlcvTargetFailure?: typeof markOhlcvTargetFailure;
};

export type OhlcvRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  tick: (now?: Date) => Promise<void>;
};

export type OhlcvSyncSummary = {
  top100: {
    total: number;
    ready: number;
  };
  targets: {
    waiting: number;
    running: number;
    failed: number;
  };
  lag: {
    oldest_recent_sync_ms: number;
    oldest_historical_gap_ms: number;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

function isRecentCoverageCurrentEnough(latestSyncedAt: Date | null, now: Date) {
  if (!latestSyncedAt) {
    return false;
  }

  return latestSyncedAt.getTime() >= now.getTime() - DAY_MS;
}

export function summarizeOhlcvSyncStatus(database: AppDatabase, now: Date): OhlcvSyncSummary {
  const rows = database.db.select().from(ohlcvSyncTargets).all();
  let top100Total = 0;
  let top100Ready = 0;
  let waiting = 0;
  let running = 0;
  let failed = 0;
  let oldestRecentSyncMs = 0;
  let oldestHistoricalGapMs = 0;

  for (const row of rows) {
    if (row.priorityTier === 'top100') {
      top100Total += 1;
      if (isRecentCoverageCurrentEnough(row.latestSyncedAt, now)) {
        top100Ready += 1;
      }
    }

    if (row.status === 'running') {
      running += 1;
    } else if (row.status === 'failed') {
      failed += 1;
    } else {
      waiting += 1;
    }

    const recentLagMs = row.latestSyncedAt ? now.getTime() - row.latestSyncedAt.getTime() : Number.MAX_SAFE_INTEGER;
    oldestRecentSyncMs = Math.max(oldestRecentSyncMs, recentLagMs === Number.MAX_SAFE_INTEGER ? 0 : recentLagMs);

    const desiredOldestMs = now.getTime() - row.targetHistoryDays * DAY_MS;
    const historicalGapMs = row.oldestSyncedAt ? Math.max(row.oldestSyncedAt.getTime() - desiredOldestMs, 0) : row.targetHistoryDays * DAY_MS;
    oldestHistoricalGapMs = Math.max(oldestHistoricalGapMs, historicalGapMs);
  }

  return {
    top100: {
      total: top100Total,
      ready: top100Ready,
    },
    targets: {
      waiting,
      running,
      failed,
    },
    lag: {
      oldest_recent_sync_ms: oldestRecentSyncMs,
      oldest_historical_gap_ms: oldestHistoricalGapMs,
    },
  };
}

export function createOhlcvRuntime(
  database: AppDatabase,
  config: OhlcvRuntimeConfig,
  logger: RuntimeLogger,
  overrides: OhlcvRuntimeOverrides = {},
): OhlcvRuntime {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  async function refreshTargets(now: Date) {
    if (overrides.refreshTargets) {
      await overrides.refreshTargets(now);
      return;
    }

    const targets = await buildOhlcvSyncTargets(database, config.ccxtExchanges as never, undefined, {
      targetHistoryDays: config.ohlcvTargetHistoryDays,
    });
    upsertOhlcvSyncTargets(database, targets, now);
    refreshOhlcvPriorityTiers(database, now);
  }

  return {
    async tick(now = new Date()) {
      if (inFlight) {
        return inFlight;
      }

      inFlight = (async () => {
        try {
          await refreshTargets(now);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ error: message }, 'ohlcv target refresh failed');
          return;
        }

        const leased = (overrides.leaseNextOhlcvTarget ?? leaseNextOhlcvTarget)(database, now);

        if (!leased) {
          return;
        }

        try {
          const recentCoverageWasCurrent = isRecentCoverageCurrentEnough(leased.latestSyncedAt, now);
          const recentCandles = await (overrides.syncRecentOhlcvWindow ?? syncRecentOhlcvWindow)(database, leased, now);
          const nextLatestSyncedAt = recentCandles.at(-1)
            ? new Date(recentCandles.at(-1)!.timestamp)
            : leased.latestSyncedAt;

          let nextOldestSyncedAt = leased.oldestSyncedAt;

          if (recentCoverageWasCurrent && isRecentCoverageCurrentEnough(nextLatestSyncedAt, now)) {
            const historicalCandles = await (overrides.deepenHistoricalOhlcvWindow ?? deepenHistoricalOhlcvWindow)(database, {
              ...leased,
              latestSyncedAt: nextLatestSyncedAt,
            }, now);

            if (historicalCandles[0]) {
              nextOldestSyncedAt = new Date(historicalCandles[0].timestamp);
            }
          }

          (overrides.markOhlcvTargetSuccess ?? markOhlcvTargetSuccess)(database, {
            coinId: leased.coinId,
            exchangeId: leased.exchangeId,
            symbol: leased.symbol,
            interval: leased.interval,
            vsCurrency: leased.vsCurrency,
            latestSyncedAt: nextLatestSyncedAt,
            oldestSyncedAt: nextOldestSyncedAt,
            completedAt: now,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          (overrides.markOhlcvTargetFailure ?? markOhlcvTargetFailure)(database, {
            coinId: leased.coinId,
            exchangeId: leased.exchangeId,
            symbol: leased.symbol,
            interval: leased.interval,
            vsCurrency: leased.vsCurrency,
            failedAt: now,
            error: message,
          });
          logger.error({ error: message, coinId: leased.coinId }, 'ohlcv runtime tick failed');
        }
      })().finally(() => {
        inFlight = null;
      });

      return inFlight;
    },
    async start() {
      // Start the first tick in the background without awaiting
      // to prevent blocking the server startup. The tick will
      // complete asynchronously and subsequent ticks run on the interval.
      void this.tick();
      timer = setInterval(() => {
        void this.tick();
      }, (config.ohlcvRefreshIntervalSeconds ?? 60) * 1000);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      if (inFlight) {
        await inFlight;
      }
    },
  };
}
