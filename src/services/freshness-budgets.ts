export type EndpointFreshnessBudget = {
  family: string;
  representative_routes: string[];
  target_freshness_seconds: number | null;
  degraded_after_seconds: number | null;
  budget_basis: 'latest_market_snapshot' | 'provider_refresh' | 'route_interval' | 'fixture_or_seeded';
  notes: string;
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
