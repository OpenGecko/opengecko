# OpenGecko Endpoint Parity Matrix

This document turns the CoinGecko endpoint overview into an execution-oriented planning matrix for OpenGecko. It is meant to answer four questions per endpoint:

- how important is it for migration success
- how hard is it to implement faithfully
- what data platform components it depends on
- which release phase it should belong to

Source baseline:

- `https://docs.coingecko.com/reference/endpoint-overview`
- public reference pages linked from CoinGecko's docs index as of `2026-03-20`

This matrix is about OpenGecko planning, not a claim that OpenGecko already supports these endpoints.

## Legend

### Access tier

- `Public`: available on CoinGecko's public/demo surface
- `Premium`: paid plan only, but not enterprise-only
- `Enterprise`: enterprise-only

### OpenGecko priority

- `P0`: must-have for early migration wins and base-url replacement
- `P1`: high-value follow-up that materially expands compatibility
- `P2`: important expansion, but not required for the first strong public launch
- `P3`: advanced, premium-like, or long-tail surface with high data/platform cost

### Release phase

- `R0`: foundation and compatibility shell
- `R1`: core coins and historical charts
- `R2`: market expansion, exchanges, contract coverage, richer aggregates
- `R3`: NFT and public treasury families
- `R4`: onchain DEX and hardest premium or enterprise parity

### Internal services shorthand

- `Health`: healthcheck and metadata shell
- `CoinRegistry`: canonical coins, tokens, platforms, slugs, and address maps
- `PriceCache`: hot spot prices and quote conversions
- `MarketSummary`: market caps, volume, supply, rankings, category aggregates
- `ChartStore`: historical price, volume, OHLC, supply, and time-series storage
- `SearchIndex`: coins, exchanges, NFTs, categories, and ranking logic
- `ExchangeVenue`: exchange and derivatives venue metadata plus ticker ingestion
- `NftCatalog`: NFT collection metadata, market stats, and marketplace aggregation
- `TreasuryLedger`: curated entity, holdings, and transaction datasets
- `OnchainIndexer`: networks, pools, trades, token metadata, holders, and OHLCV
- `EntityResolver`: joins between CoinGecko-compatible external IDs and internal entities

## Surface Area Summary

| Family | Endpoints | Recommended first-ship focus | Main blocker |
| --- | ---: | --- | --- |
| Simple + General | 12 | Yes | search ranking and global aggregation |
| Coins + Contracts + Categories | 20 | Yes | ticker normalization and historical fidelity |
| NFTs | 7 | Later | fragmented sources and derived collection metrics |
| Exchanges + Derivatives | 10 | Later | ticker normalization, trust scoring, derivatives fields |
| Public Treasury | 5 | Later | curated off-chain disclosures and derived finance fields |
| Onchain DEX | 29 | Much later | multi-chain indexing, ranking logic, holders and trader analytics |
| Total | 83 | staged rollout required | data platform complexity |

## Family 1: Simple + General

