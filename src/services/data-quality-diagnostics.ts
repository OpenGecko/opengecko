import type { buildCoverageMatrix } from './coverage-matrix';
import type { RuntimeDiagnostics } from './runtime-diagnostics';
import type { AppDatabase } from '../db/client';
import { getMarketRows } from '../modules/catalog';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, getUsableSnapshot } from '../modules/market-freshness';
import { getReferenceMarketCapRank } from '../modules/coins/market-data';
import { supplyChartPoints } from '../db/schema';

type CoverageMatrix = ReturnType<typeof buildCoverageMatrix>;
type CoverageEntry = CoverageMatrix['entries'][number];

type QualityStatus = 'pass' | 'degraded' | 'fail' | 'out_of_scope';
type SourceState = 'live' | 'hybrid' | 'seeded' | 'fixture' | 'synthetic' | 'fallback' | 'degraded' | 'unavailable' | 'out_of_scope';
type QualityDimensionId =
  | 'contract_compatibility'
  | 'freshness_liveness'
  | 'completeness_coverage'
  | 'live_source_fidelity'
  | 'fixture_fallback_transparency'
  | 'metadata_truthfulness';

type QualityDimension = {
  id: QualityDimensionId;
  score: number;
  status: QualityStatus;
  weight: number;
  reason_codes: string[];
  message: string;
};

type QualityFamilyConfig = {
  family: string;
  aliases: string[];
  runtimeFamilyIds: string[];
  required: boolean;
  representativeRoutes: string[];
  coverageFamily?: string;
  contractEvidence: string[];
  fallbackCoverageFamily?: string;
  outOfScope?: boolean;
};

const TARGET_THRESHOLD = 9;
const MARKET_TOP_N_DENOMINATOR = 100;

