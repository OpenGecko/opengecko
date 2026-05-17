import { describe, expect, it } from 'vitest';

import {
  bumpMarketDataRevision,
  clearRecoveredMarketRuntimeDegradation,
  completeBootstrapRuntime,
  completeInitialMarketSync,
  createMarketDataRuntimeState,
  enableStaleLiveFallback,
  getMarketRuntimePhase,
  markMarketRuntimeListenerBound,
  markMarketRuntimeListenerStopped,
  recordInitialSyncFailure,
  recordInitialSyncSnapshotAvailability,
  recordForcedProviderFailure,
  recordMarketRefreshFailure,
  recordMarketRefreshSuccess,
  recordProviderFailureCooldown,
  clearProviderFailureCooldown,
  recordSeededBootstrapRuntime,
  recordValidationRuntimeOverride,
  type MarketDataRuntimeState,
  type MarketRuntimePhase,
} from '../src/services/market-runtime-state';

function createState(overrides: Partial<MarketDataRuntimeState> = {}) {
  const baseState = createMarketDataRuntimeState();

  return {
    ...baseState,
    ...overrides,
    validationOverride: {
      ...baseState.validationOverride,
      ...overrides.validationOverride,
    },
    forcedProviderFailure: {
      ...baseState.forcedProviderFailure,
      ...overrides.forcedProviderFailure,
    },
    startupPrewarm: {
      ...baseState.startupPrewarm,
      ...overrides.startupPrewarm,
    },
  };
}

