import { describe, expect, it } from 'vitest';

import { getSnapshotAccessPolicy, getSnapshotFreshness, getUsableSnapshot } from '../src/modules/market-freshness';

describe('market snapshot freshness', () => {
  it('marks recent snapshots as fresh and exposes provider metadata', () => {
    const freshness = getSnapshotFreshness(
      {
        lastUpdated: new Date('2026-03-20T00:04:00.000Z'),
        sourceProvidersJson: JSON.stringify(['binance', 'kraken']),
        sourceCount: 2,
      },
      300,
      Date.parse('2026-03-20T00:05:00.000Z'),
    );

    expect(freshness).toEqual({
      ageSeconds: 60,
      isStale: false,
      providers: ['binance', 'kraken'],
      sourceCount: 2,
    });
  });

  it('marks old snapshots as stale', () => {
    const freshness = getSnapshotFreshness(
      {
        lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
        sourceProvidersJson: JSON.stringify(['coinbase']),
        sourceCount: 1,
      },
      300,
      Date.parse('2026-03-20T00:10:01.000Z'),
    );

    expect(freshness.isStale).toBe(true);
    expect(freshness.ageSeconds).toBe(601);
  });

  it('allows seeded snapshots before initial sync but rejects after', () => {
    const snapshot = {
      lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
      sourceProvidersJson: '[]',
      sourceCount: 0,
    };

    // Before sync — seeded snapshots allowed as fallback
    expect(getUsableSnapshot(
      snapshot,
      300,
      { initialSyncCompleted: false, allowStaleLiveService: false },
      Date.parse('2026-03-20T00:01:00.000Z'),
    )).toEqual(snapshot);

    // After sync — seeded snapshots rejected
    expect(getUsableSnapshot(
      snapshot,
      300,
      { initialSyncCompleted: true, allowStaleLiveService: false },
      Date.parse('2026-03-20T00:01:00.000Z'),
    )).toBeNull();
  });

  it('allows fresh live snapshots', () => {
    const snapshot = {
      lastUpdated: new Date('2026-03-20T00:04:00.000Z'),
      sourceProvidersJson: '["binance"]',
      sourceCount: 1,
    };

    expect(getUsableSnapshot(
      snapshot,
      300,
      { initialSyncCompleted: true, allowStaleLiveService: false },
      Date.parse('2026-03-20T00:05:00.000Z'),
    )).toEqual(snapshot);
  });

  it('allows stale live data when allowStaleLiveService is true', () => {
    const snapshot = {
      lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
      sourceProvidersJson: '["binance"]',
      sourceCount: 1,
    };

    expect(getUsableSnapshot(
      snapshot,
      300,
      { initialSyncCompleted: false, allowStaleLiveService: true },
      Date.parse('2026-03-20T00:10:00.000Z'),
    )).toEqual(snapshot);
  });

  it('returns null for stale live data when not allowed', () => {
    const snapshot = {
      lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
      sourceProvidersJson: '["binance"]',
      sourceCount: 1,
    };

    expect(getUsableSnapshot(
      snapshot,
      300,
      { initialSyncCompleted: true, allowStaleLiveService: false },
      Date.parse('2026-03-20T00:10:00.000Z'),
    )).toBeNull();
  });
});
