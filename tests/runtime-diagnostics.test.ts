import { describe, expect, it } from 'vitest';

import { buildRuntimeDiagnostics } from '../src/services/runtime-diagnostics';
import type { MarketDataRuntimeState } from '../src/services/market-runtime-state';
import { createProviderBreakerState, recordProviderFailure, recordProviderSuccess } from '../src/services/provider-breaker';

const REQUIRED_PROVIDER_DIAGNOSTIC_FIELDS = [
  'id',
  'state',
  'last_success_at',
  'last_failure_at',
  'last_failure_reason',
  'failure_kind',
  'failure_count',
  'next_retry_at',
  'alert_status',
] as const;

function createState(overrides: Partial<MarketDataRuntimeState> = {}): MarketDataRuntimeState {
  const baseState: MarketDataRuntimeState = {
    initialSyncCompleted: false,
      listenerBindDeferred: false,
    initialSyncCompletedWithoutUsableLiveSnapshots: false,
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
  it('normalizes seconds-encoded persisted snapshot timestamps without throwing', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
      }),
      {
        lastUpdated: new Date(1_775_466_023),
        sourceProvidersJson: '["coinbase"]',
        sourceCount: 1,
      },
      300,
      Date.parse('2026-04-06T09:05:00.000Z'),
    );

    expect(diagnostics.readiness.state).toBe('ready');
    expect(diagnostics.hot_paths.shared_market_snapshot).toEqual({
      available: true,
      source_class: 'fresh_live',
      last_successful_live_refresh_at: '2026-04-06T09:00:23.000Z',
      freshness: {
        threshold_seconds: 300,
        age_seconds: 277,
        is_stale: false,
      },
      providers: ['coinbase'],
      provider_count: 1,
    });
  });

  it('treats invalid persisted snapshot timestamps as unavailable instead of throwing', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
      }),
      {
        lastUpdated: new Date(Number.NaN),
        sourceProvidersJson: '["coinbase"]',
        sourceCount: 1,
      },
      300,
      Date.parse('2026-04-06T09:05:00.000Z'),
    );

    expect(diagnostics.hot_paths.shared_market_snapshot).toEqual({
      available: false,
      source_class: 'unavailable',
      last_successful_live_refresh_at: null,
      freshness: {
        threshold_seconds: 300,
        age_seconds: null,
        is_stale: null,
      },
      providers: [],
      provider_count: 0,
    });
  });

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
        canonical_phase: 'cold_boot',
        listener_bound: false,
        listener_bind_deferred: false,
        initial_sync_completed: false,
        degraded: false,
        zero_live_completed_boot: false,
        validation_override_active: false,
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
        canonical_phase: 'stale_ready',
        listener_bound: false,
        listener_bind_deferred: false,
        initial_sync_completed: false,
        degraded: true,
        zero_live_completed_boot: false,
        validation_override_active: false,
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
        canonical_phase: 'stale_ready',
        listener_bound: false,
        listener_bind_deferred: false,
        initial_sync_completed: false,
        degraded: true,
        zero_live_completed_boot: false,
        validation_override_active: false,
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
        canonical_phase: 'live_ready',
        listener_bound: true,
        listener_bind_deferred: false,
        initial_sync_completed: true,
        degraded: false,
        zero_live_completed_boot: false,
        validation_override_active: false,
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
      canonical_phase: 'validation_override',
      listener_bind_deferred: false,
      initial_sync_completed: false,
      degraded: true,
      validation_override_active: true,
    });
    expect(seededDiagnostics.degraded.validation_override).toEqual({
      active: true,
      mode: 'degraded_seeded_bootstrap',
      reason: 'validator degraded boot',
    });
    expect(seededDiagnostics.hot_paths.shared_market_snapshot.source_class).toBe('degraded_seeded_bootstrap');
    expect(seededDiagnostics.degraded.stale_live_enabled).toBe(false);
  });

  it('reports seeded bootstrap runtime mode distinctly from degraded seeded bootstrap', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        validationOverride: {
          mode: 'seeded_bootstrap',
          reason: 'default runtime seeded from persistent live snapshots',
          snapshotTimestampOverride: null,
          snapshotSourceCountOverride: null,
        },
      }),
      {
        lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      new Date('2026-03-20T00:02:00.000Z').getTime(),
    );

    expect(diagnostics.readiness).toMatchObject({
      state: 'starting',
      canonical_phase: 'validation_override',
      initial_sync_completed: false,
      degraded: false,
      zero_live_completed_boot: false,
      validation_override_active: true,
    });
    expect(diagnostics.degraded).toMatchObject({
      active: false,
      stale_live_enabled: true,
      reason: 'default runtime seeded from persistent live snapshots',
      validation_override: {
        active: true,
        mode: 'seeded_bootstrap',
        reason: 'default runtime seeded from persistent live snapshots',
      },
    });
    expect(diagnostics.hot_paths.shared_market_snapshot.source_class).toBe('seeded_bootstrap');
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
        canonical_phase: 'stale_ready',
        listener_bound: true,
        listener_bind_deferred: false,
        initial_sync_completed: true,
        degraded: true,
        zero_live_completed_boot: false,
        validation_override_active: false,
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

  it('reports provider breaker health without exposing provider credentials', () => {
    const providerBreakers = createProviderBreakerState(['binance', 'coinbase'], {
      baseBackoffMs: 60_000,
      jitterRatio: 0,
    });
    recordProviderFailure(
      providerBreakers,
      'binance',
      new Date('2026-03-26T00:00:00.000Z').getTime(),
      'ticker fetch timed out',
    );

    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
        providerBreakers,
      }),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '["coinbase"]',
        sourceCount: 1,
      },
      300,
      new Date('2026-03-26T00:00:30.000Z').getTime(),
    );

    expect(diagnostics.readiness.canonical_phase).toBe('provider_degraded');
    expect(diagnostics.degraded.provider_breakers).toEqual([
      {
        id: 'binance',
        state: 'open',
        status: 'open',
        alert_status: 'degraded',
        failure_kind: 'timeout',
        failure_count: 1,
        opened_until: '2026-03-26T00:01:00.000Z',
        next_retry_at: '2026-03-26T00:01:00.000Z',
        last_success_at: null,
        last_failure_at: '2026-03-26T00:00:00.000Z',
        last_failure_reason: 'provider request timed out',
        retry_in_ms: 30_000,
      },
      {
        id: 'coinbase',
        state: 'closed',
        status: 'closed',
        alert_status: 'healthy',
        failure_kind: null,
        failure_count: 0,
        opened_until: null,
        next_retry_at: null,
        last_success_at: null,
        last_failure_at: null,
        last_failure_reason: null,
        retry_in_ms: 0,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
    expect(JSON.stringify(diagnostics)).not.toContain('api_key');
  });

  it('reports classified provider breaker failure states without raw upstream details', () => {
    const state = createState();
    state.providerBreakers = createProviderBreakerState(['bybit'], {
      baseBackoffMs: 1_000,
      jitterRatio: 0,
    });
    recordProviderFailure(
      state.providerBreakers,
      'bybit',
      Date.parse('2026-03-21T00:00:00.000Z'),
      'ccxt bybit 403 Forbidden block access from your country request id secret-header stack trace',
    );

    const diagnostics = buildRuntimeDiagnostics(
      state,
      null,
      60,
      Date.parse('2026-03-21T00:00:00.100Z'),
    );

    expect(diagnostics.degraded.provider_breakers).toEqual([
      expect.objectContaining({
        id: 'bybit',
        state: 'open',
        failure_kind: 'regional_block',
        last_failure_reason: 'provider regionally blocked',
      }),
    ]);
    expect(diagnostics.providers).toEqual([
      expect.objectContaining({
        id: 'bybit',
        failure_kind: 'regional_block',
        last_failure_reason: 'provider regionally blocked',
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('secret-header');
    expect(JSON.stringify(diagnostics)).not.toContain('stack trace');
  });

  it('lists required breaker state fields only for providers with real breaker state', () => {
    const providerBreakers = createProviderBreakerState(['binance'], {
      baseBackoffMs: 60_000,
      jitterRatio: 0,
    });
    recordProviderFailure(
      providerBreakers,
      'binance',
      new Date('2026-03-26T00:00:00.000Z').getTime(),
      'GET https://user:pass@example.test/tickers?api_key=super-secret-token Authorization: Bearer abc123',
    );

    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
        providerBreakers,
      }),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      new Date('2026-03-26T00:00:30.000Z').getTime(),
    );

    const providers = diagnostics.providers ?? [];
    expect(providers.map((provider) => provider.id)).toEqual(['binance']);

    for (const provider of providers) {
      expect(Object.keys(provider)).toEqual(expect.arrayContaining([...REQUIRED_PROVIDER_DIAGNOSTIC_FIELDS]));
      expect(['closed', 'open', 'half_open']).toContain(provider.state);
      expect(['healthy', 'degraded', 'failing']).toContain(provider.alert_status);
      expect(typeof provider.failure_count).toBe('number');
      expect(provider.last_success_at === null || typeof provider.last_success_at === 'string').toBe(true);
      expect(provider.last_failure_at === null || typeof provider.last_failure_at === 'string').toBe(true);
      expect(provider.last_failure_reason === null || typeof provider.last_failure_reason === 'string').toBe(true);
      expect(provider.next_retry_at === null || typeof provider.next_retry_at === 'string').toBe(true);
    }

    expect(providers.find((provider) => provider.id === 'binance')).toMatchObject({
      state: 'open',
      alert_status: 'degraded',
      failure_count: 1,
      failure_kind: 'unknown',
      next_retry_at: '2026-03-26T00:01:00.000Z',
      last_failure_reason: 'provider failed',
    });
    expect(JSON.stringify(providers)).not.toContain('api_key');
    expect(JSON.stringify(providers)).not.toContain('super-secret-token');
    expect(JSON.stringify(providers)).not.toContain('Bearer');
  });

  it('reports non-CCXT provider breaker fields only when real breaker state exists', () => {
    const providerBreakers = createProviderBreakerState(['binance', 'defillama'], {
      baseBackoffMs: 60_000,
      jitterRatio: 0,
    });
    const failedAt = new Date('2026-03-26T00:00:00.000Z').getTime();
    recordProviderSuccess(providerBreakers, 'binance', failedAt - 60_000);
    recordProviderFailure(providerBreakers, 'defillama', failedAt, 'DeFiLlama pool fetch failed');

    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
        providerBreakers,
      }),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      failedAt + 30_000,
    );

    expect(diagnostics.providers).toEqual([
      expect.objectContaining({
        id: 'binance',
        state: 'closed',
        alert_status: 'healthy',
        last_success_at: '2026-03-25T23:59:00.000Z',
      }),
      expect.objectContaining({
        id: 'defillama',
        state: 'open',
        alert_status: 'degraded',
        failure_count: 1,
        failure_kind: 'unknown',
        last_failure_at: '2026-03-26T00:00:00.000Z',
        last_failure_reason: 'provider failed',
        next_retry_at: '2026-03-26T00:01:00.000Z',
      }),
    ]);
    expect(diagnostics.providers?.map((provider) => provider.id)).not.toEqual(expect.arrayContaining([
      'currency-api',
      'subsquid',
    ]));
  });

  it('classifies provider alert status across healthy, degraded, and failing transitions', () => {
    const providerBreakers = createProviderBreakerState(['binance', 'coinbase', 'kraken'], {
      baseBackoffMs: 60_000,
      jitterRatio: 0,
    });
    const startedAt = new Date('2026-03-26T00:00:00.000Z').getTime();

    recordProviderFailure(providerBreakers, 'binance', startedAt, 'first timeout');
    recordProviderFailure(providerBreakers, 'coinbase', startedAt, 'first timeout');
    recordProviderFailure(providerBreakers, 'coinbase', startedAt + 1_000, 'second timeout');
    recordProviderFailure(providerBreakers, 'coinbase', startedAt + 2_000, 'third timeout');

    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
        providerBreakers,
      }),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '["kraken"]',
        sourceCount: 1,
      },
      300,
      startedAt + 30_000,
    );

    expect(diagnostics.providers).toEqual([
      expect.objectContaining({
        id: 'binance',
        state: 'open',
        failure_count: 1,
        alert_status: 'degraded',
      }),
      expect.objectContaining({
        id: 'coinbase',
        state: 'open',
        failure_count: 3,
        alert_status: 'failing',
      }),
      expect.objectContaining({
        id: 'kraken',
        state: 'closed',
        failure_count: 0,
        alert_status: 'healthy',
      }),
    ]);
    expect(diagnostics.degraded.provider_breakers).toEqual([
      expect.objectContaining({
        id: 'binance',
        alert_status: 'degraded',
      }),
      expect.objectContaining({
        id: 'coinbase',
        alert_status: 'failing',
      }),
      expect.objectContaining({
        id: 'kraken',
        alert_status: 'healthy',
      }),
    ]);
  });

  it('keeps recently recovered providers degraded during the alert recovery window', () => {
    const providerBreakers = createProviderBreakerState(['binance'], {
      baseBackoffMs: 60_000,
      jitterRatio: 0,
    });
    const failedAt = new Date('2026-03-26T00:00:00.000Z').getTime();
    const recoveredAt = failedAt + 30_000;

    recordProviderFailure(providerBreakers, 'binance', failedAt, 'temporary timeout');
    recordProviderSuccess(providerBreakers, 'binance', recoveredAt);

    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
        providerBreakers,
      }),
      {
        lastUpdated: new Date(recoveredAt),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      recoveredAt + 30_000,
    );

    expect(diagnostics.providers).toEqual([
      expect.objectContaining({
        id: 'binance',
        state: 'closed',
        failure_count: 0,
        last_success_at: '2026-03-26T00:00:30.000Z',
        last_failure_at: '2026-03-26T00:00:00.000Z',
        alert_status: 'degraded',
      }),
    ]);
  });

  it('identifies provider capability ownership and last contribution by prioritized surface', () => {
    const providerBreakers = createProviderBreakerState(['binance', 'kraken'], {
      baseBackoffMs: 60_000,
      jitterRatio: 0,
    });
    const refreshedAt = new Date('2026-03-26T00:00:00.000Z').getTime();
    recordProviderSuccess(providerBreakers, 'binance', refreshedAt);
    recordProviderFailure(providerBreakers, 'kraken', refreshedAt + 1_000, 'ticker timeout');

    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBound: true,
        providerBreakers,
      }),
      {
        lastUpdated: new Date(refreshedAt),
        sourceProvidersJson: '["binance"]',
        sourceCount: 1,
      },
      300,
      refreshedAt + 30_000,
    );

    expect(diagnostics.providers?.find((provider) => provider.id === 'binance')).toMatchObject({
      id: 'binance',
      capabilities: [
        {
          surface: 'market_price',
          endpoint_families: ['/simple/price', '/coins/markets'],
          ownership: 'latest_contributor',
          state: 'contributed',
          last_contribution_at: '2026-03-26T00:00:00.000Z',
          degraded_reason: null,
        },
        {
          surface: 'ticker',
          endpoint_families: ['/coins/{id}/tickers', '/exchanges/{id}/tickers'],
          ownership: 'configured',
          state: 'contributed',
          last_contribution_at: '2026-03-26T00:00:00.000Z',
          degraded_reason: null,
        },
        {
          surface: 'exchange',
          endpoint_families: ['/exchanges/list', '/exchanges', '/exchanges/{id}'],
          ownership: 'configured',
          state: 'contributed',
          last_contribution_at: '2026-03-26T00:00:00.000Z',
          degraded_reason: null,
        },
        {
          surface: 'chart',
          endpoint_families: ['/coins/{id}/market_chart', '/coins/{id}/ohlc'],
          ownership: 'configured',
          state: 'unavailable',
          last_contribution_at: null,
          degraded_reason: 'no chart contribution recorded for provider',
        },
      ],
    });

    expect(diagnostics.providers?.find((provider) => provider.id === 'kraken')).toMatchObject({
      id: 'kraken',
      capabilities: [
        expect.objectContaining({
          surface: 'market_price',
          ownership: 'configured',
          state: 'degraded',
          last_contribution_at: null,
          degraded_reason: 'provider request timed out',
        }),
        expect.objectContaining({
          surface: 'ticker',
          ownership: 'configured',
          state: 'degraded',
          last_contribution_at: null,
          degraded_reason: 'provider request timed out',
        }),
        expect.objectContaining({
          surface: 'exchange',
          ownership: 'configured',
          state: 'degraded',
          last_contribution_at: null,
          degraded_reason: 'provider request timed out',
        }),
        expect.objectContaining({
          surface: 'chart',
          ownership: 'configured',
          state: 'degraded',
          last_contribution_at: null,
          degraded_reason: 'provider request timed out',
        }),
      ],
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

  it('reports when listener bind was intentionally deferred until after initial sync', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        listenerBindDeferred: true,
      }),
      null,
      300,
    );

    expect(diagnostics.readiness).toEqual({
      state: 'ready',
      canonical_phase: 'live_ready',
      listener_bound: false,
      listener_bind_deferred: true,
      initial_sync_completed: true,
      degraded: false,
      zero_live_completed_boot: false,
      validation_override_active: false,
    });
  });

  it('surfaces explicit zero-live completed boot readiness booleans', () => {
    const diagnostics = buildRuntimeDiagnostics(
      createState({
        initialSyncCompleted: true,
        initialSyncCompletedWithoutUsableLiveSnapshots: true,
      }),
      {
        lastUpdated: new Date('2026-03-26T00:00:00.000Z'),
        sourceProvidersJson: '[]',
        sourceCount: 0,
      },
      300,
      new Date('2026-03-26T00:01:00.000Z').getTime(),
    );

    expect(diagnostics.readiness).toMatchObject({
      state: 'ready',
      canonical_phase: 'zero_live_ready',
      initial_sync_completed: true,
      degraded: false,
      zero_live_completed_boot: true,
      validation_override_active: false,
    });
  });
});
