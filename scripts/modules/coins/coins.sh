#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COIN_ID="${COIN_ID:-bitcoin}"
PLATFORM_ID="${PLATFORM_ID:-ethereum}"
CONTRACT_ADDRESS="${CONTRACT_ADDRESS:-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48}"
VS_CURRENCY="${VS_CURRENCY:-usd}"
HISTORY_DATE="${HISTORY_DATE:-20-03-2026}"
MARKET_CHART_RANGE_FROM="${MARKET_CHART_RANGE_FROM:-1773446400}"
MARKET_CHART_RANGE_TO="${MARKET_CHART_RANGE_TO:-1773964800}"

# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

module_title "OpenGecko Coins Module Checks"

module_section "Registry"
check_status "GET /coins/list responds" "/coins/list"
check_json_expr "coin list returns id/symbol/name rows" "/coins/list" 'type == "array" and length > 0 and ([.[0] | has("id") and has("symbol") and has("name")] | all(.))' "coin list returns the base registry fields"
check_json_expr "coin list includes platform data when requested" "/coins/list?include_platform=true" 'type == "array" and length > 0 and ([.[0] | has("platforms")] | all(.))' "coin list adds platforms when include_platform=true"
check_status "GET /coins/list/new responds" "/coins/list/new"
check_json_expr "new listings return a coins envelope with listing timestamps" "/coins/list/new" 'has("coins") and (.coins | type) == "array" and (.coins | length) > 0 and ([.coins[] | has("id") and has("activated_at")] | all(.))' "new listings are wrapped in a coins array with activation timestamps"

module_section "Markets"
check_status "GET /coins/markets responds" "/coins/markets?vs_currency=${VS_CURRENCY}&per_page=10&page=1"
check_json_expr "market rows expose core pricing fields" "/coins/markets?vs_currency=${VS_CURRENCY}&per_page=10&page=1" 'type == "array" and length > 0 and ([.[0] | has("id") and has("current_price") and has("market_cap") and has("price_change_percentage_24h")] | all(.))' "market rows expose id, price, market cap, and 24h change"
check_json_expr "market category filters keep the request contract shape" "/coins/markets?vs_currency=${VS_CURRENCY}&category=smart-contract-platform" 'type == "array"' "category filter returns an array payload even when seeded categories are sparse"
check_status "GET /coins/top_gainers_losers responds" "/coins/top_gainers_losers?vs_currency=${VS_CURRENCY}"
check_json_expr "top gainers/losers returns both collections" "/coins/top_gainers_losers?vs_currency=${VS_CURRENCY}" 'has("top_gainers") and has("top_losers") and (.top_gainers | type) == "array" and (.top_losers | type) == "array"' "top gainers/losers returns paired arrays"

module_section "Detail"
check_status "GET /coins/:id responds" "/coins/${COIN_ID}"
check_json_expr "coin detail includes market data and ticker arrays by default" "/coins/${COIN_ID}" 'has("id") and has("market_data") and (.market_data | type) == "object" and has("tickers") and (.tickers | type) == "array"' "coin detail includes market data and tickers"
check_json_expr "coin detail can omit market data explicitly" "/coins/${COIN_ID}?market_data=false&localization=false" 'has("market_data") and (.market_data == null)' "market_data=false nulls the market_data field"
check_json_expr "coin detail can include category details" "/coins/${COIN_ID}?localization=false&tickers=false&include_categories_details=true" 'has("categories") and has("categories_details")' "include_categories_details adds category detail metadata"