| Endpoint | Tier | Priority | Phase | Main params | Response shape | Primary data needs | Internal services | Difficulty | Parity risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/ping` | Public | P0 | R0 | none | tiny status object | service health only | `Health` | Low | Low |
| `/simple/price` | Public | P0 | R0 | `vs_currencies`; `ids` or `names` or `symbols`; `include_*`; `precision` | map keyed by coin id with quote fields and optional market stats | hot spot prices; quote conversions; coin lookup precedence | `CoinRegistry`, `PriceCache`, `EntityResolver` | Medium | Medium |
| `/simple/token_price/{id}` | Public | P0 | R0 | `id`; `contract_addresses`; `vs_currencies`; `include_*`; `precision` | map keyed by contract address with quote fields | contract-to-coin mapping; chain-aware price source selection | `CoinRegistry`, `PriceCache`, `EntityResolver` | Medium | Medium |
| `/simple/supported_vs_currencies` | Public | P0 | R0 | none | array of currency codes | supported quote currency list | `PriceCache` | Low | Low |
| `/asset_platforms` | Public | P0 | R0 | `filter=nft` | array of platform objects | canonical network registry; native coin mapping; images | `CoinRegistry` | Low | Low |
| `/exchange_rates` | Public | P1 | R0 | none | `{ rates: { code: { name, unit, value, type }}}` | BTC-relative FX and crypto conversion table | `PriceCache` | Low | Low |
| `/search` | Public | P0 | R0 | `query` | object with `coins[]`, `exchanges[]`, `categories[]`, `nfts[]` and related groups | full-text search index; ranking by popularity and market data | `SearchIndex`, `CoinRegistry`, `ExchangeVenue`, `NftCatalog` | Medium | High |
| `/global` | Public | P1 | R0 | none | aggregate market object under `data` | market-wide cap, volume, dominance, counts | `MarketSummary`, `CoinRegistry` | High | High |
| `/token_lists/{asset_platform_id}/all.json` | Public | P1 | R1 | `asset_platform_id` | token-list standard object with `tokens[]` | per-chain token registries; decimals; logos; chain IDs | `CoinRegistry`, `EntityResolver` | Medium | Medium |
| `/search/trending` | Public | P2 | R2 | `show_max` and related plan behavior | object with rich nested `coins[]`, `nfts[]`, `categories[]` payloads | trending signals; search telemetry; market snapshots | `SearchIndex`, `MarketSummary`, `NftCatalog` | High | Very High |
| `/global/decentralized_finance_defi` | Public | P2 | R2 | none | aggregate DeFi object under `data` | DeFi category taxonomy; market aggregates | `MarketSummary`, `CoinRegistry` | High | High |
| `/global/market_cap_chart` | Premium | P3 | R4 | `days`; `vs_currency` | historical chart object for market cap and volume | stored historical global aggregates | `ChartStore`, `MarketSummary` | High | High |

## Family 2: Coins, Contracts, and Categories

| Endpoint | Tier | Priority | Phase | Main params | Response shape | Primary data needs | Internal services | Difficulty | Parity risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/coins/list` | Public | P0 | R0 | `include_platform`; `status` | array of `{ id, symbol, name, platforms? }` | canonical coin registry; active and inactive lifecycle; platform address map | `CoinRegistry`, `EntityResolver` | Medium | Medium |
| `/coins/markets` | Public | P0 | R1 | `vs_currency`; lookup params; `category`; `order`; `per_page`; `page`; `sparkline`; `price_change_percentage`; `precision` | paginated market rows with price, cap, supply, ROI, ATH, ATL, and optional sparkline | market cache; category mapping; pagination and ranking logic | `MarketSummary`, `PriceCache`, `CoinRegistry` | High | High |
| `/coins/{id}` | Public | P0 | R1 | `localization`; `tickers`; `market_data`; `community_data`; `developer_data`; `sparkline`; `include_categories_details`; `dex_pair_format` | large detail object combining metadata and market state | coin metadata; links; socials; dev metrics; community metrics; market data | `CoinRegistry`, `MarketSummary`, `ExchangeVenue`, `EntityResolver` | Very High | Very High |
| `/coins/{id}/history` | Public | P1 | R1 | `date`; `localization` | point-in-time detail snapshot | daily historical snapshots with metadata and market fields | `ChartStore`, `CoinRegistry`, `MarketSummary` | High | High |
| `/coins/{id}/market_chart` | Public | P1 | R1 | `vs_currency`; `days`; optional `interval`; `precision` | time-series object with `prices`, `market_caps`, `total_volumes` | historical chart store with auto-granularity rules | `ChartStore`, `PriceCache`, `EntityResolver` | Medium | Medium |
| `/coins/{id}/market_chart/range` | Public | P1 | R1 | `vs_currency`; `from`; `to`; optional `interval`; `precision` | same chart object as rolling lookback variant | historical chart store; explicit range parser | `ChartStore`, `PriceCache`, `EntityResolver` | Medium | Medium |
| `/coins/{id}/ohlc` | Public | P1 | R1 | `vs_currency`; `days`; optional `interval`; `precision` | array of `[timestamp, open, high, low, close]` | candle generation from historical prices | `ChartStore`, `PriceCache` | Medium | Medium |
| `/coins/categories/list` | Public | P1 | R1 | none | array of category ids and names | category taxonomy | `CoinRegistry`, `MarketSummary` | Low | Low |
| `/coins/categories` | Public | P1 | R1 | `order` | category leaderboard rows with cap, volume, top assets, content | category taxonomy plus aggregate market stats | `MarketSummary`, `CoinRegistry` | Medium | Medium |
| `/coins/{platform_id}/contract/{contract_address}` | Public | P1 | R1 | `platform_id`; `contract_address` | coin detail object resolved by chain and address | contract resolution; token metadata; same fields as coin detail | `CoinRegistry`, `EntityResolver`, `MarketSummary` | Very High | Very High |
| `/coins/{platform_id}/contract/{contract_address}/market_chart` | Public | P1 | R1 | `platform_id`; `contract_address`; `vs_currency`; `days`; optional `interval`; `precision` | token chart object by contract address | contract resolution plus historical token series | `EntityResolver`, `ChartStore`, `PriceCache` | Medium | Medium |
| `/coins/{platform_id}/contract/{contract_address}/market_chart/range` | Public | P1 | R1 | `platform_id`; `contract_address`; `vs_currency`; `from`; `to`; optional `interval`; `precision` | token chart object by contract address and range | contract resolution plus explicit range series | `EntityResolver`, `ChartStore`, `PriceCache` | Medium | Medium |
| `/coins/top_gainers_losers` | Premium | P2 | R2 | `vs_currency`; `duration`; `price_change_percentage`; `top_coins` | object with `top_gainers[]` and `top_losers[]` | ranked market snapshots; min-volume thresholds; mover ranking logic | `MarketSummary`, `PriceCache` | Medium | High |
| `/coins/list/new` | Premium | P2 | R2 | none | recently listed coin rows with activation times | listing events and activation timestamps | `CoinRegistry` | Medium | High |
| `/coins/{id}/tickers` | Public | P2 | R2 | `exchange_ids`; `include_exchange_logo`; `page`; `order`; `depth`; `dex_pair_format` | paginated object with rich `tickers[]` | exchange and DEX ticker ingestion; trust scoring; optional depth | `ExchangeVenue`, `CoinRegistry`, `EntityResolver` | Very High | Very High |
| `/coins/{id}/ohlc/range` | Premium | P3 | R4 | `vs_currency`; `from`; `to`; `interval` | explicit-range OHLC array | stored candle history with range-specific rules | `ChartStore`, `PriceCache` | Medium | Medium |
| `/coins/{id}/circulating_supply_chart` | Enterprise | P3 | R4 | `days`; optional `interval` | supply series object | retained historical circulating supply ledger | `ChartStore`, `MarketSummary` | High | High |
| `/coins/{id}/circulating_supply_chart/range` | Enterprise | P3 | R4 | `from`; `to` | supply series object by range | retained circulating supply history with range queries | `ChartStore`, `MarketSummary` | High | High |
| `/coins/{id}/total_supply_chart` | Enterprise | P3 | R4 | `days`; optional `interval` | total supply series object | retained historical total supply ledger | `ChartStore`, `MarketSummary` | High | High |
| `/coins/{id}/total_supply_chart/range` | Enterprise | P3 | R4 | `from`; `to` | total supply series object by range | retained total supply history with range queries | `ChartStore`, `MarketSummary` | High | High |

