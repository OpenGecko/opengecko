export type EndpointFreshnessBudget = {
  family: string;
  representative_routes: string[];
  target_freshness_seconds: number | null;
  degraded_after_seconds: number | null;
  budget_basis: 'latest_market_snapshot' | 'provider_refresh' | 'route_interval' | 'fixture_or_seeded';
  notes: string;
};

type CoverageEntry = {
  family: string;
  representative_routes: string[];
  ownership_class: string;
  providers: string[];
  last_successful_refresh_at: string | null;
  freshness: {
    target_freshness_seconds: number | null;
    degraded_after_seconds: number | null;
    current_age_seconds: number | null;
    state: 'fresh' | 'degraded' | 'stale' | 'unbudgeted' | 'unknown';
  };
  data_fidelity: {
    source_state: string;
    counts_as_live: boolean;
    non_live: boolean;
    reason_codes: string[];
  };
};

type CoverageMatrixLike = {
  generated_at: string;
  entries: CoverageEntry[];
};

export type FreshnessBudgetRecord = EndpointFreshnessBudget & {
  last_success_at: string | null;
  last_successful_refresh_at: string | null;
  current_age_seconds: number | null;
  age_seconds: number | null;
  budget_seconds: number | null;
  budget: {
    target_freshness_seconds: number | null;
    degraded_after_seconds: number | null;
    basis: EndpointFreshnessBudget['budget_basis'];
  };
  status: CoverageEntry['freshness']['state'];
  reason: string;
  reason_codes: string[];
  source_state: string;
  ownership_class: string;
  counts_as_live_evidence: boolean;
  counts_as_live_freshness_evidence: boolean;
  non_live_evidence: boolean;
  provider_ids: string[];
  provider_count: number;
};

const ENDPOINT_FRESHNESS_BUDGETS: EndpointFreshnessBudget[] = [
  {
    family: 'simple',
    representative_routes: ['/simple/price', '/simple/token_price/:id'],
    target_freshness_seconds: 30,
    degraded_after_seconds: 120,
    budget_basis: 'latest_market_snapshot',
    notes: 'Hot price routes should follow market snapshot revision and avoid long response TTLs.',
  },
  {
    family: 'coins_markets',
    representative_routes: ['/coins/markets'],
    target_freshness_seconds: 60,
    degraded_after_seconds: 300,
    budget_basis: 'latest_market_snapshot',
    notes: 'High-volume market lists can tolerate slightly older snapshots than simple price.',
  },
  {
    family: 'coin_detail',
    representative_routes: ['/coins/:id', '/coins/:id/tickers'],
    target_freshness_seconds: 300,
    degraded_after_seconds: 900,
    budget_basis: 'latest_market_snapshot',
    notes: 'Metadata may be older than market fields; market_data should follow live snapshot freshness.',
  },
  {
    family: 'exchanges',
    representative_routes: ['/exchanges', '/exchanges/:id', '/exchanges/:id/tickers'],
    target_freshness_seconds: 900,
    degraded_after_seconds: 3_600,
    budget_basis: 'provider_refresh',
    notes: 'Exchange volume and ticker surfaces depend on successful exchange refresh coverage.',
  },
  {
    family: 'onchain',
    representative_routes: ['/onchain/networks/:network/pools', '/onchain/networks/:network/pools/:address'],
    target_freshness_seconds: 120,
    degraded_after_seconds: 600,
    budget_basis: 'provider_refresh',
    notes: 'Fixture-backed onchain surfaces should remain marked until live provider replay evidence exists.',
  },
  {
    family: 'derivatives',
    representative_routes: ['/derivatives', '/derivatives/exchanges', '/derivatives/exchanges/:id'],
    target_freshness_seconds: 120,
    degraded_after_seconds: 600,
    budget_basis: 'provider_refresh',
    notes: 'Derivative budgets apply after live futures/swap ingestion replaces fixture rows.',
  },
  {
    family: 'historical_charts',
    representative_routes: ['/coins/:id/market_chart', '/coins/:id/ohlc', '/global/market_cap_chart'],
    target_freshness_seconds: null,
    degraded_after_seconds: null,
    budget_basis: 'route_interval',
    notes: 'Historical chart quality is judged by interval continuity, retention, and gap repair rather than latest tick age.',
  },
  {
    family: 'supply_charts',
    representative_routes: ['/coins/:id/circulating_supply_chart', '/coins/:id/total_supply_chart'],
    target_freshness_seconds: 86_400,
    degraded_after_seconds: 604_800,
    budget_basis: 'provider_refresh',
    notes: 'Supply chart routes should surface replay/live source age without treating fixture fallbacks as live freshness.',
  },
  {
    family: 'treasury',
    representative_routes: ['/companies/public_treasury/:coin_id', '/public_treasury/:entity_id'],
    target_freshness_seconds: 86_400,
    degraded_after_seconds: 604_800,
    budget_basis: 'fixture_or_seeded',
    notes: 'Treasury disclosure data may update slowly, but seeded or replay disclosures must remain explicitly non-live.',
  },
  {
    family: 'stable_catalog',
    representative_routes: ['/coins/list', '/asset_platforms', '/exchanges/list'],
    target_freshness_seconds: 3_600,
    degraded_after_seconds: 86_400,
    budget_basis: 'fixture_or_seeded',
    notes: 'Stable catalogs are safe for longer HTTP caching but still need docs honesty when seeded.',
  },
];

