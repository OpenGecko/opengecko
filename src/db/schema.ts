import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const coins = sqliteTable('coins', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  apiSymbol: text('api_symbol').notNull(),
  hashingAlgorithm: text('hashing_algorithm'),
  blockTimeInMinutes: integer('block_time_in_minutes'),
  categoriesJson: text('categories_json').notNull().default('[]'),
  descriptionJson: text('description_json').notNull().default('{}'),
  linksJson: text('links_json').notNull().default('{}'),
  imageThumbUrl: text('image_thumb_url'),
  imageSmallUrl: text('image_small_url'),
  imageLargeUrl: text('image_large_url'),
  marketCapRank: integer('market_cap_rank'),
  genesisDate: text('genesis_date'),
  platformsJson: text('platforms_json').notNull().default('{}'),
  status: text('status', { enum: ['active', 'inactive'] }).notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const assetPlatforms = sqliteTable('asset_platforms', {
  id: text('id').primaryKey(),
  chainIdentifier: integer('chain_identifier'),
  name: text('name').notNull(),
  shortname: text('shortname').notNull(),
  nativeCoinId: text('native_coin_id'),
  imageUrl: text('image_url'),
  isNft: integer('is_nft', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const marketSnapshots = sqliteTable(
  'market_snapshots',
  {
    coinId: text('coin_id')
      .notNull()
      .references(() => coins.id),
    vsCurrency: text('vs_currency').notNull(),
    price: real('price').notNull(),
    marketCap: real('market_cap'),
    totalVolume: real('total_volume'),
    marketCapRank: integer('market_cap_rank'),
    fullyDilutedValuation: real('fully_diluted_valuation'),
    circulatingSupply: real('circulating_supply'),
    totalSupply: real('total_supply'),
    maxSupply: real('max_supply'),
    ath: real('ath'),
    athChangePercentage: real('ath_change_percentage'),
    athDate: integer('ath_date', { mode: 'timestamp_ms' }),
    atl: real('atl'),
    atlChangePercentage: real('atl_change_percentage'),
    atlDate: integer('atl_date', { mode: 'timestamp_ms' }),
    priceChange24h: real('price_change_24h'),
    priceChangePercentage24h: real('price_change_percentage_24h'),
    sourceProvidersJson: text('source_providers_json').notNull().default('[]'),
    sourceCount: integer('source_count').notNull().default(0),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    lastUpdated: integer('last_updated', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.coinId, table.vsCurrency] }),
  }),
);

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  marketCap: real('market_cap'),
  marketCapChange24h: real('market_cap_change_24h'),
  volume24h: real('volume_24h'),
  content: text('content'),
  top3CoinsJson: text('top_3_coins_json').notNull().default('[]'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const chartPoints = sqliteTable(
  'chart_points',
  {
    coinId: text('coin_id')
      .notNull()
      .references(() => coins.id),
    vsCurrency: text('vs_currency').notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    price: real('price').notNull(),
    marketCap: real('market_cap'),
    totalVolume: real('total_volume'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.coinId, table.vsCurrency, table.timestamp] }),
  }),
);

export const exchanges = sqliteTable('exchanges', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  yearEstablished: integer('year_established'),
  country: text('country'),
  description: text('description').notNull().default(''),
  url: text('url').notNull(),
  imageUrl: text('image_url'),
  hasTradingIncentive: integer('has_trading_incentive', { mode: 'boolean' }).notNull().default(false),
  trustScore: integer('trust_score'),
  trustScoreRank: integer('trust_score_rank'),
  tradeVolume24hBtc: real('trade_volume_24h_btc'),
  tradeVolume24hBtcNormalized: real('trade_volume_24h_btc_normalized'),
  facebookUrl: text('facebook_url'),
  redditUrl: text('reddit_url'),
  telegramUrl: text('telegram_url'),
  slackUrl: text('slack_url'),
  otherUrlJson: text('other_url_json').notNull().default('[]'),
  twitterHandle: text('twitter_handle'),
  centralised: integer('centralised', { mode: 'boolean' }).notNull().default(true),
  publicNotice: text('public_notice'),
  alertNotice: text('alert_notice'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const exchangeVolumePoints = sqliteTable(
  'exchange_volume_points',
  {
    exchangeId: text('exchange_id')
      .notNull()
      .references(() => exchanges.id),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    volumeBtc: real('volume_btc').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.exchangeId, table.timestamp] }),
  }),
);

export const derivativesExchanges = sqliteTable('derivatives_exchanges', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  openInterestBtc: real('open_interest_btc'),
  tradeVolume24hBtc: real('trade_volume_24h_btc'),
  numberOfPerpetualPairs: integer('number_of_perpetual_pairs'),
  numberOfFuturesPairs: integer('number_of_futures_pairs'),
  yearEstablished: integer('year_established'),
  country: text('country'),
  description: text('description').notNull().default(''),
  url: text('url').notNull(),
  imageUrl: text('image_url'),
  centralised: integer('centralised', { mode: 'boolean' }).notNull().default(true),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const derivativeTickers = sqliteTable(
  'derivative_tickers',
  {
    exchangeId: text('exchange_id')
      .notNull()
      .references(() => derivativesExchanges.id),
    symbol: text('symbol').notNull(),
    market: text('market').notNull(),
    indexId: text('index_id'),
    price: real('price'),
    pricePercentageChange24h: real('price_percentage_change_24h'),
    contractType: text('contract_type').notNull(),
    indexValue: real('index_value'),
    basis: real('basis'),
    spread: real('spread'),
    fundingRate: real('funding_rate'),
    openInterestBtc: real('open_interest_btc'),
    tradeVolume24hBtc: real('trade_volume_24h_btc'),
    lastTradedAt: integer('last_traded_at', { mode: 'timestamp_ms' }),
    expiredAt: integer('expired_at', { mode: 'timestamp_ms' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.exchangeId, table.symbol] }),
  }),
);

