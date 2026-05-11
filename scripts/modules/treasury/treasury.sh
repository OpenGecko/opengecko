#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITY_ID="${ENTITY_ID:-strategy}"
COIN_ID="${COIN_ID:-bitcoin}"

# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

module_title "OpenGecko Treasury Module Checks"

module_section "Treasury Listings"
check_status "GET /entities/list responds" "/entities/list?entity_type=companies&page=1&per_page=10"
check_json_expr "entities list returns data envelope and fixture/live metadata" "/entities/list?entity_type=companies&page=1&per_page=10" 'has("data") and (.data | type == "array") and (.data | length > 0) and (.meta | has("fixture") and has("source") and has("updated_at"))' "entities list marks treasury source state"
check_status "GET /companies/public_treasury/:coin responds" "/companies/public_treasury/${COIN_ID}?per_page=50&page=1"
check_json_expr "treasury by coin returns aggregate and company rows" "/companies/public_treasury/${COIN_ID}?per_page=50&page=1" 'has("data") and (.data.coin_id == "'"${COIN_ID}"'") and (.data | has("total_holdings") and has("total_value_usd") and has("companies")) and (.data.companies | type == "array") and (.meta | has("fixture") and has("source") and has("updated_at") and has("fallback_rows_count"))' "coin treasury exposes aggregate rows and explicit source/fallback metadata"

module_section "Treasury Entity"
check_status "GET /public_treasury/:entity responds" "/public_treasury/${ENTITY_ID}"
check_json_expr "treasury profile returns holdings and source metadata" "/public_treasury/${ENTITY_ID}" 'has("data") and (.data.id == "'"${ENTITY_ID}"'") and (.data.holdings | type == "array") and (.data | has("total_current_value_usd")) and (.meta | has("fixture") and has("source") and has("updated_at") and has("fallback_rows_count"))' "entity profile exposes holdings plus source/fallback metadata"
check_status "GET /public_treasury/:entity/transaction_history responds" "/public_treasury/${ENTITY_ID}/transaction_history?per_page=100&page=1"
check_json_expr "treasury transaction history returns paginated rows and source metadata" "/public_treasury/${ENTITY_ID}/transaction_history?per_page=100&page=1" 'has("data") and (.data.transactions | type == "array") and (.data.transactions | length > 0) and ([.data.transactions[] | has("date") and has("source_url") and has("coin_id") and has("holding_balance")] | all(.)) and (.meta | has("fixture") and has("source") and has("updated_at") and has("transaction_count"))' "transaction history supports daily sweep verification metadata"
check_status "GET /public_treasury/:entity/:coin/holding_chart responds" "/public_treasury/${ENTITY_ID}/${COIN_ID}/holding_chart?days=30&include_empty_intervals=true"
check_json_expr "treasury holding chart returns tuple arrays and fallback metadata" "/public_treasury/${ENTITY_ID}/${COIN_ID}/holding_chart?days=30&include_empty_intervals=true" 'has("data") and (.data.holdings | type == "array") and (.data.holding_value_in_usd | type == "array") and (.meta | has("fixture") and has("source") and has("updated_at"))' "holding chart preserves tuple arrays and explicit fallback/live state"

module_summary
