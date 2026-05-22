import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import type { Database as BetterSqlite3DatabaseClient } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Database as BunDatabase } from 'bun:sqlite';

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

type SqliteStatement<Row = unknown> = {
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  run(...params: unknown[]): unknown;
};

export type SqliteClient = {
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  close(): void;
};

type AppDrizzleDatabase = BetterSQLite3Database<AppSchema> | BunSQLiteDatabase<AppSchema>;

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
  configured_url: string;
  effective_path: string;
  path_class: SqliteDatabasePathClass;
  storage_mode: 'in_memory' | 'file';
  shared_file: boolean;
  journal_mode: string | null;
  wal_enabled: boolean;
  busy_timeout_ms: number | null;
};

export type AppDatabase = {
  client: SqliteClient;
  db: AppDrizzleDatabase;
  runtime: SqliteRuntime;
  url: string;
  persistedTimestampCompatibility: PersistedTimestampCompatibility;
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

function redactSensitiveDatabasePath(value: string) {
  return /api[_-]?key|bearer|password|secret|token/i.test(value)
    ? '[database path redacted]'
    : value;
}

export function buildSqliteDatabaseDiagnostics(
  database: Pick<AppDatabase, 'client' | 'runtime' | 'url'>,
  configuredUrl = database.url,
): SqliteDatabaseDiagnostics {
  const pathClass = classifyDatabasePath(database.url);
  const journalMode = readStringPragma(database.client, 'journal_mode');
  const busyTimeoutMs = readNumberPragma(database.client, 'busy_timeout');

  return {
    runtime: database.runtime,
    driver: database.runtime === 'bun' ? 'bun:sqlite' : 'better-sqlite3',
    configured_url: redactSensitiveDatabasePath(configuredUrl),
    effective_path: redactSensitiveDatabasePath(database.url),
    path_class: pathClass,
    storage_mode: pathClass === 'in_memory' ? 'in_memory' : 'file',
    shared_file: pathClass !== 'in_memory',
    journal_mode: journalMode,
    wal_enabled: journalMode === 'wal',
    busy_timeout_ms: busyTimeoutMs,
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

  const client = new Database(resolvedUrl);
  client.pragma('journal_mode = WAL');
  client.pragma(`busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
  client.pragma('foreign_keys = ON');

  return {
    client,
    db: drizzle(client, { schema }),
    runtime: 'node',
    url: resolvedUrl,
    persistedTimestampCompatibility: normalizePersistedLegacySecondTimestamps(client),
  };
}

function createBunDatabase(resolvedUrl: string): AppDatabase {
  const { Database } = require('bun:sqlite') as { Database: new (filename?: string) => BunDatabase };
  const { drizzle } = require('drizzle-orm/bun-sqlite') as {
    drizzle: (client: BunDatabase, config: { schema: AppSchema }) => BunSQLiteDatabase<AppSchema>;
  };

  const rawClient = new Database(resolvedUrl);
  const client = new BunSqliteClient(rawClient);
  client.pragma('journal_mode = WAL');
  client.pragma(`busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
  client.pragma('foreign_keys = ON');

  return {
    client,
    db: drizzle(rawClient, { schema }),
    runtime: 'bun',
    url: resolvedUrl,
    persistedTimestampCompatibility: normalizePersistedLegacySecondTimestamps(client),
  };
}

export function createDatabase(databaseUrl: string): AppDatabase {
  const resolvedUrl = resolveDatabaseUrl(databaseUrl);

  if (resolvedUrl !== ':memory:') {
    mkdirSync(dirname(resolvedUrl), { recursive: true });
  }

  return detectSqliteRuntime() === 'bun' ? createBunDatabase(resolvedUrl) : createNodeDatabase(resolvedUrl);
}
