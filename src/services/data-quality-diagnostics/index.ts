
import type { AppDatabase } from '../../db/client';
import type { RuntimeDiagnostics } from '../runtime-diagnostics';
import {
  COVERAGE_FRESHNESS_STATE_VALUES,
  COVERAGE_OWNERSHIP_CLASS_VALUES,
  DATA_SOURCE_STATE_VALUES,
  NON_LIVE_DATA_SOURCE_STATES,
  QUALITY_DIMENSION_ID_VALUES,
  QUALITY_REASON_CODE_VALUES,
  QUALITY_STATUS_VALUES,
  type QualityDimensionId,
  type SourceState,
} from '../data-quality-contract';
import { buildFreshnessBudgetRecord } from '../freshness-budgets';
import { buildCatalogHybridQualityEvidence } from './catalog-hybrid';
import { FAMILY_CONFIGS, TARGET_THRESHOLD } from './constants';
import { buildDerivativesQualityEvidence } from './derivatives';
import { buildExchangeQualityEvidence } from './exchanges';
import { buildGlobalQualityEvidence } from './global';
import { buildMarketQualityEvidence } from './market';
import { providerReasonCodes, runtimeAffectsFamily } from './runtime';
import { buildDimension, freshnessScore, roundScore, sourceScore, sourceStateForOwnership, statusForScore } from './scoring';
import type { CoverageMatrix, GlobalPublicRouteData } from './types';

export { TARGET_THRESHOLD, MARKET_TOP_N_DENOMINATOR, MAJOR_EXCHANGE_TARGETS } from './constants';
export type { CoverageMatrix, CoverageEntry, GlobalPublicRouteData, QualityDimension, QualityFamilyConfig } from './types';

