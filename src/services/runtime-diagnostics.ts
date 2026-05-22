import type { MarketSnapshotRow } from '../db/schema';
import { getMarketRuntimePhase, getProviderAttemptDiagnosticsState, type MarketDataRuntimeState, type MarketRuntimePhase } from './market-runtime-state';
import { getSnapshotOwnership } from './market-snapshots';
import { getEffectiveSnapshot, getSnapshotFreshness, normalizeRuntimeSnapshotTimestamp } from '../modules/market-freshness';
import { sanitizeNullableDiagnosticText } from './diagnostic-sanitizer';
import { classifyRuntimeMarketSnapshotSourceClass, type RuntimeMarketSnapshotSourceClass } from './diagnostics-policy';
import { summarizeProviderBreakerState, type ProviderFailureKind } from './provider-breaker';

export type ProviderAlertStatus = 'healthy' | 'degraded' | 'failing';
export type ProviderCapabilitySurface = 'market_price' | 'ticker' | 'exchange' | 'chart';
export type ProviderCapabilityState = 'pending' | 'contributed' | 'degraded' | 'unavailable';
export type ProviderCapabilityOwnership = 'configured' | 'latest_contributor';
export type ProviderCapabilityEvidence = Partial<Record<ProviderCapabilitySurface, Record<string, string>>>;

export const PROVIDER_ALERT_STATUS_FAILING_FAILURE_COUNT = 3;
export const PROVIDER_ALERT_STATUS_RECENT_RECOVERY_WINDOW_MS = 120_000;

export type ProviderRuntimeDiagnostics = {
  id: string;
  state: 'closed' | 'open' | 'half_open';
  alert_status: ProviderAlertStatus;
  failure_kind: ProviderFailureKind | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  failure_count: number;
  next_retry_at: string | null;
  capabilities: Array<{
    surface: ProviderCapabilitySurface;
    endpoint_families: string[];
    ownership: ProviderCapabilityOwnership;
    state: ProviderCapabilityState;
    last_contribution_at: string | null;
    degraded_reason: string | null;
  }>;
};

export type RuntimeDiagnostics = {
  readiness: {
    state: 'starting' | 'ready' | 'degraded';
    canonical_phase: MarketRuntimePhase;
    listener_bound: boolean;
    listener_bind_deferred: boolean;
    initial_sync_completed: boolean;
    degraded: boolean;
    zero_live_completed_boot: boolean;
    validation_override_active: boolean;
  };
  degraded: {
    active: boolean;
    stale_live_enabled: boolean;
    reason: string | null;
    provider_failure_cooldown_until: string | null;
    injected_provider_failure: {
      active: boolean;
      reason: string | null;
    };
    provider_breakers?: Array<{
      id: string;
      state: 'closed' | 'open' | 'half_open';
      status: 'closed' | 'open' | 'half_open';
      alert_status: ProviderAlertStatus;
      failure_kind: ProviderFailureKind | null;
      failure_count: number;
      opened_until: string | null;
      next_retry_at: string | null;
      last_success_at: string | null;
      last_failure_at: string | null;
      last_failure_reason: string | null;
      retry_in_ms: number;
    }>;
    validation_override: {
      active: boolean;
      mode: 'off' | 'stale_disallowed' | 'stale_allowed' | 'degraded_seeded_bootstrap' | 'seeded_bootstrap' | 'zero_live_completed_boot';
      reason: string | null;
    };
  };
  providers?: ProviderRuntimeDiagnostics[];
  provider_attempts?: {
    in_flight_count: number;
    in_flight: Array<{
      provider: string;
      family: string;
      started_at: string;
    }>;
    recent_outcomes: Array<{
      provider: string;
      family: string;
      outcome: string;
      started_at: string;
      finished_at: string;
      duration_ms: number;
      reason: string | null;
    }>;
    outcome_counts: Array<{
      provider: string;
      family: string;
      outcome: string;
      count: number;
    }>;
    fault_controls: Array<{
      provider: string;
      family: string;
      mode: string;
      reason: string | null;
    }>;
  };
  hot_paths: {
    shared_market_snapshot: {
      available: boolean;
      source_class: RuntimeMarketSnapshotSourceClass;
      last_successful_live_refresh_at: string | null;
      freshness: {
        threshold_seconds: number;
        age_seconds: number | null;
        is_stale: boolean | null;
      };
      providers: string[];
      provider_count: number;
    };
    cache_revision: number;
  };
};

