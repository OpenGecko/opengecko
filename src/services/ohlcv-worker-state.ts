import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { ohlcvSyncTargets, type OhlcvSyncTargetRow } from '../db/schema';
import type { OhlcvPriorityTier, OhlcvSyncTargetSeed } from './ohlcv-targets';

const PRIORITY_RANK: Record<OhlcvPriorityTier, number> = {
  top100: 0,
  requested: 1,
  long_tail: 2,
};
const DAY_MS = 24 * 60 * 60 * 1000;

type OhlcvTargetKey = {
  coinId: string;
  exchangeId: string;
  symbol: string;
  interval: string;
  vsCurrency: string;
};

export function upsertOhlcvSyncTargets(database: AppDatabase, targets: OhlcvSyncTargetSeed[], now: Date) {
  for (const target of targets) {
    database.db
      .insert(ohlcvSyncTargets)
      .values({
        coinId: target.coinId,
        exchangeId: target.exchangeId,
        symbol: target.symbol,
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: target.priorityTier,
        latestSyncedAt: null,
        oldestSyncedAt: null,
        targetHistoryDays: target.targetHistoryDays,
        status: 'idle',
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        failureCount: 0,
        nextRetryAt: null,
        lastRequestedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [ohlcvSyncTargets.coinId, ohlcvSyncTargets.exchangeId, ohlcvSyncTargets.symbol, ohlcvSyncTargets.interval, ohlcvSyncTargets.vsCurrency],
        set: {
          priorityTier: sql`CASE
            WHEN ${ohlcvSyncTargets.priorityTier} = 'top100' THEN 'top100'
            WHEN ${target.priorityTier} = 'top100' THEN 'top100'
            WHEN ${ohlcvSyncTargets.priorityTier} = 'requested' THEN 'requested'
            WHEN ${target.priorityTier} = 'requested' THEN 'requested'
            ELSE 'long_tail'
          END`,
          targetHistoryDays: target.targetHistoryDays,
          updatedAt: now,
        },
      })
      .run();
  }
}

export function leaseNextOhlcvTarget(database: AppDatabase, now: Date): OhlcvSyncTargetRow | null {
  const candidates = database.db
    .select()
    .from(ohlcvSyncTargets)
    .where(
      and(
        or(
          eq(ohlcvSyncTargets.status, 'idle'),
          eq(ohlcvSyncTargets.status, 'failed'),
        ),
        or(isNull(ohlcvSyncTargets.nextRetryAt), lte(ohlcvSyncTargets.nextRetryAt, now)),
      ),
    )
    .orderBy(asc(ohlcvSyncTargets.lastSuccessAt), asc(ohlcvSyncTargets.updatedAt))
    .all();

  const remainingDepthDays = (target: OhlcvSyncTargetRow) => {
    const desiredOldestMs = now.getTime() - target.targetHistoryDays * DAY_MS;
    const historicalGapMs = target.oldestSyncedAt
      ? Math.max(target.oldestSyncedAt.getTime() - desiredOldestMs, 0)
      : target.targetHistoryDays * DAY_MS;

    return Math.ceil(historicalGapMs / DAY_MS);
  };

  const selected = [...candidates].sort((left, right) => {
    const priorityDifference = PRIORITY_RANK[left.priorityTier] - PRIORITY_RANK[right.priorityTier];

    if (priorityDifference !== 0) {
      return priorityDifference;
    }

    const leftRetryDue = left.status === 'failed' ? 0 : 1;
    const rightRetryDue = right.status === 'failed' ? 0 : 1;

    if (leftRetryDue !== rightRetryDue) {
      return leftRetryDue - rightRetryDue;
    }

    const depthDifference = remainingDepthDays(right) - remainingDepthDays(left);

    if (depthDifference !== 0) {
      return depthDifference;
    }

    const leftSuccess = left.lastSuccessAt?.getTime() ?? 0;
    const rightSuccess = right.lastSuccessAt?.getTime() ?? 0;

    if (leftSuccess !== rightSuccess) {
      return leftSuccess - rightSuccess;
    }

    return left.coinId.localeCompare(right.coinId);
  })[0];

  if (!selected) {
    return null;
  }

  database.db.update(ohlcvSyncTargets).set({
    status: 'running',
    lastAttemptAt: now,
    updatedAt: now,
  }).where(and(
    eq(ohlcvSyncTargets.coinId, selected.coinId),
    eq(ohlcvSyncTargets.exchangeId, selected.exchangeId),
    eq(ohlcvSyncTargets.symbol, selected.symbol),
    eq(ohlcvSyncTargets.interval, selected.interval),
    eq(ohlcvSyncTargets.vsCurrency, selected.vsCurrency),
  )).run();

  return database.db.select().from(ohlcvSyncTargets).where(and(
    eq(ohlcvSyncTargets.coinId, selected.coinId),
    eq(ohlcvSyncTargets.exchangeId, selected.exchangeId),
    eq(ohlcvSyncTargets.symbol, selected.symbol),
    eq(ohlcvSyncTargets.interval, selected.interval),
    eq(ohlcvSyncTargets.vsCurrency, selected.vsCurrency),
  )).get() ?? null;
}