const FAMILY_CONFIGS: QualityFamilyConfig[] = [
  {
    family: 'simple',
    aliases: ['simple_price', 'token_price', 'exchange_rates'],
    runtimeFamilyIds: ['simple'],
    required: true,
    representativeRoutes: ['/simple/price', '/simple/token_price/:id', '/exchange_rates'],
    coverageFamily: 'simple',
    contractEvidence: ['tests/simple-price-parity.test.ts', 'tests/token-price-parity.test.ts', 'tests/exchange-rates-parity.test.ts'],
  },
  {
    family: 'coins',
    aliases: ['coins_markets', 'coin_detail'],
    runtimeFamilyIds: ['coins_markets', 'coin_detail'],
    required: true,
    representativeRoutes: ['/coins/list', '/coins/markets', '/coins/:id'],
    coverageFamily: 'coins_markets',
    contractEvidence: ['tests/coins-markets-parity.test.ts', 'tests/coin-detail-parity.test.ts'],
  },
  {
    family: 'exchanges',
    aliases: ['exchange_list', 'exchange_detail', 'exchange_tickers', 'exchange_volumes'],
    runtimeFamilyIds: ['exchanges'],
    required: true,
    representativeRoutes: ['/exchanges/list', '/exchanges', '/exchanges/:id', '/exchanges/:id/tickers'],
    coverageFamily: 'exchanges',
    contractEvidence: ['tests/exchange-routes.test.ts', 'tests/exchange-fidelity.test.ts'],
  },
  {
    family: 'global',
    aliases: ['global_aggregates', 'global_charts'],
    runtimeFamilyIds: ['global', 'coins_markets'],
    required: true,
    representativeRoutes: ['/global', '/global/decentralized_finance_defi', '/global/market_cap_chart'],
    fallbackCoverageFamily: 'coins_markets',
    contractEvidence: ['tests/global-routes.test.ts', 'tests/global-parity.test.ts'],
  },
  {
    family: 'search',
    aliases: ['search_routes', 'trending', 'stable_catalog'],
    runtimeFamilyIds: ['search', 'stable_catalog'],
    required: true,
    representativeRoutes: ['/search', '/search/trending'],
    coverageFamily: 'stable_catalog',
    contractEvidence: ['tests/search-routes.test.ts'],
  },
  {
    family: 'assets',
    aliases: ['asset_platforms', 'token_lists', 'stable_catalog'],
    runtimeFamilyIds: ['assets', 'stable_catalog'],
    required: true,
    representativeRoutes: ['/asset_platforms', '/token_lists/:platform/all.json'],
    coverageFamily: 'stable_catalog',
    contractEvidence: ['tests/catalog.test.ts', 'tests/docs-drift.test.ts'],
  },
  {
    family: 'treasury',
    aliases: ['public_treasury'],
    runtimeFamilyIds: ['treasury'],
    required: true,
    representativeRoutes: ['/companies/public_treasury/:coin_id', '/public_treasury/:entity_id'],
    coverageFamily: 'treasury',
    contractEvidence: ['tests/treasury-routes.test.ts', 'tests/modules/treasury-ext-contract.test.ts'],
  },
  {
    family: 'onchain',
    aliases: ['geckoterminal', 'onchain_networks', 'onchain_pools', 'onchain_trades'],
    runtimeFamilyIds: ['onchain'],
    required: true,
    representativeRoutes: ['/onchain/networks', '/onchain/networks/:network/pools'],
    coverageFamily: 'onchain',
    contractEvidence: ['tests/modules/onchain.test.ts'],
  },
  {
    family: 'derivatives',
    aliases: ['derivative_tickers', 'derivative_exchanges'],
    runtimeFamilyIds: ['derivatives'],
    required: true,
    representativeRoutes: ['/derivatives', '/derivatives/exchanges', '/derivatives/exchanges/:id'],
    coverageFamily: 'derivatives',
    contractEvidence: ['tests/derivatives-routes.test.ts', 'tests/provider-replay-derivatives.test.ts'],
  },
  {
    family: 'supply',
    aliases: ['supply_charts', 'circulating_supply_charts', 'total_supply_charts'],
    runtimeFamilyIds: ['supply_charts'],
    required: true,
    representativeRoutes: ['/coins/:id/circulating_supply_chart', '/coins/:id/total_supply_chart'],
    coverageFamily: 'supply_charts',
    contractEvidence: ['tests/provider-replay-supply-charts.test.ts'],
  },
  {
    family: 'historical',
    aliases: ['historical_charts', 'ohlcv', 'market_charts', 'coin_history'],
    runtimeFamilyIds: ['historical_charts', 'coin_history'],
    required: true,
    representativeRoutes: ['/coins/:id/market_chart', '/coins/:id/ohlc', '/coins/:id/history'],
    coverageFamily: 'historical_charts',
    contractEvidence: ['tests/chart-route-invariants.test.ts', 'tests/provider-replay-market-charts.test.ts', 'tests/provider-replay-coin-history.test.ts'],
  },
];

