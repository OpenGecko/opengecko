import type { MarketSnapshotRow } from '../db/schema';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import { getSnapshotOwnership } from '../services/market-snapshots';

export type SnapshotFreshness = {
  ageSeconds: number;
  isStale: boolean;
  providers: string[];
  sourceCount: number;
};

export type SnapshotAccessPolicy = {
  initialSyncCompleted: boolean;
  allowStaleLiveService: boolean;
};

function applyValidationSnapshotOverride<T extends Pick<MarketSnapshotRow, 'lastUpdated' | 'sourceCount'>>(
  snapshot: T,
  runtimeState: MarketDataRuntimeState,
): T {
  const validationOverride = runtimeState.validationOverride;

  if (!validationOverride || validationOverride.mode === 'off') {
    return snapshot;
  }

  const nextLastUpdated = validationOverride.snapshotTimestampOverride
    ? new Date(validationOverride.snapshotTimestampOverride)
    : snapshot.lastUpdated;
  const nextSourceCount = validationOverride.snapshotSourceCountOverride ?? snapshot.sourceCount;

  if (nextLastUpdated === snapshot.lastUpdated && nextSourceCount === snapshot.sourceCount) {
    return snapshot;
  }

  const overriddenSnapshot = {
    ...snapshot,
    lastUpdated: nextLastUpdated,
    sourceCount: nextSourceCount,
  };

  if (validationOverride.mode !== 'degraded_seeded_bootstrap') {
    return overriddenSnapshot;
  }

  return {
    ...overriddenSnapshot,
    marketCap: null,
    totalVolume: null,
    priceChange24h: null,
    priceChangePercentage24h: null,
  };
}

export function isLiveSnapshot(snapshot: Pick<MarketSnapshotRow, 'sourceCount'>) {
  return getSnapshotOwnership(snapshot) === 'live';
}

export function getSnapshotFreshness(
  snapshot: Pick<MarketSnapshotRow, 'lastUpdated' | 'sourceProvidersJson' | 'sourceCount'>,
  thresholdSeconds: number,
  now = Date.now(),
): SnapshotFreshness {
  const ageSeconds = Math.max(0, Math.floor((now - snapshot.lastUpdated.getTime()) / 1000));

  return {
    ageSeconds,
    isStale: ageSeconds > thresholdSeconds,
    providers: JSON.parse(snapshot.sourceProvidersJson) as string[],
    sourceCount: snapshot.sourceCount,
  };
}

export function getSnapshotAccessPolicy(runtimeState: MarketDataRuntimeState): SnapshotAccessPolicy {
  const validationOverrideMode = runtimeState.validationOverride?.mode ?? 'off';

  if (validationOverrideMode === 'stale_disallowed') {
    return {
      initialSyncCompleted: true,
      allowStaleLiveService: false,
    };
  }

  if (validationOverrideMode === 'stale_allowed') {
    return {
      initialSyncCompleted: true,
      allowStaleLiveService: true,
    };
  }

  if (validationOverrideMode === 'degraded_seeded_bootstrap') {
    return {
      initialSyncCompleted: false,
      allowStaleLiveService: true,
    };
  }

  return {
    initialSyncCompleted: runtimeState.initialSyncCompleted,
    allowStaleLiveService: runtimeState.allowStaleLiveService,
  };
}

export function getUsableSnapshot<T extends Pick<MarketSnapshotRow, 'lastUpdated' | 'sourceProvidersJson' | 'sourceCount'>>(
  snapshot: T | null,
  thresholdSeconds: number,
  accessPolicy: SnapshotAccessPolicy,
  now = Date.now(),
) {
  if (!snapshot) {
    return null;
  }

  // Seeded snapshots (sourceCount === 0) — usable before initial sync completes
  if (!isLiveSnapshot(snapshot)) {
    if (!accessPolicy.initialSyncCompleted) {
      return snapshot;
    }
    return null;
  }

  // Live data — check freshness
  const freshness = getSnapshotFreshness(snapshot, thresholdSeconds, now);

  if (!freshness.isStale) {
    return snapshot;
  }

  // Stale live data — allowed if policy permits
  if (accessPolicy.allowStaleLiveService) {
    return snapshot;
  }

  return null;
}

export function getEffectiveSnapshot<T extends Pick<MarketSnapshotRow, 'lastUpdated' | 'sourceProvidersJson' | 'sourceCount'>>(
  snapshot: T | null,
  runtimeState: MarketDataRuntimeState,
) {
  if (!snapshot) {
    return null;
  }

  return applyValidationSnapshotOverride(snapshot, runtimeState);
}
