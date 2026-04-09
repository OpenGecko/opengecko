import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Database as BetterSqlite3DatabaseClient } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Database as BunDatabase } from 'bun:sqlite';

import {
  assetPlatforms,
  categories,
  chartPoints,
  coins,
  derivativeTickers,
  derivativesExchanges,
  exchangeVolumePoints,
  marketSnapshots,
  ohlcvCandles,
  ohlcvSyncTargets,
  onchainDexes,
  onchainNetworks,
  onchainPools,
  quoteSnapshots,
  treasuryEntities,
  treasuryHoldings,
  treasuryTransactions,
} from './schema';


const schema = {
  assetPlatforms,
  categories,
  chartPoints,
  coins,
  derivativeTickers,
  derivativesExchanges,
  exchangeVolumePoints,
  marketSnapshots,
  ohlcvCandles,
  ohlcvSyncTargets,
  onchainDexes,
  onchainNetworks,
  onchainPools,
  quoteSnapshots,
  treasuryEntities,
  treasuryHoldings,
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
