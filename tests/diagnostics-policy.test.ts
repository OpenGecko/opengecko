import { describe, expect, it } from 'vitest';

import {
  SEEDED_EXCHANGE_TIMESTAMP_MS,
  ageSeconds,
  classifyCoverageFreshness,
  classifyExchangeEvidence,
  classifyRuntimeMarketSnapshotSourceClass,
  getRouteHttpCacheSeconds,
  hasSourceBackedProviders,
  isLiveSourceKind,
  isSeededExchangeTimestamp,
} from '../src/services/diagnostics-policy';

describe('diagnostics policy helpers', () => {
  it('classifies coverage freshness at existing TTL boundaries', () => {
    expect([
      classifyCoverageFreshness({ currentAgeSeconds: null, targetFreshnessSeconds: 60, degradedAfterSeconds: 300 }),
      classifyCoverageFreshness({ currentAgeSeconds: 60, targetFreshnessSeconds: 60, degradedAfterSeconds: 300 }),
      classifyCoverageFreshness({ currentAgeSeconds: 61, targetFreshnessSeconds: 60, degradedAfterSeconds: 300 }),
      classifyCoverageFreshness({ currentAgeSeconds: 300, targetFreshnessSeconds: 60, degradedAfterSeconds: 300 }),
      classifyCoverageFreshness({ currentAgeSeconds: 301, targetFreshnessSeconds: 60, degradedAfterSeconds: 300 }),
      classifyCoverageFreshness({ currentAgeSeconds: 10, targetFreshnessSeconds: null, degradedAfterSeconds: 300 }),
      classifyCoverageFreshness({ currentAgeSeconds: 10, targetFreshnessSeconds: 60, degradedAfterSeconds: null }),
    ]).toEqual([
      'unknown',
      'fresh',
      'degraded',
      'degraded',
      'stale',
      'unbudgeted',
      'unbudgeted',
    ]);
  });

  it('keeps source-backed provider checks from promoting canonical or empty providers', () => {
    expect(hasSourceBackedProviders(0, '["coinbase"]')).toBe(false);
    expect(hasSourceBackedProviders(1, 'not-json')).toBe(false);
    expect(hasSourceBackedProviders(1, '["canonical-validation-snapshot"]')).toBe(false);
    expect(hasSourceBackedProviders(1, '["", "  ", "canonical-validation-snapshot"]')).toBe(false);
    expect(hasSourceBackedProviders(1, '["canonical-validation-snapshot", "coinbase"]')).toBe(true);
  });

  it('classifies live/replay/seed evidence without treating seeded timestamps as live', () => {
    expect(isLiveSourceKind('live')).toBe(true);
    expect(isLiveSourceKind('replay')).toBe(false);
    expect(isLiveSourceKind(null)).toBe(false);
    expect(isSeededExchangeTimestamp(new Date(SEEDED_EXCHANGE_TIMESTAMP_MS))).toBe(true);
    expect(isSeededExchangeTimestamp(new Date(SEEDED_EXCHANGE_TIMESTAMP_MS + 1))).toBe(false);
    expect(isSeededExchangeTimestamp(null)).toBe(false);
  });

  it('preserves exchange evidence priority ordering', () => {
    expect([
      classifyExchangeEvidence({ liveTickerRowCount: 1, seededTickerRowCount: 1, liveVolumeRowCount: 1, replayVolumeRowCount: 1 }),
      classifyExchangeEvidence({ liveTickerRowCount: 1, seededTickerRowCount: 1, liveVolumeRowCount: 0, replayVolumeRowCount: 1 }),
      classifyExchangeEvidence({ liveTickerRowCount: 0, seededTickerRowCount: 1, liveVolumeRowCount: 1, replayVolumeRowCount: 1 }),
      classifyExchangeEvidence({ liveTickerRowCount: 0, seededTickerRowCount: 1, liveVolumeRowCount: 0, replayVolumeRowCount: 1 }),
      classifyExchangeEvidence({ liveTickerRowCount: 0, seededTickerRowCount: 1, liveVolumeRowCount: 0, replayVolumeRowCount: 0 }),
      classifyExchangeEvidence({ liveTickerRowCount: 0, seededTickerRowCount: 0, liveVolumeRowCount: 0, replayVolumeRowCount: 0 }),
    ]).toEqual([
      'live_ticker_and_volume',
      'live_ticker',
      'live_volume',
      'replay_only',
      'seeded_ticker_only',
      'seeded_registry_only',
    ]);
  });

  it('preserves runtime market snapshot source classification', () => {
    const base = {
      hasEffectiveSnapshot: true,
      validationOverrideMode: 'off' as const,
      latestSnapshotOwnership: 'live' as const,
      storedSnapshotOwnership: 'live' as const,
      latestSnapshotIsStale: false,
      storedSnapshotIsStale: false,
      effectiveSeededBootstrapFallbackActive: false,
      validationOverrideForcesDegradedState: false,
      listenerBoundSeededBootstrap: false,
    };

    expect([
      classifyRuntimeMarketSnapshotSourceClass({ ...base, hasEffectiveSnapshot: false }),
      classifyRuntimeMarketSnapshotSourceClass({ ...base, validationOverrideMode: 'degraded_seeded_bootstrap' }),
      classifyRuntimeMarketSnapshotSourceClass({ ...base, validationOverrideMode: 'seeded_bootstrap' }),
      classifyRuntimeMarketSnapshotSourceClass({ ...base, validationOverrideMode: 'zero_live_completed_boot' }),
      classifyRuntimeMarketSnapshotSourceClass({ ...base, validationOverrideMode: 'stale_allowed', latestSnapshotIsStale: true }),
      classifyRuntimeMarketSnapshotSourceClass({ ...base, latestSnapshotOwnership: 'seeded', storedSnapshotOwnership: 'seeded' }),
      classifyRuntimeMarketSnapshotSourceClass({
        ...base,
        latestSnapshotOwnership: 'seeded',
        storedSnapshotOwnership: 'seeded',
        effectiveSeededBootstrapFallbackActive: true,
      }),
      classifyRuntimeMarketSnapshotSourceClass({ ...base, validationOverrideForcesDegradedState: true }),
      classifyRuntimeMarketSnapshotSourceClass({ ...base, storedSnapshotIsStale: true }),
      classifyRuntimeMarketSnapshotSourceClass(base),
    ]).toEqual([
      'unavailable',
      'degraded_seeded_bootstrap',
      'seeded_bootstrap',
      'unavailable',
      'stale_live',
      'seeded_bootstrap',
      'degraded_seeded_bootstrap',
      'stale_live',
      'stale_live',
      'fresh_live',
    ]);
  });

  it('centralizes age and route cache freshness policy calculations', () => {
    expect(ageSeconds(new Date('2026-05-15T00:00:00.000Z'), new Date('2026-05-14T23:59:01.000Z'))).toBe(59);
    expect(ageSeconds(new Date('2026-05-15T00:00:00.000Z'), null)).toBeNull();
    expect(getRouteHttpCacheSeconds({ ttlSeconds: 120, targetFreshnessSeconds: 60 })).toBe(60);
    expect(getRouteHttpCacheSeconds({ ttlSeconds: 5, targetFreshnessSeconds: 30 })).toBe(5);
    expect(getRouteHttpCacheSeconds({ ttlSeconds: 5, targetFreshnessSeconds: null })).toBe(5);
  });
});
