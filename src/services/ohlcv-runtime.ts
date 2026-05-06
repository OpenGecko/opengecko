import type { FastifyBaseLogger } from 'fastify';

import type { AppDatabase } from '../db/client';
import { ohlcvSyncTargets } from '../db/schema';
import { refreshOhlcvPriorityTiers } from './ohlcv-priority';
import { buildOhlcvSyncTargets } from './ohlcv-targets';
import {
  HISTORICAL_DEEPEN_CHUNK_DAYS,
  HISTORICAL_DEEPEN_OVERLAP_DAYS,
  deepenHistoricalOhlcvWindow,
  syncRecentOhlcvWindow,
} from './ohlcv-sync';
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

type OhlcvDepthStatusCounts = {
  complete: number;
  catching_up: number;
  blocked: number;
};

type OhlcvRetryRecoveryCounts = {
  due: number;
  backoff: number;
};

type OhlcvRetryStarvationCounts = {
  starved: number;
};

type OhlcvQueuePriorityCounts = {
  eligible_for_lease: number;
  retry_due_failed: number;
  retry_backoff_failed: number;
  incomplete_depth: number;
  complete_depth: number;
  running: number;
  starved_retry_due: number;
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
  backfill: {
    healthy: number;
    behind: number;
    retry_scheduled: number;
    max_target_history_days: number;
  };
  history: {
    target_depth_days: number;
    desired_oldest_at: string | null;
    oldest_covered_at: string | null;
    newest_covered_at: string | null;
    targets_with_any_history: number;
    targets_at_target_depth: number;
    by_tier: Record<'top100' | 'requested' | 'long_tail', {
      total: number;
      with_any_history: number;
      at_target_depth: number;
      oldest_covered_at: string | null;
      remaining_depth_days: number;
      estimated_remaining_chunks: number;
      depth_status_counts: OhlcvDepthStatusCounts;
      retry_recovery_counts: OhlcvRetryRecoveryCounts;
      retry_starvation_counts: OhlcvRetryStarvationCounts;
    }>;
    depth_status_counts: OhlcvDepthStatusCounts;
    retry_recovery_counts: OhlcvRetryRecoveryCounts;
    retry_starvation_counts: OhlcvRetryStarvationCounts;
    retry_starvation_thresholds: {
      due_age_seconds: number;
    };
    queue_priority_summary: {
      totals: OhlcvQueuePriorityCounts;
      by_tier: Record<'top100' | 'requested' | 'long_tail', OhlcvQueuePriorityCounts>;
    };
    depth_alert_thresholds: {
      complete_remaining_depth_days: number;
      catching_up_min_remaining_depth_days: number;
      blocked_statuses: string[];
    };
    completion_estimate: {
      chunk_days: number;
      overlap_days: number;
      targets_incomplete: number;
      remaining_depth_days: number;
      estimated_remaining_chunks: number;
      max_remaining_depth_days: number;
    };
    most_behind_samples: Record<'top100' | 'requested' | 'long_tail', Array<{
      coin_id: string;
      exchange_id: string;
      symbol: string;
      vs_currency: string;
      interval: string;
      status: string;
      target_history_days: number;
      oldest_synced_at: string | null;
      latest_synced_at: string | null;
      remaining_depth_days: number;
      estimated_remaining_chunks: number;
    }>>;
    blocked_target_samples: Record<'top100' | 'requested' | 'long_tail', Array<{
      coin_id: string;
      exchange_id: string;
      symbol: string;
      vs_currency: string;
      interval: string;
      status: string;
      target_history_days: number;
      oldest_synced_at: string | null;
      latest_synced_at: string | null;
      remaining_depth_days: number;
      estimated_remaining_chunks: number;
      failure_count: number;
      next_retry_at: string | null;
      retry_in_seconds: number | null;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
    }>>;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MOST_BEHIND_SAMPLE_LIMIT = 5;
const BLOCKED_TARGET_SAMPLE_LIMIT = 5;
const LAST_ERROR_MAX_LENGTH = 180;
const RETRY_STARVATION_DUE_AGE_SECONDS = 120;
const DEPTH_COMPLETE_REMAINING_DAYS = 0;
const DEPTH_CATCHING_UP_MIN_REMAINING_DAYS = 1;
const DEPTH_BLOCKED_STATUSES = ['failed'] as const;

function isRecentCoverageCurrentEnough(latestSyncedAt: Date | null, now: Date) {
  if (!latestSyncedAt) {
    return false;
  }

  return latestSyncedAt.getTime() >= now.getTime() - DAY_MS;
}

function emptyHistoryTierSummary() {
  return {
    total: 0,
    with_any_history: 0,
    at_target_depth: 0,
    oldest_covered_at: null as string | null,
    remaining_depth_days: 0,
    estimated_remaining_chunks: 0,
    depth_status_counts: emptyDepthStatusCounts(),
    retry_recovery_counts: emptyRetryRecoveryCounts(),
    retry_starvation_counts: emptyRetryStarvationCounts(),
  };
}

function emptyDepthStatusCounts(): OhlcvDepthStatusCounts {
  return {
    complete: 0,
    catching_up: 0,
    blocked: 0,
  };
}

function emptyRetryRecoveryCounts(): OhlcvRetryRecoveryCounts {
  return {
    due: 0,
    backoff: 0,
  };
}

function emptyRetryStarvationCounts(): OhlcvRetryStarvationCounts {
  return {
    starved: 0,
  };
}

function emptyQueuePriorityCounts(): OhlcvQueuePriorityCounts {
  return {
    eligible_for_lease: 0,
    retry_due_failed: 0,
    retry_backoff_failed: 0,
    incomplete_depth: 0,
    complete_depth: 0,
    running: 0,
    starved_retry_due: 0,
  };
}

function classifyDepthStatus(targetRemainingDepthDays: number, status: string) {
  if (targetRemainingDepthDays <= DEPTH_COMPLETE_REMAINING_DAYS) {
    return 'complete' as const;
  }

  if ((DEPTH_BLOCKED_STATUSES as readonly string[]).includes(status)) {
    return 'blocked' as const;
  }

  return 'catching_up' as const;
}

function toIso(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

function emptyMostBehindSamples(): OhlcvSyncSummary['history']['most_behind_samples'] {
  return {
    top100: [],
    requested: [],
    long_tail: [],
  };
}

function emptyBlockedTargetSamples(): OhlcvSyncSummary['history']['blocked_target_samples'] {
  return {
    top100: [],
    requested: [],
    long_tail: [],
  };
}

function sanitizeLastError(value: string | null) {
  if (!value) {
    return null;
  }

  const withoutUrlSecrets = value.replace(/https?:\/\/[^\s]+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      parsed.username = parsed.username ? 'redacted' : '';
      parsed.password = parsed.password ? 'redacted' : '';
      parsed.search = parsed.search ? '?redacted' : '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return '[url redacted]';
    }
  });
  const sanitized = withoutUrlSecrets.replace(
    /((?:api[_-]?key|apikey|token|secret|signature|password|pass)=)[^&\s]+/gi,
    '$1redacted',
  );

  return sanitized.length > LAST_ERROR_MAX_LENGTH
    ? `${sanitized.slice(0, LAST_ERROR_MAX_LENGTH - 3)}...`
    : sanitized;
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
  let healthy = 0;
  let behind = 0;
  let retryScheduled = 0;
  let maxTargetHistoryDays = 0;
  let oldestCoveredMs: number | null = null;
  let newestCoveredMs: number | null = null;
  let targetsWithAnyHistory = 0;
  let targetsAtTargetDepth = 0;
  let targetsIncomplete = 0;
  let remainingDepthDays = 0;
  let estimatedRemainingChunks = 0;
  let maxRemainingDepthDays = 0;
  const historyByTier = {
    top100: emptyHistoryTierSummary(),
    requested: emptyHistoryTierSummary(),
    long_tail: emptyHistoryTierSummary(),
  };
  const depthStatusCounts = emptyDepthStatusCounts();
  const retryRecoveryCounts = emptyRetryRecoveryCounts();
  const retryStarvationCounts = emptyRetryStarvationCounts();
  const queuePrioritySummary = {
    totals: emptyQueuePriorityCounts(),
    by_tier: {
      top100: emptyQueuePriorityCounts(),
      requested: emptyQueuePriorityCounts(),
      long_tail: emptyQueuePriorityCounts(),
    },
  };
  const mostBehindSamples = emptyMostBehindSamples();
  const blockedTargetSamples = emptyBlockedTargetSamples();

  for (const row of rows) {
    const tier = historyByTier[row.priorityTier];
    const queueTier = queuePrioritySummary.by_tier[row.priorityTier];
    tier.total += 1;

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
    const targetRemainingDepthDays = Math.ceil(historicalGapMs / DAY_MS);
    const targetEstimatedRemainingChunks = targetRemainingDepthDays === 0
      ? 0
      : Math.ceil(targetRemainingDepthDays / HISTORICAL_DEEPEN_CHUNK_DAYS);
    oldestHistoricalGapMs = Math.max(oldestHistoricalGapMs, historicalGapMs);
    maxTargetHistoryDays = Math.max(maxTargetHistoryDays, row.targetHistoryDays);
    remainingDepthDays += targetRemainingDepthDays;
    estimatedRemainingChunks += targetEstimatedRemainingChunks;
    maxRemainingDepthDays = Math.max(maxRemainingDepthDays, targetRemainingDepthDays);
    tier.remaining_depth_days += targetRemainingDepthDays;
    tier.estimated_remaining_chunks += targetEstimatedRemainingChunks;
    const depthStatus = classifyDepthStatus(targetRemainingDepthDays, row.status);
    depthStatusCounts[depthStatus] += 1;
    tier.depth_status_counts[depthStatus] += 1;
    const queueDepthStatus = targetRemainingDepthDays > 0 ? 'incomplete_depth' : 'complete_depth';
    queuePrioritySummary.totals[queueDepthStatus] += 1;
    queueTier[queueDepthStatus] += 1;
    if (row.status === 'running') {
      queuePrioritySummary.totals.running += 1;
      queueTier.running += 1;
    }
    const isRetryBackoff = row.status === 'failed' && row.nextRetryAt && row.nextRetryAt.getTime() > now.getTime();
    const isLeaseEligible = (row.status === 'idle' || row.status === 'failed') && !isRetryBackoff;
    if (isLeaseEligible) {
      queuePrioritySummary.totals.eligible_for_lease += 1;
      queueTier.eligible_for_lease += 1;
    }
    if (row.status === 'failed') {
      const retryRecoveryStatus = isRetryBackoff ? 'backoff' : 'due';
      retryRecoveryCounts[retryRecoveryStatus] += 1;
      tier.retry_recovery_counts[retryRecoveryStatus] += 1;
      if (retryRecoveryStatus === 'due') {
        queuePrioritySummary.totals.retry_due_failed += 1;
        queueTier.retry_due_failed += 1;
      } else {
        queuePrioritySummary.totals.retry_backoff_failed += 1;
        queueTier.retry_backoff_failed += 1;
      }
      const retryDueAgeMs = row.nextRetryAt
        ? now.getTime() - row.nextRetryAt.getTime()
        : row.lastAttemptAt
          ? now.getTime() - row.lastAttemptAt.getTime()
          : Number.POSITIVE_INFINITY;
      if (retryRecoveryStatus === 'due' && retryDueAgeMs >= RETRY_STARVATION_DUE_AGE_SECONDS * 1000) {
        retryStarvationCounts.starved += 1;
        tier.retry_starvation_counts.starved += 1;
        queuePrioritySummary.totals.starved_retry_due += 1;
        queueTier.starved_retry_due += 1;
      }
    }

    if (targetRemainingDepthDays > 0) {
      targetsIncomplete += 1;
      mostBehindSamples[row.priorityTier].push({
        coin_id: row.coinId,
        exchange_id: row.exchangeId,
        symbol: row.symbol,
        vs_currency: row.vsCurrency,
        interval: row.interval,
        status: row.status,
        target_history_days: row.targetHistoryDays,
        oldest_synced_at: row.oldestSyncedAt?.toISOString() ?? null,
        latest_synced_at: row.latestSyncedAt?.toISOString() ?? null,
        remaining_depth_days: targetRemainingDepthDays,
        estimated_remaining_chunks: targetEstimatedRemainingChunks,
      });

      if (depthStatus === 'blocked') {
        blockedTargetSamples[row.priorityTier].push({
          coin_id: row.coinId,
          exchange_id: row.exchangeId,
          symbol: row.symbol,
          vs_currency: row.vsCurrency,
          interval: row.interval,
          status: row.status,
          target_history_days: row.targetHistoryDays,
          oldest_synced_at: row.oldestSyncedAt?.toISOString() ?? null,
          latest_synced_at: row.latestSyncedAt?.toISOString() ?? null,
          remaining_depth_days: targetRemainingDepthDays,
          estimated_remaining_chunks: targetEstimatedRemainingChunks,
          failure_count: row.failureCount,
          next_retry_at: row.nextRetryAt?.toISOString() ?? null,
          retry_in_seconds: row.nextRetryAt
            ? Math.max(Math.ceil((row.nextRetryAt.getTime() - now.getTime()) / 1000), 0)
            : null,
          last_attempt_at: row.lastAttemptAt?.toISOString() ?? null,
          last_success_at: row.lastSuccessAt?.toISOString() ?? null,
          last_error: sanitizeLastError(row.lastError),
        });
      }
    }

    if (row.oldestSyncedAt) {
      const oldestMs = row.oldestSyncedAt.getTime();
      oldestCoveredMs = oldestCoveredMs === null ? oldestMs : Math.min(oldestCoveredMs, oldestMs);
      tier.oldest_covered_at = toIso(Math.min(
        oldestMs,
        tier.oldest_covered_at ? Date.parse(tier.oldest_covered_at) : oldestMs,
      ));
      targetsWithAnyHistory += 1;
      tier.with_any_history += 1;

      if (oldestMs <= desiredOldestMs) {
        targetsAtTargetDepth += 1;
        tier.at_target_depth += 1;
      }
    }

    if (row.latestSyncedAt) {
      const latestMs = row.latestSyncedAt.getTime();
      newestCoveredMs = newestCoveredMs === null ? latestMs : Math.max(newestCoveredMs, latestMs);
    }

    if (row.nextRetryAt && row.nextRetryAt.getTime() > now.getTime()) {
      retryScheduled += 1;
    }

    if (historicalGapMs > 0 || !isRecentCoverageCurrentEnough(row.latestSyncedAt, now)) {
      behind += 1;
    } else {
      healthy += 1;
    }
  }

  for (const samples of Object.values(mostBehindSamples)) {
    samples.sort((left, right) =>
      right.remaining_depth_days - left.remaining_depth_days
      || left.coin_id.localeCompare(right.coin_id)
      || left.exchange_id.localeCompare(right.exchange_id)
      || left.symbol.localeCompare(right.symbol));
    samples.splice(MOST_BEHIND_SAMPLE_LIMIT);
  }

  for (const samples of Object.values(blockedTargetSamples)) {
    samples.sort((left, right) => {
      const leftRetry = left.next_retry_at ? Date.parse(left.next_retry_at) : Number.MAX_SAFE_INTEGER;
      const rightRetry = right.next_retry_at ? Date.parse(right.next_retry_at) : Number.MAX_SAFE_INTEGER;

      return leftRetry - rightRetry
        || right.remaining_depth_days - left.remaining_depth_days
        || left.coin_id.localeCompare(right.coin_id)
        || left.exchange_id.localeCompare(right.exchange_id)
        || left.symbol.localeCompare(right.symbol);
    });
    samples.splice(BLOCKED_TARGET_SAMPLE_LIMIT);
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
    backfill: {
      healthy,
      behind,
      retry_scheduled: retryScheduled,
      max_target_history_days: maxTargetHistoryDays,
    },
    history: {
      target_depth_days: maxTargetHistoryDays,
      desired_oldest_at: maxTargetHistoryDays > 0
        ? new Date(now.getTime() - maxTargetHistoryDays * DAY_MS).toISOString()
        : null,
      oldest_covered_at: toIso(oldestCoveredMs),
      newest_covered_at: toIso(newestCoveredMs),
      targets_with_any_history: targetsWithAnyHistory,
      targets_at_target_depth: targetsAtTargetDepth,
      by_tier: historyByTier,
      depth_status_counts: depthStatusCounts,
      retry_recovery_counts: retryRecoveryCounts,
      retry_starvation_counts: retryStarvationCounts,
      retry_starvation_thresholds: {
        due_age_seconds: RETRY_STARVATION_DUE_AGE_SECONDS,
      },
      queue_priority_summary: queuePrioritySummary,
      depth_alert_thresholds: {
        complete_remaining_depth_days: DEPTH_COMPLETE_REMAINING_DAYS,
        catching_up_min_remaining_depth_days: DEPTH_CATCHING_UP_MIN_REMAINING_DAYS,
        blocked_statuses: [...DEPTH_BLOCKED_STATUSES],
      },
      completion_estimate: {
        chunk_days: HISTORICAL_DEEPEN_CHUNK_DAYS,
        overlap_days: HISTORICAL_DEEPEN_OVERLAP_DAYS,
        targets_incomplete: targetsIncomplete,
        remaining_depth_days: remainingDepthDays,
        estimated_remaining_chunks: estimatedRemainingChunks,
        max_remaining_depth_days: maxRemainingDepthDays,
      },
      most_behind_samples: mostBehindSamples,
      blocked_target_samples: blockedTargetSamples,
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
