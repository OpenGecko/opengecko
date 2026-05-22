import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectSqliteRuntime, migrateDatabase, type AppDatabase } from '../src/db/client';
import {
  buildSqliteDatabaseDiagnostics,
  classifyDatabasePath,
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  createDatabase,
} from '../src/db/runtime';
import { coins, marketSnapshots } from '../src/db/schema';

describe('sqlite runtime support', () => {
  it('detects the active runtime consistently', () => {
    const expectedRuntime = process.versions.bun ? 'bun' : 'node';

    expect(detectSqliteRuntime()).toBe(expectedRuntime);
  });

  it('creates a shared Drizzle database wrapper that can run basic queries', () => {
    const database: AppDatabase = createDatabase(':memory:');

    try {
      migrateDatabase(database);

      const now = new Date();
      database.db
        .insert(coins)
        .values({
          id: 'bitcoin',
          symbol: 'btc',
          name: 'Bitcoin',
          apiSymbol: 'bitcoin',
          hashingAlgorithm: null,
          blockTimeInMinutes: null,
          categoriesJson: '[]',
          descriptionJson: '{}',
          linksJson: '{}',
          imageThumbUrl: null,
          imageSmallUrl: null,
          imageLargeUrl: null,
          marketCapRank: null,
          genesisDate: null,
          platformsJson: '{}',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const storedCoin = database.db.select().from(coins).get();

      expect(database.runtime).toBe(detectSqliteRuntime());
      expect(storedCoin?.id).toBe('bitcoin');
    } finally {
      database.client.close();
    }
  });

  it('classifies mission validation database paths and exposes SQLite safety pragmas', () => {
    expect(classifyDatabasePath(':memory:')).toBe('in_memory');
    expect(classifyDatabasePath('/tmp/opengecko-runtime.sqlite')).toBe('tmp_validation_file');
    expect(classifyDatabasePath('/tmp/opengecko-quality.sqlite')).toBe('tmp_validation_file');
    expect(classifyDatabasePath('/tmp/non-opengecko.sqlite')).toBe('tmp_file');
    expect(classifyDatabasePath('data/opengecko.db')).toBe('repo_data_file');
    expect(classifyDatabasePath('/var/lib/opengecko/opengecko.db')).toBe('durable_file');

    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-db-diagnostics-'));
    const database = createDatabase(join(tempDir, 'opengecko-runtime.sqlite'));

    try {
      const diagnostics = buildSqliteDatabaseDiagnostics(database, join(tempDir, 'opengecko-runtime.sqlite'));

      expect(diagnostics).toMatchObject({
        runtime: detectSqliteRuntime(),
        configured_url: join(tempDir, 'opengecko-runtime.sqlite'),
        effective_path: join(tempDir, 'opengecko-runtime.sqlite'),
        path_class: 'tmp_validation_file',
        storage_mode: 'file',
        shared_file: true,
        journal_mode: 'wal',
        wal_enabled: true,
        busy_timeout_ms: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
      });
    } finally {
      database.client.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts sensitive-looking database path segments from diagnostics without changing classification', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-db-redaction-secret-'));
    const database = createDatabase(join(tempDir, 'opengecko-runtime.sqlite'));

    try {
      const diagnostics = buildSqliteDatabaseDiagnostics(database, join(tempDir, 'opengecko-runtime.sqlite'));

      expect(diagnostics.configured_url).toBe('[database path redacted]');
      expect(diagnostics.effective_path).toBe('[database path redacted]');
      expect(diagnostics.path_class).toBe('tmp_validation_file');
      expect(diagnostics.storage_mode).toBe('file');
    } finally {
      database.client.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports persisted timestamp compatibility as inactive for fresh and current persisted databases', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-db-compat-'));
    const persistedPath = join(tempDir, 'persisted.db');
    const persistedNow = new Date('2026-04-07T00:00:00.000Z');
    const seededPersistedDatabase: AppDatabase = createDatabase(persistedPath);
    try {
      migrateDatabase(seededPersistedDatabase);
      seededPersistedDatabase.db.insert(coins).values({
        id: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        apiSymbol: 'bitcoin',
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: '{}',
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: 1,
        genesisDate: null,
        platformsJson: '{}',
        status: 'active',
        createdAt: persistedNow,
        updatedAt: persistedNow,
      }).run();
      seededPersistedDatabase.db.insert(marketSnapshots).values({
        coinId: 'bitcoin',
        vsCurrency: 'usd',
        price: 90_000,
        marketCap: 1_800_000_000_000,
        totalVolume: 50_000_000_000,
        marketCapRank: 1,
        fullyDilutedValuation: null,
        circulatingSupply: null,
        totalSupply: null,
        maxSupply: null,
        ath: null,
        athChangePercentage: null,
        athDate: null,
        atl: null,
        atlChangePercentage: null,
        atlDate: null,
        priceChange24h: null,
        priceChangePercentage24h: null,
        updatedAt: persistedNow,
        lastUpdated: persistedNow,
        sourceProvidersJson: '[]',
        sourceCount: 0,
      }).run();
    } finally {
      seededPersistedDatabase.client.close();
    }

    const persistedDatabase: AppDatabase = createDatabase(persistedPath);
    try {
      const persistedSnapshot = persistedDatabase.db.select().from(marketSnapshots).get();

      expect(persistedDatabase.persistedTimestampCompatibility).toEqual({
        normalizedAtOpen: false,
        source: 'none',
      });
      expect(persistedSnapshot?.lastUpdated).toBeInstanceOf(Date);
      expect(persistedSnapshot?.lastUpdated.getTime()).toBeGreaterThan(100_000_000_000);
    } finally {
      persistedDatabase.client.close();
    }

    const freshPath = join(tempDir, 'fresh.db');
    const freshNow = new Date('2026-04-07T00:00:00.000Z');
    const freshDatabase: AppDatabase = createDatabase(freshPath);
    try {
      migrateDatabase(freshDatabase);
      freshDatabase.db.insert(coins).values({
        id: 'ethereum',
        symbol: 'eth',
        name: 'Ethereum',
        apiSymbol: 'ethereum',
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: '{}',
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: null,
        genesisDate: null,
        platformsJson: '{}',
        status: 'active',
        createdAt: freshNow,
        updatedAt: freshNow,
      }).run();
    } finally {
      freshDatabase.client.close();
    }

    const reopenedFreshDatabase: AppDatabase = createDatabase(freshPath);
    try {
      expect(reopenedFreshDatabase.persistedTimestampCompatibility).toEqual({
        normalizedAtOpen: false,
        source: 'none',
      });
      expect(
        reopenedFreshDatabase.client.prepare<{ created_at: number }>('SELECT created_at FROM coins WHERE id = ?').get('ethereum')?.created_at,
      ).toBe(freshNow.getTime());
    } finally {
      reopenedFreshDatabase.client.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
