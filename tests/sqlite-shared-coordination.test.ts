import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, type AppDatabase } from '../src/db/client';
import { buildSqliteDatabaseDiagnostics } from '../src/db/runtime';
import {
  acquireSqliteWorkLease,
  buildSqliteCoordinationDiagnostics,
  recordSqliteRefreshFailed,
  registerSqliteProcessHeartbeat,
  releaseSqliteWorkLease,
  withSqliteImmediateTransaction,
} from '../src/db/sqlite-coordination';
import { coins, marketSnapshots, quoteSnapshots } from '../src/db/schema';

function seedCoin(database: AppDatabase, now: Date) {
  database.db.insert(coins).values({
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
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedMarketSnapshot(database: AppDatabase, price: number, now: Date) {
  database.db.insert(marketSnapshots).values({
    coinId: 'bitcoin',
    vsCurrency: 'usd',
    price,
    marketCap: price * 20_000_000,
    totalVolume: 1_000_000,
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
    updatedAt: now,
    lastUpdated: now,
    sourceProvidersJson: '["seed"]',
    sourceCount: 1,
  }).run();
}

describe('shared SQLite API-worker coordination', () => {
  let tempDir: string;
  let dbPath: string;
  let apiDatabase: AppDatabase;
  let workerDatabase: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-sqlite-shared-'));
    dbPath = join(tempDir, 'opengecko-runtime.sqlite');
    apiDatabase = createDatabase(dbPath);
    migrateDatabase(apiDatabase);
    workerDatabase = createDatabase(dbPath);
    migrateDatabase(workerDatabase);
  });

  afterEach(() => {
    apiDatabase?.client.close();
    workerDatabase?.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('lets API readers see the previous coherent revision while a worker write is uncommitted', () => {
    const now = new Date('2026-05-23T00:00:00.000Z');
    seedCoin(apiDatabase, now);
    seedMarketSnapshot(apiDatabase, 90_000, now);

    withSqliteImmediateTransaction(workerDatabase, () => {
      workerDatabase.client.prepare(`
        UPDATE market_snapshots
        SET price = ?, last_updated = ?, updated_at = ?
        WHERE coin_id = 'bitcoin' AND vs_currency = 'usd'
      `).run(91_000, now.getTime() + 60_000, now.getTime() + 60_000);

      const apiReadDuringWrite = apiDatabase.client
        .prepare<{ price: number; last_updated: number }>(`
          SELECT price, last_updated
          FROM market_snapshots
          WHERE coin_id = 'bitcoin' AND vs_currency = 'usd'
        `)
        .get();

      expect(apiReadDuringWrite).toEqual({
        price: 90_000,
        last_updated: now.getTime(),
      });
    });

    const apiReadAfterCommit = apiDatabase.client
      .prepare<{ price: number }>(`
        SELECT price
        FROM market_snapshots
        WHERE coin_id = 'bitcoin' AND vs_currency = 'usd'
      `)
      .get();

    expect(apiReadAfterCommit?.price).toBe(91_000);
  });

  it('rolls back failed multi-table refresh writes and records degraded refresh diagnostics', () => {
    const now = new Date('2026-05-23T00:00:00.000Z');
    seedCoin(apiDatabase, now);
    seedMarketSnapshot(apiDatabase, 90_000, now);

    expect(() => withSqliteImmediateTransaction(workerDatabase, () => {
      workerDatabase.db.insert(quoteSnapshots).values({
        coinId: 'bitcoin',
        vsCurrency: 'usd',
        exchangeId: 'coinbase',
        symbol: 'BTC/USD',
        fetchedAt: now,
        price: 91_000,
        quoteVolume: 10_000,
        priceChangePercentage24h: 1,
        sourcePayloadJson: '{}',
      }).run();
      workerDatabase.client.prepare(`
        UPDATE market_snapshots
        SET price = ?, last_updated = ?, updated_at = ?
        WHERE coin_id = 'bitcoin' AND vs_currency = 'usd'
      `).run(91_000, now.getTime() + 60_000, now.getTime() + 60_000);

      throw new Error('injected mid-refresh failure');
    })).toThrow('injected mid-refresh failure');

    recordSqliteRefreshFailed(
      workerDatabase,
      'market_refresh',
      new Date('2026-05-23T00:01:00.000Z'),
      ['quote_snapshots', 'market_snapshots'],
      new Error('injected mid-refresh failure'),
      'test-worker',
    );

    expect(apiDatabase.client.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM quote_snapshots').get()?.count).toBe(0);
    expect(apiDatabase.client.prepare<{ price: number }>('SELECT price FROM market_snapshots').get()?.price).toBe(90_000);

    const coordination = buildSqliteCoordinationDiagnostics(apiDatabase, new Date('2026-05-23T00:02:00.000Z'));
    expect(coordination.revisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'market_refresh',
        revision: 0,
        status: 'degraded',
        active_owner: 'test-worker',
        failed_at: '2026-05-23T00:01:00.000Z',
        affected_tables: ['market_snapshots', 'quote_snapshots'],
      }),
    ]));
  });

  it('serializes duplicate durable worker work with lease ownership diagnostics', () => {
    const now = new Date('2026-05-23T00:00:00.000Z');
    const first = acquireSqliteWorkLease(apiDatabase, 'market_refresh', now, {
      leaseOwner: 'worker-a',
      leaseToken: 'token-a',
      leaseTtlMs: 60_000,
    });
    const second = acquireSqliteWorkLease(workerDatabase, 'market_refresh', now, {
      leaseOwner: 'worker-b',
      leaseToken: 'token-b',
      leaseTtlMs: 60_000,
    });

    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({
      acquired: false,
      skippedReason: 'active_lease',
      activeOwner: 'worker-a',
    });

    const whileLeased = buildSqliteCoordinationDiagnostics(apiDatabase, now);
    expect(whileLeased.work_leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'market_refresh',
        active: true,
        lease_owner: 'worker-a',
        skipped_duplicate_count: 1,
        serialized_run_count: 1,
      }),
    ]));

    if (first.acquired) {
      expect(releaseSqliteWorkLease(apiDatabase, first.lease, new Date('2026-05-23T00:00:01.000Z'))).toBe(true);
    }
    const third = acquireSqliteWorkLease(workerDatabase, 'market_refresh', new Date('2026-05-23T00:00:02.000Z'), {
      leaseOwner: 'worker-b',
      leaseToken: 'token-b',
      leaseTtlMs: 60_000,
    });

    expect(third.acquired).toBe(true);
  });

  it('diagnoses safe shared API and worker processes on the same validation DB', () => {
    const now = new Date('2026-05-23T00:00:00.000Z');
    registerSqliteProcessHeartbeat(apiDatabase, 'api', now, 'api:test');
    registerSqliteProcessHeartbeat(workerDatabase, 'worker', now, 'worker:test');

    expect(buildSqliteDatabaseDiagnostics(apiDatabase, dbPath, 'api')).toMatchObject({
      process_role: 'api',
      path_class: 'tmp_validation_file',
      storage_mode: 'file',
      shared_file: true,
      wal_enabled: true,
      busy_timeout_ms: expect.any(Number),
      status: 'healthy',
      status_reason: 'sqlite_ok',
      shared_safety: {
        status: 'safe',
        process_role: 'api',
        reason_codes: expect.arrayContaining([
          'sqlite_shared_file_wal_enabled',
          'sqlite_shared_file_busy_timeout_positive',
        ]),
      },
    });

    const coordination = buildSqliteCoordinationDiagnostics(apiDatabase, now);
    expect(coordination.shared_database).toEqual({
      observed_process_count: expect.any(Number),
      observed_roles: ['api', 'worker'],
      db_paths: [dbPath],
      single_shared_path: true,
      api_worker_shared: true,
    });
  });
});