## Family 3: NFTs

| Endpoint | Tier | Priority | Phase | Main params | Response shape | Primary data needs | Internal services | Difficulty | Parity risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/nfts/list` | Public | P2 | R3 | `order`; `per_page`; `page` | paginated collection registry rows | NFT collection registry; contract and platform mapping | `NftCatalog`, `EntityResolver` | Medium | Medium |
| `/nfts/{id}` | Public | P2 | R3 | `id` | rich collection detail object with floor, volume, supply, owners, pct changes, links, and images | aggregated marketplace feeds; holder counts; USD and native conversions | `NftCatalog`, `MarketSummary`, `EntityResolver` | Very High | Very High |
| `/nfts/{asset_platform_id}/contract/{contract_address}` | Public | P2 | R3 | `asset_platform_id`; `contract_address` | same collection detail object resolved by contract | contract normalization and chain-specific collection lookup | `NftCatalog`, `EntityResolver` | Very High | Very High |
| `/nfts/markets` | Premium | P3 | R3 | `asset_platform_id`; `order`; `per_page`; `page` | ranked collection market rows | ranked NFT market dataset with chain filters | `NftCatalog`, `MarketSummary` | Very High | Very High |
| `/nfts/{id}/market_chart` | Premium | P3 | R3 | `days` | historical series for floor, volume, and market cap in USD and native units | retained collection snapshots and historical chart store | `NftCatalog`, `ChartStore` | High | High |
| `/nfts/{asset_platform_id}/contract/{contract_address}/market_chart` | Premium | P3 | R3 | `asset_platform_id`; `contract_address`; `days` | same historical series shape resolved by contract | contract resolution plus historical NFT metrics | `NftCatalog`, `ChartStore`, `EntityResolver` | High | High |
| `/nfts/{id}/tickers` | Premium | P3 | R3 | `id` | object with marketplace-by-marketplace ticker rows | marketplace floor and volume feeds; marketplace metadata | `NftCatalog`, `EntityResolver` | High | High |

## Family 4: Exchanges and Derivatives

| Endpoint | Tier | Priority | Phase | Main params | Response shape | Primary data needs | Internal services | Difficulty | Parity risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/exchanges` | Public | P2 | R2 | `per_page`; `page` | paginated exchange summary rows | exchange registry; active status; BTC-normalized volume; trust scores | `ExchangeVenue`, `MarketSummary` | Medium | High |
| `/exchanges/list` | Public | P2 | R2 | `status` | lightweight exchange id map | exchange slug registry and lifecycle status | `ExchangeVenue` | Low | Low |
| `/exchanges/{id}` | Public | P2 | R2 | `id`; `dex_pair_format` | exchange detail object with metadata and top 100 tickers | venue metadata; top ticker selection; converted values | `ExchangeVenue`, `MarketSummary`, `EntityResolver` | High | High |
| `/exchanges/{id}/volume_chart` | Public | P2 | R2 | `days` | array of `[timestamp, volume_btc]` | stored exchange volume history in BTC | `ExchangeVenue`, `ChartStore` | Medium | Medium |
| `/derivatives/exchanges` | Public | P2 | R2 | `order`; `per_page`; `page` | paginated derivatives venue summary rows | derivatives venue registry; aggregate OI and volume in BTC | `ExchangeVenue`, `MarketSummary` | High | High |
| `/derivatives/exchanges/list` | Public | P2 | R2 | none | lightweight derivatives venue id map | derivatives venue registry | `ExchangeVenue` | Low | Low |
| `/exchanges/{id}/tickers` | Public | P3 | R2 | `coin_ids`; `include_exchange_logo`; `page`; `depth`; `order`; `dex_pair_format` | paginated object with rich ticker rows and optional depth | full ticker ingestion; order-book depth; anomaly and stale flags | `ExchangeVenue`, `EntityResolver`, `MarketSummary` | Very High | Very High |
| `/exchanges/{id}/volume_chart/range` | Premium | P3 | R4 | `from`; `to` | volume history array by explicit range | daily BTC volume history with validation rules | `ExchangeVenue`, `ChartStore` | Medium | Medium |
| `/derivatives` | Public | P3 | R2 | none | derivatives ticker rows with funding, basis, open interest, spread, expiry, and volume | contract-level derivatives feeds across venues | `ExchangeVenue`, `MarketSummary`, `EntityResolver` | Very High | Very High |
| `/derivatives/exchanges/{id}` | Public | P3 | R3 | `include_tickers` | derivatives venue detail object and optional tickers | venue metadata; contract feeds; expiry state; OI and funding | `ExchangeVenue`, `EntityResolver`, `MarketSummary` | Very High | Very High |

