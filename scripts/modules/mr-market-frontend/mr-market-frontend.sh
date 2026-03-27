#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

COIN_ID="${COIN_ID:-bitcoin}"
VS_CURRENCY="${VS_CURRENCY:-usd}"
MARKET_CHART_RANGE_FROM="${MARKET_CHART_RANGE_FROM:-1773446400}"
MARKET_CHART_RANGE_TO="${MARKET_CHART_RANGE_TO:-1773964800}"

module_title "OpenGecko Mr.Market Frontend Contract Checks"

module_section "List Contract"
check_status "GET /coins/markets responds" "/coins/markets?vs_currency=${VS_CURRENCY}&per_page=10&page=1"
check_json_expr "markets returns frontend-required list fields" "/coins/markets?vs_currency=${VS_CURRENCY}&per_page=10&page=1" 'length > 0 and (.[0] | has("id") and has("symbol") and has("image") and has("market_cap_rank") and has("market_cap") and has("current_price") and has("price_change_percentage_24h"))' "first market row contains the fields required by the frontend list view"
check_json_expr "markets returns sortable numeric-or-null values" "/coins/markets?vs_currency=${VS_CURRENCY}&per_page=10&page=1" 'length > 0 and ((.[0].market_cap_rank == null or (.[0].market_cap_rank | type) == "number") and (.[0].current_price == null or (.[0].current_price | type) == "number") and (.[0].price_change_percentage_24h == null or (.[0].price_change_percentage_24h | type) == "number"))' "list sorting fields are numeric when present"
check_json_expr "markets returns non-empty identifiers and non-negative price fields" "/coins/markets?vs_currency=${VS_CURRENCY}&per_page=10&page=1" 'length > 0 and ((.[0].id | type) == "string" and (.[0].id | length) > 0) and ((.[0].symbol | type) == "string" and (.[0].symbol | length) > 0) and ((.[0].image == null) or ((.[0].image | type) == "string" and (.[0].image | length) > 0)) and (.[0].market_cap_rank == null or ((.[0].market_cap_rank | type) == "number" and .[0].market_cap_rank > 0)) and (.[0].market_cap == null or ((.[0].market_cap | type) == "number" and .[0].market_cap >= 0)) and (.[0].current_price == null or ((.[0].current_price | type) == "number" and .[0].current_price >= 0))' "first market row carries usable ids and non-negative market values"
check_json_expr "representative frontend-critical market rows return usable images" "/coins/markets?vs_currency=${VS_CURRENCY}&ids=bitcoin,ethereum,solana,ripple,dogecoin" 'length == 5 and ([.[].image | type == "string" and length > 0] | all(.))' "representative frontend-critical list rows carry non-null non-empty image strings"

module_section "Detail Contract"
check_status "GET /coins/:id responds" "/coins/${COIN_ID}"
check_json_expr "coin detail returns frontend-required header and info fields" "/coins/${COIN_ID}" 'has("id") and has("symbol") and has("name") and (.image | type) == "object" and (.image | has("thumb")) and ((.image.thumb == null) or ((.image.thumb | type) == "string")) and (.description | type) == "object" and (.description | has("en")) and has("genesis_date") and (.market_data | type) == "object" and (.market_data | has("current_price")) and (.market_data.current_price | has("usd")) and (.market_data.current_price.usd == null or (.market_data.current_price.usd | type) == "number") and (.market_data.price_change_percentage_24h == null or (.market_data.price_change_percentage_24h | type) == "number") and (.market_data.price_change_24h == null or (.market_data.price_change_24h | type) == "number") and (.tickers | type) == "array"' "coin detail payload contains the fields required by the frontend detail page"
check_json_expr "coin detail returns ticker market identifiers for pair sorting" "/coins/${COIN_ID}" '(.tickers | type) == "array" and ((.tickers | length) == 0 or ([.tickers[].market.identifier | type] | all(. == "string")))' "every ticker exposes market.identifier when tickers are present"
check_json_expr "coin detail returns the requested coin and non-empty display fields" "/coins/${COIN_ID}" '.id == "'"${COIN_ID}"'" and (.symbol | type) == "string" and (.symbol | length) > 0 and (.name | type) == "string" and (.name | length) > 0 and (.image.thumb == null or ((.image.thumb | type) == "string" and (.image.thumb | length) > 0)) and (.market_data.current_price.usd == null or ((.market_data.current_price.usd | type) == "number" and .market_data.current_price.usd >= 0))' "coin detail matches the requested id and carries usable display values"
check_json_expr "coin detail ticker identifiers are non-empty when present" "/coins/${COIN_ID}" '(.tickers | type) == "array" and ((.tickers | length) == 0 or ([.tickers[].market.identifier | type == "string" and length > 0] | all(.)))' "every ticker exposes a non-empty market.identifier when tickers are present"
check_json_expr "representative frontend-critical detail rows return usable image objects" "/coins/${COIN_ID}" '(.image.thumb | type) == "string" and (.image.thumb | length) > 0 and (.image.small | type) == "string" and (.image.small | length) > 0 and (.image.large | type) == "string" and (.image.large | length) > 0' "representative frontend-critical detail rows carry non-null non-empty image fields"