function toIsoString(timestamp: number | null) {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function classifyProviderAlertStatus(provider: {
  status: 'closed' | 'open' | 'half_open';
  failure_count: number;
  last_success_at: number | null;
  last_failure_at: number | null;
}, now: number): ProviderAlertStatus {
  if (provider.failure_count >= PROVIDER_ALERT_STATUS_FAILING_FAILURE_COUNT) {
    return 'failing';
  }

  if (provider.status !== 'closed' || provider.failure_count > 0) {
    return 'degraded';
  }

  if (
    provider.last_success_at !== null
    && provider.last_failure_at !== null
    && provider.last_success_at >= provider.last_failure_at
    && now - provider.last_success_at <= PROVIDER_ALERT_STATUS_RECENT_RECOVERY_WINDOW_MS
  ) {
    return 'degraded';
  }

  return 'healthy';
}

const PROVIDER_ID_ALIASES: Record<string, string> = {
  bybit_spot: 'bybit',
  gdax: 'coinbase',
  okex: 'okx',
};

export function normalizeProviderCapabilityId(providerId: string) {
  const trimmedProviderId = providerId.trim();
  const unprefixedProviderId = trimmedProviderId.startsWith('ccxt.')
    ? trimmedProviderId.slice('ccxt.'.length)
    : trimmedProviderId;

  return PROVIDER_ID_ALIASES[unprefixedProviderId] ?? unprefixedProviderId;
}

function getCapabilityEvidenceAt(
  evidence: ProviderCapabilityEvidence,
  surface: ProviderCapabilitySurface,
  providerId: string,
) {
  return evidence[surface]?.[normalizeProviderCapabilityId(providerId)] ?? null;
}

function buildEvidenceDrivenCapability(
  surface: Exclude<ProviderCapabilitySurface, 'market_price'>,
  endpointFamilies: string[],
  provider: {
    id: string;
    state: 'closed' | 'open' | 'half_open';
    last_failure_reason: string | null;
  },
  evidence: ProviderCapabilityEvidence,
  initialSyncCompleted: boolean,
) {
  const providerIsDegraded = provider.state !== 'closed';
  const evidenceAt = getCapabilityEvidenceAt(evidence, surface, provider.id);

  return {
    surface,
    endpoint_families: endpointFamilies,
    ownership: evidenceAt !== null ? 'latest_contributor' as const : 'configured' as const,
    state: providerIsDegraded
      ? 'degraded' as const
      : evidenceAt !== null
        ? 'contributed' as const
        : initialSyncCompleted
          ? 'unavailable' as const
          : 'pending' as const,
    last_contribution_at: evidenceAt,
    degraded_reason: providerIsDegraded
      ? provider.last_failure_reason ?? 'provider degraded'
      : null,
  };
}

function buildProviderCapabilities(
  provider: {
    id: string;
    state: 'closed' | 'open' | 'half_open';
    last_success_at: string | null;
    last_failure_reason: string | null;
  },
  latestContributorProviders: Set<string>,
  latestContributorAt: string | null,
  initialSyncCompleted: boolean,
  capabilityEvidence: ProviderCapabilityEvidence,
): ProviderRuntimeDiagnostics['capabilities'] {
  const providerIsDegraded = provider.state !== 'closed';
  const normalizedProviderId = normalizeProviderCapabilityId(provider.id);
  const contributedMarketPrice = latestContributorProviders.has(normalizedProviderId);

  return [
    {
      surface: 'market_price',
      endpoint_families: ['/simple/price', '/coins/markets'],
      ownership: contributedMarketPrice ? 'latest_contributor' : 'configured',
      state: providerIsDegraded
        ? 'degraded'
        : contributedMarketPrice
          ? 'contributed'
          : initialSyncCompleted
            ? 'unavailable'
            : 'pending',
      last_contribution_at: contributedMarketPrice ? latestContributorAt : null,
      degraded_reason: providerIsDegraded
        ? provider.last_failure_reason ?? 'provider degraded'
        : null,
    },
    buildEvidenceDrivenCapability(
      'ticker',
      ['/coins/{id}/tickers', '/exchanges/{id}/tickers'],
      provider,
      capabilityEvidence,
      initialSyncCompleted,
    ),
    buildEvidenceDrivenCapability(
      'exchange',
      ['/exchanges/list', '/exchanges', '/exchanges/{id}'],
      provider,
      capabilityEvidence,
      initialSyncCompleted,
    ),
    buildEvidenceDrivenCapability(
      'chart',
      ['/coins/{id}/market_chart', '/coins/{id}/ohlc'],
      provider,
      capabilityEvidence,
      initialSyncCompleted,
    ),
  ];
}

export function buildRuntimeDiagnostics(
  runtimeState: MarketDataRuntimeState,
  latestUsdSnapshot: Pick<MarketSnapshotRow, 'lastUpdated' | 'sourceProvidersJson' | 'sourceCount'> | null,
  marketFreshnessThresholdSeconds: number,
  now = Date.now(),
  capabilityEvidence: ProviderCapabilityEvidence = {},
): RuntimeDiagnostics {
  const listenerBoundSeededBootstrap = runtimeState.listenerBound
    && runtimeState.validationOverride.mode === 'off'
    && runtimeState.allowStaleLiveService
    && runtimeState.syncFailureReason === null;
  const effectiveLatestUsdSnapshot = normalizeRuntimeSnapshotTimestamp(getEffectiveSnapshot(latestUsdSnapshot, runtimeState));
  const latestSnapshotOwnership = effectiveLatestUsdSnapshot ? getSnapshotOwnership(effectiveLatestUsdSnapshot) : null;
  const latestSnapshotFreshness = effectiveLatestUsdSnapshot && latestSnapshotOwnership === 'live'
    ? getSnapshotFreshness(effectiveLatestUsdSnapshot, marketFreshnessThresholdSeconds, now)
    : null;
  const latestStoredUsdSnapshot = normalizeRuntimeSnapshotTimestamp(latestUsdSnapshot);
  const storedSnapshotOwnership = latestStoredUsdSnapshot ? getSnapshotOwnership(latestStoredUsdSnapshot) : null;
  const storedLatestSnapshotFreshness = latestStoredUsdSnapshot && storedSnapshotOwnership === 'live'
    ? getSnapshotFreshness(latestStoredUsdSnapshot, marketFreshnessThresholdSeconds, now)
    : null;
  const validationOverride = runtimeState.validationOverride ?? {
    mode: 'off' as const,
    reason: null,
  };
  const validationOverrideActive = validationOverride.mode !== 'off';
  const effectiveInitialSyncCompleted = validationOverride.mode === 'degraded_seeded_bootstrap' || validationOverride.mode === 'seeded_bootstrap'
    ? false
    : validationOverride.mode === 'zero_live_completed_boot'
      ? true
    : validationOverrideActive
      ? true
      : runtimeState.initialSyncCompleted;
  const cooldownUntil = runtimeState.providerFailureCooldownUntil;
  const providerBreakerSummaries = runtimeState.providerBreakers
    ? summarizeProviderBreakerState(runtimeState.providerBreakers, now)
    : [];
  const providerDiagnostics = providerBreakerSummaries
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => {
      const nextRetryAt = provider.status === 'open' ? toIsoString(provider.opened_until) : null;
      const lastFailureReason = sanitizeNullableDiagnosticText(provider.last_failure_reason);
      const lastSuccessAt = toIsoString(provider.last_success_at);
      return {
        id: provider.id,
        state: provider.status,
        alert_status: classifyProviderAlertStatus(provider, now),
        failure_kind: provider.failure_kind ?? null,
        last_success_at: lastSuccessAt,
        last_failure_at: toIsoString(provider.last_failure_at),
        last_failure_reason: lastFailureReason,
        failure_count: provider.failure_count,
        next_retry_at: nextRetryAt,
        capabilities: buildProviderCapabilities(
          {
            id: provider.id,
            state: provider.status,
            last_success_at: lastSuccessAt,
            last_failure_reason: lastFailureReason,
          },
          new Set((latestSnapshotFreshness?.providers ?? []).map(normalizeProviderCapabilityId)),
          effectiveLatestUsdSnapshot?.sourceCount && effectiveLatestUsdSnapshot.sourceCount > 0
            ? effectiveLatestUsdSnapshot.lastUpdated.toISOString()
            : null,
          effectiveInitialSyncCompleted,
          capabilityEvidence,
        ),
      };
    });
  const providerBreakerDiagnostics = providerDiagnostics.map((provider) => ({
    id: provider.id,
    state: provider.state,
    status: provider.state,
    alert_status: provider.alert_status,
    failure_kind: provider.failure_kind,
    failure_count: provider.failure_count,
    opened_until: provider.next_retry_at,
    next_retry_at: provider.next_retry_at,
    last_success_at: provider.last_success_at,
    last_failure_at: provider.last_failure_at,
    last_failure_reason: provider.last_failure_reason,
    retry_in_ms: provider.state === 'open' && provider.next_retry_at !== null
      ? Math.max(0, new Date(provider.next_retry_at).getTime() - now)
      : 0,
  }));
  const providerAttemptDiagnostics = getProviderAttemptDiagnosticsState(runtimeState);
  const inFlightAttempts = Object.values(providerAttemptDiagnostics.inFlight)
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.family.localeCompare(right.family));
  const outcomeCounts = Object.entries(providerAttemptDiagnostics.outcomeCounts)
    .map(([key, count]) => {
      const [family, provider, outcome] = key.split(':');
      return {
        provider: provider ?? 'unknown',
        family: family ?? 'unknown',
        outcome: outcome ?? 'unknown',
        count,
      };
    })
    .sort((left, right) => (
      left.provider.localeCompare(right.provider)
      || left.family.localeCompare(right.family)
      || left.outcome.localeCompare(right.outcome)
    ));
  const faultControls = Object.values(providerAttemptDiagnostics.faultControls)
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.family.localeCompare(right.family))
    .map((control) => ({
      provider: control.provider,
      family: control.family,
      mode: control.mode,
      reason: sanitizeNullableDiagnosticText(control.reason),
    }));
  const hasProviderAttemptDiagnostics = inFlightAttempts.length > 0
    || providerAttemptDiagnostics.recentOutcomes.length > 0
    || outcomeCounts.length > 0
    || faultControls.length > 0;
  const injectedProviderFailure = runtimeState.forcedProviderFailure ?? {
    active: false,
    reason: null,
  };
  const effectiveAllowStaleLiveService = validationOverride.mode === 'stale_disallowed'
    ? false
    : validationOverride.mode === 'stale_allowed'
      ? true
      : validationOverride.mode === 'seeded_bootstrap'
        ? latestSnapshotOwnership === 'live'
        : validationOverride.mode === 'degraded_seeded_bootstrap'
          ? false
          : validationOverride.mode === 'zero_live_completed_boot'
            ? false
          : runtimeState.allowStaleLiveService;
  const effectiveFailureReason = sanitizeNullableDiagnosticText(validationOverride.reason ?? runtimeState.syncFailureReason);
  const effectiveSeededBootstrapFallbackActive = validationOverride.mode === 'degraded_seeded_bootstrap'
    || (
      effectiveInitialSyncCompleted === false
      && latestSnapshotOwnership === 'seeded'
      && effectiveFailureReason !== null
    );
  const validationOverrideForcesDegradedState = validationOverride.mode === 'stale_disallowed';
  const effectiveStaleLiveFallbackActive = validationOverride.mode === 'stale_allowed'
    || validationOverride.mode === 'stale_disallowed'
    || effectiveAllowStaleLiveService
    || (effectiveFailureReason !== null && storedLatestSnapshotFreshness?.isStale === true);
  const effectiveDegradedActive = (
    validationOverride.mode !== 'seeded_bootstrap'
    && validationOverride.mode !== 'zero_live_completed_boot'
    && (effectiveStaleLiveFallbackActive || effectiveSeededBootstrapFallbackActive)
  );
  const sourceClass = classifyRuntimeMarketSnapshotSourceClass({
    hasEffectiveSnapshot: effectiveLatestUsdSnapshot !== null,
    validationOverrideMode: validationOverride.mode,
    latestSnapshotOwnership,
    storedSnapshotOwnership,
    latestSnapshotIsStale: latestSnapshotFreshness?.isStale ?? null,
    storedSnapshotIsStale: storedLatestSnapshotFreshness?.isStale ?? null,
    effectiveSeededBootstrapFallbackActive,
    validationOverrideForcesDegradedState,
    listenerBoundSeededBootstrap,
  });

  const hotPathSnapshot = effectiveLatestUsdSnapshot
    ? (() => {
      const freshness = latestSnapshotFreshness ?? getSnapshotFreshness(effectiveLatestUsdSnapshot, marketFreshnessThresholdSeconds, now);

      return {
        available: true,
        source_class: sourceClass,
        last_successful_live_refresh_at: effectiveLatestUsdSnapshot.sourceCount > 0 ? effectiveLatestUsdSnapshot.lastUpdated.toISOString() : null,
        freshness: {
          threshold_seconds: marketFreshnessThresholdSeconds,
          age_seconds: freshness.ageSeconds,
          is_stale: freshness.isStale,
        },
        providers: freshness.providers,
        provider_count: freshness.sourceCount,
      };
    })()
    : {
      available: false,
      source_class: sourceClass,
      last_successful_live_refresh_at: null,
      freshness: {
        threshold_seconds: marketFreshnessThresholdSeconds,
        age_seconds: null,
        is_stale: null,
      },
      providers: [],
      provider_count: 0,
    };

  const readinessState = effectiveDegradedActive
    ? 'degraded'
    : effectiveInitialSyncCompleted
      ? 'ready'
      : 'starting';

  return {
    readiness: {
      state: readinessState,
      canonical_phase: getMarketRuntimePhase(runtimeState, now),
      listener_bound: runtimeState.listenerBound,
      listener_bind_deferred: runtimeState.listenerBindDeferred,
      initial_sync_completed: effectiveInitialSyncCompleted,
      degraded: effectiveDegradedActive,
      zero_live_completed_boot: validationOverride.mode === 'zero_live_completed_boot'
        ? true
        : runtimeState.initialSyncCompletedWithoutUsableLiveSnapshots,
      validation_override_active: validationOverrideActive,
    },
    degraded: {
      active: effectiveDegradedActive,
      stale_live_enabled: effectiveAllowStaleLiveService,
      reason: effectiveFailureReason,
      provider_failure_cooldown_until: cooldownUntil === null ? null : new Date(cooldownUntil).toISOString(),
      injected_provider_failure: {
        active: injectedProviderFailure.active,
        reason: sanitizeNullableDiagnosticText(injectedProviderFailure.reason),
      },
      ...(providerBreakerDiagnostics.length > 0 ? { provider_breakers: providerBreakerDiagnostics } : {}),
      validation_override: {
        active: validationOverrideActive,
        mode: validationOverride.mode,
        reason: sanitizeNullableDiagnosticText(validationOverride.reason),
      },
    },
    ...(providerDiagnostics.length > 0 ? { providers: providerDiagnostics } : {}),
    ...(hasProviderAttemptDiagnostics ? { provider_attempts: {
      in_flight_count: inFlightAttempts.length,
      in_flight: inFlightAttempts,
      recent_outcomes: providerAttemptDiagnostics.recentOutcomes,
      outcome_counts: outcomeCounts,
      fault_controls: faultControls,
    } } : {}),
    hot_paths: {
      shared_market_snapshot: hotPathSnapshot,
      cache_revision: runtimeState.hotDataRevision,
    },
  };
}
