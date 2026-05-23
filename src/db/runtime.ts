import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import type { Database as BetterSqlite3DatabaseClient } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Database as BunDatabase } from 'bun:sqlite';

import {
  createSqliteDiagnosticState,
  instrumentSqliteClient,
  MAX_SQLITE_RECENT_FAILURES,
  recordSqliteDiagnosticFailure,
  type SqliteDiagnosticFailureSample,
  type SqliteDiagnosticState,
} from './sqlite-diagnostics';
import {
  assetPlatforms,
  categories,
  chartResponseSourceCounters,
  chartResponseSourceEvents,
  chartPoints,
  coinHistorySnapshots,
  coins,
  derivativeTickers,
  derivativesExchanges,
  exchangeVolumePoints,
  exchangeVolumeSourcePoints,
  marketSnapshots,
  marketChartSourcePoints,
  ohlcvCandles,
  ohlcvSyncTargets,
  optionalProviderJobRuns,
  onchainDexes,
  onchainNetworks,
  onchainPoolOhlcv,
  onchainPoolTrades,
  onchainPools,
  onchainTokenHolderCounts,
  onchainTokenHolders,
  onchainTokenTraders,
  quoteSnapshots,
  supplyChartPoints,
  treasuryEntities,
  treasuryHoldings,
  treasurySourceDocuments,
  treasuryTransactions,
} from './schema';

export {
  createSqliteDiagnosticState,
  recordSqliteDiagnosticFailure,
  type SqliteDiagnosticFailureClassification,
  type SqliteDiagnosticFailureSample,
  type SqliteDiagnosticState,
} from './sqlite-diagnostics';


const schema = {
  assetPlatforms,
  categories,
  chartResponseSourceCounters,
  chartResponseSourceEvents,
  chartPoints,
  coinHistorySnapshots,
  coins,
  derivativeTickers,
  derivativesExchanges,
  exchangeVolumePoints,
  exchangeVolumeSourcePoints,
  marketSnapshots,
  marketChartSourcePoints,
  ohlcvCandles,
  ohlcvSyncTargets,
  optionalProviderJobRuns,
  onchainDexes,
  onchainNetworks,
  onchainPoolOhlcv,
  onchainPoolTrades,
  onchainPools,
  onchainTokenHolderCounts,
  onchainTokenHolders,
  onchainTokenTraders,
  quoteSnapshots,
  supplyChartPoints,
  treasuryEntities,
  treasuryHoldings,
  treasurySourceDocuments,
  treasuryTransactions,
};

type AppSchema = typeof schema;
type SqliteRuntime = 'node' | 'bun';

export type SqliteStatement<Row = unknown> = {
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  run(...params: unknown[]): unknown;
  raw?(): SqliteStatement<unknown>;
  values?(...params: unknown[]): unknown[][];
};

export type SqliteClient = {
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  close(): void;
};

type AppDrizzleDatabase = BetterSQLite3Database<AppSchema> | BunSQLiteDatabase<AppSchema>;
type SqliteProcessRole = 'api' | 'worker' | 'validation' | 'test' | 'unknown';

type PersistedTimestampCompatibility = {
  normalizedAtOpen: boolean;
  source: 'none' | 'legacy_seconds';
};

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export type SqliteDatabasePathClass =
  | 'in_memory'
  | 'tmp_validation_file'
  | 'tmp_file'
  | 'repo_data_file'
  | 'durable_file';

