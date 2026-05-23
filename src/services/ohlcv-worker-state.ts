import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { ohlcvSyncTargets, type OhlcvSyncTargetRow } from '../db/schema';
import type { OhlcvPriorityTier, OhlcvSyncTargetSeed } from './ohlcv-targets';
import {
  DEFAULT_OHLCV_LEASE_TTL_MS,
  isOhlcvLeaseExpired,
  selectNextOhlcvLeaseTarget,
} from './ohlcv-scheduling-policy';

type OhlcvTargetKey = {
  coinId: string;
  exchangeId: string;
  symbol: string;
  interval: string;
  vsCurrency: string;
};

type OhlcvLeaseIdentity = {
  leaseOwner?: string | null;
  leaseToken?: string | null;
};

type OhlcvLeaseOptions = {
  leaseOwner?: string;
  leaseToken?: string;
  leaseTtlMs?: number;
};

function defaultLeaseOwner() {
  return `ohlcv-worker:${process.pid}`;
}

function extractChangedRows(result: unknown) {
  if (result && typeof result === 'object' && 'changes' in result) {
    const changes = (result as { changes?: unknown }).changes;
    return typeof changes === 'number' ? changes : 0;
  }

  return 0;
}

function targetKeyWhere(input: OhlcvTargetKey) {
  return and(
    eq(ohlcvSyncTargets.coinId, input.coinId),
    eq(ohlcvSyncTargets.exchangeId, input.exchangeId),
    eq(ohlcvSyncTargets.symbol, input.symbol),
    eq(ohlcvSyncTargets.interval, input.interval),
    eq(ohlcvSyncTargets.vsCurrency, input.vsCurrency),
  );
}

function readTarget(database: AppDatabase, input: OhlcvTargetKey) {
  return database.db.select().from(ohlcvSyncTargets).where(targetKeyWhere(input)).get() ?? null;
}

function hasMatchingLease(row: OhlcvSyncTargetRow, input: OhlcvLeaseIdentity) {
  if (input.leaseToken !== undefined && row.leaseToken !== input.leaseToken) {
    return false;
  }

  if (input.leaseOwner !== undefined && row.leaseOwner !== input.leaseOwner) {
    return false;
  }

  return true;
}

function hasRequiredLeaseIdentity(input: OhlcvLeaseIdentity): input is { leaseOwner: string; leaseToken: string } {
  return typeof input.leaseOwner === 'string'
    && input.leaseOwner.length > 0
    && typeof input.leaseToken === 'string'
    && input.leaseToken.length > 0;
}

function activeLeaseWhere(input: OhlcvTargetKey & { leaseOwner: string; leaseToken: string }, activeAt: Date) {
  return and(
    targetKeyWhere(input),
    eq(ohlcvSyncTargets.status, 'running'),
    eq(ohlcvSyncTargets.leaseOwner, input.leaseOwner),
    eq(ohlcvSyncTargets.leaseToken, input.leaseToken),
    isNotNull(ohlcvSyncTargets.leaseExpiresAt),
    gt(ohlcvSyncTargets.leaseExpiresAt, activeAt),
  );
}

function classifyLeaseRecoveryReason(target: OhlcvSyncTargetRow, now: Date, leaseTtlMs: number) {
  if (target.status !== 'running' || !isOhlcvLeaseExpired(target, now, leaseTtlMs)) {
    return null;
  }

  if (target.leaseExpiresAt) {
    return 'expired_lease_deadline';
  }

  if (target.lastAttemptAt) {
    return 'legacy_running_without_deadline';
  }

  return 'running_without_attempt_or_deadline';
}

