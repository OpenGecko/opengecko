#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXCHANGE_ID="${EXCHANGE_ID:-binance}"
DERIVATIVES_EXCHANGE_ID="${DERIVATIVES_EXCHANGE_ID:-binance_futures}"
VOLUME_RANGE_FROM="${VOLUME_RANGE_FROM:-0}"
VOLUME_RANGE_TO="${VOLUME_RANGE_TO:-4102444800}"

# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

module_title "OpenGecko Exchanges Module Checks"

module_section "Exchange List"
check_status "GET /exchanges/list responds" "/exchanges/list"
check_json_expr "exchange list returns exchange identifiers" "/exchanges/list" 'type == "array" and length > 0 and ([.[].id | type] | all(. == "string")) and ([.[].name | type] | all(. == "string"))' "exchange list contains id/name rows"
check_json_expr "inactive exchange list returns an empty array" "/exchanges/list?status=inactive" 'type == "array" and length == 0' "inactive status yields no seeded exchanges"

module_section "Exchange Detail"
check_status "GET /exchanges paginates exchange summaries" "/exchanges?per_page=2&page=1"
check_json_expr "exchange summaries include ranking and volume fields" "/exchanges?per_page=2&page=1" 'type == "array" and length > 0 and ([.[0] | has("id") and has("name") and has("trust_score_rank") and has("trade_volume_24h_btc")] | all(.))' "exchange summaries expose ranking and btc volume fields"
check_status "GET /exchanges/:id responds" "/exchanges/${EXCHANGE_ID}"
check_json_expr "exchange detail returns overview fields and ticker array" "/exchanges/${EXCHANGE_ID}" 'has("id") and has("name") and has("centralized") and (.tickers | type) == "array" and (.tickers | length > 0)' "exchange detail contains overview metadata and embedded tickers"
check_status "GET /exchanges/:id with contract-address formatting responds" "/exchanges/${EXCHANGE_ID}?dex_pair_format=contract_address"
check_json_expr "contract-address formatting rewrites seeded USDC base" "/exchanges/${EXCHANGE_ID}?dex_pair_format=contract_address" '(.tickers | map(select(.coin_id == "usd-coin")) | length > 0) and ((.tickers | map(select(.coin_id == "usd-coin"))[0].base) == "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")' "usd-coin ticker base is rendered as a contract address"

module_section "Exchange Tickers"
check_status "GET /exchanges/:id/tickers responds" "/exchanges/${EXCHANGE_ID}/tickers"
check_json_expr "exchange tickers return market metadata and pair fields" "/exchanges/${EXCHANGE_ID}/tickers" 'has("name") and (.tickers | type) == "array" and (.tickers | length > 0) and ([.tickers[] | has("base") and has("target") and has("market") and (.market | has("identifier") and has("name"))] | all(.))' "ticker payload includes market metadata and pair fields"
check_json_expr "coin_ids filter narrows to the requested asset" "/exchanges/${EXCHANGE_ID}/tickers?coin_ids=ethereum&order=volume_asc" '(.tickers | length) == 1 and .tickers[0].coin_id == "ethereum"' "coin_ids filter returns only ethereum rows"
check_json_expr "depth=true adds depth-cost fields" "/exchanges/${EXCHANGE_ID}/tickers?coin_ids=usd-coin&depth=true&dex_pair_format=contract_address" '(.tickers | length) == 1 and (.tickers[0] | has("cost_to_move_up_usd") and has("cost_to_move_down_usd") and .base == "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")' "depth-enabled tickers include order-book cost fields"

module_section "Exchange Volume"
check_status "GET /exchanges/:id/volume_chart responds" "/exchanges/${EXCHANGE_ID}/volume_chart?days=7"
check_json_expr "volume chart returns timestamp/value pairs" "/exchanges/${EXCHANGE_ID}/volume_chart?days=7" 'type == "array" and length > 0 and ([.[0] | length == 2 and (.[0] | type) == "number" and (.[1] | type) == "number"] | all(.))' "volume_chart returns numeric [timestamp, volume] tuples"
check_status "GET /exchanges/:id/volume_chart/range responds" "/exchanges/${EXCHANGE_ID}/volume_chart/range?from=${VOLUME_RANGE_FROM}&to=${VOLUME_RANGE_TO}"
check_json_expr "volume chart range returns ascending timestamp/value pairs" "/exchanges/${EXCHANGE_ID}/volume_chart/range?from=${VOLUME_RANGE_FROM}&to=${VOLUME_RANGE_TO}" 'type == "array" and length > 0 and ([.[0] | length == 2 and (.[0] | type) == "number" and (.[1] | type) == "number"] | all(.))' "volume_chart/range returns numeric [timestamp, volume] tuples"

module_section "Derivatives"
check_status "GET /derivatives responds" "/derivatives"
check_json_expr "derivatives list exposes contract-level market fields" "/derivatives" 'type == "array" and length > 0 and ([.[0] | has("market") and has("symbol") and has("price") and has("contract_type")] | all(.))' "derivatives rows expose market, symbol, price, and contract type"
check_status "GET /derivatives/exchanges responds" "/derivatives/exchanges?order=trade_volume_24h_btc_desc&per_page=1&page=1"
check_json_expr "derivatives exchanges include open-interest and volume fields" "/derivatives/exchanges?order=trade_volume_24h_btc_desc&per_page=1&page=1" 'type == "array" and length == 1 and ([.[0] | has("id") and has("open_interest_btc") and has("trade_volume_24h_btc")] | all(.))' "derivatives exchange summaries expose open interest and volume"
check_status "GET /derivatives/exchanges/list responds" "/derivatives/exchanges/list"
check_status "GET /derivatives/exchanges/:id responds" "/derivatives/exchanges/${DERIVATIVES_EXCHANGE_ID}?include_tickers=true"
check_json_expr "derivatives exchange detail can include ticker payloads" "/derivatives/exchanges/${DERIVATIVES_EXCHANGE_ID}?include_tickers=true" 'has("id") and has("name") and (.tickers | type) == "array" and (.tickers | length > 0) and ([.tickers[] | has("symbol") and has("contract_type") and has("trade_volume_24h_btc")] | all(.))' "derivatives exchange detail includes seeded contract rows"

module_summary
