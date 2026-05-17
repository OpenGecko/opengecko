#!/usr/bin/env bash
# OpenGecko CoinGecko-Compatible API Endpoint Tester
# Usage: BASE_URL=http://localhost:3000 bash scripts/test-endpoints.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
VERBOSE="${VERBOSE:-0}"
MAX_BODY_CHARS="${MAX_BODY_CHARS:-2000}"
ENDPOINT_CURL_MAX_TIME="${ENDPOINT_CURL_MAX_TIME:-20}"
PASS=0
FAIL=0
SKIP=0
TOTAL=0
MARKET_DATA_READY=0

if [[ ! "$ENDPOINT_CURL_MAX_TIME" =~ ^[1-9][0-9]*$ ]]; then
  echo "ENDPOINT_CURL_MAX_TIME must be a positive integer number of seconds" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d /tmp/opengecko-endpoints.XXXXXX)"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

hr() {
  printf '%0.s─' {1..72}
  echo
}

check() {
  local desc="$1"
  local url="$2"
  local expected_status="${3:-200}"
  TOTAL=$((TOTAL + 1))

  local call_id="${TOTAL}"
  local full_url="${BASE_URL}${url}"
  local body_file="$TMP_DIR/body-${call_id}.json"
  local headers_file="$TMP_DIR/headers-${call_id}.txt"
  local err_file="$TMP_DIR/curl-${call_id}.err"
  local metrics
  local curl_exit_code=0

  metrics=$(curl -sS -D "$headers_file" -o "$body_file" -w '%{http_code}|%{time_total}|%{size_download}|%{content_type}|%{remote_ip}' --max-time "$ENDPOINT_CURL_MAX_TIME" "$full_url" 2>"$err_file") || curl_exit_code=$?

  local http_code
  local time_total
  local size_download
  local content_type
  local remote_ip

  IFS='|' read -r http_code time_total size_download content_type remote_ip <<<"${metrics:-000|0|0|unknown|unknown}"

  local body
  body=$(cat "$body_file" 2>/dev/null || echo "")

  if [[ "$curl_exit_code" -ne 0 && "$http_code" == "000" ]]; then
    http_code="000"
  fi

  if [[ "$http_code" == "$expected_status" ]]; then
    echo -e "  ${GREEN}✅ ${http_code}${NC} ${desc}"
    echo -e "     ${CYAN}${full_url}${NC}"
    if [[ "$VERBOSE" == "1" ]]; then
      echo -e "     ${CYAN}time=${time_total}s size=${size_download}B type=${content_type:-unknown} ip=${remote_ip:-unknown}${NC}"
    fi
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌ ${http_code} (expected ${expected_status})${NC} ${desc}"
    echo -e "     ${CYAN}${full_url}${NC}"
    echo -e "     ${YELLOW}time=${time_total}s size=${size_download}B type=${content_type:-unknown} ip=${remote_ip:-unknown}${NC}"

    if [[ -s "$err_file" ]]; then
      local curl_error
      curl_error=$(cat "$err_file")
      echo -e "     ${YELLOW}curl: ${curl_error}${NC}"
    fi

    if [[ -n "$body" ]]; then
      if echo "$body" | jq . >/dev/null 2>&1; then
        echo -e "     ${YELLOW}Response (pretty, truncated to ${MAX_BODY_CHARS} chars):${NC}"
        echo "$body" | jq -C . 2>/dev/null | head -c "$MAX_BODY_CHARS" | sed 's/^/       /' || true
        echo
      else
        echo -e "     ${YELLOW}Response (raw, truncated to ${MAX_BODY_CHARS} chars):${NC}"
        echo "$body" | head -c "$MAX_BODY_CHARS" | sed 's/^/       /' || true
        echo
      fi
    fi

    FAIL=$((FAIL + 1))
  fi
}

