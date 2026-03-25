#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEARCH_QUERY="${SEARCH_QUERY:-bitcoin}"
TRENDING_LIMIT="${TRENDING_LIMIT:-1}"

# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

module_title "OpenGecko Search Module Checks"

module_section "Search Query"
check_status "GET /search responds" "/search?query=${SEARCH_QUERY}"
check_json_expr "search response groups results by resource family" "/search?query=${SEARCH_QUERY}" 'has("coins") and has("exchanges") and has("icos") and has("categories") and has("nfts")' "search payload exposes grouped result arrays"
check_json_expr "search query bitcoin returns at least one coin hit" "/search?query=bitcoin" '(.coins | type) == "array" and (.coins | length) > 0 and ([.coins[].id | type] | all(. == "string"))' "bitcoin search returns at least one coin result"
check_json_expr "search query stable returns at least one category hit" "/search?query=stable" '(.categories | type) == "array" and (.categories | length) > 0 and ([.categories[].id | type] | all(. == "string"))' "stable search returns at least one category result"

module_section "Trending"
check_status "GET /search/trending responds" "/search/trending"
check_json_expr "trending response returns coin and category groups" "/search/trending" 'has("coins") and has("categories") and has("nfts") and (.coins | type) == "array" and (.categories | type) == "array"' "trending payload exposes grouped arrays"
check_json_expr "trending items include nested item/data structures" "/search/trending" '(.coins | length > 0) and ([.coins[] | has("item") and (.item | has("id") and has("slug") and has("data"))] | all(.))' "trending coin rows include nested item/data payloads"
check_json_expr "trending show_max limits both coin and category groups" "/search/trending?show_max=${TRENDING_LIMIT}" "(.coins | length) <= ${TRENDING_LIMIT} and (.categories | length) <= ${TRENDING_LIMIT}" "show_max limits both coin and category result groups"

module_summary
