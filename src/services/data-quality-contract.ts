export const QUALITY_STATUS_VALUES = ['pass', 'degraded', 'fail', 'out_of_scope'] as const;

export type QualityStatus = typeof QUALITY_STATUS_VALUES[number];

export const DATA_SOURCE_STATE_VALUES = [
  'live',
  'hybrid',
  'seeded',
  'fixture',
  'replay',
  'synthetic',
  'fallback',
  'degraded',
  'stale',
  'unavailable',
  'out_of_scope',
] as const;

export type SourceState = typeof DATA_SOURCE_STATE_VALUES[number];

export const NON_LIVE_DATA_SOURCE_STATES = DATA_SOURCE_STATE_VALUES.filter(
  (state) => state !== 'live',
) as Exclude<SourceState, 'live'>[];

export const COVERAGE_OWNERSHIP_CLASS_VALUES = [
  'live',
  'hybrid',
  'seeded',
  'synthetic',
  'fixture',
  'unavailable',
] as const;

export type CoverageOwnershipClass = typeof COVERAGE_OWNERSHIP_CLASS_VALUES[number];

export const COVERAGE_FRESHNESS_STATE_VALUES = [
  'fresh',
  'degraded',
  'stale',
  'unbudgeted',
  'unknown',
] as const;

export const QUALITY_DIMENSION_ID_VALUES = [
  'contract_compatibility',
  'freshness_liveness',
  'completeness_coverage',
  'live_source_fidelity',
  'fixture_fallback_transparency',
  'metadata_truthfulness',
] as const;

export type QualityDimensionId = typeof QUALITY_DIMENSION_ID_VALUES[number];

export const QUALITY_REASON_CODE_VALUES = [
  'below_target_threshold',
  'blocked_provider_counted_as_live',
  'degraded_only',
  'derivatives_live_fidelity_below_contract_score',
  'fallback_only',
  'fixture_only',
  'fixture_source',
  'hybrid_only',
  'missing_contract_evidence',
  'missing_coverage_entry',
  'missing_database',
  'missing_exchange_volume_chart_source',
  'missing_freshness_budget',
  'out_of_scope_only',
  'partial_coverage',
  'provider_blocked',
  'provider_degraded',
  'provider_error',
  'regional_block',
  'replay_only',
  'required_family_below_threshold',
  'runtime_degraded',
  'seeded_only',
  'seeded_source',
  'source_unavailable',
  'sparse_market_rows_or_aggregate_mismatch',
  'stale_only',
  'stale_source',
  'synthetic_only',
  'synthetic_source',
  'unavailable_only',
  'unbudgeted_source',
  'unknown_freshness',
] as const;
