import { randomUUID } from 'node:crypto';

import type { AppDatabase, SqliteDatabasePathClass } from './runtime';
import { classifyDatabasePath } from './runtime';
import { sanitizeDiagnosticText } from '../services/diagnostic-sanitizer';

export type SqliteProcessRole = 'api' | 'worker' | 'validation' | 'test' | 'unknown';

export type SqliteWorkLease = {
  family: string;
  leaseOwner: string;
  leaseToken: string;
  acquiredAt: Date;
  expiresAt: Date;
};

type AcquireSqliteWorkLeaseOptions = {
  leaseOwner?: string;
  leaseToken?: string;
  leaseTtlMs?: number;
};

export type SqliteWorkLeaseAcquisition =
  | {
    acquired: true;
    lease: SqliteWorkLease;
  }
  | {
    acquired: false;
    family: string;
    skippedReason: 'active_lease';
    activeOwner: string | null;
    activeExpiresAt: Date | null;
  };

export const DEFAULT_SQLITE_WORK_LEASE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_SQLITE_PROCESS_HEARTBEAT_FRESHNESS_MS = 2 * 60 * 1000;
const DEFAULT_SQLITE_PROCESS_HEARTBEAT_REFRESH_INTERVAL_MS = 30 * 1000;

export type SqliteProcessHeartbeatRegistration = {
  processId: string;
  refresh: (now?: Date) => boolean;
  markInactive: (now?: Date) => boolean;
  stop: () => void;
};

type RegisterSqliteProcessHeartbeatOptions = {
  autoRefresh?: boolean;
  refreshIntervalMs?: number;
};

type SqliteCoordinationDiagnosticsOptions = {
  processHeartbeatFreshnessMs?: number;
};

function extractChangedRows(result: unknown) {
  if (result && typeof result === 'object' && 'changes' in result) {
    const changes = (result as { changes?: unknown }).changes;
    return typeof changes === 'number' ? changes : 0;
  }

  return 0;
}

function parseTimestamp(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value);
}

function iso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function redactSensitiveSqliteCoordinationText(value: string) {
  return /api[_-]?key|bearer|password|secret|token/i.test(value)
    ? '[sqlite coordination value redacted]'
    : value;
}

function processIdFor(role: SqliteProcessRole) {
  return `${role}:${process.pid}`;
}

export function ensureSqliteCoordinationTables(database: AppDatabase) {
  database.client.exec(`
    CREATE TABLE IF NOT EXISTS opengecko_sqlite_refresh_revisions (
      family text PRIMARY KEY NOT NULL,
      revision integer NOT NULL DEFAULT 0,
      status text NOT NULL,
      active_owner text,
      started_at integer,
      committed_at integer,
      failed_at integer,
      degraded_reason text,
      affected_tables_json text NOT NULL DEFAULT '[]',
      updated_at integer NOT NULL
    );

    CREATE TABLE IF NOT EXISTS opengecko_sqlite_work_leases (
      family text PRIMARY KEY NOT NULL,
      lease_owner text,
      lease_token text,
      lease_acquired_at integer,
      lease_expires_at integer,
      lease_recovery_count integer NOT NULL DEFAULT 0,
      skipped_duplicate_count integer NOT NULL DEFAULT 0,
      serialized_run_count integer NOT NULL DEFAULT 0,
      last_contention_at integer,
      last_released_at integer,
      updated_at integer NOT NULL
    );

    CREATE TABLE IF NOT EXISTS opengecko_sqlite_process_heartbeats (
      process_id text PRIMARY KEY NOT NULL,
      role text NOT NULL,
      db_path text NOT NULL,
      path_class text NOT NULL,
      started_at integer NOT NULL,
      updated_at integer NOT NULL,
      status text NOT NULL
    );

    CREATE INDEX IF NOT EXISTS opengecko_sqlite_process_heartbeats_role_updated_at_idx
      ON opengecko_sqlite_process_heartbeats (role, updated_at);
  `);
}

export function withSqliteImmediateTransaction<T>(
  database: AppDatabase,
  operation: () => T,
) {
  database.client.exec('BEGIN IMMEDIATE');

  try {
    const result = operation();
    database.client.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.client.exec('ROLLBACK');
    } catch {
      // Preserve the original write failure; SQLite diagnostics already record rollback failures.
    }
    throw error;
  }
}

