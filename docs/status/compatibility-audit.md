# Compatibility Audit

## Summary

- Matrix endpoints audited: 83 table entries (76 active non-summary endpoints plus 7 NFT endpoints retained as removed-roadmap context).
- Implemented: 76
- Not started: 7
- Status labels: `implemented`, `partial`, `stub`, `not_started`.
- Active non-NFT parity: 76 / 76 matrix endpoints outside the removed NFT family are route-registered.

## Coverage & Evidence

- Route inventory taken from `src/modules/*.ts` registration points.
- Response-shape evidence comes from `tests/app.test.ts`, `tests/compare-coingecko.test.ts`, and `tests/fixtures/contract-fixtures.json`.
- Invalid-parameter and envelope evidence comes from `tests/invalid-params.test.ts` plus shared `HttpError` handling in `src/http/errors.ts`.
- NFT rows remain `not_started` because the parity matrix explicitly marks that family as removed from the active roadmap.

## Per-family field compatibility notes

### Simple + General

- Faithful fields: `gecko_says`, simple quote maps, supported currency arrays, asset platform identity fields, exchange-rate `data` payloads, `search` groups, `global.data` aggregates, token-list standard fields.
- Stubbed/approximate areas: search ranking/trending heuristics and global/defi aggregates remain deterministic local approximations rather than full CoinGecko telemetry.

### Coins + Contracts + Categories

- Faithful fields: market rows, rich coin detail shape, historical/chart/ohlc arrays, contract-address detail/chart parity, category list/leaderboard fields, supply-series envelopes, mover/list-new envelopes.
- Divergences: ranking universe, some market-derived values, and ticker trust/depth semantics are simplified versus CoinGecko.

### Exchanges + Derivatives

- Faithful fields: exchange registry/detail rows, ticker envelopes, derivatives venue summary/detail rows, derivatives contract rows, volume chart tuple shapes.
- Divergences: trust score, some venue metadata, and depth/spread fidelity remain approximated or fixture-backed.

### Public Treasury

- Faithful fields: entity list rows, grouped treasury summaries, entity profile holdings, holding chart arrays, transaction history rows.
- Divergences: finance-derived metrics come from curated seed/live hybrid data rather than full disclosure ingestion.

### Onchain DEX

- Faithful fields: JSON:API `data`/`included`/`meta` envelopes for networks, dexes, pools, tokens, simple token price, trades, OHLCV, categories, megafilter, and ranking/search feeds.
- Divergences: live provider coverage is strongest on Ethereum; several endpoints fall back to seeded or fixture-backed data when live discovery/SQD data is unavailable.

## Endpoint audit table

