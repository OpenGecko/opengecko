#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_ID="${NETWORK_ID:-eth}"
DEX_ID="${DEX_ID:-uniswap_v3}"
POOL_ADDRESS="${POOL_ADDRESS:-0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640}"
TOKEN_ADDRESS="${TOKEN_ADDRESS:-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48}"
TIMEFRAME="${TIMEFRAME:-hour}"

# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

module_title "OpenGecko Onchain Module Checks"

module_section "Networks and DEXes"
check_status "GET /onchain/networks responds" "/onchain/networks?page=1"
check_json_expr "network list returns JSON:API resources with pagination metadata" "/onchain/networks?page=1" 'has("data") and (.data | type == "array") and (.data | length > 0) and ([.data[0] | has("id") and .type == "network" and (.attributes | has("name") and has("chain_identifier"))] | all(.)) and (.meta.page == 1)' "network list exposes resource shape and page metadata"
check_status "GET /onchain/networks/:network/dexes responds" "/onchain/networks/${NETWORK_ID}/dexes?page=1"
check_json_expr "network dex list returns dex resources with network metadata" "/onchain/networks/${NETWORK_ID}/dexes?page=1" 'has("data") and (.data | type == "array") and (.data | length > 0) and ([.data[0] | has("id") and .type == "dex" and (.relationships.network.data.id == "'"${NETWORK_ID}"'")] | all(.)) and (.meta.network == "'"${NETWORK_ID}"'")' "dex list keeps JSON:API relationships and network metadata"

module_section "Pools"
check_status "GET /onchain/networks/:network/pools responds" "/onchain/networks/${NETWORK_ID}/pools?page=1"
check_json_expr "pool list returns source-attributed pool resources" "/onchain/networks/${NETWORK_ID}/pools?page=1" 'has("data") and (.data | type == "array") and (.data | length > 0) and ([.data[0] | .type == "pool" and (.attributes | has("address") and has("reserve_usd") and has("volume_usd"))] | all(.)) and (.meta | has("source") and has("fixture") and has("updated_at")) and ((.meta.fixture == true and (.meta.source == "seeded" or .meta.source == "fixture")) or (.meta.fixture == false and (.meta.source != "fixture" and .meta.source != "seeded" and (.meta.updated_at | type == "string"))))' "pool list marks fixture/live state and freshness safely"
check_status "GET /onchain/networks/:network/dexes/:dex/pools responds" "/onchain/networks/${NETWORK_ID}/dexes/${DEX_ID}/pools?page=1"
check_json_expr "dex pool list returns source metadata and pool rows" "/onchain/networks/${NETWORK_ID}/dexes/${DEX_ID}/pools?page=1" 'has("data") and (.data | type == "array") and (.data | length > 0) and (.meta.dex == "'"${DEX_ID}"'") and (.meta | has("source") and has("fixture") and has("updated_at")) and ((.meta.fixture == true and (.meta.source == "seeded" or .meta.source == "fixture")) or (.meta.fixture == false and (.meta.updated_at | type == "string")))' "dex pool list includes source/freshness metadata"
check_status "GET /onchain/networks/:network/pools/:address responds" "/onchain/networks/${NETWORK_ID}/pools/${POOL_ADDRESS}"
check_json_expr "pool detail returns source metadata and pool shape" "/onchain/networks/${NETWORK_ID}/pools/${POOL_ADDRESS}" 'has("data") and (.data.type == "pool") and (.data.attributes.address == "'"${POOL_ADDRESS}"'") and (.meta | has("source") and has("fixture") and has("updated_at")) and ((.meta.fixture == true and (.meta.source == "seeded" or .meta.source == "fixture")) or (.meta.fixture == false and (.meta.updated_at | type == "string")))' "pool detail cannot claim live without freshness/source evidence"