export function recordSqliteRefreshCommitted(
  database: AppDatabase,
  family: string,
  committedAt: Date,
  affectedTables: string[],
  leaseOwner: string | null = null,
) {
  ensureSqliteCoordinationTables(database);
  const current = database.client.prepare<{ revision: number }>(
    'SELECT revision FROM opengecko_sqlite_refresh_revisions WHERE family = ?',
  ).get(family);
  const nextRevision = (current?.revision ?? 0) + 1;

  database.client.prepare(`
    INSERT INTO opengecko_sqlite_refresh_revisions (
      family,
      revision,
      status,
      active_owner,
      started_at,
      committed_at,
      failed_at,
      degraded_reason,
      affected_tables_json,
      updated_at
    )
    VALUES (?, ?, 'committed', NULL, ?, ?, NULL, NULL, ?, ?)
    ON CONFLICT(family) DO UPDATE SET
      revision = excluded.revision,
      status = excluded.status,
      active_owner = excluded.active_owner,
      started_at = excluded.started_at,
      committed_at = excluded.committed_at,
      failed_at = excluded.failed_at,
      degraded_reason = excluded.degraded_reason,
      affected_tables_json = excluded.affected_tables_json,
      updated_at = excluded.updated_at
  `).run(
    family,
    nextRevision,
    committedAt.getTime(),
    committedAt.getTime(),
    JSON.stringify([...new Set(affectedTables)].sort()),
    committedAt.getTime(),
  );

  return {
    family,
    revision: nextRevision,
    status: 'committed' as const,
    leaseOwner,
  };
}

export function recordSqliteRefreshFailed(
  database: AppDatabase,
  family: string,
  failedAt: Date,
  affectedTables: string[],
  error: unknown,
  leaseOwner: string | null = null,
) {
  ensureSqliteCoordinationTables(database);
  const current = database.client.prepare<{ revision: number }>(
    'SELECT revision FROM opengecko_sqlite_refresh_revisions WHERE family = ?',
  ).get(family);

  database.client.prepare(`
    INSERT INTO opengecko_sqlite_refresh_revisions (
      family,
      revision,
      status,
      active_owner,
      started_at,
      committed_at,
      failed_at,
      degraded_reason,
      affected_tables_json,
      updated_at
    )
    VALUES (?, ?, 'degraded', ?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(family) DO UPDATE SET
      revision = excluded.revision,
      status = excluded.status,
      active_owner = excluded.active_owner,
      failed_at = excluded.failed_at,
      degraded_reason = excluded.degraded_reason,
      affected_tables_json = excluded.affected_tables_json,
      updated_at = excluded.updated_at
  `).run(
    family,
    current?.revision ?? 0,
    leaseOwner,
    failedAt.getTime(),
    failedAt.getTime(),
    sanitizeDiagnosticText(error),
    JSON.stringify([...new Set(affectedTables)].sort()),
    failedAt.getTime(),
  );
}

export function acquireSqliteWorkLease(
  database: AppDatabase,
  family: string,
  now: Date,
  options: AcquireSqliteWorkLeaseOptions = {},
): SqliteWorkLeaseAcquisition {
  ensureSqliteCoordinationTables(database);
  const leaseOwner = options.leaseOwner ?? `worker:${process.pid}`;
  const leaseToken = options.leaseToken ?? randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_SQLITE_WORK_LEASE_TTL_MS;
  const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);

  return withSqliteImmediateTransaction(database, () => {
    database.client.prepare(`
      INSERT OR IGNORE INTO opengecko_sqlite_work_leases (
        family,
        lease_owner,
        lease_token,
        lease_acquired_at,
        lease_expires_at,
        updated_at
      )
      VALUES (?, NULL, NULL, NULL, NULL, ?)
    `).run(family, now.getTime());

    const changedRows = extractChangedRows(database.client.prepare(`
      UPDATE opengecko_sqlite_work_leases
      SET
        lease_owner = ?,
        lease_token = ?,
        lease_acquired_at = ?,
        lease_expires_at = ?,
        lease_recovery_count = CASE
          WHEN lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          THEN lease_recovery_count + 1
          ELSE lease_recovery_count
        END,
        serialized_run_count = serialized_run_count + 1,
        updated_at = ?
      WHERE family = ?
        AND (
          lease_owner IS NULL
          OR lease_expires_at IS NULL
          OR lease_expires_at <= ?
        )
    `).run(
      leaseOwner,
      leaseToken,
      now.getTime(),
      leaseExpiresAt.getTime(),
      now.getTime(),
      now.getTime(),
      family,
      now.getTime(),
    ));

    if (changedRows > 0) {
      return {
        acquired: true,
        lease: {
          family,
          leaseOwner,
          leaseToken,
          acquiredAt: now,
          expiresAt: leaseExpiresAt,
        },
      };
    }

    const active = database.client.prepare<{ lease_owner: string | null; lease_expires_at: number | null }>(`
      SELECT lease_owner, lease_expires_at
      FROM opengecko_sqlite_work_leases
      WHERE family = ?
    `).get(family);

    database.client.prepare(`
      UPDATE opengecko_sqlite_work_leases
      SET
        skipped_duplicate_count = skipped_duplicate_count + 1,
        last_contention_at = ?,
        updated_at = ?
      WHERE family = ?
    `).run(now.getTime(), now.getTime(), family);

    return {
      acquired: false,
      family,
      skippedReason: 'active_lease',
      activeOwner: active?.lease_owner ?? null,
      activeExpiresAt: parseTimestamp(active?.lease_expires_at),
    };
  });
}