check_json() {
  local desc="$1"
  local url="$2"
  local jq_filter="$3"
  local expected="$4"
  TOTAL=$((TOTAL + 1))

  local full_url="${BASE_URL}${url}"
  local body
  body=$(curl -sS --max-time "$ENDPOINT_CURL_MAX_TIME" "$full_url" 2>/dev/null) || body=""

  local actual
  actual=$(echo "$body" | jq -r "$jq_filter" 2>/dev/null) || actual="JQ_ERROR"

  if [[ "$actual" == "$expected" ]]; then
    echo -e "  ${GREEN}✅${NC} ${desc}"
    echo -e "     ${CYAN}${full_url}${NC}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}❌${NC} ${desc}"
    echo -e "     ${CYAN}${full_url}${NC}"
    echo -e "     ${YELLOW}jq ${jq_filter}${NC}"
    echo -e "     ${YELLOW}Expected: ${expected}${NC}"
    echo -e "     ${YELLOW}Actual:   ${actual}${NC}"
    if [[ -n "$body" ]]; then
      if echo "$body" | jq . >/dev/null 2>&1; then
        echo -e "     ${YELLOW}Body (pretty, truncated to ${MAX_BODY_CHARS} chars):${NC}"
        echo "$body" | jq -C . 2>/dev/null | head -c "$MAX_BODY_CHARS" | sed 's/^/       /' || true
        echo
      else
        echo -e "     ${YELLOW}Body (raw, truncated to ${MAX_BODY_CHARS} chars):${NC}"
        echo "$body" | head -c "$MAX_BODY_CHARS" | sed 's/^/       /' || true
        echo
      fi
    fi
    FAIL=$((FAIL + 1))
  fi
}

peek() {
  local label="$1"
  local url="$2"
  local jq_filter="${3:-.}"
  local full_url="${BASE_URL}${url}"

  local body
  body=$(curl -s --max-time "$ENDPOINT_CURL_MAX_TIME" "$full_url" 2>/dev/null) || body="{}"

  echo -e "  ${CYAN}🔍 ${label}${NC}"
  echo -e "     ${full_url}"
  echo "$body" | timeout 5 jq "$jq_filter" 2>/dev/null | head -30 | sed 's/^/     /' || true
  echo
}

skip_check() {
  local desc="$1"
  local reason="$2"
  TOTAL=$((TOTAL + 1))
  SKIP=$((SKIP + 1))
  echo -e "  ${YELLOW}⏭ SKIP${NC} ${desc}"
  echo -e "     ${YELLOW}${reason}${NC}"
}

wait_for_market_data() {
  local timeout_seconds="${1:-30}"
  local started_at
  started_at=$(date +%s)

  echo -e "${BOLD}⏳ Readiness${NC}"
  echo -e "  Waiting for market snapshots (up to ${timeout_seconds}s)..."

  while true; do
    local body
    body=$(curl -s --max-time 5 "${BASE_URL}/simple/price?ids=bitcoin&vs_currencies=usd" 2>/dev/null) || body="{}"

    if echo "$body" | jq -e '(.bitcoin.usd | type) == "number"' >/dev/null 2>&1; then
      echo -e "  ${GREEN}✅ Market data ready${NC}"
      echo
      MARKET_DATA_READY=1
      return 0
    fi

    local now
    now=$(date +%s)
    if (( now - started_at >= timeout_seconds )); then
      echo -e "  ${YELLOW}⚠ Market data not ready after ${timeout_seconds}s; continuing anyway${NC}"
      echo
      return 1
    fi

    sleep 1
  done
}

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}OpenGecko Endpoint Tester${NC}"
echo -e "Target: ${CYAN}${BASE_URL}${NC}"
echo -e "Time:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo -e "Verbose:${CYAN} ${VERBOSE}${NC} (set VERBOSE=1 for timing/info on passing checks)"
echo -e "Timeout:${CYAN} ${ENDPOINT_CURL_MAX_TIME}s${NC} (set ENDPOINT_CURL_MAX_TIME to tune endpoint request budget)"
echo -e "Body:   ${CYAN}full responses on pass/fail checks${NC}"
hr