## Family 5: Public Treasury

| Endpoint | Tier | Priority | Phase | Main params | Response shape | Primary data needs | Internal services | Difficulty | Parity risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/entities/list` | Public | P2 | R3 | `entity_type`; `per_page`; `page` | paginated entity registry rows | curated companies and governments registry | `TreasuryLedger`, `EntityResolver` | Medium | Medium |
| `/{entity}/public_treasury/{coin_id}` | Public | P3 | R3 | `entity`; `coin_id`; `per_page`; `page`; `order` | totals plus `companies[]` or `governments[]` rows | curated holdings disclosures; pricing; supply share calculation | `TreasuryLedger`, `MarketSummary`, `EntityResolver` | High | Very High |
| `/public_treasury/{entity_id}` | Public | P3 | R3 | `entity_id`; optional holding change params | full entity treasury profile with holdings and derived finance fields | entity master data; holdings; PnL; per-share metrics | `TreasuryLedger`, `MarketSummary`, `EntityResolver` | Very High | Very High |
| `/public_treasury/{entity_id}/{coin_id}/holding_chart` | Public | P3 | R3 | `days`; `include_empty_intervals` | historical holdings and USD value series | retained holdings snapshots or reconstructed ledger over time | `TreasuryLedger`, `ChartStore`, `MarketSummary` | High | High |
| `/public_treasury/{entity_id}/transaction_history` | Public | P3 | R3 | `per_page`; `page`; `order`; `coin_ids` | object with normalized treasury transactions and source URLs | curated disclosure parsing; transaction normalization; entity ledger reconstruction | `TreasuryLedger`, `EntityResolver` | Very High | Very High |

## Family 6: Onchain DEX / GeckoTerminal

| Endpoint | Tier | Priority | Phase | Main params | Response shape | Primary data needs | Internal services | Difficulty | Parity risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/onchain/networks` | Public | P2 | R4 | `page` | JSON:API-style `data[]` network resources | GeckoTerminal network registry and mapping to asset platforms | `OnchainIndexer`, `CoinRegistry`, `EntityResolver` | Low | Low |
| `/onchain/networks/{network}/dexes` | Public | P2 | R4 | `network`; `page` | JSON:API-style `data[]` dex resources | per-network DEX registry | `OnchainIndexer` | Low | Low |
| `/onchain/networks/{network}/pools/{address}` | Public | P2 | R4 | `network`; `address`; optional `include`; `include_volume_breakdown`; `include_composition` | pool resource plus optional `included[]` related entities | pool registry; liquidity; volumes; tx counts; token refs | `OnchainIndexer`, `EntityResolver` | High | High |
| `/onchain/networks/{network}/pools/multi/{addresses}` | Public | P2 | R4 | `network`; `addresses`; optional `include`; `include_volume_breakdown`; `include_composition` | array of pool resources plus shared includes | batch pool fetch with included-resource de-duplication | `OnchainIndexer`, `EntityResolver` | High | High |
| `/onchain/networks/{network}/pools` | Public | P2 | R4 | `network`; `page`; `sort`; optional `include`; `include_gt_community_data` | top pool rows plus optional included entities | ranked pool stats by tx count or volume | `OnchainIndexer`, `MarketSummary` | Medium | Medium |
| `/onchain/networks/{network}/dexes/{dex}/pools` | Public | P2 | R4 | `network`; `dex`; `page`; `sort`; optional `include` | DEX-scoped top pool rows | DEX-specific pool catalog and stats | `OnchainIndexer`, `MarketSummary` | Medium | Medium |
| `/onchain/networks/{network}/new_pools` | Public | P2 | R4 | `network`; `page`; optional `include` | new pool rows within a network | pool discovery indexed by creation time | `OnchainIndexer` | Medium | High |
| `/onchain/networks/{network}/tokens/{token_address}/pools` | Public | P2 | R4 | `network`; `token_address`; `page`; `sort`; optional `include`; `include_inactive_source` | pool rows for a token plus optional includes | token-to-pool map; ranked pool metrics | `OnchainIndexer`, `EntityResolver` | High | High |
| `/onchain/networks/{network}/tokens/{address}` | Public | P2 | R4 | `network`; `address`; optional `include=top_pools`; `include_composition`; `include_inactive_source` | single token market resource plus optional pools | aggregate token pricing across pools; liquidity and volume | `OnchainIndexer`, `PriceCache`, `EntityResolver` | High | High |
| `/onchain/networks/{network}/tokens/multi/{addresses}` | Public | P2 | R4 | `network`; `addresses`; optional `include=top_pools`; `include_composition`; `include_inactive_source` | array of token market resources plus optional includes | batched token lookup across pools | `OnchainIndexer`, `PriceCache`, `EntityResolver` | High | High |
| `/onchain/networks/{network}/tokens/{address}/info` | Public | P2 | R4 | `network`; `address` | token metadata resource | token metadata, CoinGecko id linkage, socials, websites | `OnchainIndexer`, `CoinRegistry`, `EntityResolver` | Medium | Medium |
| `/onchain/networks/{network}/pools/{pool_address}/info` | Public | P2 | R4 | `network`; `pool_address`; optional `include=pool` | token metadata for pool constituents plus optional pool | pool constituent mapping and token metadata | `OnchainIndexer`, `EntityResolver` | Medium | Medium |
| `/onchain/tokens/info_recently_updated` | Public | P2 | R4 | optional `network`; `include=network` | recently updated token metadata feed | metadata update log ordered by recency | `OnchainIndexer`, `CoinRegistry` | Medium | High |
| `/onchain/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}` | Public | P2 | R4 | `timeframe`; `aggregate`; `before_timestamp`; `limit`; `currency`; `token`; `include_empty_intervals` | OHLCV series under `data` and `meta` | trade stream or bar store per pool | `OnchainIndexer`, `ChartStore`, `PriceCache` | High | High |
| `/onchain/networks/{network}/pools/{pool_address}/trades` | Public | P2 | R4 | optional `trade_volume_in_usd_greater_than`; `token` | recent trade resources | normalized swap events with USD conversion | `OnchainIndexer`, `PriceCache` | Medium | Medium |
| `/onchain/simple/networks/{network}/token_price/{addresses}` | Public | P2 | R4 | `network`; `addresses`; optional `include_market_cap`; `mcap_fdv_fallback`; `include_24hr_vol`; `include_24hr_price_change`; `include_total_reserve_in_usd`; `include_inactive_source` | fast JSON:API-style price object keyed in attributes | best pool or source selection per token; derived market cap and reserve fields | `OnchainIndexer`, `PriceCache`, `EntityResolver` | High | High |
| `/onchain/networks/trending_pools` | Public | P3 | R4 | `page`; `duration`; optional `include`; `include_gt_community_data` | ranked trending pool rows across all networks | cross-network ranking signals and community metrics | `OnchainIndexer`, `MarketSummary` | Very High | Very High |
| `/onchain/networks/{network}/trending_pools` | Public | P3 | R4 | `network`; `page`; `duration`; optional `include`; `include_gt_community_data` | ranked trending pool rows within a network | network-specific trending signals and community metrics | `OnchainIndexer`, `MarketSummary` | Very High | Very High |
| `/onchain/networks/new_pools` | Public | P3 | R4 | `page`; optional `include`; `include_gt_community_data` | new pool rows across all networks | global pool discovery and cross-network ordering | `OnchainIndexer` | High | High |
| `/onchain/pools/megafilter` | Premium | P3 | R4 | many filters across networks, dexes, FDV, reserve, age, taxes, tx counts, price-change windows | premium pool screener result set | indexed pool warehouse; filter engine; risk and tax checks | `OnchainIndexer`, `MarketSummary` | Very High | Very High |
| `/onchain/search/pools` | Public | P3 | R4 | `query`; optional `network`; `page`; `include` | search results with pools and included entities | full-text search over pools, tokens, symbols, and contracts | `SearchIndex`, `OnchainIndexer`, `EntityResolver` | High | Very High |
| `/onchain/pools/trending_search` | Premium | P3 | R4 | optional `pools`; `include` | trending-search pool rows | internal search behavior and popularity signals | `SearchIndex`, `OnchainIndexer` | Very High | Very High |
| `/onchain/networks/{network_id}/tokens/{token_address}/top_traders` | Premium | P3 | R4 | optional `traders`; `sort`; `include_address_label` | token trader leaderboard | wallet-level trade attribution, PnL, and label data | `OnchainIndexer`, `MarketSummary`, `EntityResolver` | Very High | Very High |
| `/onchain/networks/{network}/tokens/{address}/top_holders` | Premium | P3 | R4 | optional `holders`; `include_pnl_details` | token holder leaderboard | retained holder snapshots, address clustering, optional PnL enrichment | `OnchainIndexer`, `MarketSummary` | Very High | Very High |
| `/onchain/networks/{network}/tokens/{token_address}/holders_chart` | Premium | P3 | R4 | optional `days` | holder-count chart under `data` | historical holder snapshots and rollups | `OnchainIndexer`, `ChartStore` | High | High |
| `/onchain/networks/{network}/tokens/{token_address}/ohlcv/{timeframe}` | Premium | P3 | R4 | `timeframe`; `aggregate`; `before_timestamp`; `limit`; `currency`; `include_empty_intervals`; `include_inactive_source` | token-level OHLCV series aggregated across pools | cross-pool source selection and bar aggregation | `OnchainIndexer`, `ChartStore`, `PriceCache` | Very High | Very High |
| `/onchain/networks/{network}/tokens/{token_address}/trades` | Premium | P3 | R4 | optional `trade_volume_in_usd_greater_than` | recent token trades across pools | cross-pool trade aggregation and ordering | `OnchainIndexer`, `PriceCache` | High | High |
| `/onchain/categories` | Premium | P3 | R4 | `page`; `sort` | category resource rows | onchain category taxonomy and aggregate stats | `OnchainIndexer`, `MarketSummary` | Medium | High |
| `/onchain/categories/{category_id}/pools` | Premium | P3 | R4 | `category_id`; `page`; `sort`; optional `include` | pool rows for a category plus optional includes | category-to-pool membership and sortable pool stats | `OnchainIndexer`, `MarketSummary` | High | High |

