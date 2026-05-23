import { createProviderBreakerState, summarizeProviderBreakerState, type ProviderBreakerState } from './provider-breaker';
import { sanitizeNullableDiagnosticText } from './diagnostic-sanitizer';

export type ProviderAttemptOutcome =
  | 'successful'
  | 'timed_out'
  | 'canceled'
  | 'failed'
  | 'breaker_open'
  | 'blocked_unavailable'
  | 'skipped'
  | 'recovered';

export type ProviderAttemptFamily = 'market' | 'exchange' | 'ticker' | 'chart' | 'onchain';

export type ProviderFaultControlMode = 'timeout' | 'failure' | 'canceled' | 'blocked_unavailable' | 'off';

export type ProviderAttemptRecord = {
  provider: string;
  family: ProviderAttemptFamily;
  outcome: ProviderAttemptOutcome;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  reason: string | null;
};

export type ProviderInFlightAttempt = {
  provider: string;
  family: ProviderAttemptFamily;
  started_at: string;
};

export type ProviderFaultControl = {
  provider: string;
  family: ProviderAttemptFamily;
  mode: ProviderFaultControlMode;
  reason: string | null;
};

export type ProviderAttemptDiagnosticsState = {
  inFlight: Record<string, ProviderInFlightAttempt>;
  recentOutcomes: ProviderAttemptRecord[];
  outcomeCounts: Record<string, number>;
  faultControls: Record<string, ProviderFaultControl>;
};

const PROVIDER_ATTEMPT_RECENT_LIMIT = 50;

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
  providerAttempts?: ProviderAttemptDiagnosticsState;
  exchangeTickerIngestion?: {
    last_refresh_at: string | null;
    configured_exchange_ids: string[];
    attempted_exchange_ids: string[];
    promotion_attempted_exchange_ids: string[];
    successful_exchange_ids: string[];
    live_backed_exchange_ids: string[];
    failed_exchange_ids: string[];
    blocked_exchange_ids: string[];
    unavailable_exchange_ids: string[];
    exchange_results: Record<string, {
      fetched_ticker_count: number;
      matched_ticker_count: number;
      accepted_ticker_rows: number;
      rejected_ticker_rows: number;
      rejection_reasons: Record<string, number>;
      failed_kind: string | null;
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

function providerAttemptKey(provider: string, family: ProviderAttemptFamily) {
  return `${family}:${provider}`;
}

export function getProviderAttemptDiagnosticsState(state: MarketDataRuntimeState): ProviderAttemptDiagnosticsState {
  state.providerAttempts ??= {
    inFlight: {},
    recentOutcomes: [],
    outcomeCounts: {},
    faultControls: {},
  };

  return state.providerAttempts;
}

function sanitizeProviderAttemptReason(reason: string | null | undefined) {
  return sanitizeNullableDiagnosticText(reason ?? null);
}

export function startProviderAttempt(
  state: MarketDataRuntimeState,
  provider: string,
  family: ProviderAttemptFamily,
  startedAt = Date.now(),
) {
  getProviderAttemptDiagnosticsState(state).inFlight[providerAttemptKey(provider, family)] = {
    provider,
    family,
    started_at: new Date(startedAt).toISOString(),
  };
}

export function finishProviderAttempt(
  state: MarketDataRuntimeState,
  provider: string,
  family: ProviderAttemptFamily,
  outcome: ProviderAttemptOutcome,
  reason: string | null | undefined = null,
  finishedAt = Date.now(),
  durationMsOverride?: number,
) {
  const key = providerAttemptKey(provider, family);
  const providerAttempts = getProviderAttemptDiagnosticsState(state);
  const inFlight = providerAttempts.inFlight[key] ?? null;
  delete providerAttempts.inFlight[key];

  const startedAt = inFlight?.started_at ?? new Date(finishedAt).toISOString();
  const measuredDurationMs = durationMsOverride ?? (finishedAt - Date.parse(startedAt));
  const durationMs = Number.isFinite(measuredDurationMs) ? Math.max(0, measuredDurationMs) : 0;
  const countKey = `${family}:${provider}:${outcome}`;
  providerAttempts.outcomeCounts[countKey] = (providerAttempts.outcomeCounts[countKey] ?? 0) + 1;
  providerAttempts.recentOutcomes.unshift({
    provider,
    family,
    outcome,
    started_at: startedAt,
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: durationMs,
    reason: sanitizeProviderAttemptReason(reason),
  });
  providerAttempts.recentOutcomes = providerAttempts.recentOutcomes.slice(0, PROVIDER_ATTEMPT_RECENT_LIMIT);
}

export function setProviderFaultControl(
  state: MarketDataRuntimeState,
  control: ProviderFaultControl,
) {
  const key = providerAttemptKey(control.provider, control.family);
  const providerAttempts = getProviderAttemptDiagnosticsState(state);

  if (control.mode === 'off') {
    delete providerAttempts.faultControls[key];
    return;
  }

  providerAttempts.faultControls[key] = {
    provider: control.provider,
    family: control.family,
    mode: control.mode,
    reason: sanitizeProviderAttemptReason(control.reason),
  };
}

export function resetProviderFaultControls(state: MarketDataRuntimeState) {
  getProviderAttemptDiagnosticsState(state).faultControls = {};
}

export function getProviderFaultControl(
  state: MarketDataRuntimeState | undefined,
  provider: string,
  family: ProviderAttemptFamily,
) {
  return state?.providerAttempts?.faultControls[providerAttemptKey(provider, family)] ?? null;
}

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
    providerAttempts: {
      inFlight: {},
      recentOutcomes: [],
      outcomeCounts: {},
      faultControls: {},
    },
    exchangeTickerIngestion: {
      last_refresh_at: null,
      configured_exchange_ids: providerIds,
      attempted_exchange_ids: [],
      promotion_attempted_exchange_ids: [],
      successful_exchange_ids: [],
      live_backed_exchange_ids: [],
      failed_exchange_ids: [],
      blocked_exchange_ids: [],
      unavailable_exchange_ids: [],
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
