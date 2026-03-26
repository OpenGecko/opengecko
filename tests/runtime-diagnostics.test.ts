import { describe, expect, it } from 'vitest';

import { buildRuntimeDiagnostics } from '../src/services/runtime-diagnostics';
import type { MarketDataRuntimeState } from '../src/services/market-runtime-state';

function createState(overrides: Partial<MarketDataRuntimeState> = {}): MarketDataRuntimeState {
  return {
    initialSyncCompleted: false,
    allowStaleLiveService: false,
    syncFailureReason: null,
    listenerBound: false,
    hotDataRevision: 0,
    ...overrides,
  };
}

describe('runtime diagnostics', () => {
  it('reports startup state with seeded bootstrap source class before readiness', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState(),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '[]',
        sourceCount: 0,
      },
      300,
      new Date('2026-03-26T00:01:00.000Z').getTime(),
    );

    expect(diagnostics).toEqual({
      readiness: {
        state: 'starting',
        listener_bound: false,
        initial_sync_completed: false,
      },
      degraded: {
        active: false,
        stale_live_enabled: false,
        reason: null,
      },
      hot_paths: {
        cache_revision: 0,
        shared_market_snapshot: {
          available: true,
          source_class: 'seeded_bootstrap',
          last_successful_live_refresh_at: null,
          freshness: {
            threshold_seconds: 300,
            age_seconds: 60,
            is_stale: false,
          },
          providers: [],
          provider_count: 0,
        },
      },
    });
  });

  it('reports degraded stale-live service with stale snapshot metadata and provider cause', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        allowStaleLiveService: true,
        syncFailureReason: 'provider timeout',
        hotDataRevision: 4,
      }),
      {
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      new Date('2026-03-26T00:00:00.000Z').getTime(),
    );

    expect(diagnostics).toEqual({
      readiness: {
        state: 'degraded',
        listener_bound: false,
        initial_sync_completed: false,
      },
      degraded: {
        active: true,
        stale_live_enabled: true,
        reason: 'provider timeout',
      },
      hot_paths: {
        cache_revision: 4,
        shared_market_snapshot: {
          available: true,
          source_class: 'stale_live',
          last_successful_live_refresh_at: '2026-03-19T00:00:00.000Z',
          freshness: {
            threshold_seconds: 300,
            age_seconds: 604800,
            is_stale: true,
          },
          providers: ['binance'],
          provider_count: 1,
        },
      },
    });
  });

  it('reports ready state with fresh live source class after recovery', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
        hotDataRevision: 2,
      }),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '["binance","kraken"]',
        sourceCount: 2,
      },
      300,
      new Date('2026-03-26T00:02:00.000Z').getTime(),
    );

    expect(diagnostics).toEqual({
      readiness: {
        state: 'ready',
        listener_bound: true,
        initial_sync_completed: true,
      },
      degraded: {
        active: false,
        stale_live_enabled: false,
        reason: null,
      },
      hot_paths: {
        cache_revision: 2,
        shared_market_snapshot: {
          available: true,
          source_class: 'fresh_live',
          last_successful_live_refresh_at: '2026-03-26T00:00:00.000Z',
          freshness: {
            threshold_seconds: 300,
            age_seconds: 120,
            is_stale: false,
          },
          providers: ['binance', 'kraken'],
          provider_count: 2,
        },
      },
    });
  });

  it('reports degraded provider failure while preserving ready hot-endpoint fallback semantics', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        allowStaleLiveService: true,
        syncFailureReason: 'provider timeout',
        listenerBound: true,
        hotDataRevision: 5,
      }),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      new Date('2026-03-26T00:20:00.000Z').getTime(),
    );

    expect(diagnostics).toEqual({
      readiness: {
        state: 'degraded',
        listener_bound: true,
        initial_sync_completed: true,
      },
      degraded: {
        active: true,
        stale_live_enabled: true,
        reason: 'provider timeout',
      },
      hot_paths: {
        cache_revision: 5,
        shared_market_snapshot: {
          available: true,
          source_class: 'stale_live',
          last_successful_live_refresh_at: '2026-03-26T00:00:00.000Z',
          freshness: {
            threshold_seconds: 300,
            age_seconds: 1200,
            is_stale: true,
          },
          providers: ['binance'],
          provider_count: 1,
        },
      },
    });
  });
});
