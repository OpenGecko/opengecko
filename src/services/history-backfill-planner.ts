import type { CoverageTarget } from './coverage-targets';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_SYNC_WINDOW_DAYS = 30;
export const HISTORY_BACKFILL_CHUNK_DAYS = 180;

export type HistoryBackfillReason = 'missing' | 'stale' | 'production_stale' | 'shallow' | 'gap_repair';

export type ObservedCoverageTargetState = {
  family: CoverageTarget['family'];
  provider: string;
  coinId: string;
  interval: CoverageTarget['interval'];
  vsCurrency: string;
  latestAt: Date | null;
  oldestAt: Date | null;
  sourceRowCount: number;
  gaps?: Array<{
    from: Date;
    to: Date;
  }>;
};

export type HistoryBackfillTask = {
  family: CoverageTarget['family'];
  provider: string;
  coinId: string;
  interval: CoverageTarget['interval'];
  vsCurrency: string;
  from: Date;
  to: Date;
  reason: HistoryBackfillReason;
  priority: number;
};

export type HistoryBackfillPlannerOptions = {
  targets: CoverageTarget[];
  observed: ObservedCoverageTargetState[];
  now: Date;
};

const TIER_RANK: Record<CoverageTarget['tier'], number> = {
  S: 0,
  A: 1,
  B: 2,
  long_tail: 3,
};

const REASON_RANK: Record<HistoryBackfillReason, number> = {
  production_stale: 0,
  stale: 1,
  missing: 2,
  shallow: 3,
  gap_repair: 4,
};

function targetKey(input: Pick<CoverageTarget, 'family' | 'provider' | 'entityType' | 'entityId' | 'interval' | 'vsCurrency'>) {
  return [input.family, input.provider, input.entityType, input.entityId, input.interval, input.vsCurrency].join(':');
}

function observedKey(input: ObservedCoverageTargetState) {
  return [input.family, input.provider, 'coin', input.coinId, input.interval, input.vsCurrency].join(':');
}

function daysBefore(date: Date, days: number) {
  return new Date(date.getTime() - days * DAY_MS);
}

function buildTask(target: CoverageTarget, from: Date, to: Date, reason: HistoryBackfillReason): HistoryBackfillTask {
  return {
    family: target.family,
    provider: target.provider,
    coinId: target.entityId,
    interval: target.interval,
    vsCurrency: target.vsCurrency,
    from,
    to,
    reason,
    priority: target.priority,
  };
}

function compareTasks(targetByTaskKey: Map<string, CoverageTarget>) {
  return (left: HistoryBackfillTask, right: HistoryBackfillTask) => {
    const leftTarget = targetByTaskKey.get(taskTargetKey(left));
    const rightTarget = targetByTaskKey.get(taskTargetKey(right));
    const tierDiff = TIER_RANK[leftTarget?.tier ?? 'long_tail'] - TIER_RANK[rightTarget?.tier ?? 'long_tail'];

    if (tierDiff !== 0) {
      return tierDiff;
    }

    const reasonDiff = REASON_RANK[left.reason] - REASON_RANK[right.reason];

    if (reasonDiff !== 0) {
      return reasonDiff;
    }

    const priorityDiff = left.priority - right.priority;

    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    const familyDiff = left.family.localeCompare(right.family);

    if (familyDiff !== 0) {
      return familyDiff;
    }

    const providerDiff = left.provider.localeCompare(right.provider);

    if (providerDiff !== 0) {
      return providerDiff;
    }

    const coinDiff = left.coinId.localeCompare(right.coinId);

    if (coinDiff !== 0) {
      return coinDiff;
    }

    return left.interval.localeCompare(right.interval) || left.vsCurrency.localeCompare(right.vsCurrency);
  };
}

function taskTargetKey(input: HistoryBackfillTask) {
  return [input.family, input.provider, 'coin', input.coinId, input.interval, input.vsCurrency].join(':');
}

export function planHistoryBackfillTasks(options: HistoryBackfillPlannerOptions): HistoryBackfillTask[] {
  const observedByKey = new Map(options.observed.map((state) => [observedKey(state), state]));
  const enabledTargets = options.targets.filter((target) => target.enabled);
  const targetByTaskLookupKey = new Map(enabledTargets.map((target) => [targetKey(target), target]));
  const tasks: HistoryBackfillTask[] = [];

  for (const target of enabledTargets) {
    const state = observedByKey.get(targetKey(target));

    if (!state || !state.latestAt || !state.oldestAt || state.sourceRowCount <= 0) {
      const firstSyncWindowDays = Math.min(target.targetHistoryDays, FIRST_SYNC_WINDOW_DAYS);
      tasks.push(buildTask(
        target,
        daysBefore(options.now, firstSyncWindowDays),
        options.now,
        'missing',
      ));
      continue;
    }

    const latestAgeSeconds = Math.max((options.now.getTime() - state.latestAt.getTime()) / 1000, 0);

    if (latestAgeSeconds > target.freshnessSloSeconds) {
      tasks.push(buildTask(target, state.latestAt, options.now, 'stale'));
    } else if (latestAgeSeconds > target.productionFreshnessSloSeconds) {
      tasks.push(buildTask(target, state.latestAt, options.now, 'production_stale'));
    }

    const desiredOldest = daysBefore(options.now, target.targetHistoryDays);

    if (state.oldestAt.getTime() > desiredOldest.getTime()) {
      const from = new Date(Math.max(desiredOldest.getTime(), state.oldestAt.getTime() - HISTORY_BACKFILL_CHUNK_DAYS * DAY_MS));
      tasks.push(buildTask(target, from, state.oldestAt, 'shallow'));
    }

    for (const gap of state.gaps ?? []) {
      tasks.push(buildTask(target, gap.from, gap.to, 'gap_repair'));
    }
  }

  return tasks.sort(compareTasks(targetByTaskLookupKey));
}
