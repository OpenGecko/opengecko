import { describe, expect, it } from 'vitest';

import { buildRuntimeDiagnostics } from '../src/services/runtime-diagnostics';
import type { MarketDataRuntimeState } from '../src/services/market-runtime-state';

function createState(overrides: Partial<MarketDataRuntimeState> = {}): MarketDataRuntimeState {
  const baseState: MarketDataRuntimeState = {
    initialSyncCompleted: false,
    allowStaleLiveService: false,
    syncFailureReason: null,
    listenerBound: false,
    hotDataRevision: 0,
    validationOverride: {
      mode: 'off',
      reason: null,
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    },
    providerFailureCooldownUntil: null,
    forcedProviderFailure: {
      active: false,
      reason: null,
    },
    startupPrewarm: {
      enabled: false,
      budgetMs: 0,
      readyWithinBudget: true,
      firstRequestWarmBenefitsObserved: false,
      firstRequestWarmBenefitPending: false,
      targets: [],
      completedAt: null,
      totalDurationMs: null,
      targetResults: [],
    },
  };

  return {
    ...baseState,
    ...overrides,
    validationOverride: overrides.validationOverride ?? baseState.validationOverride,
    forcedProviderFailure: overrides.forcedProviderFailure ?? baseState.forcedProviderFailure,
    startupPrewarm: overrides.startupPrewarm ?? baseState.startupPrewarm,
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
        provider_failure_cooldown_until: null,
        injected_provider_failure: {
          active: false,
          reason: null,
        },
        validation_override: {
          active: false,
          mode: 'off',
          reason: null,
        },
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

  it('distinguishes failed degraded seeded boot from ordinary seeded startup', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        allowStaleLiveService: true,
        syncFailureReason: 'bootstrap upstream unavailable',
        hotDataRevision: 3,
      }),
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
        state: 'degraded',
        listener_bound: false,
        initial_sync_completed: false,
      },
      degraded: {
        active: true,
        stale_live_enabled: true,
        reason: 'bootstrap upstream unavailable',
        provider_failure_cooldown_until: null,
        injected_provider_failure: {
          active: false,
          reason: null,
        },
        validation_override: {
          active: false,
          mode: 'off',
          reason: null,
        },
      },
      hot_paths: {
        cache_revision: 3,
        shared_market_snapshot: {
          available: true,
          source_class: 'degraded_seeded_bootstrap',
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
        provider_failure_cooldown_until: null,
        injected_provider_failure: {
          active: false,
          reason: null,
        },
        validation_override: {
          active: false,
          mode: 'off',
          reason: null,
        },
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
        provider_failure_cooldown_until: null,
        injected_provider_failure: {
          active: false,
          reason: null,
        },
        validation_override: {
          active: false,
          mode: 'off',
          reason: null,
        },
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

  it('reports validation override state for stale-live and degraded seeded boot scenarios', () => {
    const staleAllowedDiagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        validationOverride: {
          mode: 'stale_allowed',
          reason: 'validator stale-live allowed',
          snapshotTimestampOverride: null,
          snapshotSourceCountOverride: null,
        },
      }),
      {
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      new Date('2026-03-26T00:00:00.000Z').getTime(),
    );

    expect(staleAllowedDiagnostics.degraded).toMatchObject({
      active: true,
      stale_live_enabled: true,
      reason: 'validator stale-live allowed',
      validation_override: {
        active: true,
        mode: 'stale_allowed',
        reason: 'validator stale-live allowed',
      },
    });
    expect(staleAllowedDiagnostics.hot_paths.shared_market_snapshot.source_class).toBe('stale_live');

    const seededDiagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        validationOverride: {
          mode: 'degraded_seeded_bootstrap',
          reason: 'validator degraded boot',
          snapshotTimestampOverride: null,
          snapshotSourceCountOverride: null,
        },
      }),
      {
        lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
        sourceProvidersJson: '[]',
        sourceCount: 0,
      },
      300,
      new Date('2026-03-26T00:00:00.000Z').getTime(),
    );

    expect(seededDiagnostics.readiness).toMatchObject({
      state: 'degraded',
      initial_sync_completed: false,
    });
    expect(seededDiagnostics.degraded.validation_override).toEqual({
      active: true,
      mode: 'degraded_seeded_bootstrap',
      reason: 'validator degraded boot',
    });
    expect(seededDiagnostics.hot_paths.shared_market_snapshot.source_class).toBe('degraded_seeded_bootstrap');
  });

  it('reports ready state after recovery whenever failure indicators are cleared', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
        hotDataRevision: 6,
      }),
      {
        lastUpdated: new Date('2026-03-26T00:10:00.000Z'),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      new Date('2026-03-26T00:11:00.000Z').getTime(),
    );

    expect(diagnostics.readiness.state).toBe('ready');
    expect(diagnostics.degraded).toEqual({
      active: false,
      stale_live_enabled: false,
      reason: null,
      provider_failure_cooldown_until: null,
      injected_provider_failure: {
        active: false,
        reason: null,
      },
      validation_override: {
        active: false,
        mode: 'off',
        reason: null,
      },
    });
    expect(diagnostics.hot_paths.cache_revision).toBe(6);
    expect(diagnostics.hot_paths.shared_market_snapshot.source_class).toBe('fresh_live');
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
        provider_failure_cooldown_until: null,
        injected_provider_failure: {
          active: false,
          reason: null,
        },
        validation_override: {
          active: false,
          mode: 'off',
          reason: null,
        },
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

  it('reports active provider failure cooldown alongside degraded provider state', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        allowStaleLiveService: true,
        syncFailureReason: 'provider failure cooldown active after exchange refresh failure',
        listenerBound: true,
        hotDataRevision: 7,
        providerFailureCooldownUntil: new Date('2026-03-26T00:05:00.000Z').getTime(),
      }),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      new Date('2026-03-26T00:01:00.000Z').getTime(),
    );

    expect(diagnostics.degraded).toEqual({
      active: true,
      stale_live_enabled: true,
      reason: 'provider failure cooldown active after exchange refresh failure',
      provider_failure_cooldown_until: '2026-03-26T00:05:00.000Z',
      injected_provider_failure: {
        active: false,
        reason: null,
      },
      validation_override: {
        active: false,
        mode: 'off',
        reason: null,
      },
    });
  });

  it('reports injected provider failure state alongside degraded recovery fields', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        allowStaleLiveService: true,
        syncFailureReason: 'validator forced outage',
        listenerBound: true,
        forcedProviderFailure: {
          active: true,
          reason: 'validator forced outage',
        },
      }),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      new Date('2026-03-26T00:02:00.000Z').getTime(),
    );

    expect(diagnostics.degraded).toEqual({
      active: true,
      stale_live_enabled: true,
      reason: 'validator forced outage',
      provider_failure_cooldown_until: null,
      injected_provider_failure: {
        active: true,
        reason: 'validator forced outage',
      },
      validation_override: {
        active: false,
        mode: 'off',
        reason: null,
      },
    });
  });
});