export type SqliteDatabaseDiagnostics = {
  runtime: SqliteRuntime;
  driver: 'bun:sqlite' | 'better-sqlite3';
  process_role: SqliteProcessRole;
  configured_url: string;
  effective_path: string;
  path_class: SqliteDatabasePathClass;
  storage_mode: 'in_memory' | 'file';
  shared_file: boolean;
  journal_mode: string | null;
  wal_enabled: boolean;
  busy_timeout_ms: number | null;
  status: 'healthy' | 'contention_backoff' | 'fatal_persistence_failure' | 'unsafe_shared_configuration';
  status_reason: 'sqlite_ok' | 'sqlite_contention_observed' | 'sqlite_fatal_persistence_failure' | 'sqlite_unsafe_shared_configuration';
  shared_safety: {
    status: 'safe' | 'not_shared' | 'unsafe';
    reason_codes: Array<
      | 'sqlite_shared_file_wal_enabled'
      | 'sqlite_shared_file_busy_timeout_positive'
      | 'sqlite_not_shared_in_memory'
      | 'sqlite_wal_not_enabled'
      | 'sqlite_busy_timeout_not_positive'
    >;
    process_role: SqliteProcessRole;
  };
  lock_contention: {
    status: 'clear' | 'contention_observed';
    total_count: number;
    busy_count: number;
    locked_count: number;
    last_observed_at: string | null;
    recent_samples: SqliteDiagnosticFailureSample[];
    max_recent_samples: number;
  };
  persistence: {
    status: 'healthy' | 'contention_backoff' | 'fatal_failure';
    reason_code: 'sqlite_ok' | 'sqlite_contention_backoff' | 'sqlite_fatal_persistence_failure';
    fatal_failure_count: number;
    last_failure_at: string | null;
    recent_failures: SqliteDiagnosticFailureSample[];
    max_recent_failures: number;
  };
};

export type AppDatabase = {
  client: SqliteClient;
  db: AppDrizzleDatabase;
  runtime: SqliteRuntime;
  url: string;
  persistedTimestampCompatibility: PersistedTimestampCompatibility;
  sqliteDiagnostics: SqliteDiagnosticState;
};

class BunSqliteClient implements SqliteClient {
  constructor(private readonly database: BunDatabase) {}

  prepare<Row = unknown>(sql: string): SqliteStatement<Row> {
    const statement = this.database.query<Row>(sql);

    return {
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
      run: (...params) => statement.run(...params),
    };
  }

  exec(sql: string) {
    this.database.exec(sql);
  }

  pragma(sql: string) {
    return this.database.query(`PRAGMA ${sql}`).get();
  }

  close() {
    this.database.close();
  }
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' || Boolean(process.versions.bun);
}

export function detectSqliteRuntime(): SqliteRuntime {
  return isBunRuntime() ? 'bun' : 'node';
}

function resolveDatabaseUrl(databaseUrl: string) {
  if (databaseUrl === ':memory:') {
    return databaseUrl;
  }

  return resolve(process.cwd(), databaseUrl);
}

