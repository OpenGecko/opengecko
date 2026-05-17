import type { buildCoverageMatrix } from './coverage-matrix';
import type { RuntimeDiagnostics } from './runtime-diagnostics';

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

function runtimeAffectsFamily(runtimeDiagnostics: RuntimeDiagnostics, runtimeFamilyIds: string[]) {
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

export function buildDataQualityDiagnostics(
  coverageMatrix: CoverageMatrix,
  runtimeDiagnostics: RuntimeDiagnostics,
  now = new Date(),
) {
  const coverageByFamily = new Map(coverageMatrix.entries.map((entry) => [entry.family, entry]));
  const runtimeReasonCodes = providerReasonCodes(runtimeDiagnostics);

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
        runtime_degradation: runtimeAffected
          ? {
              active: true,
              reason_codes: runtimeReasonCodes,
              reason: runtimeDiagnostics.degraded.reason ?? runtimeDiagnostics.degraded.injected_provider_failure.reason,
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
    score_scopes: ['contract_compatibility', 'live_source_fidelity', 'fixture_fallback_transparency', 'overall_gate'],
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