wait_for_market_data 30 || true

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}🏥 Health${NC}"
check "GET /ping" "/ping"

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}💰 Simple${NC}"
check "GET /simple/supported_vs_currencies" "/simple/supported_vs_currencies"
check_json "simple/supported_vs_currencies includes usd" "/simple/supported_vs_currencies" 'index("usd") != null' "true"
check_json "simple/supported_vs_currencies includes usdt" "/simple/supported_vs_currencies" 'index("usdt") != null' "true"
check "GET /simple/price" "/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true"
if [[ "$MARKET_DATA_READY" == "1" ]]; then
  check_json "simple/price returns numeric bitcoin.usd" "/simple/price?ids=bitcoin&vs_currencies=usd" '(.bitcoin.usd | type) == "number"' "true"
else
  skip_check "simple/price returns numeric bitcoin.usd" "market snapshots not ready yet"
fi
check "GET /simple/token_price/:id" "/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd"
check "GET /exchange_rates" "/exchange_rates"

peek "simple/price keys" "/simple/price?ids=bitcoin,ethereum&vs_currencies=usd" 'keys'
peek "exchange_rates structure" "/exchange_rates" '.data | keys | .[0:5]'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}🔍 Search${NC}"
check "GET /search?query=bitcoin" "/search?query=bitcoin"
check "GET /search?query=eth" "/search?query=eth"
check "GET /search?query=stable" "/search?query=stable"
check "GET /search/trending" "/search/trending"
check "GET /search/trending?show_max=1" "/search/trending?show_max=1"

peek "search results" "/search?query=bitcoin" '{ coins: (.coins | length), exchanges: (.exchanges | length), categories: (.categories | length), nfts: (.nfts | length) }'
peek "search trending" "/search/trending?show_max=1" '{ coins: (.coins | length), categories: (.categories | length), nfts: (.nfts | length) }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}🌍 Global${NC}"
check "GET /global" "/global"
check "GET /global/market_cap_chart?days=7" "/global/market_cap_chart?vs_currency=usd&days=7"
check_json "global/market_cap_chart exposes freshness/source metadata" "/global/market_cap_chart?vs_currency=usd&days=7" 'has("meta") and (.meta | has("source") and has("fixture") and has("updated_at")) and ((.meta.fixture == true and .meta.source == "fixture") or (.meta.fixture == false and (.meta.updated_at | type == "string")))' "true"
check "GET /global/decentralized_finance_defi" "/global/decentralized_finance_defi"

peek "global structure" "/global" '.data | { active_cryptocurrencies, markets, total_market_cap: (.total_market_cap | keys), total_volume: (.total_volume | keys) }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}🪙 Coins — List & Detail${NC}"
check "GET /coins/list" "/coins/list"
check "GET /coins/list/new" "/coins/list/new"
check_json "coins/list/new exposes freshness/source metadata" "/coins/list/new" 'has("meta") and (.meta.fixture == false) and .meta.source == "catalog" and (.meta.updated_at | type == "string")' "true"
check "GET /coins/list?include_platform=true" "/coins/list?include_platform=true"
check "GET /coins/bitcoin" "/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false"
check "GET /coins/ethereum (full)" "/coins/ethereum"
check "GET /coins/bitcoin?market_data=false" "/coins/bitcoin?market_data=false&localization=false"
check "GET /coins/bitcoin?sparkline=true" "/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=true"
check "GET /coins/bitcoin?include_categories_details=true" "/coins/bitcoin?localization=false&tickers=false&include_categories_details=true"
check "GET /coins/bitcoin?dex_pair_format=symbol" "/coins/bitcoin?localization=false&tickers=false&dex_pair_format=symbol"
check "GET /coins/not-a-coin (404)" "/coins/not-a-coin" "404"

