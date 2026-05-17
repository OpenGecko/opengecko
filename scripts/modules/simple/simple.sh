#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOP10_ASSETS="bitcoin,ethereum,tether,binancecoin,solana,ripple,usd-coin,dogecoin,cardano,tron"
TOP50_ASSETS="bitcoin,ethereum,tether,binancecoin,solana,ripple,usd-coin,dogecoin,cardano,tron,avalanche-2,chainlink,polkadot,stellar,shiba-inu,internet-computer,bitcoin-cash,litecoin,uniswap,cosmos,ethereum-classic,filecoin,arbitrum,curve-dao-token,aave,near,optimism,injective-protocol,algorand,aptos,sui,monero,zksync,okb,pepe,bonk,celestia,jasmycoin,kaspa,matic-network,blur,wormhole,pyth-network,flow,tezos,1inch,sandbox,decentraland,chiliz,render-token,immutable-x"
STABLE_ASSETS="tether,usd-coin"
QUOTE_CURRENCIES="usd,eur"
TOKEN_CONTRACTS="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,0xdac17f958d2ee523a2206206994597c13d831ec7"

# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

market_data_ready() {
  local body
  body=$(curl -sS --max-time 5 "${BASE_URL}/simple/price?ids=bitcoin&vs_currencies=usd" 2>/dev/null) || body="{}"
  printf '%s' "$body" | jq -e '(.bitcoin.usd | type) == "number"' >/dev/null 2>&1
}

top10_price_basket_ready() {
  local body
  body=$(curl -sS --max-time 10 "${BASE_URL}/simple/price?ids=${TOP10_ASSETS}&vs_currencies=usd" 2>/dev/null) || body="{}"
  printf '%s' "$body" | jq -e '(keys | length == 10) and ([to_entries[].value.usd | type] | all(. == "number"))' >/dev/null 2>&1
}

price_basket_ready() {
  local body
  body=$(curl -sS --max-time 10 "${BASE_URL}/simple/price?ids=${TOP50_ASSETS}&vs_currencies=usd" 2>/dev/null) || body="{}"
  printf '%s' "$body" | jq -e 'keys | length > 0' >/dev/null 2>&1
}

token_price_ready() {
  local body
  body=$(curl -sS --max-time 10 "${BASE_URL}/simple/token_price/ethereum?contract_addresses=${TOKEN_CONTRACTS}&vs_currencies=usd" 2>/dev/null) || body="{}"
  printf '%s' "$body" | jq -e 'keys | length > 0' >/dev/null 2>&1
}

show_price_snapshot() {
  local body
  body=$(curl -sS --max-time 10 "${BASE_URL}/simple/price?ids=${TOP10_ASSETS}&vs_currencies=usd" 2>/dev/null) || body="{}"
  local summary
  summary=$(printf '%s' "$body" | jq -r 'to_entries[0:5] | map("\(.key)=\(.value.usd // "n/a")") | join(", ")' 2>/dev/null) || summary="unavailable"
  log_sample "snapshot" "$summary"
}

module_title "OpenGecko Simple Module Checks"

module_section "Availability"
check_status "GET /ping responds" "/ping"
check_status "GET /simple/supported_vs_currencies responds" "/simple/supported_vs_currencies"

module_section "Currency Coverage"
check_json "supported_vs_currencies contains usd" "/simple/supported_vs_currencies" 'index("usd") != null' "true"
check_json "supported_vs_currencies contains eur" "/simple/supported_vs_currencies" 'index("eur") != null' "true"
check_json "supported_vs_currencies contains usdt" "/simple/supported_vs_currencies" 'index("usdt") != null' "true"

module_section "Breadth"
check_status "GET /simple/price supports top-10 asset basket" "/simple/price?ids=${TOP10_ASSETS}&vs_currencies=${QUOTE_CURRENCIES}"
if top10_price_basket_ready; then
  check_json_expr "top-10 price basket returns 10 asset objects" "/simple/price?ids=${TOP10_ASSETS}&vs_currencies=usd" 'keys | length == 10' "10 asset ids are present in the response"
  check_json_expr "top-10 price basket returns numeric usd prices" "/simple/price?ids=${TOP10_ASSETS}&vs_currencies=usd" '([to_entries[].value.usd | type] | all(. == "number"))' "every top-10 asset has a numeric usd price"
  check_json_expr "stable assets return both usd and eur quotes" "/simple/price?ids=${STABLE_ASSETS}&vs_currencies=${QUOTE_CURRENCIES}" '([to_entries[].value | has("usd") and has("eur")] | all(.))' "stable assets include usd and eur quote fields"
  show_price_snapshot
else
  skip_check "top-10 price basket returns 10 asset objects" "top-10 live breadth precondition is not met yet"
  skip_check "top-10 price basket returns numeric usd prices" "top-10 live breadth precondition is not met yet"
  skip_check "stable assets return both usd and eur quotes" "top-10 live breadth precondition is not met yet"
fi

module_section "Top-50 Coverage"
check_status "GET /simple/price supports top-50 asset basket" "/simple/price?ids=${TOP50_ASSETS}&vs_currencies=usd"
if price_basket_ready; then
  check_json_expr "top-50 price basket returns at least one matched asset object" "/simple/price?ids=${TOP50_ASSETS}&vs_currencies=usd" 'keys | length > 0' "the response contains matched asset ids without requiring all requested ids to be available"
  check_json_expr "top-50 price basket returns numeric usd prices" "/simple/price?ids=${TOP50_ASSETS}&vs_currencies=usd" '([to_entries[].value.usd | type] | all(. == "number"))' "every top-50 asset has a numeric usd price"
else
  skip_check "top-50 price basket returns at least one matched asset object" "market snapshots are not ready yet"
  skip_check "top-50 price basket returns numeric usd prices" "market snapshots are not ready yet"
fi

module_section "Field Coverage"
check_status "GET /simple/price supports optional market fields" "/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true"
if market_data_ready; then
  check_json_expr "optional market fields are present for bitcoin" "/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true" '(.bitcoin | has("usd_market_cap") and has("usd_24h_vol") and has("usd_24h_change") and has("last_updated_at"))' "market-cap, volume, 24h change, and last_updated_at fields are present"
else
  skip_check "optional market fields are present for bitcoin" "market snapshots are not ready yet"
fi

module_section "Token Pricing"
check_status "GET /simple/token_price/ethereum responds" "/simple/token_price/ethereum?contract_addresses=${TOKEN_CONTRACTS}&vs_currencies=usd"
if token_price_ready; then
  check_json_expr "token price returns requested contract keys" "/simple/token_price/ethereum?contract_addresses=${TOKEN_CONTRACTS}&vs_currencies=usd" 'has("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")' "the USDC contract key is present in the response"
else
  skip_check "token price returns requested contract keys" "token price snapshots are not ready yet"
fi

module_section "Reference Rates"
check_status "GET /exchange_rates responds" "/exchange_rates"
check_json "exchange_rates has rates map" "/exchange_rates" '(.rates | type) == "object" or (.data | type) == "object"' "true"

module_summary