module_section "Tokens"
check_status "GET /onchain/networks/:network/tokens/:address responds" "/onchain/networks/${NETWORK_ID}/tokens/${TOKEN_ADDRESS}"
check_json_expr "token detail returns token resource and source metadata" "/onchain/networks/${NETWORK_ID}/tokens/${TOKEN_ADDRESS}" 'has("data") and (.data.type == "token") and (.data.attributes.address == "'"${TOKEN_ADDRESS}"'") and (.data.attributes | has("price_usd") and has("top_pools")) and (.meta | has("source") and has("fixture") and has("updated_at")) and ((.meta.fixture == true and (.meta.source == "seeded" or .meta.source == "fixture")) or (.meta.fixture == false and (.meta.updated_at | type == "string")))' "token detail exposes freshness/source metadata for fixture/live safety"
check_status "GET /onchain/networks/:network/tokens/:address/pools responds" "/onchain/networks/${NETWORK_ID}/tokens/${TOKEN_ADDRESS}/pools?page=1"
check_json_expr "token pools return pool resources for the requested token" "/onchain/networks/${NETWORK_ID}/tokens/${TOKEN_ADDRESS}/pools?page=1" 'has("data") and (.data | type == "array") and (.data | length > 0) and ([.data[0] | .type == "pool" and (.attributes.base_token_address == "'"${TOKEN_ADDRESS}"'" or .attributes.quote_token_address == "'"${TOKEN_ADDRESS}"'")] | all(.)) and (.meta.token_address == "'"${TOKEN_ADDRESS}"'")' "token pool list remains token-scoped"
check_status "GET /onchain/simple/networks/:network/token_price/:addresses responds" "/onchain/simple/networks/${NETWORK_ID}/token_price/${TOKEN_ADDRESS}?include_market_cap=true&include_24hr_vol=true&include_24hr_price_change=true&include_total_reserve_in_usd=true"
check_json_expr "onchain simple token price returns requested metric maps" "/onchain/simple/networks/${NETWORK_ID}/token_price/${TOKEN_ADDRESS}?include_market_cap=true&include_24hr_vol=true&include_24hr_price_change=true&include_total_reserve_in_usd=true" 'has("data") and (.data.type == "simple_token_price") and (.data.attributes | has("token_prices") and has("market_cap_usd") and has("h24_volume_usd") and has("h24_price_change_percentage") and has("total_reserve_in_usd"))' "simple token price exposes requested metric maps"
check_status "GET /onchain/networks/:network/tokens/:address/info responds" "/onchain/networks/${NETWORK_ID}/tokens/${TOKEN_ADDRESS}/info"
check_json_expr "token info returns updated_at freshness field" "/onchain/networks/${NETWORK_ID}/tokens/${TOKEN_ADDRESS}/info" 'has("data") and (.data.type == "token_info") and (.data.attributes.address == "'"${TOKEN_ADDRESS}"'") and (.data.attributes.updated_at | type == "number")' "token info exposes updated_at freshness"

module_section "Trades and OHLCV"
check_status "GET /onchain/networks/:network/pools/:address/trades responds" "/onchain/networks/${NETWORK_ID}/pools/${POOL_ADDRESS}/trades?limit=5"
check_json_expr "pool trades return source metadata and ordered trade rows" "/onchain/networks/${NETWORK_ID}/pools/${POOL_ADDRESS}/trades?limit=5" 'has("data") and (.data | type == "array") and (.data | length > 0) and ([.data[0] | .type == "trade" and (.attributes | has("tx_hash") and has("block_timestamp") and has("volume_in_usd"))] | all(.)) and (.meta | has("source")) and ((.meta.source == "fixture") or (.meta.source != "fixture" and (.data[0].attributes.block_timestamp | type == "number")))' "pool trades fail unsafe fixture/live claims"
check_status "GET /onchain/networks/:network/pools/:address/ohlcv/:timeframe responds" "/onchain/networks/${NETWORK_ID}/pools/${POOL_ADDRESS}/ohlcv/${TIMEFRAME}?limit=5"
check_json_expr "pool OHLCV returns source-attributed candle lists" "/onchain/networks/${NETWORK_ID}/pools/${POOL_ADDRESS}/ohlcv/${TIMEFRAME}?limit=5" 'has("data") and (.data.type == "ohlcv") and (.data.attributes | has("ohlcv_list") and has("source")) and (.data.attributes.ohlcv_list | type == "array") and (.data.attributes.ohlcv_list | length > 0)' "pool ohlcv includes source-attributed candles"
check_status "GET /onchain/networks/:network/tokens/:address/ohlcv/:timeframe responds" "/onchain/networks/${NETWORK_ID}/tokens/${TOKEN_ADDRESS}/ohlcv/${TIMEFRAME}?limit=5"
check_json_expr "token OHLCV returns source pools for provenance" "/onchain/networks/${NETWORK_ID}/tokens/${TOKEN_ADDRESS}/ohlcv/${TIMEFRAME}?limit=5" 'has("data") and (.data.type == "ohlcv") and (.data.attributes | has("ohlcv_list") and has("source_pools")) and (.data.attributes.ohlcv_list | type == "array") and (.data.attributes.source_pools | type == "array")' "token ohlcv exposes source_pools provenance"

module_section "Categories and Discovery"
check_status "GET /onchain/categories responds" "/onchain/categories?page=1"
check_json_expr "onchain categories return JSON:API resources and pagination metadata" "/onchain/categories?page=1" 'has("data") and (.data | type == "array") and (.data | length > 0) and ([.data[0] | .type == "category" and (.attributes | has("name") and has("pool_count") and has("reserve_in_usd"))] | all(.)) and (.meta.page == 1)' "onchain categories expose category aggregate shape"
check_status "GET /onchain/categories/:category/pools responds" "/onchain/categories/stablecoins/pools?page=1"
check_json_expr "onchain category pools return pool rows for the category" "/onchain/categories/stablecoins/pools?page=1" 'has("data") and (.data | type == "array") and (.data | length > 0) and (.meta.category_id == "stablecoins")' "onchain category pools preserve category metadata"

module_summary