peek "coin detail keys" "/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false" 'keys'
peek "coin detail market_data" "/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false" '.market_data | { current_price: (.current_price | keys), market_cap: (.market_cap | keys), total_volume: (.total_volume | keys) }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}📊 Coins — Markets${NC}"
check "GET /coins/markets" "/coins/markets?vs_currency=usd"
check "GET /coins/markets?per_page=1&page=1" "/coins/markets?vs_currency=usd&per_page=1&page=1"
check "GET /coins/markets?per_page=1&page=2" "/coins/markets?vs_currency=usd&per_page=1&page=2"
check "GET /coins/markets?order=market_cap_asc" "/coins/markets?vs_currency=usd&order=market_cap_asc"
check "GET /coins/markets?sparkline=true" "/coins/markets?vs_currency=usd&sparkline=true"
check "GET /coins/markets?price_change_percentage=24h,7d" "/coins/markets?vs_currency=usd&price_change_percentage=24h,7d"
check "GET /coins/markets?category=smart-contract-platform" "/coins/markets?vs_currency=usd&category=smart-contract-platform"

peek "markets[0] keys" "/coins/markets?vs_currency=usd&per_page=1" '.[0] | keys'
peek "markets[0] price fields" "/coins/markets?vs_currency=usd&per_page=1" '.[0] | { id, current_price, market_cap, total_volume, price_change_percentage_24h }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}📈 Coins — History & Charts${NC}"
check "GET /coins/bitcoin/history?date=20-03-2026" "/coins/bitcoin/history?date=20-03-2026"
check "GET /coins/bitcoin/market_chart?days=7" "/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily"
check "GET /coins/bitcoin/market_chart?days=max" "/coins/bitcoin/market_chart?vs_currency=usd&days=max"
check "GET /coins/bitcoin/market_chart/range" "/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800"
check "GET /coins/bitcoin/ohlc?days=7" "/coins/bitcoin/ohlc?vs_currency=usd&days=7&interval=daily"
check "GET /coins/bitcoin/ohlc?days=30" "/coins/bitcoin/ohlc?vs_currency=usd&days=30&interval=daily"
check "GET /coins/bitcoin/ohlc/range" "/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773446400&to=1773964800&interval=daily"
check "GET /coins/bitcoin/circulating_supply_chart?days=30" "/coins/bitcoin/circulating_supply_chart?days=30"
check "GET /coins/bitcoin/circulating_supply_chart/range" "/coins/bitcoin/circulating_supply_chart/range?from=1773446400&to=1773964800"
check "GET /coins/bitcoin/total_supply_chart?days=30" "/coins/bitcoin/total_supply_chart?days=30"
check "GET /coins/bitcoin/total_supply_chart/range" "/coins/bitcoin/total_supply_chart/range?from=1773446400&to=1773964800"
check "GET /coins/not-a-coin/market_chart (404)" "/coins/not-a-coin/market_chart?vs_currency=usd&days=7" "404"
check "GET /coins/not-a-coin/ohlc (404)" "/coins/not-a-coin/ohlc?vs_currency=usd&days=7" "404"

peek "market_chart structure" "/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily" '{ prices_count: (.prices | length), market_caps_count: (.market_caps | length), total_volumes_count: (.total_volumes | length) }'
peek "ohlc sample" "/coins/bitcoin/ohlc?vs_currency=usd&days=7&interval=daily" '.[0]'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}🏷️ Coins — Tickers${NC}"
check "GET /coins/bitcoin/tickers" "/coins/bitcoin/tickers"
check "GET /coins/bitcoin/tickers?include_exchange_logo=true" "/coins/bitcoin/tickers?include_exchange_logo=true"
check "GET /coins/bitcoin/tickers?exchange_ids=coinbase" "/coins/bitcoin/tickers?exchange_ids=coinbase"
check "GET /coins/bitcoin/tickers?order=volume_asc" "/coins/bitcoin/tickers?order=volume_asc"

