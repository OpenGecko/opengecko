
import type { AppDatabase } from '../../db/client';
import { getMarketRows } from '../../modules/catalog';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, getUsableSnapshot } from '../../modules/market-freshness';
import type { RuntimeDiagnostics } from '../runtime-diagnostics';
import { GLOBAL_AGGREGATE_TOLERANCE_RATIO } from './constants';
import type { GlobalPublicRouteData } from './types';
import { deltaRatio, isFiniteNonNegative, isFinitePositive, latestIsoFromDates, safePercentage } from './utils';

function buildExchangeGlobalRuntimeState(runtimeDiagnostics: RuntimeDiagnostics) {
  return {
    initialSyncCompleted: runtimeDiagnostics.readiness.initial_sync_completed,
    listenerBindDeferred: runtimeDiagnostics.readiness.listener_bind_deferred,
    initialSyncCompletedWithoutUsableLiveSnapshots: runtimeDiagnostics.readiness.zero_live_completed_boot,
    allowStaleLiveService: runtimeDiagnostics.degraded.stale_live_enabled,
    syncFailureReason: runtimeDiagnostics.degraded.reason,
    validationOverride: {
      mode: runtimeDiagnostics.degraded.validation_override.mode,
      reason: runtimeDiagnostics.degraded.validation_override.reason,
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    },
    providerFailureCooldownUntil: null,
    forcedProviderFailure: runtimeDiagnostics.degraded.injected_provider_failure,
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
    hotDataRevision: runtimeDiagnostics.hot_paths.cache_revision,
    listenerBound: runtimeDiagnostics.readiness.listener_bound,
  };
}