export function releaseSqliteWorkLease(
  database: AppDatabase,
  lease: SqliteWorkLease,
  releasedAt = new Date(),
) {
  ensureSqliteCoordinationTables(database);
  const changedRows = extractChangedRows(database.client.prepare(`
    UPDATE opengecko_sqlite_work_leases
    SET
      lease_owner = NULL,
      lease_token = NULL,
      lease_acquired_at = NULL,
      lease_expires_at = NULL,
      last_released_at = ?,
      updated_at = ?
    WHERE family = ?
      AND lease_owner = ?
      AND lease_token = ?
  `).run(
    releasedAt.getTime(),
    releasedAt.getTime(),
    lease.family,
    lease.leaseOwner,
    lease.leaseToken,
  ));

  return changedRows > 0;
}

export function registerSqliteProcessHeartbeat(
  database: AppDatabase,
  role: SqliteProcessRole,
  now = new Date(),
  processId = processIdFor(role),
  options: RegisterSqliteProcessHeartbeatOptions = {},
): SqliteProcessHeartbeatRegistration {
  ensureSqliteCoordinationTables(database);
  const pathClass = classifyDatabasePath(database.url);

  database.client.prepare(`
    INSERT INTO opengecko_sqlite_process_heartbeats (
      process_id,
      role,
      db_path,
      path_class,
      started_at,
      updated_at,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(process_id) DO UPDATE SET
      role = excluded.role,
      db_path = excluded.db_path,
      path_class = excluded.path_class,
      updated_at = excluded.updated_at,
      status = excluded.status
  `).run(
    processId,
    role,
    database.url,
    pathClass,
    now.getTime(),
    now.getTime(),
  );

  const refresh = (refreshedAt = new Date()) => {
    ensureSqliteCoordinationTables(database);
    const changedRows = extractChangedRows(database.client.prepare(`
      UPDATE opengecko_sqlite_process_heartbeats
      SET
        updated_at = ?,
        status = 'active'
      WHERE process_id = ?
    `).run(refreshedAt.getTime(), processId));

    return changedRows > 0;
  };

  const markInactive = (inactiveAt = new Date()) => markSqliteProcessHeartbeatInactive(
    database,
    processId,
    inactiveAt,
  );

  const autoRefresh = options.autoRefresh ?? arguments.length <= 2;
  const refreshIntervalMs = Math.max(
    Math.min(
      options.refreshIntervalMs ?? DEFAULT_SQLITE_PROCESS_HEARTBEAT_REFRESH_INTERVAL_MS,
      DEFAULT_SQLITE_PROCESS_HEARTBEAT_FRESHNESS_MS,
    ),
    1_000,
  );
  let timer: NodeJS.Timeout | null = null;

  if (autoRefresh) {
    timer = setInterval(() => {
      try {
        refresh();
      } catch {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }
    }, refreshIntervalMs);
    timer.unref();
  }

  return {
    processId,
    refresh,
    markInactive,
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export function markSqliteProcessHeartbeatInactive(
  database: AppDatabase,
  processId: string,
  now = new Date(),
) {
  ensureSqliteCoordinationTables(database);
  const changedRows = extractChangedRows(database.client.prepare(`
    UPDATE opengecko_sqlite_process_heartbeats
    SET
      updated_at = ?,
      status = 'inactive'
    WHERE process_id = ?
  `).run(now.getTime(), processId));

  return changedRows > 0;
}

function readJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

export function buildSqliteCoordinationDiagnostics(
  database: AppDatabase,
  now = new Date(),
  options: SqliteCoordinationDiagnosticsOptions = {},
) {
  ensureSqliteCoordinationTables(database);
  const revisions = database.client.prepare<{
    family: string;
    revision: number;
    status: string;
    active_owner: string | null;
    started_at: number | null;
    committed_at: number | null;
    failed_at: number | null;
    degraded_reason: string | null;
    affected_tables_json: string | null;
    updated_at: number;
  }>('SELECT * FROM opengecko_sqlite_refresh_revisions ORDER BY family').all();
  const leases = database.client.prepare<{
    family: string;
    lease_owner: string | null;
    lease_acquired_at: number | null;
    lease_expires_at: number | null;
    lease_recovery_count: number;
    skipped_duplicate_count: number;
    serialized_run_count: number;
    last_contention_at: number | null;
    last_released_at: number | null;
    updated_at: number;
  }>('SELECT * FROM opengecko_sqlite_work_leases ORDER BY family').all();
  const processes = database.client.prepare<{
    process_id: string;
    role: SqliteProcessRole;
    db_path: string;
    path_class: SqliteDatabasePathClass;
    started_at: number;
    updated_at: number;
    status: string;
  }>('SELECT * FROM opengecko_sqlite_process_heartbeats ORDER BY role, process_id').all();
  const processHeartbeatFreshnessMs = options.processHeartbeatFreshnessMs
    ?? DEFAULT_SQLITE_PROCESS_HEARTBEAT_FRESHNESS_MS;
  const processDiagnostics = processes.map((process) => {
    const ageMs = Math.max(now.getTime() - process.updated_at, 0);
    const isFresh = ageMs <= processHeartbeatFreshnessMs;
    const active = process.status === 'active' && isFresh;
    const status = process.status === 'active' && !isFresh ? 'stale' : process.status;

    return {
      process_id: process.process_id,
      role: process.role,
      db_path: redactSensitiveSqliteCoordinationText(process.db_path),
      path_class: process.path_class,
      started_at: iso(parseTimestamp(process.started_at)),
      updated_at: iso(parseTimestamp(process.updated_at)),
      age_seconds: Math.max(Math.floor(ageMs / 1000), 0),
      active,
      status,
      stored_status: process.status,
      freshness_window_seconds: Math.floor(processHeartbeatFreshnessMs / 1000),
    };
  });
  const activeProcesses = processes.filter((process) => {
    const ageMs = Math.max(now.getTime() - process.updated_at, 0);
    return process.status === 'active' && ageMs <= processHeartbeatFreshnessMs;
  });
  const dbPaths = [...new Set(activeProcesses.map((process) => process.db_path))].sort();
  const roles = [...new Set(activeProcesses.map((process) => process.role))].sort();
  const updatedTimestamps = [
    ...revisions.map((revision) => revision.updated_at),
    ...leases.map((lease) => lease.updated_at),
    ...processes.map((process) => process.updated_at),
  ];
  const generatedAtMs = updatedTimestamps.length > 0
    ? Math.max(...updatedTimestamps)
    : now.getTime();

  return {
    generated_at: new Date(generatedAtMs).toISOString(),
    revisions: revisions.map((revision) => ({
      family: revision.family,
      revision: revision.revision,
      status: revision.status,
      active_owner: revision.active_owner,
      started_at: iso(parseTimestamp(revision.started_at)),
      committed_at: iso(parseTimestamp(revision.committed_at)),
      failed_at: iso(parseTimestamp(revision.failed_at)),
      degraded_reason: sanitizeDiagnosticText(revision.degraded_reason ?? ''),
      affected_tables: readJsonArray(revision.affected_tables_json),
      updated_at: iso(parseTimestamp(revision.updated_at)),
    })),
    work_leases: leases.map((lease) => ({
      family: lease.family,
      active: lease.lease_owner !== null && (lease.lease_expires_at === null || lease.lease_expires_at > now.getTime()),
      lease_owner: lease.lease_owner,
      lease_acquired_at: iso(parseTimestamp(lease.lease_acquired_at)),
      lease_expires_at: iso(parseTimestamp(lease.lease_expires_at)),
      lease_recovery_count: lease.lease_recovery_count,
      skipped_duplicate_count: lease.skipped_duplicate_count,
      serialized_run_count: lease.serialized_run_count,
      last_contention_at: iso(parseTimestamp(lease.last_contention_at)),
      last_released_at: iso(parseTimestamp(lease.last_released_at)),
      updated_at: iso(parseTimestamp(lease.updated_at)),
    })),
    process_heartbeats: processDiagnostics,
    shared_database: {
      observed_process_count: activeProcesses.length,
      observed_roles: roles,
      db_paths: dbPaths.map(redactSensitiveSqliteCoordinationText),
      single_shared_path: dbPaths.length <= 1,
      api_worker_shared: roles.includes('api') && roles.includes('worker') && dbPaths.length === 1,
      heartbeat_freshness_window_seconds: Math.floor(processHeartbeatFreshnessMs / 1000),
      total_known_process_count: processes.length,
      stale_process_count: processDiagnostics.filter((process) => process.status === 'stale').length,
      inactive_process_count: processDiagnostics.filter((process) => process.status === 'inactive').length,
    },
  };
}
