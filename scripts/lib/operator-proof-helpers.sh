#!/usr/bin/env bash
# Shared helpers for the operator proof smoke script.
# This file is sourced by scripts/operator-proof-smoke.sh and expects that script
# to initialize the proof bundle path variables and counters before sourcing.

json_escape() {
  if [[ "$#" -gt 0 ]]; then
    jq -Rsa . <<<"$1"
  else
    jq -Rsa .
  fi
}

record_command() {
  local phase="$1"
  local command="$2"
  local exit_code="$3"

  jq -nc \
    --arg phase "$phase" \
    --arg command "$command" \
    --argjson exit_code "$exit_code" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{timestamp: $timestamp, phase: $phase, command: $command, exit_code: $exit_code}' >> "$COMMANDS_FILE"
}

record_port_check() {
  local phase="$1"
  local port="$2"
  local status="$3"
  local detail="$4"
  local exit_code="$5"

  jq -nc \
    --arg phase "$phase" \
    --argjson port "$port" \
    --arg status "$status" \
    --arg detail "$detail" \
    --argjson exit_code "$exit_code" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{timestamp: $timestamp, phase: $phase, port: $port, status: $status, detail: $detail, exit_code: $exit_code}' >> "$PORT_CHECKS_FILE"
}

record_server_lifecycle() {
  local phase="$1"
  local port="$2"
  local pid="$3"
  local status="$4"
  local detail="$5"
  local exit_code="${6:-null}"

  if [[ "$exit_code" == "null" ]]; then
    jq -nc \
      --arg phase "$phase" \
      --argjson port "$port" \
      --arg pid "$pid" \
      --arg status "$status" \
      --arg detail "$detail" \
      --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{timestamp: $timestamp, phase: $phase, port: $port, pid: $pid, status: $status, detail: $detail, exit_code: null}' >> "$SERVER_LIFECYCLE_FILE"
  else
    jq -nc \
      --arg phase "$phase" \
      --argjson port "$port" \
      --arg pid "$pid" \
      --arg status "$status" \
      --arg detail "$detail" \
      --argjson exit_code "$exit_code" \
      --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{timestamp: $timestamp, phase: $phase, port: $port, pid: $pid, status: $status, detail: $detail, exit_code: $exit_code}' >> "$SERVER_LIFECYCLE_FILE"
  fi
}

check_reserved_ports_clear() {
  local phase="$1"
  local failed=0

  for port in "${RESERVED_PORTS[@]}"; do
    local pids=""
    pids="$(lsof -ti ":${port}" 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      record_port_check "$phase" "$port" "occupied" "pids=${pids//$'\n'/,}; refusing to touch unknown process" 98
      failed=1
    else
      record_port_check "$phase" "$port" "clear" "no listener found" 0
    fi
  done

  if [[ "$failed" -ne 0 ]]; then
    record_command "reserved-port-${phase}" "check reserved ports 3100 3102 3103 are clear" 98
    return 98
  fi

  record_command "reserved-port-${phase}" "check reserved ports 3100 3102 3103 are clear" 0
}

run_recorded() {
  local phase="$1"
  shift
  local command="$*"
  local exit_code=0

  "$@" || exit_code=$?
  record_command "$phase" "$command" "$exit_code"
  return "$exit_code"
}

mark_failure() {
  local message="$1"
  echo "FAIL: ${message}" >&2
  FAILURES=$((FAILURES + 1))
}

capture_server_log_tail() {
  local port="$1"
  local phase="$2"
  local log_path="$3"
  local output="${PROOF_ROOT}/server-${port}-${phase}-tail.log"

  if [[ -f "$log_path" ]]; then
    tail -n 80 "$log_path" > "$output" 2>/dev/null || true
    printf '%s' "$output"
  else
    printf 'missing-log:%s' "$log_path"
  fi
}

assert_server_running() {
  local port="$1"
  local phase="$2"

  if [[ -z "${SERVER_PID}" || -z "${CURRENT_PORT}" || "$CURRENT_PORT" != "$port" ]]; then
    record_server_lifecycle "$phase" "$port" "${SERVER_PID:-}" "not_owned" "no owned server is currently tracked for this port" 1
    mark_failure "port ${port} lifecycle check failed at ${phase}: no owned server is tracked"
    return 1
  fi

  if kill -0 "$SERVER_PID" >/dev/null 2>&1 && lsof -ti ":${port}" >/dev/null 2>&1; then
    record_server_lifecycle "$phase" "$port" "$SERVER_PID" "running" "owned server process and listener are alive" 0
    return 0
  fi

  local exit_code=1
  set +e
  wait "$SERVER_PID" >/dev/null 2>&1
  exit_code=$?
  set -e
  local tail_path
  tail_path="$(capture_server_log_tail "$port" "$phase" "${PROOF_ROOT}/server-${port}.log")"
  record_server_lifecycle "$phase" "$port" "$SERVER_PID" "exited" "owned server stopped before expected teardown; log_tail=${tail_path}" "$exit_code"
  mark_failure "port ${port} exited during ${phase}; log tail: ${tail_path}"
  SERVER_PID=""
  return 1
}

wait_for_port_clear() {
  local port="$1"
  local started_at
  started_at=$(date +%s)

  while lsof -ti ":${port}" >/dev/null 2>&1; do
    if (( $(date +%s) - started_at > 20 )); then
      return 1
    fi
    sleep 1
  done
}

stop_server() {
  if [[ -n "${SERVER_PID}" ]]; then
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      kill "$SERVER_PID" >/dev/null 2>&1 || true
      local exit_code=0
      set +e
      wait "$SERVER_PID" >/dev/null 2>&1
      exit_code=$?
      set -e
      record_server_lifecycle "stop-${CURRENT_PORT:-unknown}" "${CURRENT_PORT:-0}" "$SERVER_PID" "stopped" "owned server stopped by operator proof teardown" "$exit_code"
    else
      local exit_code=1
      set +e
      wait "$SERVER_PID" >/dev/null 2>&1
      exit_code=$?
      set -e
      record_server_lifecycle "stop-${CURRENT_PORT:-unknown}" "${CURRENT_PORT:-0}" "$SERVER_PID" "already_exited" "owned server had exited before teardown" "$exit_code"
    fi
    SERVER_PID=""
  fi

  if [[ -n "${CURRENT_PORT}" ]]; then
    wait_for_port_clear "$CURRENT_PORT" || mark_failure "port ${CURRENT_PORT} remained occupied after stopping owned server"
    CURRENT_PORT=""
  fi
}

cleanup() {
  stop_server
}

trap cleanup EXIT

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool not found: ${tool}" >&2
    exit 127
  fi
}

