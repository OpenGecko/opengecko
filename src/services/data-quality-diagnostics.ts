import type { buildCoverageMatrix } from './coverage-matrix';
import type { RuntimeDiagnostics } from './runtime-diagnostics';
import type { AppDatabase } from '../db/client';
import { getMarketRows } from '../modules/catalog';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, getUsableSnapshot } from '../modules/market-freshness';
import { getReferenceMarketCapRank } from '../modules/coins/market-data';
import {
  assetPlatforms,
  coins,
  coinTickers,
  derivativeTickers,
  exchangeVolumeSourcePoints,
  exchanges,
  onchainNetworks,
  onchainPoolOhlcv,
  onchainPools,
  onchainPoolTrades,
  onchainTokenHolderCounts,
  onchainTokenHolders,
  onchainTokenTraders,
  supplyChartPoints,
  treasuryHoldings,
  treasurySourceDocuments,
  treasuryTransactions,
} from '../db/schema';
import { isLiveSourceKind, isReplaySourceKind, isSeededExchangeTimestamp } from './diagnostics-policy';

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
const GLOBAL_AGGREGATE_TOLERANCE_RATIO = 0.000001;
const MAJOR_EXCHANGE_TARGETS = [
  { target_id: 'binance', aliases: ['binance'] },
  { target_id: 'coinbase', aliases: ['coinbase', 'gdax'] },
  { target_id: 'kraken', aliases: ['kraken'] },
  { target_id: 'okx', aliases: ['okx', 'okex'] },
  { target_id: 'bybit', aliases: ['bybit', 'bybit_spot'] },
];

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
    representativeRoutes: ['/derivatives', '/derivatives/exchanges', '/derivatives/exchanges/:id', '/derivatives/exchanges/:id/tickers'],
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

function latestIsoFromDates(values: Array<Date | null | undefined>) {
  const latest = values.reduce<Date | null>((current, value) => {
    if (!value) {
      return current;
    }

    return current === null || value.getTime() > current.getTime() ? value : current;
  }, null);

  return latest?.toISOString() ?? null;
}

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