peek "tickers structure" "/coins/bitcoin/tickers" '{ name, tickers_count: (.tickers | length), first_ticker: .tickers[0] | { base, target, market: .market.name, last } }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}📂 Coins — Categories${NC}"
check "GET /coins/categories/list" "/coins/categories/list"
check_json "coins/categories/list returns a bare category_id/name array" "/coins/categories/list" 'type == "array" and length > 0 and ([.[] | has("category_id") and has("name") and (.category_id | type == "string" and length > 0) and (.name | type == "string" and length > 0)] | all(.))' "true"
check "GET /coins/categories" "/coins/categories"
check_json "coins/categories marks fixture/live safely" "/coins/categories" 'has("meta") and (.meta | has("fixture") and has("source") and has("updated_at")) and ((.meta.fixture == true and .meta.source == "fixture") or (.meta.fixture == false and .meta.source == "live" and (.meta.updated_at | type == "string")))' "true"
check "GET /coins/categories?order=name_desc" "/coins/categories?order=name_desc"

peek "categories" "/coins/categories" '.[0] | { id, name, market_cap, top_3_coins }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}📝 Coins — Contract Address${NC}"
check "GET /coins/ethereum/contract/0x... (should match or 404)" "/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
check "GET /coins/ethereum/contract/0xinvalid (404)" "/coins/ethereum/contract/0x0000000000000000000000000000000000000000" "404"
check "GET /coins/ethereum/contract/0x.../market_chart (404 for invalid)" "/coins/ethereum/contract/0x0000000000000000000000000000000000000000/market_chart?vs_currency=usd&days=7" "404"
check "GET /coins/ethereum/contract/0x.../market_chart/range (404 for invalid)" "/coins/ethereum/contract/0x0000000000000000000000000000000000000000/market_chart/range?vs_currency=usd&from=0&to=9999999999" "404"

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}🏦 Exchanges${NC}"
check "GET /exchanges/list" "/exchanges/list"
check "GET /exchanges/list?status=inactive" "/exchanges/list?status=inactive"
check "GET /exchanges" "/exchanges?per_page=2&page=1"
check_json "exchanges expose source and freshness fields" "/exchanges?per_page=2&page=1" 'type == "array" and length > 0 and ([.[] | has("source") and has("updated_at") and ((.source == "fixture") or (.source == "live" and (.updated_at | type == "string")))] | all(.))' "true"
check "GET /exchanges?order=trust_score_rank_asc" "/exchanges?order=trust_score_rank_asc"
check "GET /exchanges/binance" "/exchanges/binance"
check_json "exchange detail exposes source and freshness fields" "/exchanges/binance" 'has("source") and has("updated_at") and ((.source == "fixture") or (.source == "live" and (.updated_at | type == "string")))' "true"
check "GET /exchanges/binance?dex_pair_format=contract_address" "/exchanges/binance?dex_pair_format=contract_address"
check "GET /exchanges/binance/tickers" "/exchanges/binance/tickers"
check "GET /exchanges/binance/tickers?coin_ids=ethereum" "/exchanges/binance/tickers?coin_ids=ethereum"
check "GET /exchanges/binance/tickers?depth=true" "/exchanges/binance/tickers?depth=true"
check "GET /exchanges/binance/tickers?order=volume_asc" "/exchanges/binance/tickers?order=volume_asc"
check "GET /exchanges/binance/volume_chart?days=7" "/exchanges/binance/volume_chart?days=7"
check "GET /exchanges/binance/volume_chart/range" "/exchanges/binance/volume_chart/range?from=0&to=4102444800"
check "GET /exchanges/not-an-exchange (404)" "/exchanges/not-an-exchange" "404"