export function upsertOhlcvSyncTargets(database: AppDatabase, targets: OhlcvSyncTargetSeed[], now: Date) {
  for (const target of targets) {
    database.db
      .insert(ohlcvSyncTargets)
      .values({
        coinId: target.coinId,
        exchangeId: target.exchangeId,
        symbol: target.symbol,
        vsCurrency: 'usd',
        interval: target.interval,
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

export function leaseNextOhlcvTarget(
  database: AppDatabase,
  now: Date,
  options: OhlcvLeaseOptions = {},
): OhlcvSyncTargetRow | null {
  const leaseOwner = options.leaseOwner ?? defaultLeaseOwner();
  const leaseToken = options.leaseToken ?? randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_OHLCV_LEASE_TTL_MS;
  const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);
  const legacyStaleCutoff = new Date(now.getTime() - leaseTtlMs);
  const candidates = database.db
    .select()
    .from(ohlcvSyncTargets)
    .where(
      or(
        and(
          or(
            eq(ohlcvSyncTargets.status, 'idle'),
            eq(ohlcvSyncTargets.status, 'failed'),
          ),
          or(isNull(ohlcvSyncTargets.nextRetryAt), lte(ohlcvSyncTargets.nextRetryAt, now)),
        ),
        eq(ohlcvSyncTargets.status, 'running'),
      ),
    )
    .orderBy(asc(ohlcvSyncTargets.lastSuccessAt), asc(ohlcvSyncTargets.updatedAt))
    .all();

  let remainingCandidates = candidates;
  while (remainingCandidates.length > 0) {
    const selected = selectNextOhlcvLeaseTarget(remainingCandidates, now, leaseTtlMs);

    if (!selected) {
      return null;
    }

    const recoveryReason = classifyLeaseRecoveryReason(selected, now, leaseTtlMs);
    const changedRows = extractChangedRows(database.client.prepare(`
      UPDATE ohlcv_sync_targets
      SET
        status = 'running',
        lease_owner = ?,
        lease_token = ?,
        lease_acquired_at = ?,
        lease_expires_at = ?,
        last_attempt_at = ?,
        updated_at = ?,
        lease_recovery_count = CASE
          WHEN status = 'running' THEN lease_recovery_count + 1
          ELSE lease_recovery_count
        END,
        last_lease_recovered_at = CASE
          WHEN status = 'running' THEN ?
          ELSE last_lease_recovered_at
        END,
        last_lease_recovery_reason = CASE
          WHEN status = 'running' THEN ?
          ELSE last_lease_recovery_reason
        END
      WHERE coin_id = ?
        AND exchange_id = ?
        AND symbol = ?
        AND interval = ?
        AND vs_currency = ?
        AND (
          (
            status IN ('idle', 'failed')
            AND (next_retry_at IS NULL OR next_retry_at <= ?)
          )
          OR (
            status = 'running'
            AND (
              (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
              OR (
                lease_expires_at IS NULL
                AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
              )
            )
          )
        )
    `).run(
      leaseOwner,
      leaseToken,
      now.getTime(),
      leaseExpiresAt.getTime(),
      now.getTime(),
      now.getTime(),
      recoveryReason ? now.getTime() : null,
      recoveryReason,
      selected.coinId,
      selected.exchangeId,
      selected.symbol,
      selected.interval,
      selected.vsCurrency,
      now.getTime(),
      now.getTime(),
      legacyStaleCutoff.getTime(),
    ));

    if (changedRows > 0) {
      return readTarget(database, selected);
    }

    remainingCandidates = remainingCandidates.filter((candidate) =>
      candidate.coinId !== selected.coinId
      || candidate.exchangeId !== selected.exchangeId
      || candidate.symbol !== selected.symbol
      || candidate.interval !== selected.interval
      || candidate.vsCurrency !== selected.vsCurrency);
  }

  return null;
}

export function isOhlcvTargetLeaseActive(
  database: AppDatabase,
  input: OhlcvTargetKey & OhlcvLeaseIdentity & { activeAt: Date },
) {
  if (!hasRequiredLeaseIdentity(input)) {
    return false;
  }

  return database.client.prepare(`
    SELECT 1
    FROM ohlcv_sync_targets
    WHERE coin_id = ?
      AND exchange_id = ?
      AND symbol = ?
      AND interval = ?
      AND vs_currency = ?
      AND status = 'running'
      AND lease_owner = ?
      AND lease_token = ?
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > ?
    LIMIT 1
  `).get(
    input.coinId,
    input.exchangeId,
    input.symbol,
    input.interval,
    input.vsCurrency,
    input.leaseOwner,
    input.leaseToken,
    input.activeAt.getTime(),
  ) !== undefined;
}

export function markOhlcvTargetSuccess(
  database: AppDatabase,
  input: OhlcvTargetKey & OhlcvLeaseIdentity & { latestSyncedAt: Date | null; oldestSyncedAt: Date | null; completedAt: Date },
) {
  if (!hasRequiredLeaseIdentity(input)) {
    return false;
  }

  const changedRows = extractChangedRows(database.db.update(ohlcvSyncTargets).set({
    status: 'idle',
    latestSyncedAt: input.latestSyncedAt,
    oldestSyncedAt: input.oldestSyncedAt,
    lastSuccessAt: input.completedAt,
    lastError: null,
    failureCount: 0,
    nextRetryAt: null,
    leaseOwner: null,
    leaseToken: null,
    leaseAcquiredAt: null,
    leaseExpiresAt: null,
    updatedAt: input.completedAt,
  }).where(activeLeaseWhere(input, input.completedAt)).run());

  return changedRows > 0;
}

export function markOhlcvTargetFailure(
  database: AppDatabase,
  input: OhlcvTargetKey & OhlcvLeaseIdentity & { failedAt: Date; error: string },
) {
  if (!hasRequiredLeaseIdentity(input)) {
    return false;
  }

  const current = readTarget(database, input);

  if (!current || !hasMatchingLease(current, input)) {
    return false;
  }

  const failureCount = current.failureCount + 1;
  const backoffMinutes = 5 * (2 ** (failureCount - 1));
  const nextRetryAt = new Date(input.failedAt.getTime() + backoffMinutes * 60_000);

  const changedRows = extractChangedRows(database.db.update(ohlcvSyncTargets).set({
    status: 'failed',
    lastError: input.error,
    failureCount,
    nextRetryAt,
    leaseOwner: null,
    leaseToken: null,
    leaseAcquiredAt: null,
    leaseExpiresAt: null,
    updatedAt: input.failedAt,
  }).where(activeLeaseWhere(input, input.failedAt)).run());

  return changedRows > 0;
}

export function promoteOhlcvTargetPriority(
  database: AppDatabase,
  input: OhlcvTargetKey & { priorityTier: OhlcvPriorityTier; updatedAt: Date },
) {
  database.db.update(ohlcvSyncTargets).set({
    priorityTier: input.priorityTier,
    updatedAt: input.updatedAt,
  }).where(targetKeyWhere(input)).run();
}
