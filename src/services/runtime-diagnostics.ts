import type { MarketSnapshotRow } from '../db/schema';
import type { MarketDataRuntimeState } from './market-runtime-state';
import { getSnapshotOwnership } from './market-snapshots';
import { getEffectiveSnapshot, getSnapshotFreshness } from '../modules/market-freshness';

export type RuntimeDiagnostics = {
  readiness: {
    state: 'starting' | 'ready' | 'degraded';
    listener_bound: boolean;
    initial_sync_completed: boolean;
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
    validation_override: {
      active: boolean;
      mode: 'off' | 'stale_disallowed' | 'stale_allowed' | 'degraded_seeded_bootstrap';
      reason: string | null;
    };
  };
  hot_paths: {
    shared_market_snapshot: {
      available: boolean;
      source_class: 'fresh_live' | 'stale_live' | 'seeded_bootstrap' | 'degraded_seeded_bootstrap' | 'unavailable';
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

export function buildRuntimeDiagnostics(
  runtimeState: MarketDataRuntimeState,
  latestUsdSnapshot: Pick<MarketSnapshotRow, 'lastUpdated' | 'sourceProvidersJson' | 'sourceCount'> | null,
  marketFreshnessThresholdSeconds: number,
  now = Date.now(),
): RuntimeDiagnostics {
  const effectiveLatestUsdSnapshot = getEffectiveSnapshot(latestUsdSnapshot, runtimeState);
  const latestSnapshotOwnership = effectiveLatestUsdSnapshot ? getSnapshotOwnership(effectiveLatestUsdSnapshot) : null;
  const latestSnapshotFreshness = effectiveLatestUsdSnapshot && latestSnapshotOwnership === 'live'
    ? getSnapshotFreshness(effectiveLatestUsdSnapshot, marketFreshnessThresholdSeconds, now)
    : null;
  const seededBootstrapFallbackActive = (
    runtimeState.initialSyncCompleted === false
    && latestSnapshotOwnership === 'seeded'
    && runtimeState.syncFailureReason !== null
  );
  const staleLiveFallbackActive = runtimeState.allowStaleLiveService
    || (runtimeState.syncFailureReason !== null && latestSnapshotFreshness?.isStale === true);
  const degradedActive = staleLiveFallbackActive || seededBootstrapFallbackActive;
  const cooldownUntil = runtimeState.providerFailureCooldownUntil;
  const injectedProviderFailure = runtimeState.forcedProviderFailure ?? {
    active: false,
    reason: null,
  };
  const validationOverride = runtimeState.validationOverride ?? {
    mode: 'off' as const,
    reason: null,
  };
  const validationOverrideActive = validationOverride.mode !== 'off';
  const effectiveInitialSyncCompleted = validationOverride.mode === 'degraded_seeded_bootstrap'
    ? false
    : validationOverrideActive
      ? true
      : runtimeState.initialSyncCompleted;
  const effectiveAllowStaleLiveService = validationOverride.mode === 'stale_disallowed'
    ? false
    : validationOverride.mode === 'stale_allowed' || validationOverride.mode === 'degraded_seeded_bootstrap'
      ? true
      : runtimeState.allowStaleLiveService;
  const effectiveFailureReason = validationOverride.reason ?? runtimeState.syncFailureReason;
  const effectiveSeededBootstrapFallbackActive = validationOverride.mode === 'degraded_seeded_bootstrap'
    || (
      effectiveInitialSyncCompleted === false
      && latestSnapshotOwnership === 'seeded'
      && effectiveFailureReason !== null
    );
  const effectiveStaleLiveFallbackActive = validationOverride.mode === 'stale_allowed'
    || effectiveAllowStaleLiveService
    || (effectiveFailureReason !== null && latestSnapshotFreshness?.isStale === true);
  const effectiveDegradedActive = effectiveStaleLiveFallbackActive || effectiveSeededBootstrapFallbackActive;
  const sourceClass = effectiveLatestUsdSnapshot
    ? (() => {
      if (validationOverride.mode === 'degraded_seeded_bootstrap') {
        return 'degraded_seeded_bootstrap' as const;
      }

      if (validationOverride.mode === 'stale_allowed' && latestSnapshotOwnership === 'live' && latestSnapshotFreshness?.isStale) {
        return 'stale_live' as const;
      }

      if (latestSnapshotOwnership === 'seeded') {
        if (effectiveSeededBootstrapFallbackActive) {
          return 'degraded_seeded_bootstrap' as const;
        }

        return 'seeded_bootstrap' as const;
      }

      return latestSnapshotFreshness?.isStale ? 'stale_live' as const : 'fresh_live' as const;
    })()
    : 'unavailable' as const;

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
      listener_bound: runtimeState.listenerBound,
      initial_sync_completed: effectiveInitialSyncCompleted,
    },
    degraded: {
      active: effectiveDegradedActive,
      stale_live_enabled: effectiveAllowStaleLiveService,
      reason: effectiveFailureReason,
      provider_failure_cooldown_until: cooldownUntil === null ? null : new Date(cooldownUntil).toISOString(),
      injected_provider_failure: {
        active: injectedProviderFailure.active,
        reason: injectedProviderFailure.reason,
      },
      validation_override: {
        active: validationOverrideActive,
        mode: validationOverride.mode,
        reason: validationOverride.reason,
      },
    },
    hot_paths: {
      shared_market_snapshot: hotPathSnapshot,
      cache_revision: runtimeState.hotDataRevision,
    },
  };
}