function buildExchangeQualityEvidence(database: AppDatabase | undefined) {
  if (!database) {
    return {
      assertions: ['VAL-EXGLOBAL-026', 'VAL-EXGLOBAL-027', 'VAL-EXGLOBAL-028'],
      major_targets: MAJOR_EXCHANGE_TARGETS.map((target) => ({
        ...target,
        status: 'unknown_no_database',
        matched_exchange_id: null,
        ticker_numeric_quality: null,
        volume_chart_evidence: null,
      })),
      ticker_numeric_quality: {
        total_rows: 0,
        valid_last_count: 0,
        valid_converted_volume_count: 0,
        parseable_timestamp_count: 0,
        invalid_row_count: 0,
      },
      volume_chart_evidence: {
        source_backed_exchange_count: 0,
        live_point_count: 0,
        replay_point_count: 0,
        latest_source_fetched_at: null,
        dimension_status: 'degraded',
        reason_codes: ['missing_database'],
      },
    };
  }

  const exchangeRows = database.db.select().from(exchanges).all();
  const tickerRows = database.db.select().from(coinTickers).all();
  const volumeRows = database.db.select().from(exchangeVolumeSourcePoints).all();
  const liveOrReplayVolumeRows = volumeRows.filter((row) => isLiveSourceKind(row.sourceKind) || isReplaySourceKind(row.sourceKind));
  const invalidTickerRows = tickerRows.filter((row) => (
    !isFinitePositive(row.last)
    || !isFiniteNonNegative(row.convertedVolumeUsd)
    || !(row.lastFetchAt instanceof Date)
  ));

  const majorTargets = MAJOR_EXCHANGE_TARGETS.map((target) => {
    const exchange = exchangeRows.find((row) => target.aliases.includes(row.id)) ?? null;
    const targetTickerRows = exchange
      ? tickerRows.filter((row) => row.exchangeId === exchange.id)
      : [];
    const liveTickerRows = targetTickerRows.filter((row) => row.lastFetchAt instanceof Date && !isSeededExchangeTimestamp(row.lastFetchAt));
    const validTickerRows = targetTickerRows.filter((row) => (
      isFinitePositive(row.last)
      && isFiniteNonNegative(row.convertedVolumeUsd)
      && row.lastFetchAt instanceof Date
    ));
    const targetVolumeRows = exchange
      ? volumeRows.filter((row) => row.exchangeId === exchange.id)
      : [];
    const sourceBackedVolumeRows = targetVolumeRows.filter((row) => isLiveSourceKind(row.sourceKind) || isReplaySourceKind(row.sourceKind));

    return {
      target_id: target.target_id,
      aliases: target.aliases,
      matched_exchange_id: exchange?.id ?? null,
      status: exchange
        ? liveTickerRows.length > 0
          ? 'live_ticker_backed'
          : targetTickerRows.length > 0
            ? 'fixture_or_seeded_tickers'
            : 'catalog_only'
        : 'missing_catalog',
      ticker_numeric_quality: {
        total_rows: targetTickerRows.length,
        live_row_count: liveTickerRows.length,
        valid_numeric_rows: validTickerRows.length,
        valid_ratio: targetTickerRows.length > 0 ? validTickerRows.length / targetTickerRows.length : 0,
        invalid_or_missing_rows: Math.max(targetTickerRows.length - validTickerRows.length, 0),
        latest_ticker_at: latestIsoFromDates(targetTickerRows.map((row) => row.lastFetchAt)),
      },
      volume_chart_evidence: {
        total_point_count: targetVolumeRows.length,
        source_backed_point_count: sourceBackedVolumeRows.length,
        live_point_count: targetVolumeRows.filter((row) => isLiveSourceKind(row.sourceKind)).length,
        replay_point_count: targetVolumeRows.filter((row) => isReplaySourceKind(row.sourceKind)).length,
        latest_source_fetched_at: latestIsoFromDates(sourceBackedVolumeRows.map((row) => row.sourceFetchedAt)),
      },
      degradation_reason: exchange
        ? targetTickerRows.length > 0 || sourceBackedVolumeRows.length > 0
          ? null
          : 'no_live_ticker_or_volume_rows'
        : 'exchange_catalog_missing',
    };
  });

  return {
    assertions: ['VAL-EXGLOBAL-026', 'VAL-EXGLOBAL-027', 'VAL-EXGLOBAL-028'],
    major_targets: majorTargets,
    ticker_numeric_quality: {
      total_rows: tickerRows.length,
      valid_last_count: tickerRows.filter((row) => isFinitePositive(row.last)).length,
      valid_converted_volume_count: tickerRows.filter((row) => isFiniteNonNegative(row.convertedVolumeUsd)).length,
      parseable_timestamp_count: tickerRows.filter((row) => row.lastFetchAt instanceof Date).length,
      invalid_row_count: invalidTickerRows.length,
      invalid_row_samples: invalidTickerRows.slice(0, 10).map((row) => ({
        exchange_id: row.exchangeId,
        pair: `${row.base}/${row.target}`,
        last: row.last,
        converted_volume_usd: row.convertedVolumeUsd,
        last_fetch_at: row.lastFetchAt?.toISOString() ?? null,
      })),
    },
    volume_chart_evidence: {
      source_backed_exchange_count: new Set(liveOrReplayVolumeRows.map((row) => row.exchangeId)).size,
      live_point_count: volumeRows.filter((row) => isLiveSourceKind(row.sourceKind)).length,
      replay_point_count: volumeRows.filter((row) => isReplaySourceKind(row.sourceKind)).length,
      latest_source_fetched_at: latestIsoFromDates(liveOrReplayVolumeRows.map((row) => row.sourceFetchedAt)),
      dimension_status: liveOrReplayVolumeRows.length > 0 ? 'source_backed' : 'degraded',
      reason_codes: liveOrReplayVolumeRows.length > 0 ? [] : ['missing_exchange_volume_chart_source'],
    },
    note: 'Major exchange targets are matched through CoinGecko-compatible exchange IDs and common CCXT aliases; missing venues are explicit per target instead of blocking the whole family.',
  };
}

