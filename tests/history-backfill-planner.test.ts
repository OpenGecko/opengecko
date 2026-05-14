import { describe, expect, it } from 'vitest';

import { parseCoverageTargetManifest, type CoverageTargetManifest } from '../src/services/coverage-targets';
import { planHistoryBackfillTasks } from '../src/services/history-backfill-planner';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-05-14T12:00:00.000Z');

const manifest = {
  version: 1,
  targets: [
    {
      family: 'market_charts',
      provider: 'custom',
      entity_type: 'coin',
      entity_id: 'bitcoin',
      interval: '1d',
      vs_currency: 'usd',
      tier: 'S',
      target_history_days: 365,
      freshness_slo_seconds: 3600,
      production_freshness_slo_seconds: 900,
      enabled: true,
      priority: 10,
    },
    {
      family: 'market_charts',
      provider: 'custom',
      entity_type: 'coin',
      entity_id: 'ethereum',
      interval: '1d',
      vs_currency: 'usd',
      tier: 'A',
      target_history_days: 365,
      freshness_slo_seconds: 3600,
      production_freshness_slo_seconds: 900,
      enabled: true,
      priority: 20,
    },
    {
      family: 'ohlcv',
      provider: 'binance',
      entity_type: 'coin',
      entity_id: 'solana',
      interval: '1d',
      vs_currency: 'usd',
      tier: 'B',
      target_history_days: 730,
      freshness_slo_seconds: 86400,
      production_freshness_slo_seconds: 3600,
      enabled: true,
      priority: 30,
    },
    {
      family: 'market_charts',
      provider: 'custom',
      entity_type: 'coin',
      entity_id: 'dogecoin',
      interval: '1d',
      vs_currency: 'usd',
      tier: 'long_tail',
      target_history_days: 30,
      freshness_slo_seconds: 86400,
      production_freshness_slo_seconds: 3600,
      enabled: false,
      priority: 999,
    },
  ],
} satisfies CoverageTargetManifest;

const [bitcoinTarget, ethereumTarget, solanaTarget] = parseCoverageTargetManifest(manifest);

function daysAgo(days: number) {
  return new Date(now.getTime() - days * DAY_MS);
}

describe('history backfill planner', () => {
  it('does not create work for covered targets', () => {
    const tasks = planHistoryBackfillTasks({
      targets: [bitcoinTarget!],
      observed: [{
        family: 'market_charts',
        provider: 'custom',
        coinId: 'bitcoin',
        interval: '1d',
        vsCurrency: 'usd',
        latestAt: daysAgo(0.01),
        oldestAt: daysAgo(400),
        sourceRowCount: 400,
      }],
      now,
    });

    expect(tasks).toEqual([]);
  });

  it('creates a first sync task for missing enabled targets only', () => {
    const tasks = planHistoryBackfillTasks({
      targets: parseCoverageTargetManifest(manifest),
      observed: [],
      now,
    });

    expect(tasks).toEqual([
      expect.objectContaining({
        family: 'market_charts',
        provider: 'custom',
        coinId: 'bitcoin',
        interval: '1d',
        vsCurrency: 'usd',
        reason: 'missing',
        priority: 10,
      }),
      expect.objectContaining({
        family: 'market_charts',
        coinId: 'ethereum',
        reason: 'missing',
        priority: 20,
      }),
      expect.objectContaining({
        family: 'ohlcv',
        provider: 'binance',
        coinId: 'solana',
        reason: 'missing',
        priority: 30,
      }),
    ]);
    expect(tasks.map((task) => task.coinId)).not.toContain('dogecoin');
    expect(tasks[0]!.from.toISOString()).toBe('2026-04-14T12:00:00.000Z');
    expect(tasks[0]!.to).toEqual(now);
  });

  it('creates refresh tasks for production-stale and stale targets', () => {
    const tasks = planHistoryBackfillTasks({
      targets: [bitcoinTarget!, solanaTarget!],
      observed: [
        {
          family: 'market_charts',
          provider: 'custom',
          coinId: 'bitcoin',
          interval: '1d',
          vsCurrency: 'usd',
          latestAt: daysAgo(0.02),
          oldestAt: daysAgo(400),
          sourceRowCount: 400,
        },
        {
          family: 'ohlcv',
          provider: 'binance',
          coinId: 'solana',
          interval: '1d',
          vsCurrency: 'usd',
          latestAt: daysAgo(2),
          oldestAt: daysAgo(800),
          sourceRowCount: 800,
        },
      ],
      now,
    });

    expect(tasks).toEqual([
      expect.objectContaining({ coinId: 'bitcoin', reason: 'production_stale' }),
      expect.objectContaining({ coinId: 'solana', reason: 'stale' }),
    ]);
    expect(tasks[0]!.from).toEqual(daysAgo(0.02));
    expect(tasks[0]!.to).toEqual(now);
  });

  it('creates a 180-day historical chunk for shallow targets', () => {
    const tasks = planHistoryBackfillTasks({
      targets: [solanaTarget!],
      observed: [{
        family: 'ohlcv',
        provider: 'binance',
        coinId: 'solana',
        interval: '1d',
        vsCurrency: 'usd',
        latestAt: daysAgo(0.01),
        oldestAt: daysAgo(200),
        sourceRowCount: 200,
      }],
      now,
    });

    expect(tasks).toEqual([
      expect.objectContaining({
        coinId: 'solana',
        reason: 'shallow',
        from: daysAgo(380),
        to: daysAgo(200),
      }),
    ]);
  });

  it('sorts tasks deterministically by tier, reason urgency, numeric priority, and coin id', () => {
    const tasks = planHistoryBackfillTasks({
      targets: [solanaTarget!, ethereumTarget!, bitcoinTarget!],
      observed: [
        {
          family: 'ohlcv', provider: 'binance', coinId: 'solana', interval: '1d', vsCurrency: 'usd',
          latestAt: daysAgo(2), oldestAt: daysAgo(800), sourceRowCount: 800,
        },
        {
          family: 'market_charts', provider: 'custom', coinId: 'ethereum', interval: '1d', vsCurrency: 'usd',
          latestAt: daysAgo(2), oldestAt: daysAgo(400), sourceRowCount: 400,
        },
        {
          family: 'market_charts', provider: 'custom', coinId: 'bitcoin', interval: '1d', vsCurrency: 'usd',
          latestAt: daysAgo(0.02), oldestAt: daysAgo(20), sourceRowCount: 20,
        },
      ],
      now,
    });

    expect(tasks.map((task) => `${task.coinId}:${task.reason}`)).toEqual([
      'bitcoin:production_stale',
      'bitcoin:shallow',
      'ethereum:stale',
      'solana:stale',
    ]);
  });
});