| Endpoint | Family | Status | Evidence | Field compatibility notes |
| --- | --- | --- | --- | --- |
| `/ping` | Simple + General | implemented | Route registered in src/modules/health.ts and covered by compare/app contract tests. | Field reproduced: gecko_says. No notable divergence. |
| `/simple/price` | Simple + General | implemented | Route registered in src/modules/simple.ts with selector, precision, and include_* support. | Fields reproduced: quote map, *_market_cap, *_24h_vol, *_24h_change, last_updated_at. Divergence: 400 shape for missing selectors now custom rather than Fastify default. |
| `/simple/token_price/{id}` | Simple + General | implemented | Alias-aware token price route implemented in src/modules/simple.ts. | Fields reproduced: contract-keyed quote object. Divergence: only returns tracked contract matches. |
| `/simple/supported_vs_currencies` | Simple + General | implemented | Route registered in src/modules/simple.ts. | Fields reproduced: string array of vs currencies. |
| `/asset_platforms` | Simple + General | implemented | Route registered in src/modules/assets.ts. | Fields reproduced: id, chain_identifier, name, shortname, native_coin_id, image. |
| `/exchange_rates` | Simple + General | implemented | Route registered in src/modules/simple.ts. | Fields reproduced: data.{code}.{name,unit,value,type}. |
| `/search` | Simple + General | implemented | Route registered in src/modules/search.ts. | Fields reproduced: coins, exchanges, categories, nfts, icos arrays. Divergence: ranking remains simplified relative to CoinGecko. |
| `/global` | Simple + General | implemented | Route registered in src/modules/global.ts. | Fields reproduced: aggregate market data envelope. Divergence: aggregate breadth remains seeded/live hybrid. |
| `/token_lists/{asset_platform_id}/all.json` | Simple + General | implemented | Route registered in src/modules/assets.ts with alias-aware asset platform lookup. | Fields reproduced: token-list standard payload with tokens[]. |
| `/search/trending` | Simple + General | implemented | Route registered in src/modules/search.ts with show_max handling. | Fields reproduced: coins, nfts, categories groups. Divergence: trending signal source is deterministic fixture/ranking logic. |
| `/global/decentralized_finance_defi` | Simple + General | implemented | Route registered in src/modules/global.ts. | Fields reproduced: data envelope for DeFi aggregates. Divergence: aggregate values remain approximate/seeded. |
| `/global/market_cap_chart` | Simple + General | implemented | Route registered in src/modules/global.ts. | Fields reproduced: market_cap_chart series. Divergence: historical breadth limited to available stored series. |
| `/coins/list` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: id, symbol, name, optional platforms. |
| `/coins/markets` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts with filtering, ordering, pagination, sparkline, precision. | Fields reproduced: full market row surface used by fixtures/tests. Divergence: ranking universe and some values remain simplified. |
| `/coins/{id}` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: rich coin detail object including links, image, market_data, optional sections. |
| `/coins/{id}/history` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: point-in-time coin detail with market_data snapshot. |
| `/coins/{id}/market_chart` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: prices, market_caps, total_volumes arrays. |
| `/coins/{id}/market_chart/range` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: range chart payload with explicit bounds validation. |
| `/coins/{id}/ohlc` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: [timestamp, open, high, low, close] tuples. |
| `/coins/categories/list` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: category_id and name rows. |
| `/coins/categories` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts with ordering support. | Fields reproduced: category leaderboard fields. Divergence: ranking inputs remain simplified. |
| `/coins/{platform_id}/contract/{contract_address}` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts with canonical alias resolution. | Fields reproduced: coin detail by contract. |
| `/coins/{platform_id}/contract/{contract_address}/market_chart` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: token chart by contract. |
| `/coins/{platform_id}/contract/{contract_address}/market_chart/range` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: token chart/range by contract. |
| `/coins/top_gainers_losers` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: top_gainers/top_losers arrays. Divergence: mover universe derived from local ranked subset. |
| `/coins/list/new` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: coins envelope with activated_at ordering. |
| `/coins/{id}/tickers` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts with ordering and exchange filters. | Fields reproduced: tickers array with market metadata and converted fields. Divergence: trust/depth semantics remain approximated. |
| `/coins/{id}/ohlc/range` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: explicit-range OHLC tuples. |
| `/coins/{id}/circulating_supply_chart` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: circulating_supply series. |
| `/coins/{id}/circulating_supply_chart/range` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: explicit-range circulating_supply series. |
| `/coins/{id}/total_supply_chart` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: total_supply series. |
| `/coins/{id}/total_supply_chart/range` | Coins + Contracts + Categories | implemented | Route registered in src/modules/coins.ts. | Fields reproduced: explicit-range total_supply series. |
| `/nfts/list` | NFT (removed) | not_started | NFT family intentionally removed from the active roadmap in the parity matrix. | No response fields implemented. |
| `/nfts/{id}` | NFT (removed) | not_started | NFT family intentionally removed from the active roadmap in the parity matrix. | No response fields implemented. |
| `/nfts/{asset_platform_id}/contract/{contract_address}` | NFT (removed) | not_started | NFT family intentionally removed from the active roadmap in the parity matrix. | No response fields implemented. |
| `/nfts/markets` | NFT (removed) | not_started | NFT family intentionally removed from the active roadmap in the parity matrix. | No response fields implemented. |
| `/nfts/{id}/market_chart` | NFT (removed) | not_started | NFT family intentionally removed from the active roadmap in the parity matrix. | No response fields implemented. |
| `/nfts/{asset_platform_id}/contract/{contract_address}/market_chart` | NFT (removed) | not_started | NFT family intentionally removed from the active roadmap in the parity matrix. | No response fields implemented. |
| `/nfts/{id}/tickers` | NFT (removed) | not_started | NFT family intentionally removed from the active roadmap in the parity matrix. | No response fields implemented. |
| `/exchanges` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts with pagination. | Fields reproduced: exchange summary rows including trust and volume fields. |
| `/exchanges/list` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts. | Fields reproduced: id/name registry rows. |
| `/exchanges/{id}` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts. | Fields reproduced: detailed exchange payload with tickers. Divergence: trust scoring and metadata remain fixture/live hybrid. |
| `/exchanges/{id}/volume_chart` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts. | Fields reproduced: [timestamp, volume_btc] tuples. |
| `/derivatives/exchanges` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts with ordering/pagination. | Fields reproduced: derivatives venue summary rows. |
| `/derivatives/exchanges/list` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts. | Fields reproduced: id/name registry rows. |
| `/exchanges/{id}/tickers` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts. | Fields reproduced: exchange tickers array with market metadata. Divergence: order-book depth is optional and approximated. |
| `/exchanges/{id}/volume_chart/range` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts. | Fields reproduced: explicit-range volume tuples. |
| `/derivatives` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts. | Fields reproduced: derivatives contract rows with funding/open interest fields. |
| `/derivatives/exchanges/{id}` | Exchanges + Derivatives | implemented | Route registered in src/modules/exchanges.ts. | Fields reproduced: derivatives venue detail and optional tickers. |
| `/entities/list` | Public Treasury | implemented | Route registered in src/modules/treasury.ts with pagination/filtering. | Fields reproduced: treasury entity list rows. |
| `/{entity}/public_treasury/{coin_id}` | Public Treasury | implemented | Route registered in src/modules/treasury.ts. | Fields reproduced: grouped treasury holdings summary. Divergence: finance-derived metrics remain simplified. |
| `/public_treasury/{entity_id}` | Public Treasury | implemented | Route registered in src/modules/treasury.ts. | Fields reproduced: entity treasury profile with holdings[] and PnL metrics. |
| `/public_treasury/{entity_id}/{coin_id}/holding_chart` | Public Treasury | implemented | Route registered in src/modules/treasury.ts. | Fields reproduced: holdings and holding_value_in_usd series. |
| `/public_treasury/{entity_id}/transaction_history` | Public Treasury | implemented | Route registered in src/modules/treasury.ts. | Fields reproduced: transactions[] ledger rows. |
| `/onchain/networks` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts with pagination metadata. | Fields reproduced: JSON:API network resources. |
| `/onchain/networks/{network}/dexes` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: JSON:API dex resources keyed to network. |
| `/onchain/networks/{network}/pools/{address}` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: pool resource + meta.data_source. Divergence: live coverage concentrated on Ethereum and falls back to seeded data. |
| `/onchain/networks/{network}/pools/multi/{addresses}` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: multi pool lookup with deduplicated includes. |
| `/onchain/networks/{network}/pools` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: paginated pool collection. Divergence: list source remains seeded rows patched with live data. |
| `/onchain/networks/{network}/dexes/{dex}/pools` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: dex-scoped pool listing. |
| `/onchain/networks/{network}/new_pools` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: recency-ordered network discovery feed. |
| `/onchain/networks/{network}/tokens/{token_address}/pools` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: token-scoped pool listing. |
| `/onchain/networks/{network}/tokens/{address}` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: token market resource. Divergence: live pricing limited to supported/provider-backed token paths. |
| `/onchain/networks/{network}/tokens/multi/{addresses}` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: multi token lookup with optional includes. |
| `/onchain/networks/{network}/tokens/{address}/info` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: token metadata resource. |
| `/onchain/networks/{network}/pools/{pool_address}/info` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: constituent token info resources and optional pool include. |
| `/onchain/tokens/info_recently_updated` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: recently updated token metadata feed. |
| `/onchain/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: ohlcv_list envelope with source metadata. Divergence: falls back to synthetic fixtures when live swaps unavailable. |
| `/onchain/networks/{network}/pools/{pool_address}/trades` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: trade resources with source metadata. Divergence: falls back to fixtures when live swaps unavailable. |
| `/onchain/simple/networks/{network}/token_price/{addresses}` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: JSON:API simple token price with optional aggregate maps. |
| `/onchain/networks/trending_pools` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: global trending pool feed. Divergence: ranking is deterministic local logic. |
| `/onchain/networks/{network}/trending_pools` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: network-scoped trending pool feed. |
| `/onchain/networks/new_pools` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: global new-pools feed. |
| `/onchain/pools/megafilter` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: filtered pool screener with applied_filters meta. |
| `/onchain/search/pools` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: pool search results and meta query context. |
| `/onchain/pools/trending_search` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: ranked subset search feed. |
| `/onchain/networks/{network_id}/tokens/{token_address}/top_traders` | Onchain DEX | implemented | Implemented as /onchain/networks/:network/tokens/:address/top_traders in src/modules/onchain.ts. | Fields reproduced: trader leaderboard resources. Divergence: route param naming differs internally but path shape is compatible. |
| `/onchain/networks/{network}/tokens/{address}/top_holders` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: holder leaderboard resources. |
| `/onchain/networks/{network}/tokens/{token_address}/holders_chart` | Onchain DEX | implemented | Implemented as /onchain/networks/:network/tokens/:address/holders_chart in src/modules/onchain.ts. | Fields reproduced: holder-count chart resources. |
| `/onchain/networks/{network}/tokens/{token_address}/ohlcv/{timeframe}` | Onchain DEX | implemented | Implemented as /onchain/networks/:network/tokens/:address/ohlcv/:timeframe in src/modules/onchain.ts. | Fields reproduced: token ohlcv_list envelope aggregated from pools. |
| `/onchain/networks/{network}/tokens/{token_address}/trades` | Onchain DEX | implemented | Implemented as /onchain/networks/:network/tokens/:address/trades in src/modules/onchain.ts. | Fields reproduced: token trade resources aggregated across pools. |
| `/onchain/categories` | Onchain DEX | implemented | Route registered in src/modules/onchain.ts. | Fields reproduced: category resources with pagination metadata. |
| `/onchain/categories/{category_id}/pools` | Onchain DEX | implemented | Implemented as /onchain/categories/:categoryId/pools in src/modules/onchain.ts. | Fields reproduced: category-scoped pool listing. |