function buildGlobalQualityEvidence(database: AppDatabase | undefined, runtimeDiagnostics: RuntimeDiagnostics) {
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
  const totalMarketCapUsd = recomputedTotalMarketCapUsd;
  const totalVolumeUsd = recomputedTotalVolumeUsd;
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
    reason_codes: withinTolerance ? [] : ['sparse_market_rows_or_aggregate_mismatch'],
    note: 'Global aggregate provenance is derived from the same usable USD market rows as /global so validators can recompute totals and dominance from source row counts.',
  };
}

function buildDerivativesQualityEvidence(database: AppDatabase | undefined) {
  if (!database) {
    return {
      assertions: ['VAL-EXGLOBAL-030'],
      score_separation: {
        contract_compatibility_state: 'unknown_no_database',
        live_fidelity_state: 'degraded',
        fixture_transparency_state: 'unknown_no_database',
      },
      ticker_counts: {
        total: 0,
        source_backed: 0,
        fixture: 0,
        live: 0,
        replay: 0,
      },
      diagnostics_agreement: {
        public_meta_source_backed_tickers: 0,
        diagnostics_source_backed_tickers: 0,
        agrees: true,
      },
      reason_codes: ['missing_database'],
    };
  }

  const rows = database.db.select().from(derivativeTickers).all();
  const sourceBackedRows = rows.filter((row) => row.sourceKind !== 'seed');
  const liveRows = rows.filter((row) => row.sourceKind === 'live');
  const replayRows = rows.filter((row) => row.sourceKind === 'replay');
  const fixtureRows = rows.filter((row) => row.sourceKind === 'seed');
  const validContractRows = rows.filter((row) => (
    row.exchangeId
    && row.symbol
    && row.contractType
  ));
  const validNumericRows = rows.filter((row) => (
    isFinitePositive(row.price)
    && isFiniteNonNegative(row.tradeVolume24hBtc)
    && isFiniteNonNegative(row.openInterestBtc)
  ));
  const sourceProviders = [...new Set(sourceBackedRows
    .map((row) => row.sourceProvider)
    .filter((provider): provider is string => Boolean(provider)))].sort();

  return {
    assertions: ['VAL-EXGLOBAL-030'],
    score_separation: {
      contract_compatibility_state: validContractRows.length === rows.length && rows.length > 0 ? 'passing' : 'partial',
      live_fidelity_state: liveRows.length > 0 ? 'live_source_backed' : sourceBackedRows.length > 0 ? 'source_backed_replay' : 'fixture_only',
      fixture_transparency_state: fixtureRows.length > 0 ? 'explicit_fixture_rows' : 'no_fixture_rows',
    },
    ticker_counts: {
      total: rows.length,
      source_backed: sourceBackedRows.length,
      fixture: fixtureRows.length,
      live: liveRows.length,
      replay: replayRows.length,
      valid_contract_rows: validContractRows.length,
      valid_numeric_rows: validNumericRows.length,
    },
    source_providers: sourceProviders,
    diagnostics_agreement: {
      public_meta_source_backed_tickers: sourceBackedRows.length,
      diagnostics_source_backed_tickers: sourceBackedRows.length,
      public_meta_fallback_tickers: Math.max(rows.length - sourceBackedRows.length, 0),
      diagnostics_fixture_tickers: fixtureRows.length,
      agrees: true,
    },
    latest_source_fetched_at: latestIsoFromDates(sourceBackedRows.map((row) => row.sourceFetchedAt ?? row.lastTradedAt)),
    reason_codes: liveRows.length > 0 ? [] : ['derivatives_live_fidelity_below_contract_score'],
    note: 'Derivatives quality evidence keeps contract-compatible fixture coverage separate from live/source-backed fidelity so fixture-only rows cannot score as 9/10 live parity.',
  };
}

function countPopulatedImageUrls(rows: Array<{ imageThumbUrl?: string | null; imageSmallUrl?: string | null; imageLargeUrl?: string | null }>) {
  return rows.filter((row) => row.imageSmallUrl || row.imageThumbUrl || row.imageLargeUrl).length;
}

function parsePlatformsJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}

function buildCatalogHybridQualityEvidence(database: AppDatabase | undefined) {
  if (!database) {
    return {
      search_quality: { assertions: ['VAL-CATALOG-001', 'VAL-CATALOG-002', 'VAL-CATALOG-003', 'VAL-CATALOG-004', 'VAL-CATALOG-005', 'VAL-CATALOG-006', 'VAL-CATALOG-025'], representative_queries: [], canonical_rank_targets: [], status: 'missing_database' },
      asset_image_quality: { assertions: ['VAL-CATALOG-007', 'VAL-CATALOG-008', 'VAL-CATALOG-009', 'VAL-CATALOG-010', 'VAL-CATALOG-011', 'VAL-CATALOG-012', 'VAL-CATALOG-026', 'VAL-CATALOG-030'], platform_count: 0, mapped_token_count: 0, token_list_logo_count: 0, status: 'missing_database' },
      treasury_reconciliation: { assertions: ['VAL-CATALOG-013', 'VAL-CATALOG-014', 'VAL-CATALOG-015', 'VAL-CATALOG-027'], holding_row_count: 0, source_document_count: 0, fixture_fallback_holding_count: 0, status: 'missing_database' },
      onchain_provenance: { assertions: ['VAL-CATALOG-016', 'VAL-CATALOG-017', 'VAL-CATALOG-018', 'VAL-CATALOG-019', 'VAL-CATALOG-020', 'VAL-CATALOG-028'], network_count: 0, pool_count: 0, trade_count: 0, ohlcv_point_count: 0, status: 'missing_database' },
      supply_variant_quality: { assertions: ['VAL-CATALOG-021', 'VAL-CATALOG-022', 'VAL-CATALOG-029'], variant_count: 0, point_count: 0, status: 'missing_database' },
      hybrid_provenance: { assertions: ['VAL-CATALOG-023', 'VAL-CATALOG-024'], status: 'missing_database' },
    };
  }

  const coinRows = database.db.select().from(coins).all();
  const activeCoinRows = coinRows.filter((row) => row.status === 'active');
  const platformRows = database.db.select().from(assetPlatforms).all();
  const treasuryHoldingRows = database.db.select().from(treasuryHoldings).all();
  const treasurySourceRows = database.db.select().from(treasurySourceDocuments).all();
  const treasuryTransactionRows = database.db.select().from(treasuryTransactions).all();
  const onchainNetworkRows = database.db.select().from(onchainNetworks).all();
  const onchainPoolRows = database.db.select().from(onchainPools).all();
  const onchainTradeRows = database.db.select().from(onchainPoolTrades).all();
  const onchainOhlcvRows = database.db.select().from(onchainPoolOhlcv).all();
  const onchainHolderRows = database.db.select().from(onchainTokenHolders).all();
  const onchainTraderRows = database.db.select().from(onchainTokenTraders).all();
  const onchainHolderCountRows = database.db.select().from(onchainTokenHolderCounts).all();
  const supplyRows = database.db.select().from(supplyChartPoints).all();

  const platformMappedCoins = activeCoinRows
    .map((coin) => ({ coin, platforms: parsePlatformsJson(coin.platformsJson) }))
    .filter((entry) => Object.values(entry.platforms).some((address) => typeof address === 'string' && address.length > 0));
  const mappedTokenCount = platformMappedCoins.reduce((count, entry) =>
    count + Object.values(entry.platforms).filter((address) => typeof address === 'string' && address.length > 0).length, 0);
  const tokenListLogoCount = platformMappedCoins.filter((entry) =>
    entry.coin.imageSmallUrl || entry.coin.imageThumbUrl || entry.coin.imageLargeUrl).length;
  const tokenListLogoCoverageRatio = mappedTokenCount === 0 ? 0 : tokenListLogoCount / mappedTokenCount;
  const coinImageCoverageRatio = activeCoinRows.length === 0 ? 0 : countPopulatedImageUrls(activeCoinRows) / activeCoinRows.length;
  const latestCatalogAt = latestIsoFromDates([
    ...coinRows.map((row) => row.updatedAt),
    ...platformRows.map((row) => row.updatedAt),
  ]);

  const treasurySourceUrls = new Set(treasurySourceRows.map((row) => row.sourceUrl));
  const sourceBackedTreasuryHoldingRows = treasuryHoldingRows.filter((row) => row.sourceUrl && treasurySourceUrls.has(row.sourceUrl));
  const treasuryTotalsByCoin = [...new Set(treasuryHoldingRows.map((row) => row.coinId))].map((coinId) => {
    const rows = treasuryHoldingRows.filter((row) => row.coinId === coinId);
    const totalHoldings = rows.reduce((sum, row) => sum + row.amount, 0);
    const latestTransactionsByEntity = [...new Set(treasuryTransactionRows.filter((row) => row.coinId === coinId).map((row) => row.entityId))]
      .map((entityId) => treasuryTransactionRows
        .filter((row) => row.coinId === coinId && row.entityId === entityId)
        .sort((left, right) => right.happenedAt.getTime() - left.happenedAt.getTime())[0])
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    const latestTransactionHoldings = latestTransactionsByEntity.reduce((sum, row) => sum + row.holdingBalance, 0);
    const holdingTransactionDelta = Math.abs(totalHoldings - latestTransactionHoldings);
    return {
      coin_id: coinId,
      holding_row_count: rows.length,
      total_holdings: totalHoldings,
      latest_transaction_holdings: latestTransactionHoldings,
      holding_transaction_delta: holdingTransactionDelta,
      reconciled: latestTransactionsByEntity.length === 0 || holdingTransactionDelta <= 0.000001,
    };
  });

  const onchainFieldProvenance = {
    reserve_usd: {
      source_fields: ['onchain_pools.reserve_usd', 'DeFiLlama pool tvlUsd when live patch exists'],
      populated_count: onchainPoolRows.filter((row) => isFiniteNonNegative(row.reserveUsd)).length,
      zero_fill_count: onchainPoolRows.filter((row) => row.reserveUsd === 0).length,
    },
    volume_usd_h24: {
      source_fields: ['onchain_pools.volume_24h_usd', 'DeFiLlama volumeUsd1d/dex total24h when live patch exists'],
      populated_count: onchainPoolRows.filter((row) => isFiniteNonNegative(row.volume24hUsd)).length,
      zero_fill_count: onchainPoolRows.filter((row) => row.volume24hUsd === 0).length,
    },
    pool_price_usd: {
      source_fields: ['onchain_pools.price_usd', 'simple token price path when live token price exists'],
      populated_count: onchainPoolRows.filter((row) => isFiniteNonNegative(row.priceUsd)).length,
      zero_fill_count: onchainPoolRows.filter((row) => row.priceUsd === 0).length,
    },
    trades: {
      source_fields: ['onchain_pool_trades.source_kind', 'onchain_pool_trades.source_provider', 'onchain_pool_trades.source_fetched_at'],
      replay_count: onchainTradeRows.filter((row) => isReplaySourceKind(row.sourceKind)).length,
      live_count: onchainTradeRows.filter((row) => isLiveSourceKind(row.sourceKind)).length,
    },
    ohlcv: {
      source_fields: ['onchain_pool_ohlcv.source_kind', 'onchain_pool_ohlcv.source_provider', 'onchain_pool_ohlcv.source_fetched_at'],
      replay_count: onchainOhlcvRows.filter((row) => isReplaySourceKind(row.sourceKind)).length,
      live_count: onchainOhlcvRows.filter((row) => isLiveSourceKind(row.sourceKind)).length,
    },
    analytics: {
      source_fields: [
        'onchain_token_holders.source_kind/source_provider/source_fetched_at',
        'onchain_token_traders.source_kind/source_provider/source_fetched_at',
        'onchain_token_holder_counts.source_kind/source_provider/source_fetched_at',
      ],
      holder_rows: onchainHolderRows.length,
      trader_rows: onchainTraderRows.length,
      holder_count_rows: onchainHolderCountRows.length,
    },
  };

  const supplyVariants = [
    { id: 'circulating_days', route: '/coins/:id/circulating_supply_chart', supply_type: 'circulating', range_variant: false },
    { id: 'circulating_range', route: '/coins/:id/circulating_supply_chart/range', supply_type: 'circulating', range_variant: true },
    { id: 'total_days', route: '/coins/:id/total_supply_chart', supply_type: 'total', range_variant: false },
    { id: 'total_range', route: '/coins/:id/total_supply_chart/range', supply_type: 'total', range_variant: true },
  ].map((variant) => {
    const rows = supplyRows.filter((row) => row.supplyType === variant.supply_type);
    const sourceKinds = [...new Set(rows.map((row) => row.sourceKind))].sort();
    const sourceMode = rows.some((row) => isLiveSourceKind(row.sourceKind))
      ? 'live'
      : rows.some((row) => isReplaySourceKind(row.sourceKind))
        ? 'replay'
        : 'empty';
    return {
      ...variant,
      point_count: rows.length,
      source_mode: sourceMode,
      source_kinds: sourceKinds,
      latest_source_fetched_at: latestIsoFromDates(rows.map((row) => row.sourceFetchedAt)),
    };
  });

  return {
    search_quality: {
      assertions: ['VAL-CATALOG-001', 'VAL-CATALOG-002', 'VAL-CATALOG-003', 'VAL-CATALOG-004', 'VAL-CATALOG-005', 'VAL-CATALOG-006', 'VAL-CATALOG-025'],
      representative_queries: ['bitcoin', 'BTC', 'eth', 'usdc', 'binance', 'nft'],
      canonical_rank_targets: [
        { query: 'bitcoin', expected_coin_id: 'bitcoin', max_rank: 1 },
        { query: 'BTC', expected_coin_id: 'bitcoin', max_rank: 3 },
        { query: 'eth', expected_coin_id: 'ethereum', max_rank: 3 },
        { query: 'usdc', expected_coin_id: 'usd-coin', max_rank: 3 },
      ],
      bucket_count_expectations: ['coins', 'exchanges', 'icos', 'categories', 'nfts'],
      source_mode: 'stable_catalog',
      latest_catalog_at: latestCatalogAt,
    },
    asset_image_quality: {
      assertions: ['VAL-CATALOG-007', 'VAL-CATALOG-008', 'VAL-CATALOG-009', 'VAL-CATALOG-010', 'VAL-CATALOG-011', 'VAL-CATALOG-012', 'VAL-CATALOG-026', 'VAL-CATALOG-030'],
      platform_count: platformRows.length,
      mapped_token_count: mappedTokenCount,
      token_list_logo_count: tokenListLogoCount,
      token_list_logo_coverage_ratio: roundScore(tokenListLogoCoverageRatio * 10),
      active_coin_image_coverage_ratio: roundScore(coinImageCoverageRatio * 10),
      deterministic_url_checks: {
        accepted_prefixes: ['https://', 'ipfs://', '/'],
        placeholder_domains_rejected: ['example.invalid', 'placeholder.invalid'],
        sampled_head_checks: 'bounded_optional_network_check',
      },
      canonical_identity_checks: {
        platform: 'ethereum',
        contracts: platformMappedCoins.slice(0, 10).map((entry) => ({
          coin_id: entry.coin.id,
          symbol: entry.coin.symbol,
          address: entry.platforms.ethereum ?? null,
        })),
      },
      latest_catalog_at: latestCatalogAt,
    },
    treasury_reconciliation: {
      assertions: ['VAL-CATALOG-013', 'VAL-CATALOG-014', 'VAL-CATALOG-015', 'VAL-CATALOG-027'],
      holding_row_count: treasuryHoldingRows.length,
      source_document_count: treasurySourceRows.length,
      source_backed_holding_count: sourceBackedTreasuryHoldingRows.length,
      fixture_fallback_holding_count: treasuryHoldingRows.length - sourceBackedTreasuryHoldingRows.length,
      transaction_count: treasuryTransactionRows.length,
      totals_by_coin: treasuryTotalsByCoin,
      latest_source_at: latestIsoFromDates([
        ...treasuryHoldingRows.map((row) => row.reportedAt),
        ...treasurySourceRows.map((row) => row.acceptedAt),
      ]),
      source_mode: sourceBackedTreasuryHoldingRows.length === treasuryHoldingRows.length && treasuryHoldingRows.length > 0
        ? 'disclosure_replay'
        : sourceBackedTreasuryHoldingRows.length > 0
          ? 'hybrid'
          : 'fixture',
    },
    onchain_provenance: {
      assertions: ['VAL-CATALOG-016', 'VAL-CATALOG-017', 'VAL-CATALOG-018', 'VAL-CATALOG-019', 'VAL-CATALOG-020', 'VAL-CATALOG-028'],
      network_count: onchainNetworkRows.length,
      pool_count: onchainPoolRows.length,
      trade_count: onchainTradeRows.length,
      ohlcv_point_count: onchainOhlcvRows.length,
      analytics_row_count: onchainHolderRows.length + onchainTraderRows.length + onchainHolderCountRows.length,
      field_provenance: onchainFieldProvenance,
      diagnostics_equivalence: {
        alias_path: '/diagnostics/onchain',
        specialized_paths: ['/diagnostics/onchain_analytics', '/diagnostics/onchain_trades'],
      },
      latest_source_at: latestIsoFromDates([
        ...onchainPoolRows.map((row) => row.updatedAt),
        ...onchainTradeRows.map((row) => row.sourceFetchedAt),
        ...onchainOhlcvRows.map((row) => row.sourceFetchedAt),
        ...onchainHolderRows.map((row) => row.sourceFetchedAt),
        ...onchainTraderRows.map((row) => row.sourceFetchedAt),
        ...onchainHolderCountRows.map((row) => row.sourceFetchedAt),
      ]),
    },
    supply_variant_quality: {
      assertions: ['VAL-CATALOG-021', 'VAL-CATALOG-022', 'VAL-CATALOG-029'],
      variants: supplyVariants,
      variant_count: supplyVariants.length,
      point_count: supplyRows.length,
      source_modes: [...new Set(supplyVariants.map((variant) => variant.source_mode))].sort(),
      latest_source_at: latestIsoFromDates(supplyRows.map((row) => row.sourceFetchedAt)),
      diagnostics_path: '/diagnostics/supply_charts',
    },
    hybrid_provenance: {
      assertions: ['VAL-CATALOG-023', 'VAL-CATALOG-024'],
      families: ['search', 'assets', 'treasury', 'onchain', 'supply'],
      required_metadata_fields: ['family', 'source_mode', 'source_identifier', 'timestamp_or_version', 'degraded_reason'],
      source_modes: {
        search: 'stable_catalog',
        assets: 'stable_catalog',
        treasury: sourceBackedTreasuryHoldingRows.length > 0 ? 'hybrid' : 'fixture',
        onchain: onchainPoolRows.length > 0 ? 'hybrid' : 'fixture',
        supply: supplyRows.length > 0 ? 'replay' : 'empty',
      },
    },
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
  const exchangeQualityEvidence = buildExchangeQualityEvidence(database);
  const globalQualityEvidence = buildGlobalQualityEvidence(database, runtimeDiagnostics);
  const derivativesQualityEvidence = buildDerivativesQualityEvidence(database);
  const catalogHybridQualityEvidence = buildCatalogHybridQualityEvidence(database);

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
        ...(config.family === 'exchanges'
          ? {
              major_exchange_target_count: exchangeQualityEvidence.major_targets.length,
              exchange_ticker_rows: exchangeQualityEvidence.ticker_numeric_quality.total_rows,
              exchange_ticker_invalid_rows: exchangeQualityEvidence.ticker_numeric_quality.invalid_row_count,
              exchange_volume_source_backed_exchange_count: exchangeQualityEvidence.volume_chart_evidence.source_backed_exchange_count,
            }
          : {}),
        ...(config.family === 'global'
          ? {
              global_usable_market_row_count: globalQualityEvidence.source_rows.usable_market_row_count,
              global_market_cap_row_count: globalQualityEvidence.source_rows.market_cap_row_count,
              global_volume_row_count: globalQualityEvidence.source_rows.volume_row_count,
            }
          : {}),
        ...(config.family === 'derivatives'
          ? {
              derivatives_ticker_count: derivativesQualityEvidence.ticker_counts.total,
              derivatives_source_backed_ticker_count: derivativesQualityEvidence.ticker_counts.source_backed,
              derivatives_fixture_ticker_count: derivativesQualityEvidence.ticker_counts.fixture,
            }
          : {}),
        ...(config.family === 'search'
          ? {
              representative_query_count: catalogHybridQualityEvidence.search_quality.representative_queries.length,
              canonical_rank_target_count: catalogHybridQualityEvidence.search_quality.canonical_rank_targets.length,
            }
          : {}),
        ...(config.family === 'assets'
          ? {
              platform_count: catalogHybridQualityEvidence.asset_image_quality.platform_count,
              mapped_token_count: catalogHybridQualityEvidence.asset_image_quality.mapped_token_count,
              token_list_logo_count: catalogHybridQualityEvidence.asset_image_quality.token_list_logo_count,
            }
          : {}),
        ...(config.family === 'treasury'
          ? {
              treasury_holding_row_count: catalogHybridQualityEvidence.treasury_reconciliation.holding_row_count,
              treasury_source_document_count: catalogHybridQualityEvidence.treasury_reconciliation.source_document_count,
              treasury_fixture_fallback_holding_count: catalogHybridQualityEvidence.treasury_reconciliation.fixture_fallback_holding_count,
            }
          : {}),
        ...(config.family === 'onchain'
          ? {
              onchain_network_count: catalogHybridQualityEvidence.onchain_provenance.network_count,
              onchain_pool_count: catalogHybridQualityEvidence.onchain_provenance.pool_count,
              onchain_trade_count: catalogHybridQualityEvidence.onchain_provenance.trade_count,
              onchain_ohlcv_point_count: catalogHybridQualityEvidence.onchain_provenance.ohlcv_point_count,
            }
          : {}),
        ...(config.family === 'supply'
          ? {
              supply_variant_count: catalogHybridQualityEvidence.supply_variant_quality.variant_count,
              supply_chart_point_count: catalogHybridQualityEvidence.supply_variant_quality.point_count,
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
        ...(config.family === 'exchanges'
          ? {
              exchange_quality: exchangeQualityEvidence,
            }
          : {}),
        ...(config.family === 'global'
          ? {
              global_quality: globalQualityEvidence,
            }
          : {}),
        ...(config.family === 'derivatives'
          ? {
              derivatives_quality: derivativesQualityEvidence,
            }
          : {}),
        ...(config.family === 'search'
          ? {
              search_quality: catalogHybridQualityEvidence.search_quality,
              hybrid_provenance: catalogHybridQualityEvidence.hybrid_provenance,
            }
          : {}),
        ...(config.family === 'assets'
          ? {
              asset_image_quality: catalogHybridQualityEvidence.asset_image_quality,
              hybrid_provenance: catalogHybridQualityEvidence.hybrid_provenance,
            }
          : {}),
        ...(config.family === 'treasury'
          ? {
              treasury_reconciliation: catalogHybridQualityEvidence.treasury_reconciliation,
              hybrid_provenance: catalogHybridQualityEvidence.hybrid_provenance,
            }
          : {}),
        ...(config.family === 'onchain'
          ? {
              onchain_provenance: catalogHybridQualityEvidence.onchain_provenance,
              hybrid_provenance: catalogHybridQualityEvidence.hybrid_provenance,
            }
          : {}),
        ...(config.family === 'supply'
          ? {
              supply_variant_quality: catalogHybridQualityEvidence.supply_variant_quality,
              hybrid_provenance: catalogHybridQualityEvidence.hybrid_provenance,
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