export function getEndpointFreshnessBudgets() {
  return ENDPOINT_FRESHNESS_BUDGETS.map((budget) => ({
    ...budget,
    representative_routes: [...budget.representative_routes],
  }));
}

export function getEndpointFreshnessBudget(family: string) {
  return getEndpointFreshnessBudgets().find((budget) => budget.family === family) ?? null;
}

function freshnessStatusReason(status: FreshnessBudgetRecord['status']) {
  switch (status) {
    case 'fresh':
      return 'within_budget';
    case 'degraded':
      return 'freshness_degraded';
    case 'stale':
      return 'freshness_stale';
    case 'unbudgeted':
      return 'unbudgeted_source';
    case 'unknown':
    default:
      return 'missing_last_success';
  }
}

function freshnessReasonsForEntry(entry: CoverageEntry | undefined, status: FreshnessBudgetRecord['status'], countsAsLiveEvidence: boolean) {
  if (!entry) {
    return ['missing_coverage_entry'];
  }

  const statusReason = freshnessStatusReason(status);
  if (status === 'degraded' || status === 'stale' || status === 'unknown') {
    return [
      statusReason,
      ...(!countsAsLiveEvidence ? [entry.data_fidelity.reason_codes[0] ?? `${entry.data_fidelity.source_state}_only`] : []),
    ];
  }

  if (!countsAsLiveEvidence) {
    return [entry.data_fidelity.reason_codes[0] ?? `${entry.data_fidelity.source_state}_only`];
  }

  return [statusReason];
}

export function buildFreshnessBudgetRecord(
  entry: CoverageEntry | undefined,
  fallbackFamily?: string,
): FreshnessBudgetRecord {
  const family = entry?.family ?? fallbackFamily ?? 'unknown';
  const staticBudget = getEndpointFreshnessBudget(family) ?? {
    family,
    representative_routes: entry?.representative_routes ?? [],
    target_freshness_seconds: null,
    degraded_after_seconds: null,
    budget_basis: 'route_interval' as const,
    notes: 'No configured freshness budget was found for this family.',
  };
  const status = entry?.freshness.state ?? 'unknown';
  const countsAsLiveEvidence = entry?.data_fidelity.counts_as_live ?? false;
  const currentAgeSeconds = entry?.freshness.current_age_seconds ?? null;
  const reasonCodes = freshnessReasonsForEntry(entry, status, countsAsLiveEvidence);
  const reason = reasonCodes[0] ?? 'missing_coverage_entry';

  return {
    ...staticBudget,
    representative_routes: [...staticBudget.representative_routes],
    last_success_at: entry?.last_successful_refresh_at ?? null,
    last_successful_refresh_at: entry?.last_successful_refresh_at ?? null,
    current_age_seconds: currentAgeSeconds,
    age_seconds: currentAgeSeconds,
    budget_seconds: staticBudget.target_freshness_seconds,
    budget: {
      target_freshness_seconds: staticBudget.target_freshness_seconds,
      degraded_after_seconds: staticBudget.degraded_after_seconds,
      basis: staticBudget.budget_basis,
    },
    status,
    reason,
    reason_codes: reasonCodes,
    source_state: entry?.data_fidelity.source_state ?? 'unavailable',
    ownership_class: entry?.ownership_class ?? 'unavailable',
    counts_as_live_evidence: countsAsLiveEvidence,
    counts_as_live_freshness_evidence: countsAsLiveEvidence && status === 'fresh',
    non_live_evidence: !countsAsLiveEvidence,
    provider_ids: entry?.providers ?? [],
    provider_count: entry?.providers.length ?? 0,
  };
}

export function buildFreshnessBudgetDiagnostics(coverageMatrix: CoverageMatrixLike) {
  const entriesByFamily = new Map(coverageMatrix.entries.map((entry) => [entry.family, entry]));

  return {
    schema_version: 1,
    generated_at: coverageMatrix.generated_at,
    live_data_rules: {
      only_live_source_state_counts_as_live_evidence: true,
      non_live_states_do_not_count_as_live_freshness_evidence: true,
      stale_live_data_is_not_fresh_live_evidence: true,
    },
    budgets: getEndpointFreshnessBudgets().map((budget) => buildFreshnessBudgetRecord(
      entriesByFamily.get(budget.family),
      budget.family,
    )),
  };
}
