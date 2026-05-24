
import type { AppDatabase } from '../../db/client';
import { supplyChartPoints } from '../../db/schema';
import { getMarketRows } from '../../modules/catalog';
import { getReferenceMarketCapRank } from '../../modules/coins/market-data';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, getUsableSnapshot } from '../../modules/market-freshness';
import type { RuntimeDiagnostics } from '../runtime-diagnostics';
import { MARKET_TOP_N_DENOMINATOR } from './constants';
import { isFiniteNonNegative, isFinitePositive } from './utils';

type SourceBackedSupplyEvidence = {
  circulatingSupply?: number;
  totalSupply?: number;
};

function compareSupplyEvidenceRows(
  candidate: typeof supplyChartPoints.$inferSelect,
  existing: typeof supplyChartPoints.$inferSelect,
) {
  const candidateSourceRank = candidate.sourceKind === 'live' ? 1 : 0;
  const existingSourceRank = existing.sourceKind === 'live' ? 1 : 0;

  if (candidateSourceRank !== existingSourceRank) {
    return candidateSourceRank - existingSourceRank;
  }

  const candidateTimestamp = candidate.timestamp.getTime();
  const existingTimestamp = existing.timestamp.getTime();

  if (candidateTimestamp !== existingTimestamp) {
    return candidateTimestamp - existingTimestamp;
  }

  return (candidate.sourceFetchedAt?.getTime() ?? 0) - (existing.sourceFetchedAt?.getTime() ?? 0);
}

function readLatestSourceBackedSupplyEvidenceByCoin(database: AppDatabase) {
  const rows = database.db.select().from(supplyChartPoints).all();
  const evidenceRowsByKey = new Map<string, typeof rows[number]>();

  for (const row of rows) {
    if (!isFinitePositive(row.value)) {
      continue;
    }

    const key = `${row.coinId}:${row.supplyType}`;
    const existing = evidenceRowsByKey.get(key);
    if (!existing || compareSupplyEvidenceRows(row, existing) > 0) {
      evidenceRowsByKey.set(key, row);
    }
  }

  const evidenceByCoin = new Map<string, SourceBackedSupplyEvidence>();
  for (const row of evidenceRowsByKey.values()) {
    const evidence = evidenceByCoin.get(row.coinId) ?? {};

    if (row.supplyType === 'circulating') {
      evidence.circulatingSupply = row.value;
    } else {
      evidence.totalSupply = row.value;
    }

    evidenceByCoin.set(row.coinId, evidence);
  }

  return evidenceByCoin;
}

function matchesSourceBackedMarketCapDerivation(
  snapshot: { price: number | null; marketCap: number | null } | null | undefined,
  supplyEvidence: SourceBackedSupplyEvidence | undefined,
) {
  const circulatingSupply = supplyEvidence?.circulatingSupply;

  if (
    !snapshot
    || !isFinitePositive(snapshot.price)
    || !isFinitePositive(snapshot.marketCap)
    || !isFinitePositive(circulatingSupply)
  ) {
    return false;
  }

  const expectedMarketCap = snapshot.price * circulatingSupply;
  const tolerance = Math.max(1, Math.abs(expectedMarketCap) * 1e-9);

  return Math.abs(snapshot.marketCap - expectedMarketCap) <= tolerance;
}

