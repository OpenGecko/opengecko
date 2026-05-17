import { describe, expect, it } from 'vitest';

import {
  deriveOhlcvLatestSyncedAt,
  deriveOhlcvOldestSyncedAt,
  isOhlcvRecentCoverageCurrentEnough,
  rankOhlcvLeaseTargets,
  shouldDeepenOhlcvHistory,
} from '../src/services/ohlcv-scheduling-policy';

type PolicyTarget = Parameters<typeof rankOhlcvLeaseTargets>[0][number];

const NOW = new Date('2026-03-23T00:00:00.000Z');

function target(overrides: Partial<PolicyTarget> & Pick<PolicyTarget, 'coinId'>): PolicyTarget {
  return {
    coinId: overrides.coinId,
    exchangeId: overrides.exchangeId ?? 'binance',
    symbol: overrides.symbol ?? `${overrides.coinId.toUpperCase()}/USDT`,
    vsCurrency: overrides.vsCurrency ?? 'usd',
    interval: overrides.interval ?? '1d',
    priorityTier: overrides.priorityTier ?? 'long_tail',
    latestSyncedAt: overrides.latestSyncedAt ?? null,
    oldestSyncedAt: overrides.oldestSyncedAt ?? null,
    targetHistoryDays: overrides.targetHistoryDays ?? 365,
    status: overrides.status ?? 'idle',
    lastSuccessAt: overrides.lastSuccessAt ?? null,
    updatedAt: overrides.updatedAt ?? new Date('2026-03-22T00:00:00.000Z'),
    nextRetryAt: overrides.nextRetryAt ?? null,
  };
}

describe('ohlcv scheduling policy', () => {
  it('ranks eligible leases with the existing priority, retry, freshness, interval, depth, success, and id tie-breakers', () => {
    const candidates = [
      target({
        coinId: 'microcap',
        priorityTier: 'long_tail',
        oldestSyncedAt: null,
        targetHistoryDays: 3650,
      }),
      target({
        coinId: 'bitcoin-daily-deep',
        priorityTier: 'top100',
        interval: '1d',
        latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
        oldestSyncedAt: new Date('2021-03-23T00:00:00.000Z'),
        targetHistoryDays: 3650,
        lastSuccessAt: new Date('2026-03-22T00:00:00.000Z'),
      }),
      target({
        coinId: 'ethereum-retry',
        priorityTier: 'top100',
        status: 'failed',
        failureCount: 1,
        nextRetryAt: new Date('2026-03-22T23:59:00.000Z'),
      } as Partial<PolicyTarget> & Pick<PolicyTarget, 'coinId'>),
      target({
        coinId: 'bitcoin-intraday',
        priorityTier: 'top100',
        interval: '1m',
        latestSyncedAt: null,
        oldestSyncedAt: null,
        targetHistoryDays: 30,
      }),
      target({
        coinId: 'a-stale-daily',
        priorityTier: 'top100',
        latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
        oldestSyncedAt: new Date('2025-03-23T00:00:00.000Z'),
        targetHistoryDays: 365,
        lastSuccessAt: new Date('2026-03-20T00:00:00.000Z'),
      }),
    ];
    const before = structuredClone(candidates);

    const ranked = rankOhlcvLeaseTargets(candidates, NOW);

    expect(ranked.map((row) => row.coinId)).toEqual([
      'ethereum-retry',
      'bitcoin-intraday',
      'a-stale-daily',
      'bitcoin-daily-deep',
      'microcap',
    ]);
    expect(candidates).toEqual(before);
  });

  it('excludes retry-backoff and running targets from pure lease ranking without mutating them', () => {
    const candidates = [
      target({
        coinId: 'bitcoin-backoff',
        priorityTier: 'top100',
        status: 'failed',
        nextRetryAt: new Date('2026-03-23T00:10:00.000Z'),
      }),
      target({
        coinId: 'ethereum-running',
        priorityTier: 'top100',
        status: 'running',
      }),
      target({
        coinId: 'cardano-idle',
        priorityTier: 'requested',
        status: 'idle',
      }),
    ];
    const before = structuredClone(candidates);

    expect(rankOhlcvLeaseTargets(candidates, NOW).map((row) => row.coinId)).toEqual(['cardano-idle']);
    expect(candidates).toEqual(before);
  });

  it('derives cursor advancement only from accepted persisted candle arrays', () => {
    const leased = target({
      coinId: 'bitcoin',
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-20T00:00:00.000Z'),
    });

    expect(deriveOhlcvLatestSyncedAt(leased, [])?.toISOString()).toBe('2026-03-21T00:00:00.000Z');
    expect(deriveOhlcvLatestSyncedAt(leased, [
      { timestamp: Date.parse('2026-03-22T00:00:00.000Z') },
    ])?.toISOString()).toBe('2026-03-22T00:00:00.000Z');
    expect(deriveOhlcvOldestSyncedAt(leased, [])?.toISOString()).toBe('2026-03-20T00:00:00.000Z');
    expect(deriveOhlcvOldestSyncedAt(leased, [
      { timestamp: Date.parse('2025-09-23T00:00:00.000Z') },
    ])?.toISOString()).toBe('2025-09-23T00:00:00.000Z');
  });

  it('keeps historical deepening gated by route-visible recent coverage', () => {
    const stale = target({
      coinId: 'bitcoin-stale',
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
    });
    const current = target({
      coinId: 'bitcoin-current',
      latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'),
    });

    expect(isOhlcvRecentCoverageCurrentEnough(stale.latestSyncedAt, NOW)).toBe(false);
    expect(isOhlcvRecentCoverageCurrentEnough(current.latestSyncedAt, NOW)).toBe(true);
    expect(shouldDeepenOhlcvHistory(stale, new Date('2026-03-23T00:00:00.000Z'), NOW)).toBe(false);
    expect(shouldDeepenOhlcvHistory(current, current.latestSyncedAt, NOW)).toBe(true);
  });
});