peek "exchanges[0]" "/exchanges?per_page=1" '.[0] | { id, name, trade_volume_24h_btc, tickers_count: (.tickers | length) }'
peek "exchange detail" "/exchanges/binance" '{ id, name, tickers_count: (.tickers | length) }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}📉 Derivatives${NC}"
check "GET /derivatives" "/derivatives"
check "GET /derivatives/exchanges" "/derivatives/exchanges"
check "GET /derivatives/exchanges?order=trade_volume_24h_btc_desc&per_page=1&page=1" "/derivatives/exchanges?order=trade_volume_24h_btc_desc&per_page=1&page=1"
check "GET /derivatives/exchanges/list" "/derivatives/exchanges/list"
check "GET /derivatives/exchanges/binance_futures?include_tickers=true" "/derivatives/exchanges/binance_futures?include_tickers=true"

peek "derivatives[0]" "/derivatives" '.data[0] | { market, symbol, price, basis }'
peek "derivatives_exchanges[0]" "/derivatives/exchanges?per_page=1" '.data[0] | { id, name, trade_volume_24h_btc }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}🏛️ Treasury${NC}"
check "GET /entities/list" "/entities/list"
check "GET /entities/list?entity_type=companies" "/entities/list?entity_type=companies"
check "GET /entities/list?entity_type=countries" "/entities/list?entity_type=countries"
check "GET /companies/public_treasury/bitcoin" "/companies/public_treasury/bitcoin"
check "GET /companies/public_treasury/bitcoin?order=value_desc" "/companies/public_treasury/bitcoin?order=value_desc"
check "GET /public_treasury/strategy" "/public_treasury/strategy"
check "GET /public_treasury/strategy/bitcoin/holding_chart?days=7" "/public_treasury/strategy/bitcoin/holding_chart?days=7"
check "GET /public_treasury/strategy/bitcoin/holding_chart?days=7&include_empty_intervals=true" "/public_treasury/strategy/bitcoin/holding_chart?days=7&include_empty_intervals=true"
check "GET /public_treasury/strategy/transaction_history" "/public_treasury/strategy/transaction_history"
check "GET /public_treasury/strategy/transaction_history?order=date_desc" "/public_treasury/strategy/transaction_history?order=date_desc"
check "GET /public_treasury/not-an-entity (404)" "/public_treasury/not-an-entity" "404"

peek "entities" "/entities/list" '.[0] | { id, name, entity_type }'
peek "treasury detail" "/public_treasury/strategy" '{ id, name, total_current_value_usd, total_unrealized_pnl_usd, holdings_count: (.holdings | length) }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}⛓️ Onchain${NC}"
check "GET /onchain/networks" "/onchain/networks?page=1"
check "GET /onchain/networks/eth/dexes" "/onchain/networks/eth/dexes?page=1"
check "GET /onchain/networks/eth/pools" "/onchain/networks/eth/pools?page=1"
check_json "onchain pools expose safe source/freshness metadata" "/onchain/networks/eth/pools?page=1" 'has("data") and (.data | length > 0) and (.meta | has("source") and has("fixture") and has("updated_at")) and ((.meta.fixture == true and (.meta.source == "seeded" or .meta.source == "fixture")) or (.meta.fixture == false and (.meta.updated_at | type == "string")))' "true"
check "GET /onchain/networks/eth/dexes/uniswap_v3/pools" "/onchain/networks/eth/dexes/uniswap_v3/pools?page=1"
check_json "onchain dex pools expose safe source/freshness metadata" "/onchain/networks/eth/dexes/uniswap_v3/pools?page=1" 'has("data") and (.data | length > 0) and (.meta | has("source") and has("fixture") and has("updated_at")) and ((.meta.fixture == true and (.meta.source == "seeded" or .meta.source == "fixture")) or (.meta.fixture == false and (.meta.updated_at | type == "string")))' "true"
check "GET /onchain/networks/eth/tokens/0x... (USDC)" "/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
check_json "onchain token detail exposes safe source/freshness metadata" "/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" 'has("data") and .data.type == "token" and (.meta | has("source") and has("fixture") and has("updated_at")) and ((.meta.fixture == true and (.meta.source == "seeded" or .meta.source == "fixture")) or (.meta.fixture == false and (.meta.updated_at | type == "string")))' "true"
check "GET /onchain/networks/eth/pools/0x.../trades" "/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?limit=5"
check_json "onchain pool trades expose safe source/freshness metadata" "/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?limit=5" 'has("data") and (.data | length > 0) and (.meta | has("source")) and ((.meta.source == "fixture") or (.meta.source != "fixture" and (.data[0].attributes.block_timestamp | type == "number")))' "true"
check "GET /onchain/networks/eth/new_pools" "/onchain/networks/eth/new_pools?page=1"
check "GET /onchain/networks/new_pools" "/onchain/networks/new_pools?page=1"
check "GET /onchain/networks/trending_pools" "/onchain/networks/trending_pools?page=1"
check "GET /onchain/networks/eth/trending_pools" "/onchain/networks/eth/trending_pools?page=1"
check "GET /onchain/search/pools?query=usdc" "/onchain/search/pools?query=usdc&page=1"
check "GET /onchain/pools/megafilter" "/onchain/pools/megafilter?networks=eth&dexes=uniswap_v3&sort=volume_usd_h24_desc&page=1"
check "GET /onchain/categories" "/onchain/categories?page=1"
check_json "onchain categories expose aggregate rows" "/onchain/categories?page=1" 'has("data") and (.data | length > 0) and .data[0].type == "category" and (.meta | has("page") and has("total_count"))' "true"
check "GET /onchain/networks/eth/pools/0x... (404)" "/onchain/networks/eth/pools/0x0000000000000000000000000000000000000000" "404"
check "GET /onchain/networks/not-a-network/dexes (404)" "/onchain/networks/not-a-network/dexes?page=1" "404"

