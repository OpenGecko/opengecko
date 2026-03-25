#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSET_PLATFORM_ID="${ASSET_PLATFORM_ID:-ethereum}"
TOKEN_CONTRACT="${TOKEN_CONTRACT:-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48}"

# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

module_title "OpenGecko Assets Module Checks"

module_section "Asset Platforms"
check_status "GET /asset_platforms responds" "/asset_platforms"
check_json_expr "asset platforms return id/name/chain fields" "/asset_platforms" 'type == "array" and length > 0 and ([.[0] | has("id") and has("name") and has("chain_identifier") and has("native_coin_id")] | all(.))' "asset platform rows include identifier, name, chain, and native coin fields"
check_json_expr "asset platforms include ethereum" "/asset_platforms" 'map(.id) | index("ethereum") != null' "ethereum platform is present"
check_json_expr "nft filter returns only nft-capable platforms" "/asset_platforms?filter=nft" 'type == "array" and length > 0 and ([.[].id] | index("ethereum") != null)' "nft filter returns the seeded nft-capable platform set"

module_section "Token Lists"
check_status "GET /token_lists/:id/all.json responds" "/token_lists/${ASSET_PLATFORM_ID}/all.json"
check_json_expr "token list returns uniswap-style metadata envelope" "/token_lists/${ASSET_PLATFORM_ID}/all.json" 'has("name") and has("timestamp") and has("version") and has("keywords") and has("tokens") and (.tokens | type) == "array"' "token list exposes metadata envelope and token array"
check_json_expr "ethereum token list includes the seeded USDC contract" "/token_lists/${ASSET_PLATFORM_ID}/all.json" "(.tokens | map(select(.address == \"${TOKEN_CONTRACT}\")) | length) == 1" "ethereum token list includes the seeded USDC contract"
check_json_expr "token entries include decimals and gecko id extension" "/token_lists/${ASSET_PLATFORM_ID}/all.json" '(.tokens | map(select(.address == "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"))[0] | has("decimals") and (.extensions.geckoId == "usd-coin"))' "USDC token entry includes decimals and gecko id extension"

module_summary