export function buildDataQualityDiagnostics(
  coverageMatrix: CoverageMatrix,
  runtimeDiagnostics: RuntimeDiagnostics,
  now = new Date(),
  database?: AppDatabase,
  publicGlobalRouteData?: GlobalPublicRouteData,
) {
  const coverageByFamily = new Map(coverageMatrix.entries.map((entry) => [entry.family, entry]));
  const runtimeReasonCodes = providerReasonCodes(runtimeDiagnostics);
  const marketQualityEvidence = buildMarketQualityEvidence(database, runtimeDiagnostics);
  const exchangeQualityEvidence = buildExchangeQualityEvidence(database);
  const globalQualityEvidence = buildGlobalQualityEvidence(database, runtimeDiagnostics, publicGlobalRouteData);
  const derivativesQualityEvidence = buildDerivativesQualityEvidence(database);
  const catalogHybridQualityEvidence = buildCatalogHybridQualityEvidence(database);

  const families = FAMILY_CONFIGS.map((config) => {
    const coverageEntry = coverageByFamily.get(config.coverageFamily ?? config.family)
      ?? coverageByFamily.get(config.fallbackCoverageFamily ?? '');
    const sourceState = sourceStateForOwnership(coverageEntry?.ownership_class);
    const freshness = freshnessScore(coverageEntry, sourceState);
    const hasAlternateFreshLiveCoverage = sourceState === 'live'
      && coverageEntry?.freshness.state === 'fresh'
      && !runtimeDiagnostics.degraded.injected_provider_failure.active
      && runtimeDiagnostics.degraded.validation_override.mode === 'off';
    const runtimeAffected = runtimeAffectsFamily(runtimeDiagnostics, config.runtimeFamilyIds)
      && !hasAlternateFreshLiveCoverage;
    const effectiveSourceState = runtimeAffected && sourceState === 'live' ? 'degraded' as SourceState : sourceState;
    const freshnessBudget = buildFreshnessBudgetRecord(coverageEntry, config.coverageFamily ?? config.fallbackCoverageFamily ?? config.family);
    const effectiveFreshnessBudget = effectiveSourceState === sourceState
      ? freshnessBudget
      : {
          ...freshnessBudget,
          source_state: effectiveSourceState,
          counts_as_live_evidence: false,
          counts_as_live_freshness_evidence: false,
          non_live_evidence: true,
          reason: runtimeReasonCodes[0] ?? freshnessBudget.reason,
          reason_codes: runtimeReasonCodes.length > 0 ? runtimeReasonCodes : freshnessBudget.reason_codes,
        };
    const globalAggregateMismatchReasonCodes = config.family === 'global'
      ? globalQualityEvidence.reason_codes
      : [];
    const liveSourceScore = runtimeAffected ? Math.min(sourceScore(sourceState), 6) : sourceScore(sourceState);
    const sourceReasonCodes = sourceState === 'live'
      ? []
      : [sourceState === 'unavailable' ? 'source_unavailable' : `${sourceState}_only`];
    const completenessScore = coverageEntry
      ? Math.min(
          10,
          7
            + Math.min(config.representativeRoutes.length, 2)
            + (coverageEntry.evidence.tests.length > 0 ? 1 : 0),
        )
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
        globalAggregateMismatchReasonCodes.length > 0 ? 6 : coverageEntry ? 9.5 : 6,
        config.required,
        [
          ...(coverageEntry ? [] : ['missing_coverage_entry']),
          ...globalAggregateMismatchReasonCodes,
        ],
        config.family === 'global'
          ? 'Metadata truthfulness is anchored to the coverage matrix and public /global aggregate comparison evidence.'
          : 'Metadata truthfulness is anchored to the coverage matrix and provider/source evidence.',
      ),
    ];
    const gateDimensionIds = new Set<QualityDimensionId>([
      'contract_compatibility',
      'completeness_coverage',
      'fixture_fallback_transparency',
      'metadata_truthfulness',
    ]);
    const freshnessGateCap = config.required && coverageEntry?.freshness.state === 'stale'
      ? 5
      : config.required && coverageEntry?.freshness.state === 'degraded'
        ? 7
        : config.required && coverageEntry?.freshness.state === 'unknown'
          ? 4
          : 10;
    const score = roundScore(Math.min(
      freshnessGateCap,
      ...dimensions
        .filter((dimension) => gateDimensionIds.has(dimension.id))
        .map((dimension) => dimension.score),
    ));
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
        state: effectiveSourceState,
        ownership_class: coverageEntry?.ownership_class ?? 'unavailable',
        fallback: effectiveSourceState !== 'live',
        fallback_status: effectiveSourceState === 'live' ? 'none' : effectiveSourceState,
        latest_source_at: coverageEntry?.last_successful_refresh_at ?? null,
        freshness_state: coverageEntry?.freshness.state ?? 'unknown',
        freshness_budget: effectiveFreshnessBudget,
        provider_ids: coverageEntry?.providers ?? [],
        provider_count: coverageEntry?.providers.length ?? 0,
        evidence_family: coverageEntry?.family ?? null,
      },
      freshness_budget: effectiveFreshnessBudget,
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
  const gateReasonCodes = [
    ...new Set([
      ...(belowTargetFamilies.length === 0 ? [] : ['required_family_below_threshold']),
      ...belowTargetFamilies.flatMap((family) => family.reason_codes),
    ]),
  ].sort();

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
    classification_contract: {
      quality_statuses: [...QUALITY_STATUS_VALUES],
      dimension_ids: [...QUALITY_DIMENSION_ID_VALUES],
      source_states: [...DATA_SOURCE_STATE_VALUES],
      non_live_source_states: [...NON_LIVE_DATA_SOURCE_STATES],
      coverage_ownership_classes: [...COVERAGE_OWNERSHIP_CLASS_VALUES],
      coverage_freshness_states: [...COVERAGE_FRESHNESS_STATE_VALUES],
      reason_codes: [...QUALITY_REASON_CODE_VALUES],
      live_data_rules: {
        counts_as_live_state: 'live',
        required_source_ownership_class: 'live',
        non_live_states_do_not_count_as_live: true,
        fixture_seeded_replay_synthetic_fallback_stale_degraded_unavailable_out_of_scope_are_non_live: true,
      },
    },
    family_aliases: aliasMap,
    aliases,
    promoted_family_manifest: coverageMatrix.promoted_family_manifest,
    gate: {
      status: belowTargetFamilies.length === 0 ? 'pass' : 'fail',
      threshold: TARGET_THRESHOLD,
      required_family_count: families.filter((family) => family.required).length,
      below_target_count: belowTargetFamilies.length,
      below_target_families: belowTargetFamilies,
      reason_codes: gateReasonCodes,
    },
    families,
    stable_regression_fields: [
      'generated_at',
      'schema_version',
      'target_threshold',
      'classification_contract',
      'gate.status',
      'gate.below_target_families',
      'families[].family',
      'families[].score',
      'families[].status',
      'families[].score_scopes',
      'families[].source',
      'families[].freshness_budget',
      'families[].counts',
      'families[].reason_codes',
      'families[].failing_dimensions',
    ],
  };
}
