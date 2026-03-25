#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VS_CURRENCY="${VS_CURRENCY:-usd}"
MARKET_CAP_DAYS="${MARKET_CAP_DAYS:-7}"

# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

module_title "OpenGecko Global Module Checks"

module_section "Aggregate Market Snapshot"
check_status "GET /global responds" "/global"
check_json_expr "global response returns aggregate market fields" "/global" 'has("data") and (.data | has("active_cryptocurrencies") and has("markets") and has("total_market_cap") and has("total_volume") and has("market_cap_percentage") and has("updated_at"))' "global payload contains aggregate market snapshot fields"
check_json_expr "global totals include usd market cap and volume entries" "/global" '(.data.total_market_cap.usd | type) == "number" and (.data.total_volume.usd | type) == "number"' "global totals include numeric usd market cap and volume"

module_section "Global Market Cap Chart"
check_status "GET /global/market_cap_chart responds" "/global/market_cap_chart?vs_currency=${VS_CURRENCY}&days=${MARKET_CAP_DAYS}"
check_json_expr "market cap chart returns timestamp/value pairs" "/global/market_cap_chart?vs_currency=${VS_CURRENCY}&days=${MARKET_CAP_DAYS}" 'has("market_cap_chart") and (.market_cap_chart | type) == "array" and (.market_cap_chart | length) > 0 and ([.market_cap_chart[] | length == 2 and (.[0] | type) == "number" and (.[1] | type) == "number"] | all(.))' "market_cap_chart contains numeric [timestamp, market_cap] tuples"

module_section "DeFi Snapshot"
check_status "GET /global/decentralized_finance_defi responds" "/global/decentralized_finance_defi"
check_json_expr "defi response returns aggregate defi fields" "/global/decentralized_finance_defi" 'has("data") and (.data | has("defi_market_cap") and has("eth_market_cap") and has("defi_to_eth_ratio") and has("trading_volume_24h") and has("defi_dominance") and has("top_coin_name"))' "defi payload contains aggregate DeFi fields"
check_json_expr "defi response returns numeric market totals" "/global/decentralized_finance_defi" '(.data.defi_market_cap | type) == "number" and (.data.trading_volume_24h | type) == "number"' "defi market cap and trading volume are numeric"

module_summary
