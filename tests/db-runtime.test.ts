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
  createSqliteDiagnosticState,
  recordSqliteDiagnosticFailure,
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
        status: 'healthy',
        status_reason: 'sqlite_ok',
        lock_contention: {
          status: 'clear',
          total_count: 0,
          busy_count: 0,
          locked_count: 0,
          last_observed_at: null,
          recent_samples: [],
          max_recent_samples: expect.any(Number),
        },
        persistence: {
          status: 'healthy',
          reason_code: 'sqlite_ok',
          fatal_failure_count: 0,
          last_failure_at: null,
          recent_failures: [],
          max_recent_failures: expect.any(Number),
        },
      });
    } finally {
      database.client.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('counts SQLite busy and locked failures with sanitized bounded recent samples', () => {
    const state = createSqliteDiagnosticState();

    for (let index = 0; index < 12; index += 1) {
      const error = new Error(`SQLITE_BUSY: database is locked at /tmp/opengecko-secret-${index}.sqlite?token=super-secret`);
      (error as Error & { code?: string }).code = index % 2 === 0 ? 'SQLITE_BUSY' : 'SQLITE_LOCKED';
      recordSqliteDiagnosticFailure(state, error, {
        operation: `worker refresh password=hunter2 ${index}`,
        sql: 'UPDATE market_snapshots SET price = ? WHERE coin_id = ?',
        now: new Date(Date.UTC(2026, 4, 23, 0, 0, index)),
      });
    }

    const database = {
      runtime: detectSqliteRuntime(),
      url: ':memory:',
      client: createDatabase(':memory:').client,
      sqliteDiagnostics: state,
    };

    try {
      const diagnostics = buildSqliteDatabaseDiagnostics(database);

      expect(diagnostics.status).toBe('contention_backoff');
      expect(diagnostics.status_reason).toBe('sqlite_contention_observed');
      expect(diagnostics.lock_contention).toMatchObject({
        status: 'contention_observed',
        total_count: 12,
        busy_count: 6,
        locked_count: 6,
        last_observed_at: '2026-05-23T00:00:11.000Z',
        max_recent_samples: 10,
      });
      expect(diagnostics.lock_contention.recent_samples).toHaveLength(10);
      expect(diagnostics.lock_contention.recent_samples[0]).toMatchObject({
        classification: 'contention',
        reason_code: 'sqlite_busy',
        operation: expect.stringContaining('worker refresh'),
        sql_kind: 'update',
      });
      const serialized = JSON.stringify(diagnostics.lock_contention.recent_samples);
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('super-secret');
      expect(serialized).not.toContain('/tmp/opengecko-secret');
    } finally {
      database.client.close();
    }
  });

  it('distinguishes fatal SQLite persistence failures from contention backoff', () => {
    const state = createSqliteDiagnosticState();
    const contentionError = new Error('SQLITE_BUSY: database is locked');
    (contentionError as Error & { code?: string }).code = 'SQLITE_BUSY';
    recordSqliteDiagnosticFailure(state, contentionError, {
      operation: 'api read',
      sql: 'SELECT * FROM coins',
      now: new Date('2026-05-23T01:00:00.000Z'),
    });

    const fatalError = new Error('SQLITE_CORRUPT: database disk image is malformed at /var/lib/opengecko/opengecko.db?api_key=secret');
    (fatalError as Error & { code?: string }).code = 'SQLITE_CORRUPT';
    recordSqliteDiagnosticFailure(state, fatalError, {
      operation: 'worker persistence secret=raw-secret',
      sql: 'INSERT INTO market_snapshots VALUES (?)',
      now: new Date('2026-05-23T01:00:01.000Z'),
    });

    const database = {
      runtime: detectSqliteRuntime(),
      url: ':memory:',
      client: createDatabase(':memory:').client,
      sqliteDiagnostics: state,
    };

    try {
      const diagnostics = buildSqliteDatabaseDiagnostics(database);

      expect(diagnostics.status).toBe('fatal_persistence_failure');
      expect(diagnostics.status_reason).toBe('sqlite_fatal_persistence_failure');
      expect(diagnostics.lock_contention.total_count).toBe(1);
      expect(diagnostics.persistence).toMatchObject({
        status: 'fatal_failure',
        reason_code: 'sqlite_fatal_persistence_failure',
        fatal_failure_count: 1,
        last_failure_at: '2026-05-23T01:00:01.000Z',
      });
      expect(diagnostics.persistence.recent_failures).toHaveLength(1);
      expect(diagnostics.persistence.recent_failures[0]).toMatchObject({
        classification: 'fatal_persistence',
        reason_code: 'sqlite_corrupt',
        sql_kind: 'insert',
      });
      expect(JSON.stringify(diagnostics.persistence.recent_failures)).not.toContain('raw-secret');
      expect(JSON.stringify(diagnostics.persistence.recent_failures)).not.toContain('/var/lib/opengecko');
    } finally {
      database.client.close();
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