function roundScore(score: number) {
  if (!Number.isFinite(score)) {
    return 0;
  }

  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

function statusForScore(score: number, required: boolean): QualityStatus {
  if (!required) {
    return 'out_of_scope';
  }

  if (score >= TARGET_THRESHOLD) {
    return 'pass';
  }

  return score >= 6 ? 'degraded' : 'fail';
}

function sourceStateForOwnership(ownershipClass: CoverageEntry['ownership_class'] | undefined): SourceState {
  switch (ownershipClass) {
    case 'live':
      return 'live';
    case 'hybrid':
      return 'hybrid';
    case 'seeded':
      return 'seeded';
    case 'fixture':
      return 'fixture';
    case 'synthetic':
      return 'synthetic';
    case 'unavailable':
    default:
      return 'unavailable';
  }
}

function sourceScore(sourceState: SourceState) {
  switch (sourceState) {
    case 'live':
      return 9.5;
    case 'hybrid':
      return 7;
    case 'seeded':
      return 5.5;
    case 'fixture':
      return 4;
    case 'synthetic':
      return 4;
    case 'fallback':
      return 5;
    case 'degraded':
      return 5;
    case 'out_of_scope':
      return 0;
    case 'unavailable':
    default:
      return 0;
  }
}

function freshnessScore(entry: CoverageEntry | undefined, sourceState: SourceState) {
  if (!entry) {
    return { score: 4, reason: 'missing_coverage_entry' };
  }

  if (sourceState === 'fixture' || sourceState === 'seeded' || sourceState === 'synthetic') {
    return { score: 6, reason: `${sourceState}_source` };
  }

  switch (entry.freshness.state) {
    case 'fresh':
      return { score: 9.5, reason: 'fresh_source' };
    case 'unbudgeted':
      return { score: entry.last_successful_refresh_at ? 9 : 7, reason: entry.last_successful_refresh_at ? 'unbudgeted_source' : 'missing_freshness_budget' };
    case 'degraded':
      return { score: 7, reason: 'stale_source' };
    case 'stale':
      return { score: 5, reason: 'stale_source' };
    case 'unknown':
    default:
      return { score: 4, reason: 'unknown_freshness' };
  }
}

function buildDimension(
  id: QualityDimensionId,
  score: number,
  required: boolean,
  reasonCodes: string[],
  message: string,
): QualityDimension {
  const normalizedScore = roundScore(score);
  return {
    id,
    score: normalizedScore,
    status: statusForScore(normalizedScore, required),
    weight: 1,
    reason_codes: reasonCodes,
    message,
  };
}

const INJECTED_PROVIDER_FAILURE_RUNTIME_FAMILY_IDS = new Set([
  'simple',
  'coins_markets',
  'coin_detail',
  'exchanges',
  'historical_charts',
]);

function runtimeAffectsFamily(runtimeDiagnostics: RuntimeDiagnostics, runtimeFamilyIds: string[]) {
  if (
    runtimeDiagnostics.degraded.injected_provider_failure.active
    && runtimeFamilyIds.some((runtimeFamilyId) => INJECTED_PROVIDER_FAILURE_RUNTIME_FAMILY_IDS.has(runtimeFamilyId))
  ) {
    return true;
  }

  if (runtimeDiagnostics.degraded.active) {
    return true;
  }

  return (runtimeDiagnostics.providers ?? []).some((provider) =>
    provider.alert_status !== 'healthy'
    && provider.capabilities.some((capability) =>
      capability.state === 'degraded'
      && capability.endpoint_families.some((endpointFamily) =>
        runtimeFamilyIds.some((runtimeFamilyId) => endpointFamily.includes(runtimeFamilyId) || (
          runtimeFamilyId === 'coins_markets' && endpointFamily.includes('/coins/markets')
        ) || (
          runtimeFamilyId === 'simple' && endpointFamily.includes('/simple')
        ) || (
          runtimeFamilyId === 'exchanges' && endpointFamily.includes('/exchanges')
        )),
      ),
    ),
  );
}

function providerReasonCodes(runtimeDiagnostics: RuntimeDiagnostics) {
  const codes = new Set<string>();
  if (runtimeDiagnostics.degraded.active) {
    codes.add('runtime_degraded');
  }
  if (
    runtimeDiagnostics.degraded.validation_override.mode === 'stale_allowed'
    || runtimeDiagnostics.degraded.validation_override.mode === 'stale_disallowed'
  ) {
    codes.add('stale_source');
  }
  if (runtimeDiagnostics.degraded.injected_provider_failure.active) {
    codes.add('provider_error');
  }
  for (const provider of runtimeDiagnostics.providers ?? []) {
    if (provider.alert_status !== 'healthy') {
      codes.add(provider.state === 'open' ? 'provider_error' : 'provider_degraded');
    }
  }
  return [...codes].sort();
}

function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

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

function buildMarketQualityEvidence(database: AppDatabase | undefined, runtimeDiagnostics: RuntimeDiagnostics) {
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

export function buildDataQualityDiagnostics(
  coverageMatrix: CoverageMatrix,
  runtimeDiagnostics: RuntimeDiagnostics,
  now = new Date(),
  database?: AppDatabase,
) {
  const coverageByFamily = new Map(coverageMatrix.entries.map((entry) => [entry.family, entry]));
  const runtimeReasonCodes = providerReasonCodes(runtimeDiagnostics);
  const marketQualityEvidence = buildMarketQualityEvidence(database, runtimeDiagnostics);

  const families = FAMILY_CONFIGS.map((config) => {
    const coverageEntry = coverageByFamily.get(config.coverageFamily ?? config.family)
      ?? coverageByFamily.get(config.fallbackCoverageFamily ?? '');
    const sourceState = sourceStateForOwnership(coverageEntry?.ownership_class);
    const freshness = freshnessScore(coverageEntry, sourceState);
    const runtimeAffected = runtimeAffectsFamily(runtimeDiagnostics, config.runtimeFamilyIds);
    const liveSourceScore = runtimeAffected ? Math.min(sourceScore(sourceState), 6) : sourceScore(sourceState);
    const sourceReasonCodes = sourceState === 'live'
      ? []
      : [sourceState === 'unavailable' ? 'source_unavailable' : `${sourceState}_only`];
    const completenessScore = coverageEntry
      ? Math.min(10, 6 + Math.min(coverageEntry.representative_routes.length, 3) + Math.min(coverageEntry.providers.length, 1))
      : 4;
    const dimensions = [
      buildDimension(
        'contract_compatibility',
        config.contractEvidence.length > 0 ? 9.5 : 7,
        config.required,
        config.contractEvidence.length > 0 ? [] : ['missing_contract_evidence'],
        'Contract score is backed by route tests and representative smoke evidence.',
      ),
      buildDimension(
        'freshness_liveness',
        runtimeAffected ? Math.min(freshness.score, 6) : freshness.score,
        config.required,
        [
          ...(freshness.reason === 'fresh_source' ? [] : [freshness.reason]),
          ...(runtimeAffected ? runtimeReasonCodes : []),
        ],
        'Freshness score reflects coverage-matrix budgets plus runtime/provider degradation.',
      ),
      buildDimension(
        'completeness_coverage',
        completenessScore,
        config.required,
        completenessScore >= TARGET_THRESHOLD ? [] : ['partial_coverage'],
        'Completeness score reflects representative routes, provider counts, and coverage evidence breadth.',
      ),
      buildDimension(
        'live_source_fidelity',
        liveSourceScore,
        config.required,
        [...sourceReasonCodes, ...(runtimeAffected ? runtimeReasonCodes : [])],
        'Live-fidelity score is capped below 9 for fixture, seeded, hybrid, unavailable, or degraded sources.',
      ),
      buildDimension(
        'fixture_fallback_transparency',
        sourceState === 'live' ? 9.5 : 10,
        config.required,
        [],
        'Fixture, fallback, seeded, hybrid, and unavailable states are explicitly labeled with reason codes.',
      ),
      buildDimension(
        'metadata_truthfulness',
        coverageEntry ? 9.5 : 6,
        config.required,
        coverageEntry ? [] : ['missing_coverage_entry'],
        'Metadata truthfulness is anchored to the coverage matrix and provider/source evidence.',
      ),
    ];
    const score = roundScore(Math.min(...dimensions.map((dimension) => dimension.score)));
    const reasonCodes = [...new Set(dimensions.flatMap((dimension) => dimension.reason_codes))].sort();
    const failingDimensions = dimensions
      .filter((dimension) => dimension.score < TARGET_THRESHOLD)
      .map((dimension) => dimension.id);

    return {
      family: config.family,
      runtime_family_ids: config.runtimeFamilyIds,
      aliases: config.aliases,
      required: config.required,
      score,
      target_threshold: TARGET_THRESHOLD,
      status: statusForScore(score, config.required),
      score_scopes: {
        contract_compatibility: dimensions.find((dimension) => dimension.id === 'contract_compatibility')?.score ?? 0,
        freshness_liveness: dimensions.find((dimension) => dimension.id === 'freshness_liveness')?.score ?? 0,
        live_source_fidelity: dimensions.find((dimension) => dimension.id === 'live_source_fidelity')?.score ?? 0,
        fixture_fallback_transparency: dimensions.find((dimension) => dimension.id === 'fixture_fallback_transparency')?.score ?? 0,
        overall: score,
      },
      dimensions,
      source: {
        state: runtimeAffected && sourceState === 'live' ? 'degraded' as SourceState : sourceState,
        ownership_class: coverageEntry?.ownership_class ?? 'unavailable',
        fallback: sourceState !== 'live',
        fallback_status: sourceState === 'live' ? 'none' : sourceState,
        latest_source_at: coverageEntry?.last_successful_refresh_at ?? null,
        freshness_state: coverageEntry?.freshness.state ?? 'unknown',
        provider_ids: coverageEntry?.providers ?? [],
        provider_count: coverageEntry?.providers.length ?? 0,
        evidence_family: coverageEntry?.family ?? null,
      },
      counts: {
        representative_route_count: config.representativeRoutes.length,
        coverage_route_count: coverageEntry?.representative_routes.length ?? 0,
        provider_count: coverageEntry?.providers.length ?? 0,
        evidence_test_count: coverageEntry?.evidence.tests.length ?? config.contractEvidence.length,
        ...(config.family === 'coins'
          ? {
              market_top_n_configured_denominator: marketQualityEvidence.top_n.configured_denominator,
              market_top_n_measured_denominator: marketQualityEvidence.top_n.measured_denominator,
              market_top_n_returned_rows: marketQualityEvidence.top_n.returned_rows,
              market_top_n_null_quality_rows: marketQualityEvidence.top_n.null_quality_row_count,
            }
          : {}),
      },
      timestamps: {
        generated_at: now.toISOString(),
        coverage_generated_at: coverageMatrix.generated_at,
        latest_source_at: coverageEntry?.last_successful_refresh_at ?? null,
      },
      evidence: {
        representative_routes: config.representativeRoutes,
        contract_tests: config.contractEvidence,
        coverage_tests: coverageEntry?.evidence.tests ?? [],
        coverage_notes: coverageEntry?.evidence.notes ?? 'No coverage-matrix entry was available for this family.',
        ...(config.family === 'coins'
          ? {
              market_quality: marketQualityEvidence,
              replayable_evidence: {
                base_url_env: 'BASE_URL',
                generated_at: now.toISOString(),
                request_paths: [
                  marketQualityEvidence.request_path,
                  '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
                  '/coins/bitcoin',
                  '/coins/bitcoin/market_chart?vs_currency=usd&days=7',
                  '/coins/bitcoin/ohlc?vs_currency=usd&days=7',
                ],
                diagnostics_paths: ['/diagnostics/data_quality', '/diagnostics/runtime', '/diagnostics/coverage_matrix'],
              },
            }
          : {}),
        runtime_degradation: runtimeAffected
          ? {
              active: true,
              reason_codes: runtimeReasonCodes,
              reason: runtimeDiagnostics.degraded.injected_provider_failure.active
                ? runtimeDiagnostics.degraded.injected_provider_failure.reason
                : runtimeDiagnostics.degraded.reason,
            }
          : {
              active: false,
              reason_codes: [],
              reason: null,
            },
      },
      reason_codes: reasonCodes,
      failing_dimensions: failingDimensions,
    };
  });

  const belowTargetFamilies = families
    .filter((family) => family.required && family.score < TARGET_THRESHOLD)
    .map((family) => ({
      family: family.family,
      score: family.score,
      failing_dimensions: family.failing_dimensions,
      reason_codes: family.reason_codes.length > 0 ? family.reason_codes : ['below_target_threshold'],
    }));

  const aliasMap = Object.fromEntries(
    families.map((family) => [family.family, family.runtime_family_ids]),
  );
  const aliases = Object.fromEntries(
    families.flatMap((family) => [
      [family.family, family.runtime_family_ids],
      ...family.aliases.map((alias) => [alias, family.runtime_family_ids] as const),
    ]),
  );

  return {
    generated_at: now.toISOString(),
    schema_version: 1,
    target_threshold: TARGET_THRESHOLD,
    score_scale: {
      min: 0,
      max: 10,
      target: TARGET_THRESHOLD,
      rounding: 'one_decimal_no_upward_gate_rounding',
    },
    score_scopes: ['contract_compatibility', 'freshness_liveness', 'live_source_fidelity', 'fixture_fallback_transparency', 'overall_gate'],
    family_aliases: aliasMap,
    aliases,
    gate: {
      status: belowTargetFamilies.length === 0 ? 'pass' : 'fail',
      threshold: TARGET_THRESHOLD,
      required_family_count: families.filter((family) => family.required).length,
      below_target_count: belowTargetFamilies.length,
      below_target_families: belowTargetFamilies,
      reason_codes: belowTargetFamilies.length === 0 ? [] : ['required_family_below_threshold'],
    },
    families,
    stable_regression_fields: [
      'generated_at',
      'schema_version',
      'target_threshold',
      'gate.status',
      'gate.below_target_families',
      'families[].family',
      'families[].score',
      'families[].status',
      'families[].score_scopes',
      'families[].source',
      'families[].counts',
      'families[].reason_codes',
      'families[].failing_dimensions',
    ],
  };
}