default_ccxt_exchanges_csv() {
  local IFS=,
  printf '%s' "${DEFAULT_LIVE_PROMOTION_CCXT_EXCHANGES[*]}"
}

write_versions() {
  local default_ccxt_exchanges
  default_ccxt_exchanges="$(default_ccxt_exchanges_csv)"
  {
    echo "{"
    echo "  \"timestamp\": $(json_escape "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),"
    echo "  \"git_commit\": $(json_escape "$(git rev-parse HEAD)"),"
    echo "  \"git_branch\": $(json_escape "$(git rev-parse --abbrev-ref HEAD)"),"
    echo "  \"package_version\": $(jq -r '.version' package.json | json_escape),"
    echo "  \"package_manager\": $(jq -r '.packageManager' package.json | json_escape),"
    echo "  \"bun_version\": $(bun --version | json_escape),"
    echo "  \"node_version\": $(node --version | json_escape),"
    echo "  \"proof_root\": $(json_escape "$PROOF_ROOT"),"
    echo "  \"database_paths\": {"
    echo "    \"3100\": $(json_escape "$DB_PATH_3100"),"
    echo "    \"3102\": $(json_escape "$DB_PATH_3102"),"
    echo "    \"3103\": $(json_escape "$DB_PATH_3103")"
    echo "  },"
    echo "  \"ports\": [3100, 3102, 3103],"
    echo "  \"runtime_ports\": [3100, 3102, 3103],"
    echo "  \"provider_env\": {"
    echo "    \"OPEN_GECKO_DISABLE_REPO_DOTENV\": $(json_escape "${OPEN_GECKO_DISABLE_REPO_DOTENV:-1}"),"
    echo "    \"DEFILLAMA_BASE_URL\": $(json_escape "${DEFILLAMA_BASE_URL:-https://coins.llama.fi}"),"
    echo "    \"CCXT_EXCHANGES\": $(json_escape "${OPENGECKO_OPERATOR_PROOF_CCXT_EXCHANGES:-${default_ccxt_exchanges}}"),"
    echo "    \"minimum_live_promotion_exchange_attempts\": 12,"
    echo "    \"PROVIDER_FANOUT_CONCURRENCY\": $(json_escape "${PROVIDER_FANOUT_CONCURRENCY:-3}")"
    echo "  },"
    echo "  \"reserved_ports_policy\": \"preflight and post-cleanup checks require mission ports 3100, 3102, and 3103 to be clear; the script refuses to touch unknown listeners\","
    echo "  \"smoke_module_policy\": \"curated serial default: exchanges; skipped available modules are recorded with reasons\","
    echo "  \"credential_policy\": \"public providers only; no private API keys required\","
    echo "  \"repo_data_policy\": \"uses explicit validation SQLite paths under /tmp plus :memory: for validation-control; repo data directory is not required\""
    echo "}"
  } > "${PROOF_ROOT}/environment.json"
}

start_server() {
  local port="$1"
  local db_path="$2"
  local log_path="$3"
  local defillama_base_url="${DEFILLAMA_BASE_URL:-https://coins.llama.fi}"
  local disable_repo_dotenv="${OPEN_GECKO_DISABLE_REPO_DOTENV:-1}"
  local default_ccxt_exchanges
  default_ccxt_exchanges="$(default_ccxt_exchanges_csv)"
  local ccxt_exchanges="${OPENGECKO_OPERATOR_PROOF_CCXT_EXCHANGES:-${default_ccxt_exchanges}}"
  local provider_fanout_concurrency="${PROVIDER_FANOUT_CONCURRENCY:-3}"
  local command="HOST=127.0.0.1 PORT=${port} DATABASE_URL=\"${db_path}\" LOG_LEVEL=warn LOG_PRETTY=false OPEN_GECKO_DISABLE_REPO_DOTENV=\"${disable_repo_dotenv}\" DEFILLAMA_BASE_URL=\"${defillama_base_url}\" CCXT_EXCHANGES=\"${ccxt_exchanges}\" PROVIDER_FANOUT_CONCURRENCY=\"${provider_fanout_concurrency}\" bun run serve"

  if lsof -ti ":${port}" >/dev/null 2>&1; then
    echo "Port ${port} is already in use; refusing to touch unknown process." >&2
    exit 98
  fi

  echo "Starting OpenGecko on port ${port} with validation DB ${db_path}"
  HOST=127.0.0.1 \
    PORT="$port" \
    DATABASE_URL="${db_path}" \
    LOG_LEVEL=warn \
    LOG_PRETTY=false \
    OPEN_GECKO_DISABLE_REPO_DOTENV="${disable_repo_dotenv}" \
    DEFILLAMA_BASE_URL="${defillama_base_url}" \
    CCXT_EXCHANGES="${ccxt_exchanges}" \
    PROVIDER_FANOUT_CONCURRENCY="${provider_fanout_concurrency}" \
    bun run serve >"$log_path" 2>&1 &
  SERVER_PID="$!"
  CURRENT_PORT="$port"
  record_command "start-${port}" "$command" 0
  echo "$SERVER_PID" > "${PROOF_ROOT}/server-${port}.pid"
  record_server_lifecycle "start-${port}" "$port" "$SERVER_PID" "started" "owned server process started; log=${log_path}" 0
}