function isPathWithin(parentPath: string, childPath: string) {
  const relativePath = relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export function classifyDatabasePath(databaseUrl: string): SqliteDatabasePathClass {
  if (databaseUrl === ':memory:') {
    return 'in_memory';
  }

  const resolvedUrl = resolve(process.cwd(), databaseUrl);
  const resolvedTmpDir = resolve(tmpdir());
  const resolvedRepoDataDir = resolve(process.cwd(), 'data');

  if (isPathWithin(resolvedTmpDir, resolvedUrl)) {
    return /^opengecko-.+\.(sqlite|db)$/.test(basename(resolvedUrl))
      ? 'tmp_validation_file'
      : 'tmp_file';
  }

  if (isPathWithin(resolvedRepoDataDir, resolvedUrl)) {
    return 'repo_data_file';
  }

  return 'durable_file';
}

function normalizePragmaValue(value: unknown, key: string) {
  const row = Array.isArray(value) ? value[0] : value;

  if (row === null || row === undefined) {
    return null;
  }

  if (typeof row === 'string' || typeof row === 'number' || typeof row === 'boolean') {
    return row;
  }

  if (typeof row === 'object') {
    const record = row as Record<string, unknown>;
    if (record[key] !== undefined) {
      return record[key];
    }

    const firstValue = Object.values(record)[0];
    return firstValue ?? null;
  }

  return null;
}

function readStringPragma(client: SqliteClient, key: string) {
  const value = normalizePragmaValue(client.pragma(key), key);
  return value === null ? null : String(value).toLowerCase();
}

function readNumberPragma(client: SqliteClient, key: string) {
  const value = normalizePragmaValue(client.pragma(key), key);
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function safeReadStringPragma(client: SqliteClient, key: string, diagnostics?: SqliteDiagnosticState) {
  try {
    return readStringPragma(client, key);
  } catch (error) {
    if (diagnostics) {
      recordSqliteDiagnosticFailure(diagnostics, error, { operation: `diagnostics.pragma.${key}`, sql: `PRAGMA ${key}` });
    }
    return null;
  }
}

function safeReadNumberPragma(client: SqliteClient, key: string, diagnostics?: SqliteDiagnosticState) {
  try {
    return readNumberPragma(client, key);
  } catch (error) {
    if (diagnostics) {
      recordSqliteDiagnosticFailure(diagnostics, error, { operation: `diagnostics.pragma.${key}`, sql: `PRAGMA ${key}` });
    }
    return null;
  }
}

function redactSensitiveDatabasePath(value: string) {
  return /api[_-]?key|bearer|password|secret|token/i.test(value)
    ? '[database path redacted]'
    : value;
}

function resolveSqliteProcessRole(processRole?: SqliteProcessRole): SqliteProcessRole {
  if (processRole) {
    return processRole;
  }

  const configuredRole = process.env.OPENGECKO_PROCESS_ROLE;
  if (
    configuredRole === 'api'
    || configuredRole === 'worker'
    || configuredRole === 'validation'
    || configuredRole === 'test'
    || configuredRole === 'unknown'
  ) {
    return configuredRole;
  }

  return 'api';
}

function buildSharedSafety(
  sharedFile: boolean,
  walEnabled: boolean,
  busyTimeoutMs: number | null,
  processRole: SqliteProcessRole,
): SqliteDatabaseDiagnostics['shared_safety'] {
  if (!sharedFile) {
    return {
      status: 'not_shared',
      reason_codes: ['sqlite_not_shared_in_memory'],
      process_role: processRole,
    };
  }

  const reasonCodes: SqliteDatabaseDiagnostics['shared_safety']['reason_codes'] = [];
  if (walEnabled) {
    reasonCodes.push('sqlite_shared_file_wal_enabled');
  } else {
    reasonCodes.push('sqlite_wal_not_enabled');
  }

  if (typeof busyTimeoutMs === 'number' && busyTimeoutMs > 0) {
    reasonCodes.push('sqlite_shared_file_busy_timeout_positive');
  } else {
    reasonCodes.push('sqlite_busy_timeout_not_positive');
  }

  return {
    status: walEnabled && typeof busyTimeoutMs === 'number' && busyTimeoutMs > 0
      ? 'safe'
      : 'unsafe',
    reason_codes: reasonCodes,
    process_role: processRole,
  };
}

export function buildSqliteDatabaseDiagnostics(
  database: Pick<AppDatabase, 'client' | 'runtime' | 'url'> & { sqliteDiagnostics?: SqliteDiagnosticState },
  configuredUrl = database.url,
  processRole?: SqliteProcessRole,
): SqliteDatabaseDiagnostics {
  const pathClass = classifyDatabasePath(database.url);
  const journalMode = safeReadStringPragma(database.client, 'journal_mode', database.sqliteDiagnostics);
  const busyTimeoutMs = safeReadNumberPragma(database.client, 'busy_timeout', database.sqliteDiagnostics);
  const resolvedProcessRole = resolveSqliteProcessRole(processRole);
  const sharedFile = pathClass !== 'in_memory';
  const walEnabled = journalMode === 'wal';
  const sharedSafety = buildSharedSafety(sharedFile, walEnabled, busyTimeoutMs, resolvedProcessRole);
  const state = database.sqliteDiagnostics ?? createSqliteDiagnosticState();
  const recentContentionSamples = state.recentFailures.filter((sample) => sample.classification === 'contention');
  const recentFatalFailures = state.recentFailures.filter((sample) => sample.classification === 'fatal_persistence');
  const hasFatalFailure = state.totalFatalPersistenceCount > 0;
  const hasContention = state.totalContentionCount > 0;
  const status = hasFatalFailure
    ? 'fatal_persistence_failure'
    : hasContention
      ? 'contention_backoff'
      : sharedSafety.status === 'unsafe'
        ? 'unsafe_shared_configuration'
        : 'healthy';
  const statusReason = hasFatalFailure
    ? 'sqlite_fatal_persistence_failure'
    : hasContention
      ? 'sqlite_contention_observed'
      : sharedSafety.status === 'unsafe'
        ? 'sqlite_unsafe_shared_configuration'
        : 'sqlite_ok';
  const persistenceStatus = hasFatalFailure
    ? 'fatal_failure'
    : hasContention
      ? 'contention_backoff'
      : 'healthy';
  const persistenceReasonCode = hasFatalFailure
    ? 'sqlite_fatal_persistence_failure'
    : hasContention
      ? 'sqlite_contention_backoff'
      : 'sqlite_ok';

  return {
    runtime: database.runtime,
    driver: database.runtime === 'bun' ? 'bun:sqlite' : 'better-sqlite3',
    process_role: resolvedProcessRole,
    configured_url: redactSensitiveDatabasePath(configuredUrl),
    effective_path: redactSensitiveDatabasePath(database.url),
    path_class: pathClass,
    storage_mode: pathClass === 'in_memory' ? 'in_memory' : 'file',
    shared_file: sharedFile,
    journal_mode: journalMode,
    wal_enabled: walEnabled,
    busy_timeout_ms: busyTimeoutMs,
    status,
    status_reason: statusReason,
    shared_safety: sharedSafety,
    lock_contention: {
      status: hasContention ? 'contention_observed' : 'clear',
      total_count: state.totalContentionCount,
      busy_count: state.busyCount,
      locked_count: state.lockedCount,
      last_observed_at: state.lastContentionAt?.toISOString() ?? null,
      recent_samples: recentContentionSamples,
      max_recent_samples: MAX_SQLITE_RECENT_FAILURES,
    },
    persistence: {
      status: persistenceStatus,
      reason_code: persistenceReasonCode,
      fatal_failure_count: state.totalFatalPersistenceCount,
      last_failure_at: state.lastFatalPersistenceAt?.toISOString() ?? null,
      recent_failures: recentFatalFailures,
      max_recent_failures: MAX_SQLITE_RECENT_FAILURES,
    },
  };
}

function normalizePersistedLegacySecondTimestamps(_client: SqliteClient): PersistedTimestampCompatibility {
  return { normalizedAtOpen: false, source: 'none' };
}

function createNodeDatabase(resolvedUrl: string): AppDatabase {
  const Database = require('better-sqlite3') as new (path?: string) => BetterSqlite3DatabaseClient;
  const { drizzle } = require('drizzle-orm/better-sqlite3') as {
    drizzle: (client: BetterSqlite3DatabaseClient, config: { schema: AppSchema }) => BetterSQLite3Database<AppSchema>;
  };

  const rawClient = new Database(resolvedUrl);
  const sqliteDiagnostics = createSqliteDiagnosticState();
  const client = instrumentSqliteClient(rawClient, sqliteDiagnostics);
  client.pragma('journal_mode = WAL');
  client.pragma(`busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
  client.pragma('foreign_keys = ON');

  return {
    client,
    db: drizzle(client as unknown as BetterSqlite3DatabaseClient, { schema }),
    runtime: 'node',
    url: resolvedUrl,
    persistedTimestampCompatibility: normalizePersistedLegacySecondTimestamps(client),
    sqliteDiagnostics,
  };
}

function createBunDatabase(resolvedUrl: string): AppDatabase {
  const { Database } = require('bun:sqlite') as { Database: new (filename?: string) => BunDatabase };
  const { drizzle } = require('drizzle-orm/bun-sqlite') as {
    drizzle: (client: BunDatabase, config: { schema: AppSchema }) => BunSQLiteDatabase<AppSchema>;
  };

  const rawClient = new Database(resolvedUrl);
  const sqliteDiagnostics = createSqliteDiagnosticState();
  const client = instrumentSqliteClient(new BunSqliteClient(rawClient), sqliteDiagnostics);
  const drizzleClient = instrumentSqliteClient(rawClient as unknown as SqliteClient, sqliteDiagnostics);
  client.pragma('journal_mode = WAL');
  client.pragma(`busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
  client.pragma('foreign_keys = ON');

  return {
    client,
    db: drizzle(drizzleClient as unknown as BunDatabase, { schema }),
    runtime: 'bun',
    url: resolvedUrl,
    persistedTimestampCompatibility: normalizePersistedLegacySecondTimestamps(client),
    sqliteDiagnostics,
  };
}

export function createDatabase(databaseUrl: string): AppDatabase {
  const resolvedUrl = resolveDatabaseUrl(databaseUrl);

  if (resolvedUrl !== ':memory:') {
    mkdirSync(dirname(resolvedUrl), { recursive: true });
  }

  return detectSqliteRuntime() === 'bun' ? createBunDatabase(resolvedUrl) : createNodeDatabase(resolvedUrl);
}
