import type { SnapshotOwnership } from './market-snapshots';

export const SEEDED_EXCHANGE_TIMESTAMP_MS = Date.parse('2026-03-20T00:00:00.000Z');
export const CANONICAL_VALIDATION_SNAPSHOT_PROVIDER = 'canonical-validation-snapshot';

export type CoverageFreshnessState = 'fresh' | 'degraded' | 'stale' | 'unbudgeted' | 'unknown';
export type ExchangeEvidenceClass =
  | 'live_ticker_and_volume'
  | 'live_ticker'
  | 'live_volume'
  | 'replay_only'
  | 'seeded_ticker_only'
  | 'seeded_registry_only';
export type RuntimeMarketSnapshotSourceClass =
  | 'fresh_live'
  | 'stale_live'
  | 'seeded_bootstrap'
  | 'degraded_seeded_bootstrap'
  | 'unavailable';

export function ageSeconds(now: Date, timestamp: Date | null) {
  if (!timestamp) {
    return null;
  }

  return Math.max(Math.floor((now.getTime() - timestamp.getTime()) / 1_000), 0);
}

export function classifyCoverageFreshness(input: {
  currentAgeSeconds: number | null;
  targetFreshnessSeconds: number | null;
  degradedAfterSeconds: number | null;
}): CoverageFreshnessState {
  if (input.targetFreshnessSeconds === null || input.degradedAfterSeconds === null) {
    return 'unbudgeted';
  }

  if (input.currentAgeSeconds === null) {
    return 'unknown';
  }

  if (input.currentAgeSeconds <= input.targetFreshnessSeconds) {
    return 'fresh';
  }

  if (input.currentAgeSeconds <= input.degradedAfterSeconds) {
    return 'degraded';
  }

  return 'stale';
}

export function isLiveSourceKind(sourceKind: unknown): sourceKind is 'live' {
  return sourceKind === 'live';
}

export function isReplaySourceKind(sourceKind: unknown): sourceKind is 'replay' {
  return sourceKind === 'replay';
}

export function isSeededExchangeTimestamp(timestamp: Date | null | undefined) {
  return timestamp instanceof Date && timestamp.getTime() === SEEDED_EXCHANGE_TIMESTAMP_MS;
}

export function isCanonicalValidationSnapshotProvider(provider: unknown) {
  return provider === CANONICAL_VALIDATION_SNAPSHOT_PROVIDER;
}

export function hasSourceBackedProviders(sourceCount: number, sourceProvidersJson: string) {
  if (sourceCount <= 0) {
    return false;
  }

  try {
    const providers = JSON.parse(sourceProvidersJson) as unknown;

    return Array.isArray(providers) && providers.some((provider) => (
      typeof provider === 'string'
      && provider.trim().length > 0
      && !isCanonicalValidationSnapshotProvider(provider)
    ));
  } catch {
    return false;
  }
}

export function classifyExchangeEvidence(input: {
  liveTickerRowCount: number;
  seededTickerRowCount: number;
  liveVolumeRowCount: number;
  replayVolumeRowCount: number;
}): ExchangeEvidenceClass {
  if (input.liveTickerRowCount > 0 && input.liveVolumeRowCount > 0) {
    return 'live_ticker_and_volume';
  }

  if (input.liveTickerRowCount > 0) {
    return 'live_ticker';
  }

  if (input.liveVolumeRowCount > 0) {
    return 'live_volume';
  }

  if (input.replayVolumeRowCount > 0) {
    return 'replay_only';
  }

  if (input.seededTickerRowCount > 0) {
    return 'seeded_ticker_only';
  }

  return 'seeded_registry_only';
}

export function classifyRuntimeMarketSnapshotSourceClass(input: {
  hasEffectiveSnapshot: boolean;
  validationOverrideMode:
    | 'off'
    | 'stale_disallowed'
    | 'stale_allowed'
    | 'degraded_seeded_bootstrap'
    | 'seeded_bootstrap'
    | 'zero_live_completed_boot';
  latestSnapshotOwnership: SnapshotOwnership | null;
  storedSnapshotOwnership: SnapshotOwnership | null;
  latestSnapshotIsStale: boolean | null;
  storedSnapshotIsStale: boolean | null;
  effectiveSeededBootstrapFallbackActive: boolean;
  validationOverrideForcesDegradedState: boolean;
  listenerBoundSeededBootstrap: boolean;
}): RuntimeMarketSnapshotSourceClass {
  if (!input.hasEffectiveSnapshot) {
    return 'unavailable';
  }

  if (input.validationOverrideMode === 'degraded_seeded_bootstrap') {
    return 'degraded_seeded_bootstrap';
  }

  if (input.validationOverrideMode === 'seeded_bootstrap') {
    return 'seeded_bootstrap';
  }

  if (input.validationOverrideMode === 'zero_live_completed_boot') {
    return 'unavailable';
  }

  if (
    input.validationOverrideMode === 'stale_allowed'
    && input.latestSnapshotOwnership === 'live'
    && input.latestSnapshotIsStale === true
  ) {
    return 'stale_live';
  }

  if (input.latestSnapshotOwnership === 'seeded') {
    return input.effectiveSeededBootstrapFallbackActive
      ? 'degraded_seeded_bootstrap'
      : 'seeded_bootstrap';
  }

  if (
    (input.validationOverrideForcesDegradedState || input.listenerBoundSeededBootstrap)
    && input.storedSnapshotOwnership === 'live'
  ) {
    return 'stale_live';
  }

  return input.storedSnapshotIsStale === true ? 'stale_live' : 'fresh_live';
}

export function getRouteHttpCacheSeconds(input: {
  ttlSeconds: number;
  targetFreshnessSeconds: number | null | undefined;
}) {
  return Math.min(input.ttlSeconds, input.targetFreshnessSeconds ?? input.ttlSeconds);
}