module_section "History and Charts"
check_status "GET /coins/:id/history responds" "/coins/${COIN_ID}/history?date=${HISTORY_DATE}"
check_json_expr "coin history keeps the historical detail contract shape" "/coins/${COIN_ID}/history?date=${HISTORY_DATE}" 'has("id") and has("market_data") and has("tickers") and (.tickers | type) == "array"' "history payload preserves the detail contract shape even when historical market data is null"
check_status "GET /coins/:id/market_chart responds" "/coins/${COIN_ID}/market_chart?vs_currency=${VS_CURRENCY}&days=7&interval=daily"
check_json_expr "market chart returns price, market cap, and volume series" "/coins/${COIN_ID}/market_chart?vs_currency=${VS_CURRENCY}&days=7&interval=daily" 'has("prices") and has("market_caps") and has("total_volumes") and (.prices | type) == "array" and (.prices | length) > 0' "market chart returns all three named series"
check_status "GET /coins/:id/market_chart/range responds" "/coins/${COIN_ID}/market_chart/range?vs_currency=${VS_CURRENCY}&from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}"
check_json_expr "market chart range keeps the named-series contract shape" "/coins/${COIN_ID}/market_chart/range?vs_currency=${VS_CURRENCY}&from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}" 'has("prices") and has("market_caps") and has("total_volumes") and (.prices | type) == "array"' "market_chart/range preserves the named series payload even when the range is empty"
check_status "GET /coins/:id/ohlc responds" "/coins/${COIN_ID}/ohlc?vs_currency=${VS_CURRENCY}&days=7&interval=daily"
check_json_expr "ohlc returns 5-value candle tuples" "/coins/${COIN_ID}/ohlc?vs_currency=${VS_CURRENCY}&days=7&interval=daily" 'type == "array" and length > 0 and ([.[0] | length == 5 and (.[0] | type) == "number"] | all(.))' "ohlc returns [timestamp, open, high, low, close] tuples"
check_status "GET /coins/:id/ohlc/range responds" "/coins/${COIN_ID}/ohlc/range?vs_currency=${VS_CURRENCY}&from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}&interval=daily"
check_json_expr "ohlc range keeps the candle-array contract shape" "/coins/${COIN_ID}/ohlc/range?vs_currency=${VS_CURRENCY}&from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}&interval=daily" 'type == "array"' "ohlc/range preserves the candle-array payload even when the range is empty"
check_status "GET /coins/:id/circulating_supply_chart responds" "/coins/${COIN_ID}/circulating_supply_chart?days=30"
check_json_expr "supply charts return named series envelopes" "/coins/${COIN_ID}/circulating_supply_chart?days=30" 'has("circulating_supply") and (.circulating_supply | type) == "array"' "circulating supply chart returns a named series"
check_status "GET /coins/:id/total_supply_chart/range responds" "/coins/${COIN_ID}/total_supply_chart/range?from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}"
check_json_expr "total supply chart range returns named series envelopes" "/coins/${COIN_ID}/total_supply_chart/range?from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}" 'has("total_supply") and (.total_supply | type) == "array"' "total supply chart range returns a named series"

module_section "Tickers and Categories"
check_status "GET /coins/:id/tickers responds" "/coins/${COIN_ID}/tickers"
check_json_expr "coin tickers return exchange metadata and price fields" "/coins/${COIN_ID}/tickers" 'has("name") and (.tickers | type) == "array" and (.tickers | length) > 0 and ([.tickers[] | has("base") and has("target") and has("market") and has("last")] | all(.))' "coin tickers expose pair, market, and price fields"
check_json_expr "coin ticker exchange filter can isolate coinbase rows" "/coins/${COIN_ID}/tickers?exchange_ids=coinbase" '(.tickers | type) == "array" and ([.tickers[].market.identifier] | all(. == "coinbase"))' "exchange_ids filter limits rows to coinbase"
check_status "GET /coins/categories/list responds" "/coins/categories/list"
check_json_expr "category list returns category_id/name rows" "/coins/categories/list" 'type == "array" and length > 0 and ([.[0] | has("category_id") and has("name")] | all(.))' "category list returns identifier/name rows"
check_status "GET /coins/categories responds" "/coins/categories?order=name_desc"
check_json_expr "categories return market-cap metadata and top coin lists" "/coins/categories?order=name_desc" 'type == "array" and length > 0 and ([.[0] | has("id") and has("market_cap") and has("top_3_coins")] | all(.))' "categories expose market cap and top_3_coins"

module_section "Contract Address"
check_status "GET /coins/:platform/contract/:address responds" "/coins/${PLATFORM_ID}/contract/${CONTRACT_ADDRESS}?localization=false&tickers=false&community_data=false&developer_data=false"
check_json_expr "contract route resolves the seeded USDC contract" "/coins/${PLATFORM_ID}/contract/${CONTRACT_ADDRESS}?localization=false&tickers=false&community_data=false&developer_data=false" '.id == "usd-coin" and .detail_platforms.ethereum.contract_address == "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"' "contract route resolves usd-coin by the seeded ethereum address"
check_status "GET /coins/:platform/contract/:address/market_chart responds" "/coins/${PLATFORM_ID}/contract/${CONTRACT_ADDRESS}/market_chart?vs_currency=${VS_CURRENCY}&days=7"
check_json_expr "contract market chart returns named series" "/coins/${PLATFORM_ID}/contract/${CONTRACT_ADDRESS}/market_chart?vs_currency=${VS_CURRENCY}&days=7" 'has("prices") and (.prices | type) == "array"' "contract market chart returns price series"
check_status "GET /coins/:platform/contract/:address/market_chart/range responds" "/coins/${PLATFORM_ID}/contract/${CONTRACT_ADDRESS}/market_chart/range?vs_currency=${VS_CURRENCY}&from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}"
check_json_expr "contract market chart range returns named series" "/coins/${PLATFORM_ID}/contract/${CONTRACT_ADDRESS}/market_chart/range?vs_currency=${VS_CURRENCY}&from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}" 'has("prices") and (.prices | type) == "array"' "contract market chart range returns price series"

module_summary