peek "onchain networks" "/onchain/networks?page=1" '.data[0] | { id, type, attributes: .attributes | { name, chain_identifier } }'
peek "onchain dexes" "/onchain/networks/eth/dexes?page=1" '.data[0] | { id, type, attributes: .attributes | { name } }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}📦 Asset Platforms & Token Lists${NC}"
check "GET /asset_platforms" "/asset_platforms"
check "GET /token_lists/ethereum/all.json" "/token_lists/ethereum/all.json"
check "GET /token_lists/not-a-platform/all.json (404)" "/token_lists/not-a-platform/all.json" "404"

peek "asset_platforms" "/asset_platforms" '.[0] | { id, chain_identifier, name, native_coin_id }'

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}🚫 Invalid Parameters (should return 400)${NC}"
check "GET /simple/price without ids" "/simple/price?vs_currencies=usd" "400"
check "GET /simple/price without vs_currencies" "/simple/price?ids=bitcoin" "400"
check "GET /coins/markets without vs_currency" "/coins/markets" "400"
check "GET /coins/bitcoin/history without date" "/coins/bitcoin/history" "400"
check "GET /coins/bitcoin/market_chart without vs_currency" "/coins/bitcoin/market_chart?days=7" "400"
check "GET /coins/bitcoin/ohlc without vs_currency" "/coins/bitcoin/ohlc?days=7" "400"
check "GET /search without query" "/search" "400"

# ─────────────────────────────────────────────────
echo
echo -e "${BOLD}🧪 Diagnostics${NC}"
check "GET /diagnostics/chain_coverage" "/diagnostics/chain_coverage"
check "GET /diagnostics/ohlcv_sync" "/diagnostics/ohlcv_sync"

# ─────────────────────────────────────────────────
echo
hr
echo
echo -e "${BOLD}Results${NC}"
echo -e "  ${GREEN}✅ Passed: ${PASS}${NC}"
echo -e "  ${RED}❌ Failed: ${FAIL}${NC}"
echo -e "  ${YELLOW}⏭ Skipped: ${SKIP}${NC}"
echo -e "  ${BOLD}   Total:  ${TOTAL}${NC}"
echo

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}Some tests failed.${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