describe('market runtime state phase classifier', () => {
  const now = Date.UTC(2026, 4, 5);

  const phaseCases: Array<{ name: string; state: MarketDataRuntimeState; expected: MarketRuntimePhase }> = [
    {
      name: 'cold boot before listener bind and initial sync',
      state: createState(),
      expected: 'cold_boot',
    },
    {
      name: 'syncing after listener bind before initial sync completion',
      state: createState({ listenerBound: true }),
      expected: 'syncing',
    },
    {
      name: 'live ready after successful initial sync',
      state: createState({ initialSyncCompleted: true }),
      expected: 'live_ready',
    },
    {
      name: 'stale ready when stale live fallback is explicitly allowed',
      state: createState({ initialSyncCompleted: true, allowStaleLiveService: true }),
      expected: 'stale_ready',
    },
    {
      name: 'zero live ready after completed boot without usable live snapshots',
      state: createState({
        initialSyncCompleted: true,
        initialSyncCompletedWithoutUsableLiveSnapshots: true,
        allowStaleLiveService: true,
      }),
      expected: 'zero_live_ready',
    },
    {
      name: 'provider degraded while cooldown is active',
      state: createState({
        initialSyncCompleted: true,
        providerFailureCooldownUntil: now + 1,
      }),
      expected: 'provider_degraded',
    },
    {
      name: 'provider degraded while forced provider failure is active',
      state: createState({
        initialSyncCompleted: true,
        forcedProviderFailure: {
          active: true,
          reason: 'validation failure injection',
        },
      }),
      expected: 'provider_degraded',
    },
    {
      name: 'validation override takes precedence over runtime readiness flags',
      state: createState({
        initialSyncCompleted: true,
        forcedProviderFailure: {
          active: true,
          reason: 'validation failure injection',
        },
        validationOverride: {
          mode: 'stale_allowed',
          reason: 'validation scenario',
          snapshotTimestampOverride: null,
          snapshotSourceCountOverride: null,
        },
      }),
      expected: 'validation_override',
    },
  ];

  it.each(phaseCases)('$name', ({ state, expected }) => {
    expect(getMarketRuntimePhase(state, now)).toBe(expected);
  });

  it('does not report provider degradation after a cooldown expires', () => {
    const state = createState({
      initialSyncCompleted: true,
      providerFailureCooldownUntil: now,
    });

    expect(getMarketRuntimePhase(state, now)).toBe('live_ready');
  });

  it('centralizes initial sync success transitions while preserving legacy readiness fields', () => {
    const state = createState({
      syncFailureReason: 'previous outage',
      allowStaleLiveService: true,
      providerFailureCooldownUntil: now + 1,
    });

    completeInitialMarketSync(state);

    expect(state).toMatchObject({
      initialSyncCompleted: true,
      listenerBindDeferred: true,
      syncFailureReason: null,
      allowStaleLiveService: false,
      providerFailureCooldownUntil: null,
      hotDataRevision: 1,
    });
  });

  it('keeps zero-live initial sync success ready without deferring listener prewarm', () => {
    const state = createState({
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
    });

    completeInitialMarketSync(state);

    expect(state).toMatchObject({
      initialSyncCompleted: true,
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
      listenerBindDeferred: false,
      hotDataRevision: 1,
    });
  });

  it('preserves residual stale fallback when initial sync cannot refresh live snapshots', () => {
    const state = createState({
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
      allowStaleLiveService: true,
      providerFailureCooldownUntil: now + 1,
    });

    completeInitialMarketSync(state);

    expect(state).toMatchObject({
      initialSyncCompleted: true,
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
      listenerBindDeferred: false,
      syncFailureReason: 'initial sync completed without usable fresh live snapshots; serving residual source-backed snapshots as stale fallback',
      allowStaleLiveService: true,
      providerFailureCooldownUntil: null,
      hotDataRevision: 1,
    });
  });

  it('centralizes refresh recovery and failure transitions', () => {
    const state = createState({
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
      syncFailureReason: 'previous outage',
      allowStaleLiveService: true,
      providerFailureCooldownUntil: now + 1,
      listenerBindDeferred: true,
    });

    recordMarketRefreshSuccess(state);

    expect(state).toMatchObject({
      initialSyncCompletedWithoutUsableLiveSnapshots: false,
      syncFailureReason: null,
      allowStaleLiveService: false,
      providerFailureCooldownUntil: null,
      listenerBindDeferred: false,
      hotDataRevision: 1,
    });

    recordMarketRefreshFailure(state, 'provider timeout');

    expect(state).toMatchObject({
      syncFailureReason: 'provider timeout',
      allowStaleLiveService: true,
    });

    recordProviderFailureCooldown(state, now + 1);
    expect(state.providerFailureCooldownUntil).toBe(now + 1);

    clearProviderFailureCooldown(state);
    expect(state.providerFailureCooldownUntil).toBeNull();
  });

  it('centralizes stale fallback, initial sync failure, listener, and revision transitions', () => {
    const state = createState();

    recordInitialSyncFailure(state, 'network error');
    recordInitialSyncSnapshotAvailability(state, false);
    enableStaleLiveFallback(state);
    bumpMarketDataRevision(state);

    expect(state).toMatchObject({
      syncFailureReason: 'network error',
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
      allowStaleLiveService: true,
      hotDataRevision: 1,
    });

    recordInitialSyncSnapshotAvailability(state, true);
    expect(state.initialSyncCompletedWithoutUsableLiveSnapshots).toBe(false);

    clearRecoveredMarketRuntimeDegradation(state);
    expect(state).toMatchObject({
      syncFailureReason: null,
      allowStaleLiveService: false,
      providerFailureCooldownUntil: null,
      listenerBindDeferred: false,
    });

    state.listenerBindDeferred = true;
    expect(markMarketRuntimeListenerBound(state)).toEqual({ shouldRunStartupPrewarm: true });
    expect(state).toMatchObject({
      listenerBound: true,
      listenerBindDeferred: false,
    });

    expect(markMarketRuntimeListenerBound(state)).toEqual({ shouldRunStartupPrewarm: false });
    markMarketRuntimeListenerStopped(state);
    expect(state.listenerBound).toBe(false);
  });

  it('centralizes seeded bootstrap runtime transitions', () => {
    const validationState = createState({
      hotDataRevision: 0,
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
      syncFailureReason: 'previous bootstrap failure',
      listenerBindDeferred: true,
      validationOverride: {
        mode: 'off',
        reason: 'validation runtime seeded from persistent live snapshots',
        snapshotTimestampOverride: '2026-05-05T00:00:00.000Z',
        snapshotSourceCountOverride: 1,
      },
    });

    recordSeededBootstrapRuntime(validationState, true);

    expect(validationState).toMatchObject({
      initialSyncCompleted: false,
      initialSyncCompletedWithoutUsableLiveSnapshots: false,
      allowStaleLiveService: true,
      syncFailureReason: null,
      listenerBindDeferred: false,
      hotDataRevision: 1,
      validationOverride: {
        mode: 'seeded_bootstrap',
        reason: 'validation runtime seeded from persistent live snapshots',
        snapshotTimestampOverride: '2026-05-05T00:00:00.000Z',
        snapshotSourceCountOverride: 1,
      },
    });

    const defaultState = createState({
      hotDataRevision: 3,
      validationOverride: {
        mode: 'seeded_bootstrap',
        reason: 'default runtime seeded from persistent live snapshots',
        snapshotTimestampOverride: '2026-05-05T00:00:00.000Z',
        snapshotSourceCountOverride: 1,
      },
    });

    recordSeededBootstrapRuntime(defaultState, false);

    expect(defaultState).toMatchObject({
      initialSyncCompleted: true,
      allowStaleLiveService: true,
      syncFailureReason: null,
      listenerBindDeferred: false,
      hotDataRevision: 3,
      validationOverride: {
        mode: 'off',
        reason: null,
        snapshotTimestampOverride: null,
        snapshotSourceCountOverride: null,
      },
    });
  });

  it('centralizes non-seeded bootstrap completion transitions', () => {
    const liveState = createState({
      hotDataRevision: 1,
      initialSyncCompletedWithoutUsableLiveSnapshots: false,
      allowStaleLiveService: true,
      syncFailureReason: 'previous failure',
    });

    completeBootstrapRuntime(liveState, false);

    expect(liveState).toMatchObject({
      initialSyncCompleted: true,
      allowStaleLiveService: false,
      syncFailureReason: null,
      hotDataRevision: 2,
    });

    const zeroLiveValidationState = createState({
      hotDataRevision: 4,
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
    });

    completeBootstrapRuntime(zeroLiveValidationState, true);

    expect(zeroLiveValidationState).toMatchObject({
      initialSyncCompleted: true,
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
      allowStaleLiveService: true,
      syncFailureReason: null,
      hotDataRevision: 4,
    });
  });

  it('centralizes diagnostics validation override transitions', () => {
    const state = createState({
      initialSyncCompleted: true,
      allowStaleLiveService: true,
      hotDataRevision: 5,
    });

    recordValidationRuntimeOverride(state, {
      mode: 'zero_live_completed_boot',
      reason: 'validation degraded state override',
      snapshotTimestampOverride: '2026-05-05T00:00:00.000Z',
      snapshotSourceCountOverride: 0,
    });

    expect(state).toMatchObject({
      initialSyncCompleted: true,
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
      allowStaleLiveService: false,
      hotDataRevision: 6,
      validationOverride: {
        mode: 'zero_live_completed_boot',
        reason: 'validation degraded state override',
        snapshotTimestampOverride: '2026-05-05T00:00:00.000Z',
        snapshotSourceCountOverride: 0,
      },
    });

    recordValidationRuntimeOverride(state, {
      mode: 'degraded_seeded_bootstrap',
      reason: 'validation degraded state override',
      snapshotTimestampOverride: '2026-05-05T00:00:01.000Z',
      snapshotSourceCountOverride: 0,
    });

    expect(state).toMatchObject({
      initialSyncCompleted: false,
      initialSyncCompletedWithoutUsableLiveSnapshots: false,
      hotDataRevision: 7,
      validationOverride: {
        mode: 'degraded_seeded_bootstrap',
      },
    });
  });

  it('centralizes forced provider failure transitions', () => {
    const state = createState({
      providerFailureCooldownUntil: now + 1,
    });

    recordForcedProviderFailure(state, {
      active: true,
      reason: 'validation failure injection',
    });

    expect(state).toMatchObject({
      providerFailureCooldownUntil: now + 1,
      forcedProviderFailure: {
        active: true,
        reason: 'validation failure injection',
      },
    });

    recordForcedProviderFailure(state, {
      active: false,
      reason: null,
    });

    expect(state).toMatchObject({
      providerFailureCooldownUntil: null,
      forcedProviderFailure: {
        active: false,
        reason: null,
      },
    });
  });
});
