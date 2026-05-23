import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins, ohlcvSyncTargets } from '../src/db/schema';
import {
  leaseNextOhlcvTarget,
  markOhlcvTargetFailure,
  markOhlcvTargetSuccess,
  promoteOhlcvTargetPriority,
  upsertOhlcvSyncTargets,
} from '../src/services/ohlcv-worker-state';

describe('ohlcv worker state', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-ohlcv-worker-state-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);

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
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z'),
    }).onConflictDoNothing().run();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedTarget(values: Partial<typeof ohlcvSyncTargets.$inferInsert> & Pick<typeof ohlcvSyncTargets.$inferInsert, 'coinId' | 'exchangeId' | 'symbol'>) {
    database.db.insert(ohlcvSyncTargets).values({
      coinId: values.coinId,
      exchangeId: values.exchangeId,
      symbol: values.symbol,
      vsCurrency: values.vsCurrency ?? 'usd',
      interval: values.interval ?? '1d',
      priorityTier: values.priorityTier ?? 'long_tail',
      latestSyncedAt: values.latestSyncedAt ?? null,
      oldestSyncedAt: values.oldestSyncedAt ?? null,
      targetHistoryDays: values.targetHistoryDays ?? 365,
      status: values.status ?? 'idle',
      lastAttemptAt: values.lastAttemptAt ?? null,
      lastSuccessAt: values.lastSuccessAt ?? null,
      lastError: values.lastError ?? null,
      failureCount: values.failureCount ?? 0,
      nextRetryAt: values.nextRetryAt ?? null,
      lastRequestedAt: values.lastRequestedAt ?? null,
      leaseOwner: values.leaseOwner ?? null,
      leaseToken: values.leaseToken ?? null,
      leaseAcquiredAt: values.leaseAcquiredAt ?? null,
      leaseExpiresAt: values.leaseExpiresAt ?? null,
      leaseRecoveryCount: values.leaseRecoveryCount ?? 0,
      lastLeaseRecoveredAt: values.lastLeaseRecoveredAt ?? null,
      lastLeaseRecoveryReason: values.lastLeaseRecoveryReason ?? null,
      createdAt: values.createdAt ?? new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: values.updatedAt ?? new Date('2026-03-22T00:00:00.000Z'),
    }).onConflictDoNothing().run();
  }

  it('stores OHLCV sync target state with cursors and retry metadata', () => {
    database.db.insert(ohlcvSyncTargets).values({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
      status: 'idle',
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      failureCount: 0,
      nextRetryAt: null,
      lastRequestedAt: null,
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z'),
    }).onConflictDoNothing().run();

    const row = database.db.select().from(ohlcvSyncTargets).all()[0];

    expect(row.priorityTier).toBe('top100');
    expect(row.targetHistoryDays).toBe(365);
    expect(row.latestSyncedAt?.toISOString()).toBe('2026-03-22T00:00:00.000Z');
    expect(row.oldestSyncedAt?.toISOString()).toBe('2025-03-22T00:00:00.000Z');
    expect(row.failureCount).toBe(0);
  });

  it('leases top100 targets before long-tail targets', () => {
    seedTarget({ coinId: 'bitcoin', exchangeId: 'binance', symbol: 'BTC/USDT', priorityTier: 'top100', nextRetryAt: null });

    database.db.insert(coins).values({
      id: 'some-microcap',
      symbol: 'smc',
      name: 'Some Microcap',
      apiSymbol: 'some-microcap',
      hashingAlgorithm: null,
      blockTimeInMinutes: null,
      categoriesJson: '[]',
      descriptionJson: '{}',
      linksJson: '{}',
      imageThumbUrl: null,
      imageSmallUrl: null,
      imageLargeUrl: null,
      marketCapRank: 9999,
      genesisDate: null,
      platformsJson: '{}',
      status: 'active',
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z'),
    }).onConflictDoNothing().run();
    seedTarget({ coinId: 'some-microcap', exchangeId: 'binance', symbol: 'SMC/USDT', priorityTier: 'long_tail', nextRetryAt: null });

    const leased = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'));

    expect(leased?.coinId).toBe('bitcoin');
    expect(leased?.status).toBe('running');
    expect(leased?.leaseOwner).toMatch(/^ohlcv-worker:/);
    expect(leased?.leaseToken).toEqual(expect.any(String));
    expect(leased?.leaseExpiresAt?.toISOString()).toBe('2026-03-23T00:15:00.000Z');
  });

  it('prevents overlapping active leases on the same target', () => {
    seedTarget({ coinId: 'bitcoin', exchangeId: 'binance', symbol: 'BTC/USDT', priorityTier: 'top100' });

    const firstLease = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'), {
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a',
      leaseTtlMs: 10 * 60 * 1000,
    });
    const secondLease = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:01:00.000Z'), {
      leaseOwner: 'worker-b',
      leaseToken: 'lease-b',
      leaseTtlMs: 10 * 60 * 1000,
    });

    const row = database.db.select().from(ohlcvSyncTargets).all()[0];

    expect(firstLease).toMatchObject({
      coinId: 'bitcoin',
      status: 'running',
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a',
    });
    expect(secondLease).toBeNull();
    expect(row.leaseOwner).toBe('worker-a');
    expect(row.leaseToken).toBe('lease-a');
    expect(row.leaseRecoveryCount).toBe(0);
  });

  it('recovers expired running leases and records recovery diagnostics', () => {
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      priorityTier: 'top100',
      status: 'running',
      lastAttemptAt: new Date('2026-03-22T23:40:00.000Z'),
      leaseOwner: 'crashed-worker',
      leaseToken: 'crashed-token',
      leaseAcquiredAt: new Date('2026-03-22T23:40:00.000Z'),
      leaseExpiresAt: new Date('2026-03-22T23:55:00.000Z'),
    });

    const recovered = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'), {
      leaseOwner: 'worker-b',
      leaseToken: 'lease-b',
      leaseTtlMs: 10 * 60 * 1000,
    });

    expect(recovered).toMatchObject({
      coinId: 'bitcoin',
      status: 'running',
      leaseOwner: 'worker-b',
      leaseToken: 'lease-b',
      leaseRecoveryCount: 1,
      lastLeaseRecoveryReason: 'expired_lease_deadline',
    });
    expect(recovered?.lastLeaseRecoveredAt?.toISOString()).toBe('2026-03-23T00:00:00.000Z');
    expect(recovered?.leaseExpiresAt?.toISOString()).toBe('2026-03-23T00:10:00.000Z');
  });

  it('does not let stale workers complete or fail a recovered lease', () => {
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      priorityTier: 'top100',
      status: 'running',
      lastAttemptAt: new Date('2026-03-22T23:40:00.000Z'),
      leaseOwner: 'crashed-worker',
      leaseToken: 'crashed-token',
      leaseAcquiredAt: new Date('2026-03-22T23:40:00.000Z'),
      leaseExpiresAt: new Date('2026-03-22T23:55:00.000Z'),
    });

    const recovered = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'), {
      leaseOwner: 'worker-b',
      leaseToken: 'lease-b',
    });

    const staleSuccess = markOhlcvTargetSuccess(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1d',
      vsCurrency: 'usd',
      latestSyncedAt: new Date('2026-03-23T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-23T00:00:00.000Z'),
      completedAt: new Date('2026-03-23T00:01:00.000Z'),
      leaseOwner: 'crashed-worker',
      leaseToken: 'crashed-token',
    });
    const staleFailure = markOhlcvTargetFailure(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1d',
      vsCurrency: 'usd',
      failedAt: new Date('2026-03-23T00:01:00.000Z'),
      error: 'late stale worker failure',
      leaseOwner: 'crashed-worker',
      leaseToken: 'crashed-token',
    });
    const ownerSuccess = markOhlcvTargetSuccess(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1d',
      vsCurrency: 'usd',
      latestSyncedAt: new Date('2026-03-23T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-23T00:00:00.000Z'),
      completedAt: new Date('2026-03-23T00:02:00.000Z'),
      leaseOwner: recovered?.leaseOwner,
      leaseToken: recovered?.leaseToken,
    });

    const row = database.db.select().from(ohlcvSyncTargets).all()[0];

    expect(staleSuccess).toBe(false);
    expect(staleFailure).toBe(false);
    expect(ownerSuccess).toBe(true);
    expect(row.status).toBe('idle');
    expect(row.latestSyncedAt?.toISOString()).toBe('2026-03-23T00:00:00.000Z');
    expect(row.lastError).toBeNull();
    expect(row.leaseOwner).toBeNull();
    expect(row.leaseToken).toBeNull();
  });

  it('leases retry-due failed targets before idle targets within the same priority tier', () => {
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      priorityTier: 'top100',
      status: 'idle',
      oldestSyncedAt: null,
      targetHistoryDays: 365,
      nextRetryAt: null,
    });
    database.db.insert(coins).values({
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
      marketCapRank: 2,
      genesisDate: null,
      platformsJson: '{}',
      status: 'active',
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z'),
    }).onConflictDoNothing().run();
    seedTarget({
      coinId: 'ethereum',
      exchangeId: 'binance',
      symbol: 'ETH/USDT',
      priorityTier: 'top100',
      status: 'failed',
      oldestSyncedAt: null,
      targetHistoryDays: 365,
      failureCount: 1,
      nextRetryAt: new Date('2026-03-22T23:59:00.000Z'),
    });

    const leased = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'));

    expect(leased?.coinId).toBe('ethereum');
    expect(leased?.status).toBe('running');
  });

  it('leases deeper incomplete targets before complete targets within the same priority tier', () => {
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      targetHistoryDays: 365,
      lastSuccessAt: new Date('2026-03-20T00:00:00.000Z'),
      nextRetryAt: null,
    });
    database.db.insert(coins).values({
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
      marketCapRank: 2,
      genesisDate: null,
      platformsJson: '{}',
      status: 'active',
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z'),
    }).onConflictDoNothing().run();
    seedTarget({
      coinId: 'ethereum',
      exchangeId: 'binance',
      symbol: 'ETH/USDT',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-02-01T00:00:00.000Z'),
      targetHistoryDays: 365,
      lastSuccessAt: new Date('2026-03-22T00:00:00.000Z'),
      nextRetryAt: null,
    });

    const leased = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'));

    expect(leased?.coinId).toBe('ethereum');
    expect(leased?.status).toBe('running');
  });

  it('leases never-synced intraday targets before deep daily historical backfill in the same priority tier', () => {
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2021-03-23T00:00:00.000Z'),
      targetHistoryDays: 3650,
      lastSuccessAt: new Date('2026-03-22T00:00:00.000Z'),
      nextRetryAt: null,
    });
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1m',
      priorityTier: 'top100',
      latestSyncedAt: null,
      oldestSyncedAt: null,
      targetHistoryDays: 30,
      lastSuccessAt: null,
      nextRetryAt: null,
    });

    const leased = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'));

    expect(leased?.interval).toBe('1m');
    expect(leased?.status).toBe('running');
  });

  it('skips targets still under retry backoff', () => {
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      priorityTier: 'top100',
      nextRetryAt: new Date('2026-03-23T01:00:00.000Z'),
    });

    const leased = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'));

    expect(leased).toBeNull();
  });

  it('leases failed targets once the retry cursor is due', () => {
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      priorityTier: 'top100',
      status: 'failed',
      failureCount: 2,
      lastError: 'rate limit',
      nextRetryAt: new Date('2026-03-22T23:59:00.000Z'),
    });

    const leased = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'));

    expect(leased?.coinId).toBe('bitcoin');
    expect(leased?.status).toBe('running');
    expect(leased?.failureCount).toBe(2);
    expect(leased?.lastError).toBe('rate limit');
    expect(leased?.lastAttemptAt?.toISOString()).toBe('2026-03-23T00:00:00.000Z');
  });

  it('keeps failed targets skipped while the retry cursor is still in backoff', () => {
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      priorityTier: 'top100',
      status: 'failed',
      failureCount: 2,
      lastError: 'rate limit',
      nextRetryAt: new Date('2026-03-23T00:10:00.000Z'),
    });

    const leased = leaseNextOhlcvTarget(database, new Date('2026-03-23T00:00:00.000Z'));

    expect(leased).toBeNull();
  });

  it('updates latestSyncedAt and oldestSyncedAt on success', () => {
    seedTarget({ coinId: 'bitcoin', exchangeId: 'binance', symbol: 'BTC/USDT' });

    markOhlcvTargetSuccess(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1d',
      vsCurrency: 'usd',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      completedAt: new Date('2026-03-23T00:00:00.000Z'),
    });

    const row = database.db.select().from(ohlcvSyncTargets).all()[0];

    expect(row.status).toBe('idle');
    expect(row.latestSyncedAt?.toISOString()).toBe('2026-03-22T00:00:00.000Z');
    expect(row.oldestSyncedAt?.toISOString()).toBe('2025-03-22T00:00:00.000Z');
    expect(row.failureCount).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it('records failure metadata with exponential backoff', () => {
    seedTarget({ coinId: 'bitcoin', exchangeId: 'binance', symbol: 'BTC/USDT', failureCount: 1 });

    markOhlcvTargetFailure(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1d',
      vsCurrency: 'usd',
      failedAt: new Date('2026-03-23T00:00:00.000Z'),
      error: 'rate limit',
    });

    const row = database.db.select().from(ohlcvSyncTargets).all()[0];

    expect(row.status).toBe('failed');
    expect(row.failureCount).toBe(2);
    expect(row.lastError).toBe('rate limit');
    expect(row.nextRetryAt?.toISOString()).toBe('2026-03-23T00:10:00.000Z');
  });

  it('resets backoff and returns failed targets to idle after a successful sync', () => {
    seedTarget({
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      status: 'failed',
      failureCount: 3,
      lastError: 'rate limit',
      nextRetryAt: new Date('2026-03-23T00:40:00.000Z'),
    });

    markOhlcvTargetSuccess(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1d',
      vsCurrency: 'usd',
      latestSyncedAt: new Date('2026-03-23T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-12-23T00:00:00.000Z'),
      completedAt: new Date('2026-03-23T00:05:00.000Z'),
    });

    const row = database.db.select().from(ohlcvSyncTargets).all()[0];

    expect(row.status).toBe('idle');
    expect(row.failureCount).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.nextRetryAt).toBeNull();
  });

  it('extends retained history depth when targetHistoryDays increases', () => {
    upsertOhlcvSyncTargets(database, [
      {
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        interval: '1d',
        priorityTier: 'long_tail',
        targetHistoryDays: 90,
      },
    ], new Date('2026-03-22T00:00:00.000Z'));

    upsertOhlcvSyncTargets(database, [
      {
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        interval: '1d',
        priorityTier: 'long_tail',
        targetHistoryDays: 180,
      },
    ], new Date('2026-03-23T00:00:00.000Z'));

    const row = database.db.select().from(ohlcvSyncTargets).all()[0];
    expect(row.targetHistoryDays).toBe(180);
  });

  it('upserts discovered targets and promotes priority without resetting cursors', () => {
    upsertOhlcvSyncTargets(database, [
      {
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        interval: '1d',
        priorityTier: 'long_tail',
        targetHistoryDays: 365,
      },
    ], new Date('2026-03-22T00:00:00.000Z'));

    markOhlcvTargetSuccess(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1d',
      vsCurrency: 'usd',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
      oldestSyncedAt: new Date('2025-03-22T00:00:00.000Z'),
      completedAt: new Date('2026-03-23T00:00:00.000Z'),
    });

    promoteOhlcvTargetPriority(database, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      interval: '1d',
      vsCurrency: 'usd',
      priorityTier: 'top100',
      updatedAt: new Date('2026-03-23T12:00:00.000Z'),
    });

    const row = database.db.select().from(ohlcvSyncTargets).all()[0];

    expect(row.priorityTier).toBe('top100');
    expect(row.latestSyncedAt?.toISOString()).toBe('2026-03-22T00:00:00.000Z');
    expect(row.oldestSyncedAt?.toISOString()).toBe('2025-03-22T00:00:00.000Z');
  });
});
