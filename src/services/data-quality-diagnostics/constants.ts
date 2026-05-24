
import type { QualityFamilyConfig } from './types';

export const TARGET_THRESHOLD = 9;
export const MARKET_TOP_N_DENOMINATOR = 100;
export const GLOBAL_AGGREGATE_TOLERANCE_RATIO = 0.000001;
export const MAJOR_EXCHANGE_TARGETS = [
  { target_id: 'binance', aliases: ['binance'] },
  { target_id: 'coinbase', aliases: ['coinbase', 'gdax'] },
  { target_id: 'kraken', aliases: ['kraken'] },
  { target_id: 'okx', aliases: ['okx', 'okex'] },
  { target_id: 'bybit', aliases: ['bybit', 'bybit_spot'] },
];

export const FAMILY_CONFIGS: QualityFamilyConfig[] = [
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

export const INJECTED_PROVIDER_FAILURE_RUNTIME_FAMILY_IDS = new Set([
  'simple',
  'coins_markets',
  'coin_detail',
  'exchanges',
  'historical_charts',
]);