wait_for_health() {
  local port="$1"
  local started_at
  started_at=$(date +%s)

  while true; do
    if curl -sf --max-time 5 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      record_command "wait-health-${port}" "curl -sf http://127.0.0.1:${port}/health" 0
      return 0
    fi

    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      record_command "wait-health-${port}" "curl -sf http://127.0.0.1:${port}/health" 1
      local tail_path
      tail_path="$(capture_server_log_tail "$port" "wait-health" "${PROOF_ROOT}/server-${port}.log")"
      record_server_lifecycle "wait-health-${port}" "$port" "$SERVER_PID" "exited" "owned server exited before health passed; log_tail=${tail_path}" 1
      return 1
    fi

    if (( $(date +%s) - started_at > 90 )); then
      record_command "wait-health-${port}" "curl -sf http://127.0.0.1:${port}/health" 124
      return 124
    fi

    sleep 1
  done
}

capture_get() {
  local port="$1"
  local label="$2"
  local path="$3"
  local expected_status="${4:-200}"
  local output="${SAMPLES_DIR}/${label}.json"
  local status
  local command="curl -sS -w %{http_code} -o ${output} http://127.0.0.1:${port}${path}"

  status=$(curl -sS --max-time 15 -w '%{http_code}' -o "$output" "http://127.0.0.1:${port}${path}" 2>"${output}.err" || true)
  if [[ "$status" == "$expected_status" ]]; then
    record_command "$label" "$command" 0
    return 0
  fi

  record_command "$label" "$command" 1
  mark_failure "${label} returned HTTP ${status:-000}, expected ${expected_status}"
  return 1
}

capture_post() {
  local port="$1"
  local label="$2"
  local path="$3"
  local body="$4"
  local expected_status="${5:-200}"
  local output="${SAMPLES_DIR}/${label}.json"
  local status
  local command="curl -sS -X POST -H content-type:application/json -d ${body} -w %{http_code} -o ${output} http://127.0.0.1:${port}${path}"

  status=$(curl -sS --max-time 15 -X POST -H 'content-type: application/json' -d "$body" -w '%{http_code}' -o "$output" "http://127.0.0.1:${port}${path}" 2>"${output}.err" || true)
  if [[ "$status" == "$expected_status" ]]; then
    record_command "$label" "$command" 0
    return 0
  fi

  record_command "$label" "$command" 1
  mark_failure "${label} returned HTTP ${status:-000}, expected ${expected_status}"
  return 1
}

assert_jq() {
  local label="$1"
  local file="$2"
  local filter="$3"
  local command="jq -e ${filter} ${file}"

  if jq -e "$filter" "$file" >/dev/null 2>&1; then
    record_command "assert-${label}" "$command" 0
    return 0
  fi

  record_command "assert-${label}" "$command" 1
  mark_failure "jq assertion failed for ${label}: ${filter}"
  return 1
}

wait_for_market_readiness() {
  local port="$1"
  local timeout_seconds="${2:-45}"
  local started_at
  started_at=$(date +%s)

  while true; do
    capture_get "$port" "readiness-simple-price" '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd' 200 || true
    capture_get "$port" "readiness-markets" '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&per_page=2&page=1&sparkline=false' 200 || true
    if jq -e '((.bitcoin.usd? | type == "number") or (.ethereum.usd? | type == "number"))' "${SAMPLES_DIR}/readiness-simple-price.json" >/dev/null 2>&1 \
      || has_finite_market_coin "${SAMPLES_DIR}/readiness-markets.json" "bitcoin" \
      || has_finite_market_coin "${SAMPLES_DIR}/readiness-markets.json" "ethereum"; then
      record_command "wait-market-readiness-${port}" "curl /simple/price or /coins/markets until finite prioritized price/source-backed market row" 0
      return 0
    fi

    if (( $(date +%s) - started_at >= timeout_seconds )); then
      record_command "wait-market-readiness-${port}" "curl /simple/price or /coins/markets until finite prioritized price/source-backed market row" 124
      return 124
    fi

    sleep 2
  done
}

wait_for_initial_sync_completed() {
  local port="$1"
  local timeout_seconds="${2:-90}"
  local started_at
  local output="${SAMPLES_DIR}/initial-sync-ready-${port}.json"
  started_at=$(date +%s)

  while true; do
    local status
    status=$(curl -sS --max-time 10 -w '%{http_code}' -o "$output" "http://127.0.0.1:${port}/diagnostics/runtime" 2>"${output}.err" || true)
    if [[ "$status" == "200" ]] \
      && jq -e '.data.readiness.initial_sync_completed == true' "$output" >/dev/null 2>&1; then
      record_command "wait-initial-sync-${port}" "curl /diagnostics/runtime until initial_sync_completed=true" 0
      return 0
    fi

    if [[ "$port" == "${CURRENT_PORT:-}" ]]; then
      assert_server_running "$port" "wait-initial-sync-${port}" || return 1
    fi

    if (( $(date +%s) - started_at >= timeout_seconds )); then
      record_command "wait-initial-sync-${port}" "curl /diagnostics/runtime until initial_sync_completed=true" 124
      return 124
    fi

    sleep 2
  done
}