export function buildGlobalQualityEvidence(
  database: AppDatabase | undefined,
  runtimeDiagnostics: RuntimeDiagnostics,
  publicGlobalRouteData?: GlobalPublicRouteData,
) {
  if (!database) {
    return {
      assertions: ['VAL-EXGLOBAL-019', 'VAL-EXGLOBAL-029'],
      request_path: '/global',
      source_rows: {
        usable_market_row_count: 0,
        market_cap_row_count: 0,
        volume_row_count: 0,
      },
      recomputation: {
        tolerance_ratio: GLOBAL_AGGREGATE_TOLERANCE_RATIO,
        total_market_cap_usd: 0,
        recomputed_total_market_cap_usd: 0,
        market_cap_delta_ratio: 0,
        total_volume_usd: 0,
        recomputed_total_volume_usd: 0,
        volume_delta_ratio: 0,
        within_tolerance: false,
      },
      public_route_values: {
        route: '/global',
        total_market_cap_usd: 0,
        total_volume_usd: 0,
        market_cap_percentage: {},
      },
      public_route_comparison: {
        compared_route: '/global',
        market_cap_delta_ratio: 0,
        volume_delta_ratio: 0,
        dominance_delta_ratios: {},
        within_tolerance: false,
      },
      reason_codes: ['missing_database'],
    };
  }

  const runtimeState = buildExchangeGlobalRuntimeState(runtimeDiagnostics);
  const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
  const rows = getMarketRows(database, 'usd', { status: 'active' })
    .map((row) => ({
      coin: row.coin,
      snapshot: getUsableSnapshot(getEffectiveSnapshot(row.snapshot, runtimeState), 300, snapshotAccessPolicy),
    }))
    .filter((row): row is typeof row & { snapshot: NonNullable<typeof row.snapshot> } => row.snapshot !== null);
  const recomputedTotalMarketCapUsd = rows.reduce((sum, row) => sum + (row.snapshot.marketCap ?? 0), 0);
  const recomputedTotalVolumeUsd = rows.reduce((sum, row) => sum + (row.snapshot.totalVolume ?? 0), 0);
  const marketCapRows = rows.filter((row) => isFinitePositive(row.snapshot.marketCap));
  const volumeRows = rows.filter((row) => isFiniteNonNegative(row.snapshot.totalVolume));
  const totalMarketCapUsd = publicGlobalRouteData?.total_market_cap.usd ?? recomputedTotalMarketCapUsd;
  const totalVolumeUsd = publicGlobalRouteData?.total_volume.usd ?? recomputedTotalVolumeUsd;
  const marketCapDeltaRatio = totalMarketCapUsd === 0
    ? (recomputedTotalMarketCapUsd === 0 ? 0 : 1)
    : Math.abs(totalMarketCapUsd - recomputedTotalMarketCapUsd) / Math.abs(totalMarketCapUsd);
  const volumeDeltaRatio = totalVolumeUsd === 0
    ? (recomputedTotalVolumeUsd === 0 ? 0 : 1)
    : Math.abs(totalVolumeUsd - recomputedTotalVolumeUsd) / Math.abs(totalVolumeUsd);
  const withinTolerance = marketCapDeltaRatio <= GLOBAL_AGGREGATE_TOLERANCE_RATIO
    && volumeDeltaRatio <= GLOBAL_AGGREGATE_TOLERANCE_RATIO
    && marketCapRows.length > 0;
  const dominanceRows = ['bitcoin', 'ethereum', 'usd-coin']
    .map((coinId) => {
      const row = rows.find((candidate) => candidate.coin.id === coinId) ?? null;
      return {
        coin_id: coinId,
        market_cap_usd: row?.snapshot.marketCap ?? null,
        recomputed_percentage: recomputedTotalMarketCapUsd > 0 && row?.snapshot.marketCap
          ? (row.snapshot.marketCap / recomputedTotalMarketCapUsd) * 100
          : null,
      };
    });
  const publicRouteDominance = {
    btc: publicGlobalRouteData?.market_cap_percentage.btc ?? safePercentage(
      rows.find((candidate) => candidate.coin.id === 'bitcoin')?.snapshot.marketCap ?? 0,
      totalMarketCapUsd,
    ),
    eth: publicGlobalRouteData?.market_cap_percentage.eth ?? safePercentage(
      rows.find((candidate) => candidate.coin.id === 'ethereum')?.snapshot.marketCap ?? 0,
      totalMarketCapUsd,
    ),
    usdc: publicGlobalRouteData?.market_cap_percentage.usdc ?? safePercentage(
      rows.find((candidate) => candidate.coin.id === 'usd-coin')?.snapshot.marketCap ?? 0,
      totalMarketCapUsd,
    ),
  };
  const publicRouteValues = {
    route: '/global',
    total_market_cap_usd: totalMarketCapUsd,
    total_volume_usd: totalVolumeUsd,
    market_cap_percentage: publicRouteDominance,
  };
  const dominanceDeltaRatios = Object.fromEntries(
    dominanceRows.map((row) => {
      const symbol = row.coin_id === 'bitcoin'
        ? 'btc'
        : row.coin_id === 'ethereum'
          ? 'eth'
          : 'usdc';
      return [symbol, deltaRatio(publicRouteDominance[symbol] ?? 0, row.recomputed_percentage ?? 0)];
    }),
  );
  const publicRouteComparison = {
    compared_route: '/global',
    market_cap_delta_ratio: deltaRatio(publicRouteValues.total_market_cap_usd, recomputedTotalMarketCapUsd),
    volume_delta_ratio: deltaRatio(publicRouteValues.total_volume_usd, recomputedTotalVolumeUsd),
    dominance_delta_ratios: dominanceDeltaRatios,
    within_tolerance: deltaRatio(publicRouteValues.total_market_cap_usd, recomputedTotalMarketCapUsd) <= GLOBAL_AGGREGATE_TOLERANCE_RATIO
      && deltaRatio(publicRouteValues.total_volume_usd, recomputedTotalVolumeUsd) <= GLOBAL_AGGREGATE_TOLERANCE_RATIO
      && Object.values(dominanceDeltaRatios).every((ratio) => ratio <= GLOBAL_AGGREGATE_TOLERANCE_RATIO),
  };

  return {
    assertions: ['VAL-EXGLOBAL-019', 'VAL-EXGLOBAL-029'],
    request_path: '/global',
    source_rows: {
      usable_market_row_count: rows.length,
      market_cap_row_count: marketCapRows.length,
      volume_row_count: volumeRows.length,
      latest_market_row_at: latestIsoFromDates(rows.map((row) => row.snapshot.lastUpdated)),
    },
    recomputation: {
      tolerance_ratio: GLOBAL_AGGREGATE_TOLERANCE_RATIO,
      total_market_cap_usd: totalMarketCapUsd,
      recomputed_total_market_cap_usd: recomputedTotalMarketCapUsd,
      market_cap_delta_ratio: marketCapDeltaRatio,
      total_volume_usd: totalVolumeUsd,
      recomputed_total_volume_usd: recomputedTotalVolumeUsd,
      volume_delta_ratio: volumeDeltaRatio,
      within_tolerance: withinTolerance,
    },
    dominance_recomputation: dominanceRows,
    public_route_values: publicRouteValues,
    public_route_comparison: publicRouteComparison,
    reason_codes: withinTolerance && publicRouteComparison.within_tolerance ? [] : ['sparse_market_rows_or_aggregate_mismatch'],
    note: 'Global aggregate provenance is derived from usable USD market rows and compared against the public /global USD totals and dominance values so validators do not rely only on self-derived sums.',
  };
}
