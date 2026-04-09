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

const SECOND_TIMESTAMP_MAX = 10_000_000_000;
const MIN_REASONABLE_RUNTIME_TIMESTAMP_MS = Date.UTC(2000, 0, 1);

export function normalizeRuntimeTimestamp(value: Date | number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }

  const rawTimestamp = value instanceof Date ? value.getTime() : value;

  if (!Number.isFinite(rawTimestamp)) {
    return null;
  }

  const normalizedTimestamp = Math.abs(rawTimestamp) < SECOND_TIMESTAMP_MAX
    ? rawTimestamp * 1000
    : rawTimestamp;

  if (!Number.isFinite(normalizedTimestamp) || normalizedTimestamp < MIN_REASONABLE_RUNTIME_TIMESTAMP_MS) {
    return null;
  }

  const normalizedDate = new Date(normalizedTimestamp);
  return Number.isNaN(normalizedDate.getTime()) ? null : normalizedDate;
}

export function coerceRuntimeTimestampForValidation(value: Date | number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const normalizedDate = normalizeRuntimeTimestamp(value);
    return normalizedDate ?? value;
  }

  return normalizeRuntimeTimestamp(value);
}

export function normalizeRuntimeSnapshotTimestamp<T extends Pick<MarketSnapshotRow, 'lastUpdated'> | null>(
  snapshot: T,
): (T & { lastUpdated: Date }) | null {
  if (!snapshot) {
    return null;
  }

  const lastUpdated = coerceRuntimeTimestampForValidation(snapshot.lastUpdated);

  if (!lastUpdated) {
    return null;
  }

  return {
    ...snapshot,
    lastUpdated,
  };
}

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

  if (
    validationOverride.mode === 'seeded_bootstrap'
    && snapshot.sourceCount > 0
  ) {
    return overriddenSnapshot;
  }

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
  const normalizedSnapshot = normalizeRuntimeSnapshotTimestamp(snapshot);

  if (!normalizedSnapshot) {
    return {
      ageSeconds: Number.POSITIVE_INFINITY,
      isStale: true,
      providers: [],
      sourceCount: 0,
    };
  }

  const ageSeconds = Math.max(0, Math.floor((now - normalizedSnapshot.lastUpdated.getTime()) / 1000));

  return {
    ageSeconds,
    isStale: ageSeconds > thresholdSeconds,
    providers: JSON.parse(normalizedSnapshot.sourceProvidersJson) as string[],
    sourceCount: normalizedSnapshot.sourceCount,
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

  if (validationOverrideMode === 'seeded_bootstrap') {
    return {
      initialSyncCompleted: false,
      allowStaleLiveService: true,
    };
  }

  if (validationOverrideMode === 'degraded_seeded_bootstrap') {
    return {
      initialSyncCompleted: false,
      allowStaleLiveService: false,
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

  const normalizedSnapshot = normalizeRuntimeSnapshotTimestamp(snapshot);

  if (!normalizedSnapshot) {
    return null;
  }

  // Seeded snapshots (sourceCount === 0) — usable before initial sync completes
  if (!isLiveSnapshot(normalizedSnapshot)) {
    if (!accessPolicy.initialSyncCompleted) {
      return normalizedSnapshot;
    }
    return null;
  }

  // Live data — check freshness
  const freshness = getSnapshotFreshness(normalizedSnapshot, thresholdSeconds, now);

  if (!freshness.isStale) {
    return normalizedSnapshot;
  }

  // Stale live data — allowed if policy permits
  if (accessPolicy.allowStaleLiveService) {
    return normalizedSnapshot;
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
