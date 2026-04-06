import { resolve } from 'node:path';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { AppDatabase } from './runtime';
import {
  assetPlatforms,
  categories,
  chartPoints,
  coins,
  derivativeTickers,
  derivativesExchanges,
  ohlcvSyncTargets,
  onchainDexes,
  onchainNetworks,
  onchainPools,
  treasuryEntities,
  treasuryHoldings,
  treasuryTransactions,
} from './schema';

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');
const TARGETED_RUNTIME_INDEX_MIGRATION_HASH = '8301ee03effe7ffc4e7723bb625c4a009dfa80811cdd268979f756b9a4cab40e';
const TARGETED_RUNTIME_INDEX_MIGRATION_CREATED_AT = 1774800000000;

type AppSchema = {
  assetPlatforms: typeof assetPlatforms;
  categories: typeof categories;
  chartPoints: typeof chartPoints;
  coins: typeof coins;
  derivativeTickers: typeof derivativeTickers;
  derivativesExchanges: typeof derivativesExchanges;
  ohlcvSyncTargets: typeof ohlcvSyncTargets;
  onchainDexes: typeof onchainDexes;
  onchainNetworks: typeof onchainNetworks;
  onchainPools: typeof onchainPools;
  treasuryEntities: typeof treasuryEntities;
  treasuryHoldings: typeof treasuryHoldings;
  treasuryTransactions: typeof treasuryTransactions;
};

export function migrateDatabase(database: AppDatabase) {
  database.client.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);

  const targetedRuntimeIndexes = [
    'coins_status_market_cap_rank_id_idx',
    'market_snapshots_vs_currency_market_cap_rank_coin_id_idx',
  ] as const;
  const targetedIndexesExist = database.client.prepare<{ name: string }>(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'index'
       AND name IN (${targetedRuntimeIndexes.map(() => '?').join(', ')})
     ORDER BY name`,
  ).all(...targetedRuntimeIndexes);

  if (targetedIndexesExist.length === targetedRuntimeIndexes.length) {
    const targetedMigrationRecorded = database.client.prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM __drizzle_migrations WHERE hash = ?',
    ).get(TARGETED_RUNTIME_INDEX_MIGRATION_HASH);

    if ((targetedMigrationRecorded?.count ?? 0) === 0) {
      database.client.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
      ).run(TARGETED_RUNTIME_INDEX_MIGRATION_HASH, TARGETED_RUNTIME_INDEX_MIGRATION_CREATED_AT);
    }
  }

  if (database.runtime === 'bun') {
    const { migrate } = require('drizzle-orm/bun-sqlite/migrator') as {
      migrate: (db: BunSQLiteDatabase<AppSchema>, config: { migrationsFolder: string }) => void;
    };

    migrate(database.db as BunSQLiteDatabase<AppSchema>, {
      migrationsFolder: MIGRATIONS_FOLDER,
    });

    return;
  }

  const { migrate } = require('drizzle-orm/better-sqlite3/migrator') as {
    migrate: (db: BetterSQLite3Database<AppSchema>, config: { migrationsFolder: string }) => void;
  };

  migrate(database.db as BetterSQLite3Database<AppSchema>, {
    migrationsFolder: MIGRATIONS_FOLDER,
  });
}
