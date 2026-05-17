import type { OhlcvSyncTargetRow } from '../db/schema';
import type { OhlcvPriorityTier } from './ohlcv-targets';

export const OHLCV_DAY_MS = 24 * 60 * 60 * 1000;

const PRIORITY_RANK: Record<OhlcvPriorityTier, number> = {
  top100: 0,
  requested: 1,
  long_tail: 2,
};

const INTERVAL_RECENT_FRESHNESS_MS: Record<string, number> = {
  '1m': 5 * 60 * 1000,
  '1d': OHLCV_DAY_MS,
};

const INTERVAL_LEASE_RANK: Record<string, number> = {
  '1m': 0,
  '1d': 1,
};

export type OhlcvSchedulingTarget = Pick<
  OhlcvSyncTargetRow,
  | 'coinId'
  | 'exchangeId'
  | 'symbol'
  | 'vsCurrency'
  | 'interval'
  | 'priorityTier'
  | 'latestSyncedAt'
  | 'oldestSyncedAt'
  | 'targetHistoryDays'
  | 'status'
  | 'lastSuccessAt'
  | 'updatedAt'
  | 'nextRetryAt'
>;

export type OhlcvCursorCandle = {
  timestamp: number;
};

export function getOhlcvTargetHistoricalGapMs(target: Pick<OhlcvSchedulingTarget, 'oldestSyncedAt' | 'targetHistoryDays'>, now: Date) {
  const desiredOldestMs = now.getTime() - target.targetHistoryDays * OHLCV_DAY_MS;

  return target.oldestSyncedAt
    ? Math.max(target.oldestSyncedAt.getTime() - desiredOldestMs, 0)
    : target.targetHistoryDays * OHLCV_DAY_MS;
}

export function getOhlcvTargetRemainingDepthDays(target: Pick<OhlcvSchedulingTarget, 'oldestSyncedAt' | 'targetHistoryDays'>, now: Date) {
  return Math.ceil(getOhlcvTargetHistoricalGapMs(target, now) / OHLCV_DAY_MS);
}

export function isOhlcvRecentCoverageCurrentEnough(latestSyncedAt: Date | null, now: Date) {
  if (!latestSyncedAt) {
    return false;
  }

  return latestSyncedAt.getTime() >= now.getTime() - OHLCV_DAY_MS;
}

export function isOhlcvTargetLeaseEligible(target: Pick<OhlcvSchedulingTarget, 'status' | 'nextRetryAt'>, now: Date) {
  return (target.status === 'idle' || target.status === 'failed')
    && (!target.nextRetryAt || target.nextRetryAt.getTime() <= now.getTime());
}

function isTargetRecentStale(target: Pick<OhlcvSchedulingTarget, 'interval' | 'latestSyncedAt'>, now: Date) {
  const freshnessMs = INTERVAL_RECENT_FRESHNESS_MS[target.interval] ?? OHLCV_DAY_MS;

  return !target.latestSyncedAt || target.latestSyncedAt.getTime() < now.getTime() - freshnessMs;
}

export function compareOhlcvLeaseTargets(left: OhlcvSchedulingTarget, right: OhlcvSchedulingTarget, now: Date) {
  const priorityDifference = PRIORITY_RANK[left.priorityTier] - PRIORITY_RANK[right.priorityTier];

  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const leftRetryDue = left.status === 'failed' ? 0 : 1;
  const rightRetryDue = right.status === 'failed' ? 0 : 1;

  if (leftRetryDue !== rightRetryDue) {
    return leftRetryDue - rightRetryDue;
  }

  const leftRecentStale = isTargetRecentStale(left, now) ? 0 : 1;
  const rightRecentStale = isTargetRecentStale(right, now) ? 0 : 1;

  if (leftRecentStale !== rightRecentStale) {
    return leftRecentStale - rightRecentStale;
  }

  const intervalDifference = (INTERVAL_LEASE_RANK[left.interval] ?? 10) - (INTERVAL_LEASE_RANK[right.interval] ?? 10);

  if (intervalDifference !== 0) {
    return intervalDifference;
  }

  const depthDifference = getOhlcvTargetRemainingDepthDays(right, now) - getOhlcvTargetRemainingDepthDays(left, now);

  if (depthDifference !== 0) {
    return depthDifference;
  }

  const leftSuccess = left.lastSuccessAt?.getTime() ?? 0;
  const rightSuccess = right.lastSuccessAt?.getTime() ?? 0;

  if (leftSuccess !== rightSuccess) {
    return leftSuccess - rightSuccess;
  }

  return left.coinId.localeCompare(right.coinId);
}

export function rankOhlcvLeaseTargets<T extends OhlcvSchedulingTarget>(targets: readonly T[], now: Date): T[] {
  return targets
    .filter((target) => isOhlcvTargetLeaseEligible(target, now))
    .sort((left, right) => compareOhlcvLeaseTargets(left, right, now));
}

export function selectNextOhlcvLeaseTarget<T extends OhlcvSchedulingTarget>(targets: readonly T[], now: Date): T | null {
  return rankOhlcvLeaseTargets(targets, now)[0] ?? null;
}

export function deriveOhlcvLatestSyncedAt(
  target: Pick<OhlcvSchedulingTarget, 'latestSyncedAt'>,
  acceptedRecentCandles: readonly OhlcvCursorCandle[],
) {
  const lastAcceptedRecentCandle = acceptedRecentCandles.at(-1);

  return lastAcceptedRecentCandle
    ? new Date(lastAcceptedRecentCandle.timestamp)
    : target.latestSyncedAt;
}

export function deriveOhlcvOldestSyncedAt(
  target: Pick<OhlcvSchedulingTarget, 'oldestSyncedAt'>,
  acceptedHistoricalCandles: readonly OhlcvCursorCandle[],
) {
  const firstAcceptedHistoricalCandle = acceptedHistoricalCandles[0];

  return firstAcceptedHistoricalCandle
    ? new Date(firstAcceptedHistoricalCandle.timestamp)
    : target.oldestSyncedAt;
}

export function shouldDeepenOhlcvHistory(
  target: Pick<OhlcvSchedulingTarget, 'latestSyncedAt'>,
  nextLatestSyncedAt: Date | null,
  now: Date,
) {
  return isOhlcvRecentCoverageCurrentEnough(target.latestSyncedAt, now)
    && isOhlcvRecentCoverageCurrentEnough(nextLatestSyncedAt, now);
}
