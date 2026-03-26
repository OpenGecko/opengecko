import type { MarketSnapshotRow } from '../db/schema';
import type { MarketDataRuntimeState } from './market-runtime-state';
import { getSnapshotOwnership } from './market-snapshots';
import { getSnapshotFreshness } from '../modules/market-freshness';

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
  };
  hot_paths: {
    shared_market_snapshot: {
      available: boolean;
      source_class: 'fresh_live' | 'stale_live' | 'seeded_bootstrap' | 'unavailable';
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
  const degradedActive = runtimeState.allowStaleLiveService || runtimeState.syncFailureReason !== null;
  const cooldownUntil = runtimeState.providerFailureCooldownUntil;
  const sourceClass = latestUsdSnapshot
    ? (() => {
      const ownership = getSnapshotOwnership(latestUsdSnapshot);
      if (ownership === 'seeded') {
        return 'seeded_bootstrap' as const;
      }

      const freshness = getSnapshotFreshness(latestUsdSnapshot, marketFreshnessThresholdSeconds, now);

      return freshness.isStale ? 'stale_live' as const : 'fresh_live' as const;
    })()
    : 'unavailable' as const;

  const hotPathSnapshot = latestUsdSnapshot
    ? (() => {
      const freshness = getSnapshotFreshness(latestUsdSnapshot, marketFreshnessThresholdSeconds, now);

      return {
        available: true,
        source_class: sourceClass,
        last_successful_live_refresh_at: latestUsdSnapshot.sourceCount > 0 ? latestUsdSnapshot.lastUpdated.toISOString() : null,
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

  const readinessState = degradedActive
    ? 'degraded'
    : runtimeState.initialSyncCompleted
      ? 'ready'
      : 'starting';

  return {
    readiness: {
      state: readinessState,
      listener_bound: runtimeState.listenerBound,
      initial_sync_completed: runtimeState.initialSyncCompleted,
    },
    degraded: {
      active: degradedActive,
      stale_live_enabled: runtimeState.allowStaleLiveService,
      reason: runtimeState.syncFailureReason,
      provider_failure_cooldown_until: cooldownUntil === null ? null : new Date(cooldownUntil).toISOString(),
    },
    hot_paths: {
      shared_market_snapshot: hotPathSnapshot,
      cache_revision: runtimeState.hotDataRevision,
    },
  };
}
