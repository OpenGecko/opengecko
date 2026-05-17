import { createProviderBreakerState, summarizeProviderBreakerState, type ProviderBreakerState } from './provider-breaker';

export type MarketDataRuntimeState = {
  initialSyncCompleted: boolean;
  listenerBindDeferred: boolean;
  initialSyncCompletedWithoutUsableLiveSnapshots: boolean;
  allowStaleLiveService: boolean;
  syncFailureReason: string | null;
  listenerBound: boolean;
  hotDataRevision: number;
  validationOverride: {
    mode: 'off' | 'stale_disallowed' | 'stale_allowed' | 'degraded_seeded_bootstrap' | 'seeded_bootstrap' | 'zero_live_completed_boot';
    reason: string | null;
    snapshotTimestampOverride: string | null;
    snapshotSourceCountOverride: number | null;
  };
  providerFailureCooldownUntil: number | null;
  providerBreakers?: ProviderBreakerState;
  forcedProviderFailure: {
    active: boolean;
    reason: string | null;
  };
  exchangeTickerIngestion?: {
    last_refresh_at: string | null;
    exchange_results: Record<string, {
      fetched_ticker_count: number;
      matched_ticker_count: number;
      accepted_ticker_rows: number;
      rejected_ticker_rows: number;
      rejection_reasons: Record<string, number>;
      failed_reason: string | null;
    }>;
  };
  startupPrewarm: {
    enabled: boolean;
    budgetMs: number;
    readyWithinBudget: boolean;
    firstRequestWarmBenefitsObserved: boolean;
    firstRequestWarmBenefitPending: boolean;
    targets: Array<{
      id: string;
      label: string;
      endpoint: string;
    }>;
    completedAt: number | null;
    totalDurationMs: number | null;
    targetResults: Array<{
      id: string;
      label: string;
      endpoint: string;
      status: 'completed' | 'timeout' | 'failed' | 'skipped_budget';
      durationMs: number;
      cacheSurface: 'simple_price' | 'coins_markets';
      warmCacheRevision: number | null;
      firstObservedRequest?: {
        durationMs: number;
        cacheHit: boolean;
      } | null;
    }>;
  };
};

export type MarketRuntimePhase =
  | 'cold_boot'
  | 'syncing'
  | 'live_ready'
  | 'stale_ready'
  | 'zero_live_ready'
  | 'provider_degraded'
  | 'validation_override';

type ValidationOverrideMode = MarketDataRuntimeState['validationOverride']['mode'];

type ValidationOverrideInput = {
  mode: ValidationOverrideMode;
  reason: string | null;
  snapshotTimestampOverride: string | null;
  snapshotSourceCountOverride: number | null;
};

export function getMarketRuntimePhase(state: MarketDataRuntimeState, now = Date.now()): MarketRuntimePhase {
  if (state.validationOverride.mode !== 'off') {
    return 'validation_override';
  }

  if (
    state.forcedProviderFailure.active
    || (state.providerFailureCooldownUntil !== null && state.providerFailureCooldownUntil > now)
    || summarizeProviderBreakerState(state.providerBreakers ?? createProviderBreakerState(), now).some(
      (provider) => provider.status === 'open',
    )
  ) {
    return 'provider_degraded';
  }

  if (state.initialSyncCompleted && state.initialSyncCompletedWithoutUsableLiveSnapshots) {
    return 'zero_live_ready';
  }

  if (state.allowStaleLiveService) {
    return 'stale_ready';
  }

  if (state.initialSyncCompleted) {
    return 'live_ready';
  }

  if (state.listenerBound) {
    return 'syncing';
  }

  return 'cold_boot';
}

export function bumpMarketDataRevision(state: MarketDataRuntimeState) {
  state.hotDataRevision += 1;
}

export function clearRecoveredMarketRuntimeDegradation(state: MarketDataRuntimeState) {
  state.syncFailureReason = null;
  state.allowStaleLiveService = false;
  state.providerFailureCooldownUntil = null;
  state.listenerBindDeferred = false;
}

export function enableStaleLiveFallback(state: MarketDataRuntimeState) {
  state.allowStaleLiveService = true;
}

export function recordInitialSyncFailure(state: MarketDataRuntimeState, reason: string) {
  state.syncFailureReason = reason;
}

export function recordInitialSyncSnapshotAvailability(state: MarketDataRuntimeState, hasUsableLiveSnapshots: boolean) {
  state.initialSyncCompletedWithoutUsableLiveSnapshots = !hasUsableLiveSnapshots;
}