has_finite_market_coin() {
  local file="$1"
  local coin="$2"

  jq -e --arg coin "$coin" '
    type == "array"
    and any(.[]; .id == $coin
      and (.current_price | type == "number" and . > 0 and . < 1000000000000000000)
      and (.last_updated | type == "string" and length > 0))
  ' "$file" >/dev/null 2>&1
}

has_finite_ticker_coin() {
  local file="$1"
  local coin="$2"

  jq -e --arg coin "$coin" '
    .tickers | type == "array"
    and any(.[]; .coin_id == $coin
      and (((.converted_last.usd? // .last) | type == "number" and . > 0 and . < 1000000000000000000))
      and (((.timestamp? // null) | type == "number") or (((.last_traded_at? // .last_fetch_at? // null) | type == "string") and ((.last_traded_at? // .last_fetch_at? // null) | length > 0))))
  ' "$file" >/dev/null 2>&1
}

has_recent_chart_points() {
  local file="$1"

  jq -e '
    .prices | type == "array"
    and any(.[]; type == "array"
      and length >= 2
      and (.[0] | type == "number")
      and (.[1] | type == "number" and . > 0 and . < 1000000000000000000))
  ' "$file" >/dev/null 2>&1
}

has_recent_ohlc_points() {
  local file="$1"

  jq -e '
    type == "array"
    and any(.[]; type == "array"
      and length >= 5
      and (.[0] | type == "number")
      and (.[1] | type == "number" and . > 0 and . < 1000000000000000000)
      and (.[2] | type == "number" and . > 0 and . < 1000000000000000000)
      and (.[3] | type == "number" and . > 0 and . < 1000000000000000000)
      and (.[4] | type == "number" and . > 0 and . < 1000000000000000000))
  ' "$file" >/dev/null 2>&1
}

select_source_backed_exchange_id() {
  local diagnostics_file="$1"
  local fallback="${2:-binance}"
  local selected

  selected="$(jq -r '
    first(([
      (.data.exchanges[]? | select((.ticker_evidence.live_row_count // 0) > 0) | .id),
      .data.provider_coverage.live_backed_exchange_ids[0],
      .data.provider_coverage.successful_exchange_ids[0]
    ] | map(select(type == "string" and length > 0)))[]) // empty
  ' "$diagnostics_file" 2>/dev/null)"

  if [[ -n "$selected" && "$selected" != "null" ]]; then
    printf '%s' "$selected"
    return 0
  fi

  printf '%s' "$fallback"
}

write_cross_overlap_evidence() {
  local coin="$1"
  local prefix="$2"
  local exchange_id="$3"

  jq -n \
    --arg coin "$coin" \
    --arg exchange_id "$exchange_id" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg market_route '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&per_page=2&page=1&sparkline=false&price_change_percentage=24h' \
    --arg coin_tickers_route "/coins/${coin}/tickers?depth=true&include_exchange_logo=false&page=1" \
    --arg exchange_tickers_route "/exchanges/${exchange_id}/tickers?coin_ids=bitcoin,ethereum&depth=true&page=1" \
    --arg market_chart_route "/coins/${coin}/market_chart?vs_currency=usd&days=1" \
    --arg ohlc_route "/coins/${coin}/ohlc?vs_currency=usd&days=1" \
    --slurpfile markets "${SAMPLES_DIR}/${prefix}-markets.json" \
    --slurpfile coin_tickers "${SAMPLES_DIR}/${prefix}-${coin}-coin-tickers.json" \
    --slurpfile exchange_tickers "${SAMPLES_DIR}/${prefix}-exchange-tickers.json" \
    --slurpfile exchange_diagnostics "${SAMPLES_DIR}/${prefix}-exchange-diagnostics.json" \
    --slurpfile market_chart "${SAMPLES_DIR}/${prefix}-${coin}-market-chart.json" \
    --slurpfile ohlc "${SAMPLES_DIR}/${prefix}-${coin}-ohlc.json" \
    --slurpfile runtime "${SAMPLES_DIR}/${prefix}-runtime.json" \
    --slurpfile chart_diagnostics "${SAMPLES_DIR}/${prefix}-chart-diagnostics.json" \
    '{
      generated_at: $generated_at,
      matched_coin_id: $coin,
      matched_exchange_id: $exchange_id,
      routes: {
        markets: $market_route,
        coin_tickers: $coin_tickers_route,
        exchange_tickers: $exchange_tickers_route,
        market_chart: $market_chart_route,
        ohlc: $ohlc_route,
        runtime_diagnostics: "/diagnostics/runtime",
        exchange_diagnostics: "/diagnostics/exchanges",
        chart_diagnostics: "/diagnostics/market_charts"
      },
      readiness: {
        finite_market_price: true,
        overlapping_exchange_ticker: true,
        numeric_recent_market_chart: true,
        numeric_recent_ohlc: true,
        provider_variability_classified_by_diagnostics: true
      },
      samples: {
        markets: $markets[0],
        coin_tickers: $coin_tickers[0],
        exchange_tickers: $exchange_tickers[0],
        exchange_diagnostics: $exchange_diagnostics[0],
        market_chart: $market_chart[0],
        ohlc: $ohlc[0],
        runtime_diagnostics: $runtime[0],
        chart_diagnostics: $chart_diagnostics[0]
      }
    }' > "$CROSS_OVERLAP_FILE"
}

wait_for_cross_overlap_readiness() {
  local port="$1"
  local timeout_seconds="${2:-90}"
  local prefix="cross-overlap-readiness"
  local started_at
  started_at=$(date +%s)

  while true; do
    capture_get "$port" "${prefix}-runtime" '/diagnostics/runtime' 200 || true
    capture_get "$port" "${prefix}-exchange-diagnostics" '/diagnostics/exchanges' 200 || true
    capture_get "$port" "${prefix}-chart-diagnostics" '/diagnostics/market_charts' 200 || true
    capture_get "$port" "${prefix}-markets" '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&per_page=2&page=1&sparkline=false&price_change_percentage=24h' 200 || true
    capture_get "$port" "${prefix}-bitcoin-coin-tickers" '/coins/bitcoin/tickers?depth=true&include_exchange_logo=false&page=1' 200 || true
    capture_get "$port" "${prefix}-ethereum-coin-tickers" '/coins/ethereum/tickers?depth=true&include_exchange_logo=false&page=1' 200 || true
    local exchange_id
    exchange_id="$(select_source_backed_exchange_id "${SAMPLES_DIR}/${prefix}-exchange-diagnostics.json" "coinbase")"
    capture_get "$port" "${prefix}-exchange-tickers" "/exchanges/${exchange_id}/tickers?coin_ids=bitcoin,ethereum&depth=true&page=1" 200 || true
    capture_get "$port" "${prefix}-bitcoin-market-chart" '/coins/bitcoin/market_chart?vs_currency=usd&days=1' 200 || true
    capture_get "$port" "${prefix}-ethereum-market-chart" '/coins/ethereum/market_chart?vs_currency=usd&days=1' 200 || true
    capture_get "$port" "${prefix}-bitcoin-ohlc" '/coins/bitcoin/ohlc?vs_currency=usd&days=1' 200 || true
    capture_get "$port" "${prefix}-ethereum-ohlc" '/coins/ethereum/ohlc?vs_currency=usd&days=1' 200 || true

    for coin in bitcoin ethereum; do
      if has_finite_market_coin "${SAMPLES_DIR}/${prefix}-markets.json" "$coin" \
        && { has_finite_ticker_coin "${SAMPLES_DIR}/${prefix}-${coin}-coin-tickers.json" "$coin" || has_finite_ticker_coin "${SAMPLES_DIR}/${prefix}-exchange-tickers.json" "$coin"; } \
        && has_recent_chart_points "${SAMPLES_DIR}/${prefix}-${coin}-market-chart.json" \
        && has_recent_ohlc_points "${SAMPLES_DIR}/${prefix}-${coin}-ohlc.json"; then
        write_cross_overlap_evidence "$coin" "$prefix" "$exchange_id"
        record_command "wait-cross-overlap-readiness-${port}" "curl priority BTC/ETH markets, tickers, chart, OHLC until one live/source-backed overlap is finite" 0
        return 0
      fi
    done

    if (( $(date +%s) - started_at >= timeout_seconds )); then
      jq -n \
        --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg reason "timed out waiting for finite BTC/ETH market, ticker, chart, and OHLC overlap" \
        --slurpfile runtime "${SAMPLES_DIR}/${prefix}-runtime.json" \
        --slurpfile markets "${SAMPLES_DIR}/${prefix}-markets.json" \
        --slurpfile exchange_tickers "${SAMPLES_DIR}/${prefix}-exchange-tickers.json" \
        --slurpfile chart_diagnostics "${SAMPLES_DIR}/${prefix}-chart-diagnostics.json" \
        '{
          generated_at: $generated_at,
          readiness: {
            finite_market_price: false,
            overlapping_exchange_ticker: false,
            numeric_recent_market_chart: false,
            numeric_recent_ohlc: false
          },
          reason: $reason,
          samples: {
            runtime_diagnostics: $runtime[0],
            markets: $markets[0],
            exchange_tickers: $exchange_tickers[0],
            chart_diagnostics: $chart_diagnostics[0]
          }
        }' > "$CROSS_OVERLAP_FILE"
      record_command "wait-cross-overlap-readiness-${port}" "curl priority BTC/ETH markets, tickers, chart, OHLC until one live/source-backed overlap is finite" 124
      return 124
    fi

    sleep 3
  done
}

run_smoke_modules_serially() {
  local base_url="$1"
  local module_list="${OPENGECKO_OPERATOR_PROOF_SMOKE_MODULES:-${DEFAULT_SMOKE_MODULES[*]}}"
  local modules=()
  local available_module

  if [[ -z "${module_list// }" ]]; then
    module_list="${DEFAULT_SMOKE_MODULES[*]}"
    record_command "smoke-modules-default" "OPENGECKO_OPERATOR_PROOF_SMOKE_MODULES is empty; using curated default modules: ${module_list}" 0
  fi

  read -r -a modules <<< "$module_list"
  if [[ "${module_list}" == "all" ]]; then
    modules=("${ALL_SMOKE_MODULES[@]}")
  fi

  for available_module in "${ALL_SMOKE_MODULES[@]}"; do
    local selected=0
    local selected_module
    for selected_module in "${modules[@]}"; do
      if [[ "$selected_module" == "$available_module" || "$selected_module" == "all-endpoints" ]]; then
        selected=1
        break
      fi
    done
    if [[ "$selected" -eq 0 ]]; then
      jq -nc \
        --arg module "$available_module" \
        --arg reason "not selected by OPENGECKO_OPERATOR_PROOF_SMOKE_MODULES curated serial list" \
        --arg selected_modules "${modules[*]}" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{timestamp: $timestamp, module: $module, reason: $reason, selected_modules: $selected_modules}' >> "$SMOKE_SKIPPED_FILE"
    fi
  done

  for module in "${modules[@]}"; do
    local command
    local script_path="scripts/modules/${module}/${module}.sh"
    if [[ "$module" == "all-endpoints" ]]; then
      command="BASE_URL=${base_url} bun run test:endpoint"
    else
      command="BASE_URL=${base_url} bun run test:endpoint:${module}"
    fi

    if [[ "$module" != "all-endpoints" && ! -f "$script_path" ]]; then
      jq -nc \
        --arg module "$module" \
        --arg reason "module script not found: ${script_path}" \
        --arg command "$command" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{timestamp: $timestamp, module: $module, reason: $reason, command: $command}' >> "$SMOKE_SKIPPED_FILE"
      record_command "smoke-${module}" "$command" 127
      mark_failure "smoke module ${module} has no script"
      continue
    fi

    echo "Running serial smoke module: ${module}"
    set +e
    if [[ "$module" == "all-endpoints" ]]; then
      BASE_URL="$base_url" bun run test:endpoint > "${PROOF_ROOT}/smoke-${module}.log" 2>&1
    else
      BASE_URL="$base_url" bun run "test:endpoint:${module}" > "${PROOF_ROOT}/smoke-${module}.log" 2>&1
    fi
    local exit_code=$?
    set -e
    if [[ "$exit_code" -eq 0 ]]; then
      record_command "smoke-${module}" "$command" 0
    else
      record_command "smoke-${module}" "$command" "$exit_code"
      mark_failure "smoke module ${module} failed"
    fi
    jq -nc \
      --arg module "$module" \
      --arg command "$command" \
      --arg log "${PROOF_ROOT}/smoke-${module}.log" \
      --argjson exit_code "$exit_code" \
      --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{timestamp: $timestamp, module: $module, command: $command, exit_code: $exit_code, log: $log}' >> "$SMOKE_EXECUTED_FILE"
  done
}

run_data_quality_gate_serially() {
  local base_url="$1"
  local command="BASE_URL=${base_url} bash scripts/data-quality-gate.sh"
  local log_path="${PROOF_ROOT}/data-quality-gate.log"

  echo "Running serial data-quality gate: ${base_url}"
  set +e
  BASE_URL="$base_url" bash scripts/data-quality-gate.sh > "$log_path" 2>&1
  local exit_code=$?
  set -e

  record_command "data-quality-gate" "$command" "$exit_code"
  if [[ "$exit_code" -ne 0 ]]; then
    if data_quality_gate_failure_is_pending_scope "$log_path"; then
      jq -n \
        --arg log "$log_path" \
        --arg reason "only pending-scope non-provider live-data families were below threshold; provider/runtime lifecycle checks remain valid" \
        '{status: "pending_scope", reason: $reason, log: $log}' > "${PROOF_ROOT}/data-quality-gate-pending-scope.json"
      record_command "data-quality-gate-pending-scope" "classify data-quality gate failure as pending-scope context" 0
      return 0
    fi

    mark_failure "data-quality gate failed"
  fi

  return 0
}

data_quality_gate_failure_is_pending_scope() {
  local log_path="$1"
  local family
  local families

  if grep -q 'reason_codes:.*runtime_degraded' "$log_path"; then
    return 1
  fi

  if grep -Eiq 'unreachable|malformed|overclaim|cross[-_ ]route|unsafe SQLite|public route comparison.*false|within_tolerance: false' "$log_path"; then
    return 1
  fi

  families="$(grep '^- family:' "$log_path" | awk '{print $3}' | sort -u)"
  if [[ -z "$families" ]]; then
    return 1
  fi

  while IFS= read -r family; do
    case "$family" in
      treasury|onchain|derivatives|supply) ;;
      *) return 1 ;;
    esac
  done <<< "$families"

  return 0
}

run_hot_route_consistency_check_serially() {
  local base_url="$1"
  local command="BASE_URL=${base_url} bash scripts/hot-route-consistency-check.sh"

  echo "Running serial hot-route consistency check: ${base_url}"
  set +e
  BASE_URL="$base_url" bash scripts/hot-route-consistency-check.sh > "${PROOF_ROOT}/hot-route-consistency-check.log" 2>&1
  local exit_code=$?
  set -e

  record_command "hot-route-consistency-check" "$command" "$exit_code"
  if [[ "$exit_code" -ne 0 ]]; then
    mark_failure "hot-route consistency check failed"
  fi

  return 0
}

write_live_promotion_evidence() {
  local port="$1"
  local prefix="$2"
  local configured_csv
  configured_csv="${OPENGECKO_OPERATOR_PROOF_CCXT_EXCHANGES:-$(default_ccxt_exchanges_csv)}"

  capture_get "$port" "${prefix}-live-promotion-runtime" '/diagnostics/runtime' 200 || true
  capture_get "$port" "${prefix}-live-promotion-exchanges" '/diagnostics/exchanges' 200 || true
  capture_get "$port" "${prefix}-live-promotion-data-quality" '/diagnostics/data_quality' 200 || true
  capture_get "$port" "${prefix}-live-promotion-coverage" '/diagnostics/coverage_matrix' 200 || true
  capture_get "$port" "${prefix}-live-promotion-onchain" '/diagnostics/onchain' 200 || true

  jq -n \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg configured_csv "$configured_csv" \
    --slurpfile runtime "${SAMPLES_DIR}/${prefix}-live-promotion-runtime.json" \
    --slurpfile exchanges "${SAMPLES_DIR}/${prefix}-live-promotion-exchanges.json" \
    --slurpfile quality "${SAMPLES_DIR}/${prefix}-live-promotion-data-quality.json" \
    --slurpfile coverage "${SAMPLES_DIR}/${prefix}-live-promotion-coverage.json" \
    --slurpfile onchain "${SAMPLES_DIR}/${prefix}-live-promotion-onchain.json" \
    '
      ($configured_csv | split(",") | map(select(length > 0))) as $configured_ids
      | ($exchanges[0].data.provider_coverage // {}) as $exchange_coverage
      | ($exchanges[0].data.providers // []) as $exchange_providers
      | ($quality[0].data.families // []) as $families
      | ($coverage[0].data.entries // []) as $coverage_entries
      | ($families | map(select(.family == "simple"))[0] // {}) as $simple
      | ($families | map(select(.family == "coins"))[0] // {}) as $coins
      | ($families | map(select(.family == "exchanges"))[0] // {}) as $exchange_family
      | ($families | map(select(.family == "onchain"))[0] // {}) as $onchain_family
      | ($coverage_entries | map(select(.family == "simple"))[0] // {}) as $simple_coverage
      | ($coverage_entries | map(select(.family == "coins_markets"))[0] // {}) as $coins_coverage
      | ($families | map(select((.source.state // "") == "live" and (((.source.ownership_class // "") != "live") or ((.source.fallback // false) == true))))) as $non_live_overclaims
      | ($exchange_providers | map(select((.failed // false) == true or (.blocked // false) == true))) as $blocked_or_unavailable_providers
      | {
          generated_at: $generated_at,
          assertions: ["VAL-LIVE-001", "VAL-LIVE-002", "VAL-LIVE-003", "VAL-LIVE-004", "VAL-LIVE-005", "VAL-LIVE-006"],
          exchange_attempts: {
            configured_exchange_ids: ($exchange_coverage.configured_exchange_ids // $configured_ids),
            configured_exchange_count: ($exchange_coverage.configured_exchange_count // ($configured_ids | length)),
            attempted_exchange_ids: ($exchange_coverage.attempted_exchange_ids // []),
            attempted_exchange_count: ($exchange_coverage.attempted_exchange_count // 0),
            promotion_attempted_exchange_ids: ($exchange_coverage.promotion_attempted_exchange_ids // $exchange_coverage.attempted_exchange_ids // []),
            promotion_attempted_exchange_count: ($exchange_coverage.promotion_attempted_exchange_count // $exchange_coverage.attempted_exchange_count // 0),
            successful_exchange_ids: ($exchange_coverage.successful_exchange_ids // []),
            successful_exchange_count: ($exchange_coverage.successful_exchange_count // 0),
            live_backed_exchange_ids: ($exchange_coverage.live_backed_exchange_ids // []),
            live_backed_exchange_count: ($exchange_coverage.live_backed_exchange_count // 0),
            failed_exchange_ids: ($exchange_coverage.failed_exchange_ids // []),
            failed_exchange_count: ($exchange_coverage.failed_exchange_count // 0),
            blocked_exchange_ids: ($exchange_coverage.blocked_exchange_ids // []),
            blocked_exchange_count: ($exchange_coverage.blocked_exchange_count // 0),
            unavailable_exchange_ids: ($exchange_coverage.unavailable_exchange_ids // []),
            unavailable_exchange_count: ($exchange_coverage.unavailable_exchange_count // 0),
            minimum_promotion_attempt_count: 12,
            attempted_minimum_met: (($exchange_coverage.promotion_attempted_exchange_count // $exchange_coverage.attempted_exchange_count // 0) >= 12),
            source_backed_route: "/diagnostics/exchanges"
          },
          blocked_or_unavailable: {
            provider_count: ($blocked_or_unavailable_providers | length),
            providers: $blocked_or_unavailable_providers,
            visible: (($blocked_or_unavailable_providers | length) == 0 or all($blocked_or_unavailable_providers[]; (((.failure_kind // .failure_reason // "") | tostring | length) > 0) or (.attempt_status == "blocked_by_breaker"))),
            note: "Blocked/unavailable providers are diagnostic facts and never count as live evidence."
          },
          hot_market: {
            simple_state: ($simple.source.state // "unknown"),
            simple_ownership_class: ($simple.source.ownership_class // "unknown"),
            simple_freshness_status: ($simple.freshness_budget.status // "unknown"),
            coins_state: ($coins.source.state // "unknown"),
            coverage_states: {
              simple: ($simple_coverage.data_fidelity.source_state // "unknown"),
              coins_markets: ($coins_coverage.data_fidelity.source_state // "unknown")
            },
            source_backed: (($simple.source.state // "") == "live" and ($simple.freshness_budget.counts_as_live_freshness_evidence // false) == true)
          },
          exchange_family: {
            state: ($exchange_family.source.state // "unknown"),
            ownership_class: ($exchange_family.source.ownership_class // "unknown"),
            source_backed: (($exchange_coverage.live_backed_exchange_count // 0) > 0),
            route_evidence: ["/exchanges", "/exchanges/{id}/tickers", "/diagnostics/exchanges"]
          },
          onchain_external: {
            state: ($onchain_family.source.state // "unknown"),
            ownership_class: ($onchain_family.source.ownership_class // "unknown"),
            provider_ids: ($onchain_family.source.provider_ids // []),
            fallback: ($onchain_family.source.fallback // true),
            honest: (($onchain_family.source.state // "") != "live" or ((($onchain_family.source.provider_ids // []) | length) > 0 and (($onchain_family.source.fallback // true) == false))),
            diagnostics_sample: $onchain[0].data
          },
          live_data_rules: {
            non_live_overclaims: $non_live_overclaims,
            fixture_seeded_replay_contract_only_do_not_count_as_live: ($non_live_overclaims | length) == 0,
            source_states_observed: ($families | map({family, state: .source.state, ownership_class: .source.ownership_class, fallback: .source.fallback}))
          },
          raw_samples: {
            runtime: $runtime[0],
            exchanges: $exchanges[0],
            data_quality: $quality[0],
            coverage: $coverage[0]
          }
        }
    ' > "$LIVE_PROMOTION_FILE"

  assert_jq "live-promotion-attempts-at-least-12" "$LIVE_PROMOTION_FILE" '.exchange_attempts.attempted_minimum_met == true' || true
  assert_jq "live-promotion-has-live-backed-exchange" "$LIVE_PROMOTION_FILE" '.exchange_attempts.live_backed_exchange_count >= 1' || true
  assert_jq "live-promotion-blocked-provider-visibility" "$LIVE_PROMOTION_FILE" '.blocked_or_unavailable.visible == true' || true
  assert_jq "live-promotion-no-non-live-overclaims" "$LIVE_PROMOTION_FILE" '.live_data_rules.fixture_seeded_replay_contract_only_do_not_count_as_live == true' || true
  assert_jq "live-promotion-hot-market-fresh-live" "$LIVE_PROMOTION_FILE" '.hot_market.source_backed == true' || true
  assert_jq "live-promotion-onchain-external-honest" "$LIVE_PROMOTION_FILE" '.onchain_external.honest == true' || true
}

sample_priority_routes() {
  local port="$1"
  local prefix="$2"

  capture_get "$port" "${prefix}-ping" '/ping' 200 || true
  capture_get "$port" "${prefix}-health" '/health' 200 || true
  capture_get "$port" "${prefix}-runtime" '/diagnostics/runtime' 200 || true
  capture_get "$port" "${prefix}-jobs" '/diagnostics/jobs' 200 || true
  capture_get "$port" "${prefix}-cache" '/diagnostics/cache' 200 || true
  capture_get "$port" "${prefix}-coverage" '/diagnostics/coverage_matrix' 200 || true
  capture_get "$port" "${prefix}-exchange-diagnostics" '/diagnostics/exchanges' 200 || true
  capture_get "$port" "${prefix}-chart-diagnostics" '/diagnostics/market_charts' 200 || true
  local exchange_id
  exchange_id="$(select_source_backed_exchange_id "${SAMPLES_DIR}/${prefix}-exchange-diagnostics.json" "coinbase")"
  capture_get "$port" "${prefix}-simple-price" '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_last_updated_at=true' 200 || true
  capture_get "$port" "${prefix}-markets" '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&per_page=2&page=1&sparkline=false&price_change_percentage=24h' 200 || true
  capture_get "$port" "${prefix}-coin-detail" '/coins/bitcoin?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false' 200 || true
  capture_get "$port" "${prefix}-coin-tickers" "/coins/bitcoin/tickers?exchange_ids=${exchange_id}&depth=true&include_exchange_logo=false&page=1" 200 || true
  capture_get "$port" "${prefix}-exchanges" '/exchanges?per_page=5&page=1' 200 || true
  capture_get "$port" "${prefix}-exchange-tickers" "/exchanges/${exchange_id}/tickers?coin_ids=bitcoin&depth=true&page=1" 200 || true
  capture_get "$port" "${prefix}-market-chart" '/coins/bitcoin/market_chart?vs_currency=usd&days=1' 200 || true
  capture_get "$port" "${prefix}-ohlc" '/coins/bitcoin/ohlc?vs_currency=usd&days=1' 200 || true

  assert_jq "${prefix}-runtime-has-readiness" "${SAMPLES_DIR}/${prefix}-runtime.json" '.data.readiness.state | type == "string"' || true
  assert_jq "${prefix}-jobs-has-scheduler" "${SAMPLES_DIR}/${prefix}-jobs.json" '.data.scheduler.enabled | type == "boolean"' || true
  assert_jq "${prefix}-markets-is-array" "${SAMPLES_DIR}/${prefix}-markets.json" 'type == "array"' || true
  assert_jq "${prefix}-exchange-tickers-shape" "${SAMPLES_DIR}/${prefix}-exchange-tickers.json" '.tickers | type == "array"' || true
  assert_jq "${prefix}-chart-shape" "${SAMPLES_DIR}/${prefix}-market-chart.json" '.prices | type == "array"' || true
  assert_jq "${prefix}-ohlc-shape" "${SAMPLES_DIR}/${prefix}-ohlc.json" 'type == "array"' || true
}

write_summary() {
  local final_exit_code="$1"

  jq -n \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg proof_root "$PROOF_ROOT" \
    --arg commands_file "$COMMANDS_FILE" \
    --arg environment_file "${PROOF_ROOT}/environment.json" \
    --arg port_checks_file "$PORT_CHECKS_FILE" \
    --arg server_lifecycle_file "$SERVER_LIFECYCLE_FILE" \
    --arg cross_overlap_file "$CROSS_OVERLAP_FILE" \
    --arg live_promotion_file "$LIVE_PROMOTION_FILE" \
    --arg smoke_executed_file "$SMOKE_EXECUTED_FILE" \
    --arg smoke_skipped_file "$SMOKE_SKIPPED_FILE" \
    --arg samples_dir "$SAMPLES_DIR" \
    --argjson failures "$FAILURES" \
    --argjson exit_code "$final_exit_code" \
    '{
      generated_at: $generated_at,
      proof_root: $proof_root,
      environment_file: $environment_file,
      commands_file: $commands_file,
      port_checks_file: $port_checks_file,
      server_lifecycle_file: $server_lifecycle_file,
      cross_overlap_file: $cross_overlap_file,
      live_promotion_file: $live_promotion_file,
      smoke_executed_file: $smoke_executed_file,
      smoke_skipped_file: $smoke_skipped_file,
      samples_dir: $samples_dir,
      failures: $failures,
      exit_code: $exit_code,
      states: ["first_run_ready", "healthy", "degraded_but_serving", "recovered"],
      assertions: ["VAL-CROSS-001", "VAL-CROSS-002", "VAL-CROSS-003", "VAL-CROSS-004", "VAL-CROSS-005", "VAL-CROSS-006", "VAL-CROSS-007", "VAL-CROSS-008", "VAL-CROSS-009", "VAL-CROSS-010", "VAL-CROSS-011", "VAL-LIVE-001", "VAL-LIVE-002", "VAL-LIVE-003", "VAL-LIVE-004", "VAL-LIVE-005", "VAL-LIVE-006"]
    }' > "$SUMMARY_FILE"
}