export function markOhlcvTargetSuccess(
  database: AppDatabase,
  input: OhlcvTargetKey & { latestSyncedAt: Date | null; oldestSyncedAt: Date | null; completedAt: Date },
) {
  database.db.update(ohlcvSyncTargets).set({
    status: 'idle',
    latestSyncedAt: input.latestSyncedAt,
    oldestSyncedAt: input.oldestSyncedAt,
    lastSuccessAt: input.completedAt,
    lastError: null,
    failureCount: 0,
    nextRetryAt: null,
    updatedAt: input.completedAt,
  }).where(and(
    eq(ohlcvSyncTargets.coinId, input.coinId),
    eq(ohlcvSyncTargets.exchangeId, input.exchangeId),
    eq(ohlcvSyncTargets.symbol, input.symbol),
    eq(ohlcvSyncTargets.interval, input.interval),
    eq(ohlcvSyncTargets.vsCurrency, input.vsCurrency),
  )).run();
}

export function markOhlcvTargetFailure(
  database: AppDatabase,
  input: OhlcvTargetKey & { failedAt: Date; error: string },
) {
  const current = database.db.select().from(ohlcvSyncTargets).where(and(
    eq(ohlcvSyncTargets.coinId, input.coinId),
    eq(ohlcvSyncTargets.exchangeId, input.exchangeId),
    eq(ohlcvSyncTargets.symbol, input.symbol),
    eq(ohlcvSyncTargets.interval, input.interval),
    eq(ohlcvSyncTargets.vsCurrency, input.vsCurrency),
  )).get();

  if (!current) {
    return;
  }

  const failureCount = current.failureCount + 1;
  const backoffMinutes = 5 * (2 ** (failureCount - 1));
  const nextRetryAt = new Date(input.failedAt.getTime() + backoffMinutes * 60_000);

  database.db.update(ohlcvSyncTargets).set({
    status: 'failed',
    lastError: input.error,
    failureCount,
    nextRetryAt,
    updatedAt: input.failedAt,
  }).where(and(
    eq(ohlcvSyncTargets.coinId, input.coinId),
    eq(ohlcvSyncTargets.exchangeId, input.exchangeId),
    eq(ohlcvSyncTargets.symbol, input.symbol),
    eq(ohlcvSyncTargets.interval, input.interval),
    eq(ohlcvSyncTargets.vsCurrency, input.vsCurrency),
  )).run();
}

export function promoteOhlcvTargetPriority(
  database: AppDatabase,
  input: OhlcvTargetKey & { priorityTier: OhlcvPriorityTier; updatedAt: Date },
) {
  database.db.update(ohlcvSyncTargets).set({
    priorityTier: input.priorityTier,
    updatedAt: input.updatedAt,
  }).where(and(
    eq(ohlcvSyncTargets.coinId, input.coinId),
    eq(ohlcvSyncTargets.exchangeId, input.exchangeId),
    eq(ohlcvSyncTargets.symbol, input.symbol),
    eq(ohlcvSyncTargets.interval, input.interval),
    eq(ohlcvSyncTargets.vsCurrency, input.vsCurrency),
  )).run();
}