export function completeInitialMarketSync(state: MarketDataRuntimeState) {
  const preserveResidualStaleFallback = state.initialSyncCompletedWithoutUsableLiveSnapshots
    && state.allowStaleLiveService;

  state.initialSyncCompleted = true;

  if (state.initialSyncCompletedWithoutUsableLiveSnapshots) {
    state.listenerBindDeferred = false;
    state.providerFailureCooldownUntil = null;
    if (preserveResidualStaleFallback) {
      state.allowStaleLiveService = true;
      state.syncFailureReason ??= 'initial sync completed without usable fresh live snapshots; serving residual source-backed snapshots as stale fallback';
    } else {
      state.syncFailureReason = null;
      state.allowStaleLiveService = false;
    }
    bumpMarketDataRevision(state);
    return;
  }

  clearRecoveredMarketRuntimeDegradation(state);
  bumpMarketDataRevision(state);
  state.listenerBindDeferred = true;
}

export function recordMarketRefreshSuccess(state: MarketDataRuntimeState) {
  state.initialSyncCompletedWithoutUsableLiveSnapshots = false;
  clearRecoveredMarketRuntimeDegradation(state);
  bumpMarketDataRevision(state);
}

export function recordMarketRefreshFailure(state: MarketDataRuntimeState, reason: string) {
  state.syncFailureReason = reason;
  enableStaleLiveFallback(state);
}

export function recordProviderFailureCooldown(state: MarketDataRuntimeState, cooldownUntil: number) {
  state.providerFailureCooldownUntil = cooldownUntil;
}

export function clearProviderFailureCooldown(state: MarketDataRuntimeState) {
  state.providerFailureCooldownUntil = null;
}

export function recordForcedProviderFailure(
  state: MarketDataRuntimeState,
  forcedProviderFailure: MarketDataRuntimeState['forcedProviderFailure'],
) {
  state.forcedProviderFailure = forcedProviderFailure;

  if (!forcedProviderFailure.active) {
    clearProviderFailureCooldown(state);
  }
}

export function recordSeededBootstrapRuntime(
  state: MarketDataRuntimeState,
  bootstrapOnlyValidationRuntime: boolean,
) {
  state.initialSyncCompleted = !bootstrapOnlyValidationRuntime;
  state.initialSyncCompletedWithoutUsableLiveSnapshots = false;
  state.allowStaleLiveService = true;
  state.syncFailureReason = null;
  state.listenerBindDeferred = false;
  state.validationOverride = bootstrapOnlyValidationRuntime
    ? {
      ...state.validationOverride,
      mode: 'seeded_bootstrap',
    }
    : {
      mode: 'off',
      reason: null,
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    };

  if (state.hotDataRevision === 0) {
    state.hotDataRevision = 1;
  }
}

export function completeBootstrapRuntime(
  state: MarketDataRuntimeState,
  bootstrapOnlyValidationRuntime: boolean,
) {
  state.initialSyncCompleted = true;
  state.allowStaleLiveService = bootstrapOnlyValidationRuntime
    && state.initialSyncCompletedWithoutUsableLiveSnapshots;
  state.syncFailureReason = null;

  if (
    !state.initialSyncCompletedWithoutUsableLiveSnapshots
    && state.hotDataRevision > 0
  ) {
    bumpMarketDataRevision(state);
  }
}

export function recordValidationRuntimeOverride(
  state: MarketDataRuntimeState,
  override: ValidationOverrideInput,
) {
  state.validationOverride = override;
  state.initialSyncCompleted = override.mode === 'zero_live_completed_boot'
    ? true
    : override.mode === 'seeded_bootstrap' || override.mode === 'degraded_seeded_bootstrap'
      ? false
      : state.initialSyncCompleted;
  state.initialSyncCompletedWithoutUsableLiveSnapshots = override.mode === 'zero_live_completed_boot';

  if (override.mode === 'zero_live_completed_boot') {
    state.allowStaleLiveService = false;
  }

  bumpMarketDataRevision(state);
}

export function markMarketRuntimeListenerBound(state: MarketDataRuntimeState) {
  state.listenerBound = true;

  if (!state.listenerBindDeferred) {
    return { shouldRunStartupPrewarm: false };
  }

  state.listenerBindDeferred = false;
  return { shouldRunStartupPrewarm: true };
}

export function markMarketRuntimeListenerStopped(state: MarketDataRuntimeState) {
  state.listenerBound = false;
}

export function createMarketDataRuntimeState(providerIds: string[] = []): MarketDataRuntimeState {
  return {
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
    providerBreakers: createProviderBreakerState(providerIds),
    forcedProviderFailure: {
      active: false,
      reason: null,
    },
    exchangeTickerIngestion: {
      last_refresh_at: null,
      exchange_results: {},
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
}