export function buildMarketQualityEvidence(database: AppDatabase | undefined, runtimeDiagnostics: RuntimeDiagnostics) {
  const requestPath = '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1';

  if (!database) {
    return {
      assertions: ['VAL-MARKET-007', 'VAL-MARKET-008', 'VAL-MARKET-009', 'VAL-MARKET-021', 'VAL-MARKET-022', 'VAL-MARKET-023', 'VAL-MARKET-024'],
      request_path: requestPath,
      top_n: {
        configured_denominator: MARKET_TOP_N_DENOMINATOR,
        measured_denominator: 0,
        returned_rows: 0,
        price_complete_count: 0,
        market_cap_complete_count: 0,
        volume_complete_count: 0,
        circulating_supply_evidence_count: 0,
        total_supply_evidence_count: 0,
        persisted_market_cap_evidence_count: 0,
        source_backed_market_cap_derivation_count: 0,
        price_completeness_ratio: 0,
        market_cap_completeness_ratio: 0,
        volume_completeness_ratio: 0,
        null_quality_row_count: 0,
        null_quality_first_page_ids: [],
        missing_market_cap_ids: [],
      },
      note: 'Market quality evidence was requested without database access.',
      field_provenance: {
        source_backed_market_cap_derivation_ids: [],
      },
    };
  }

  const runtimeState = {
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
  const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
  const sourceBackedSupplyEvidenceByCoin = readLatestSourceBackedSupplyEvidenceByCoin(database);
  const rows = getMarketRows(database, 'usd', { status: 'active' })
    .map((row) => ({
      coin: row.coin,
      snapshot: getUsableSnapshot(getEffectiveSnapshot(row.snapshot, runtimeState), 300, snapshotAccessPolicy),
    }))
    .sort((left, right) => {
      const leftNullQuality = !left.snapshot || [
        left.snapshot.price,
        left.snapshot.marketCap,
        left.snapshot.totalVolume,
      ].every((value) => !isFinitePositive(value));
      const rightNullQuality = !right.snapshot || [
        right.snapshot.price,
        right.snapshot.marketCap,
        right.snapshot.totalVolume,
      ].every((value) => !isFinitePositive(value));

      if (leftNullQuality !== rightNullQuality) {
        return leftNullQuality ? 1 : -1;
      }

      const leftRank = getReferenceMarketCapRank(left) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = getReferenceMarketCapRank(right) ?? Number.MAX_SAFE_INTEGER;

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      return left.coin.id.localeCompare(right.coin.id);
    })
    .slice(0, MARKET_TOP_N_DENOMINATOR);

  const priceCompleteCount = rows.filter((row) => isFinitePositive(row.snapshot?.price)).length;
  const marketCapCompleteCount = rows.filter((row) => isFinitePositive(row.snapshot?.marketCap)).length;
  const volumeCompleteCount = rows.filter((row) => isFiniteNonNegative(row.snapshot?.totalVolume)).length;
  const circulatingSupplyEvidenceCount = rows.filter((row) => isFinitePositive(row.snapshot?.circulatingSupply)).length;
  const totalSupplyEvidenceCount = rows.filter((row) => isFinitePositive(row.snapshot?.totalSupply)).length;
  const persistedMarketCapEvidenceCount = rows.filter((row) => isFinitePositive(row.snapshot?.marketCap)).length;
  const sourceBackedMarketCapDerivationRows = rows.filter((row) =>
    matchesSourceBackedMarketCapDerivation(row.snapshot, sourceBackedSupplyEvidenceByCoin.get(row.coin.id)),
  );
  const sourceBackedMarketCapDerivationCount = sourceBackedMarketCapDerivationRows.length;
  const missingMarketCapIds = rows
    .filter((row) => !isFinitePositive(row.snapshot?.marketCap))
    .map((row) => row.coin.id);
  const canonicalMissingMarketCapIds = missingMarketCapIds.filter((id) =>
    ['bitcoin', 'ethereum', 'tether', 'binancecoin', 'usd-coin'].includes(id),
  );
  const nullQualityRows = rows.filter((row) => !row.snapshot || [
    row.snapshot.price,
    row.snapshot.marketCap,
    row.snapshot.totalVolume,
  ].every((value) => !isFinitePositive(value)));
  const measuredDenominator = rows.length;
  const priceCompletenessRatio = priceCompleteCount / MARKET_TOP_N_DENOMINATOR;
  const marketCapCompletenessRatio = marketCapCompleteCount / MARKET_TOP_N_DENOMINATOR;
  const volumeCompletenessRatio = volumeCompleteCount / MARKET_TOP_N_DENOMINATOR;
  const exceptions = [
    ...(marketCapCompletenessRatio < 0.8
      ? [{
          field: 'market_cap',
          reason_code: 'source_unavailable',
          message: 'Live exchange ticker sources do not provide market-cap directly and no usable persisted market-cap or source-backed supply evidence exists for the listed top-N rows.',
          configured_denominator: MARKET_TOP_N_DENOMINATOR,
          measured_denominator: measuredDenominator,
          complete_count: marketCapCompleteCount,
          unavailable_count: MARKET_TOP_N_DENOMINATOR - marketCapCompleteCount,
          affected_ids: missingMarketCapIds.slice(0, 25),
        }]
      : []),
    ...(marketCapCompletenessRatio >= 0.8 && canonicalMissingMarketCapIds.length > 0
      ? [{
          field: 'market_cap',
          reason_code: 'source_unavailable',
          message: 'Canonical major rows listed here have source-backed price/volume evidence but no direct market-cap or source-backed supply evidence; public rows preserve null market_cap instead of fabricating it.',
          configured_denominator: MARKET_TOP_N_DENOMINATOR,
          measured_denominator: measuredDenominator,
          complete_count: marketCapCompleteCount,
          unavailable_count: canonicalMissingMarketCapIds.length,
          affected_ids: canonicalMissingMarketCapIds,
        }]
      : []),
    ...(priceCompletenessRatio < 0.9
      ? [{
          field: 'current_price',
          reason_code: 'missing_required_field',
          message: 'Top-N price completeness is below the market quality target.',
        }]
      : []),
    ...(volumeCompletenessRatio < 0.8
      ? [{
          field: 'total_volume',
          reason_code: 'missing_required_field',
          message: 'Top-N volume completeness is below the market quality target.',
        }]
      : []),
  ];

  return {
    assertions: ['VAL-MARKET-007', 'VAL-MARKET-008', 'VAL-MARKET-009', 'VAL-MARKET-021', 'VAL-MARKET-022', 'VAL-MARKET-023', 'VAL-MARKET-024'],
    request_path: requestPath,
    top_n: {
      configured_denominator: MARKET_TOP_N_DENOMINATOR,
      measured_denominator: measuredDenominator,
      returned_rows: rows.length,
      price_complete_count: priceCompleteCount,
      market_cap_complete_count: marketCapCompleteCount,
      volume_complete_count: volumeCompleteCount,
      circulating_supply_evidence_count: circulatingSupplyEvidenceCount,
      total_supply_evidence_count: totalSupplyEvidenceCount,
      persisted_market_cap_evidence_count: persistedMarketCapEvidenceCount,
      source_backed_market_cap_derivation_count: sourceBackedMarketCapDerivationCount,
      price_completeness_ratio: priceCompletenessRatio,
      market_cap_completeness_ratio: marketCapCompletenessRatio,
      volume_completeness_ratio: volumeCompletenessRatio,
      null_quality_row_count: nullQualityRows.length,
      null_quality_first_page_ids: nullQualityRows.map((row) => row.coin.id),
      missing_market_cap_ids: missingMarketCapIds.slice(0, 25),
    },
    exceptions,
    field_provenance: {
      source_backed_market_cap_derivation_ids: sourceBackedMarketCapDerivationRows.map((row) => row.coin.id).slice(0, 25),
    },
    note: 'Top-N completeness uses the stable configured denominator and records request paths for replay.',
  };
}