module_section "Chart Contract"
check_status "GET /coins/:id/market_chart responds" "/coins/${COIN_ID}/market_chart?vs_currency=${VS_CURRENCY}&days=7"
check_json_expr "market chart returns frontend-required prices series" "/coins/${COIN_ID}/market_chart?vs_currency=${VS_CURRENCY}&days=7" '(.prices | type) == "array" and ((.prices | length) == 0 or ([.prices[] | (length == 2 and (.[0] | type) == "number" and (.[1] == null or (.[1] | type) == "number"))] | all(.)))' "market_chart returns prices as [timestamp, price] pairs"
check_json_expr "market chart returns ascending non-negative price points" "/coins/${COIN_ID}/market_chart?vs_currency=${VS_CURRENCY}&days=7" '(.prices | type) == "array" and ((.prices | length) < 2 or ([range(0; (.prices | length) - 1) as $i | .prices[$i][0] <= .prices[$i + 1][0]] | all(.))) and ((.prices | length) == 0 or ([.prices[] | (.[1] == null or ((.[1] | type) == "number" and .[1] >= 0))] | all(.)))' "market_chart timestamps are ascending and price values stay non-negative when present"
check_status "GET /coins/:id/market_chart/range responds" "/coins/${COIN_ID}/market_chart/range?vs_currency=${VS_CURRENCY}&from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}"
check_json_expr "market chart range returns frontend-required prices series" "/coins/${COIN_ID}/market_chart/range?vs_currency=${VS_CURRENCY}&from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}" '(.prices | type) == "array" and ((.prices | length) == 0 or ([.prices[] | (length == 2 and (.[0] | type) == "number" and (.[1] == null or (.[1] | type) == "number"))] | all(.)))' "market_chart/range returns prices as [timestamp, price] pairs"
check_json_expr "market chart range returns ascending non-negative price points" "/coins/${COIN_ID}/market_chart/range?vs_currency=${VS_CURRENCY}&from=${MARKET_CHART_RANGE_FROM}&to=${MARKET_CHART_RANGE_TO}" '(.prices | type) == "array" and ((.prices | length) < 2 or ([range(0; (.prices | length) - 1) as $i | .prices[$i][0] <= .prices[$i + 1][0]] | all(.))) and ((.prices | length) == 0 or ([.prices[] | (.[1] == null or ((.[1] | type) == "number" and .[1] >= 0))] | all(.)))' "market_chart/range timestamps are ascending and price values stay non-negative when present"

module_section "Ticker Endpoint"
check_status "GET /coins/:id/tickers responds" "/coins/${COIN_ID}/tickers"
check_json_expr "coin tickers endpoint returns frontend-usable pair fields" "/coins/${COIN_ID}/tickers" 'has("tickers") and (.tickers | type) == "array" and ((.tickers | length) == 0 or ([.tickers[] | has("base") and has("target") and has("last") and has("market") and (.market | has("identifier") and has("name"))] | all(.)))' "coin tickers endpoint exposes pair display and sorting fields"
check_json_expr "coin tickers endpoint returns non-empty symbols and non-negative last prices" "/coins/${COIN_ID}/tickers" 'has("tickers") and (.tickers | type) == "array" and ((.tickers | length) == 0 or ([.tickers[] | (.base | type) == "string" and (.base | length) > 0 and (.target | type) == "string" and (.target | length) > 0 and (.market.identifier | type) == "string" and (.market.identifier | length) > 0 and (.market.name | type) == "string" and (.market.name | length) > 0 and (.last == null or ((.last | type) == "number" and .last >= 0))] | all(.)))' "coin tickers expose usable pair labels and non-negative last prices when present"

module_summary