## Cross-Cutting Parity Risks

### 1. Ranking and curation are harder than routing

The hardest parity targets are not always the biggest schemas. They are often the endpoints where CoinGecko applies editorial, behavioral, or trust logic:

- `/search/trending`
- `/coins/top_gainers_losers`
- `/coins/{id}/tickers`
- `/exchanges/{id}/tickers`
- `/onchain/networks/*/trending_pools`
- `/onchain/pools/trending_search`
- `/onchain/pools/megafilter`

### 2. Historical correctness needs retained ledgers

A large share of the premium and enterprise surface cannot be recreated well from only current snapshots. OpenGecko will need retained, queryable history for:

- price, cap, and volume charts
- OHLC and OHLCV bars
- exchange volume history
- supply history
- NFT collection history
- treasury holdings history
- holder counts and address-level stats

### 3. Canonical ID mapping is a first-class system

OpenGecko needs durable internal mappings for:

- coin ids
- asset platform ids
- contract addresses
- exchange ids
- derivatives venue ids
- NFT collection ids
- onchain network and dex ids
- treasury entity ids
- category ids

Without this layer, even "easy" endpoints become unreliable.

## Recommended Build Order

### First ship: best migration value per unit effort

- `/ping`
- all `/simple/*`
- `/asset_platforms`
- `/exchange_rates`
- `/search`
- `/global`
- `/coins/list`
- `/coins/markets`
- `/coins/{id}`
- `/coins/{id}/history`
- `/coins/{id}/market_chart`
- `/coins/{id}/market_chart/range`
- `/coins/{id}/ohlc`
- `/coins/categories/list`
- `/coins/categories`
- contract-address detail and chart endpoints

### Second ship: broad market compatibility

- `/coins/{id}/tickers`
- premium coin movers and newly listed feeds
- `/token_lists/{asset_platform_id}/all.json`
- `/global/decentralized_finance_defi`
- exchange list and detail endpoints
- exchange volume history
- derivatives venue index endpoints

### Third ship: specialist verticals

- NFT family
- public treasury family
- derivatives detail and full ticker-heavy endpoints

### Fourth ship: GeckoTerminal parity

- entire `/onchain/*` family, starting with catalogs, pool detail, token detail, pool OHLCV, and pool trades
- only then the ranking, search, holder, and trader analytics endpoints

## Maintenance Rules

- When OpenGecko adds or drops an endpoint family, update this matrix and the PRD together.
- When an endpoint moves phase or priority, update this file before implementation starts.
- When OpenGecko intentionally diverges from CoinGecko behavior, add an explicit note to the relevant endpoint row or a follow-up compatibility note.
