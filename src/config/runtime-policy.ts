export const DEFAULT_CCXT_EXCHANGES = [
  'binance',
  'bybit',
  'coinbase',
  'kraken',
  'okx',
  'gate',
  'mexc',
  'bitget',
  'bigone',
  'kucoin',
  'htx',
  'bitmart',
  'lbank',
  'whitebit',
  'coinex',
  'ascendex',
] as const;

export const DEFAULT_MARKET_FRESHNESS_THRESHOLD_SECONDS = 300;
export const DEFAULT_MARKET_REFRESH_INTERVAL_SECONDS = 60;
export const DEFAULT_CURRENCY_REFRESH_INTERVAL_SECONDS = 300;
export const DEFAULT_SEARCH_REBUILD_INTERVAL_SECONDS = 900;
export const DEFAULT_PROVIDER_FANOUT_CONCURRENCY = 2;
export const DEFAULT_OHLCV_TARGET_HISTORY_DAYS = 1825;
export const DEFAULT_OHLCV_RETENTION_DAYS = 1825;
export const DEFAULT_DEFILLAMA_POOL_SWEEP_INTERVAL_SECONDS = 300;
export const DEFAULT_DEFILLAMA_TOKEN_SWEEP_INTERVAL_SECONDS = 600;
export const DEFAULT_SUBSQUID_TRADE_SWEEP_INTERVAL_SECONDS = 60;
export const DEFAULT_COIN_CATALOG_RESCAN_INTERVAL_SECONDS = 3600;
export const DEFAULT_EXCHANGE_METADATA_RESCAN_INTERVAL_SECONDS = 21600;
export const DEFAULT_GLOBAL_AGGREGATOR_INTERVAL_SECONDS = 60;
export const DEFAULT_CATEGORY_AGGREGATOR_INTERVAL_SECONDS = 900;

export const STALE_DATA_POLICY = {
  seededSnapshotsRemainUsable: true,
  omitStaleLiveSnapshotsFromSimpleResponses: true,
  omitStaleLiveSnapshotsFromGlobalAggregates: true,
  nullOutStaleLiveMarketFieldsInDetailResponses: true,
} as const;