export const treasuryEntities = sqliteTable('treasury_entities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  symbol: text('symbol'),
  entityType: text('entity_type', { enum: ['company', 'government'] }).notNull(),
  country: text('country'),
  description: text('description').notNull().default(''),
  websiteUrl: text('website_url'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const treasuryHoldings = sqliteTable(
  'treasury_holdings',
  {
    entityId: text('entity_id')
      .notNull()
      .references(() => treasuryEntities.id),
    coinId: text('coin_id')
      .notNull()
      .references(() => coins.id),
    amount: real('amount').notNull(),
    entryValueUsd: real('entry_value_usd'),
    reportedAt: integer('reported_at', { mode: 'timestamp_ms' }).notNull(),
    sourceUrl: text('source_url'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.entityId, table.coinId] }),
  }),
);

export const treasuryTransactions = sqliteTable('treasury_transactions', {
  id: text('id').primaryKey(),
  entityId: text('entity_id')
    .notNull()
    .references(() => treasuryEntities.id),
  coinId: text('coin_id')
    .notNull()
    .references(() => coins.id),
  type: text('type', { enum: ['buy', 'sell'] }).notNull(),
  holdingNetChange: real('holding_net_change').notNull(),
  transactionValueUsd: real('transaction_value_usd'),
  holdingBalance: real('holding_balance').notNull(),
  averageEntryValueUsd: real('average_entry_value_usd'),
  happenedAt: integer('happened_at', { mode: 'timestamp_ms' }).notNull(),
  sourceUrl: text('source_url'),
});

export const onchainNetworks = sqliteTable('onchain_networks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  chainIdentifier: integer('chain_identifier'),
  coingeckoAssetPlatformId: text('coingecko_asset_platform_id'),
  nativeCurrencyCoinId: text('native_currency_coin_id'),
  imageUrl: text('image_url'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const onchainDexes = sqliteTable(
  'onchain_dexes',
  {
    id: text('id').notNull(),
    networkId: text('network_id')
      .notNull()
      .references(() => onchainNetworks.id),
    name: text('name').notNull(),
    url: text('url'),
    imageUrl: text('image_url'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.networkId, table.id] }),
  }),
);

export const coinTickers = sqliteTable(
  'coin_tickers',
  {
    coinId: text('coin_id')
      .notNull()
      .references(() => coins.id),
    exchangeId: text('exchange_id')
      .notNull()
      .references(() => exchanges.id),
    base: text('base').notNull(),
    target: text('target').notNull(),
    marketName: text('market_name').notNull(),
    last: real('last'),
    volume: real('volume'),
    convertedLastUsd: real('converted_last_usd'),
    convertedLastBtc: real('converted_last_btc'),
    convertedVolumeUsd: real('converted_volume_usd'),
    bidAskSpreadPercentage: real('bid_ask_spread_percentage'),
    trustScore: text('trust_score'),
    lastTradedAt: integer('last_traded_at', { mode: 'timestamp_ms' }),
    lastFetchAt: integer('last_fetch_at', { mode: 'timestamp_ms' }),
    isAnomaly: integer('is_anomaly', { mode: 'boolean' }).notNull().default(false),
    isStale: integer('is_stale', { mode: 'boolean' }).notNull().default(false),
    tradeUrl: text('trade_url'),
    tokenInfoUrl: text('token_info_url'),
    coinGeckoUrl: text('coin_gecko_url'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.coinId, table.exchangeId, table.base, table.target] }),
  }),
);

export type CoinRow = typeof coins.$inferSelect;
export type AssetPlatformRow = typeof assetPlatforms.$inferSelect;
export type MarketSnapshotRow = typeof marketSnapshots.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type ChartPointRow = typeof chartPoints.$inferSelect;
export type ExchangeRow = typeof exchanges.$inferSelect;
export type ExchangeVolumePointRow = typeof exchangeVolumePoints.$inferSelect;
export type DerivativesExchangeRow = typeof derivativesExchanges.$inferSelect;
export type DerivativeTickerRow = typeof derivativeTickers.$inferSelect;
export type TreasuryEntityRow = typeof treasuryEntities.$inferSelect;
export type TreasuryHoldingRow = typeof treasuryHoldings.$inferSelect;
export type TreasuryTransactionRow = typeof treasuryTransactions.$inferSelect;
export type OnchainNetworkRow = typeof onchainNetworks.$inferSelect;
export type OnchainDexRow = typeof onchainDexes.$inferSelect;
export type CoinTickerRow = typeof coinTickers.$inferSelect;
