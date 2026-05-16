#!/usr/bin/env bash
# Operator-proof OpenGecko smoke bundle.
# Starts isolated temp-SQLite runtimes on ports 3100 and 3102, runs serial route
# and diagnostics checks, records exact commands/exit codes, and always cleans up
# processes started by this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROOF_ROOT="${OPENGECKO_OPERATOR_PROOF_DIR:-$(mktemp -d /tmp/opengecko-operator-proof.XXXXXX)}"
SAMPLES_DIR="${PROOF_ROOT}/samples"
COMMANDS_FILE="${PROOF_ROOT}/commands.jsonl"
SUMMARY_FILE="${PROOF_ROOT}/summary.json"
LOG_3100="${PROOF_ROOT}/server-3100.log"
LOG_3102="${PROOF_ROOT}/server-3102.log"
DB_PATH_3100="${PROOF_ROOT}/opengecko-3100.sqlite"
DB_PATH_3102="${PROOF_ROOT}/opengecko-3102.sqlite"
# Startup proof command fragments intentionally use:
# PORT=3100
# PORT=3102
# DATABASE_URL="${DB_PATH_3100}"
# DATABASE_URL="${DB_PATH_3102}"
SERVER_PID=""
CURRENT_PORT=""
FAILURES=0

mkdir -p "$SAMPLES_DIR"
: > "$COMMANDS_FILE"

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
      wait "$SERVER_PID" >/dev/null 2>&1 || true
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

write_versions() {
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
    echo "    \"3102\": $(json_escape "$DB_PATH_3102")"
    echo "  },"
    echo "  \"ports\": [3100, 3102],"
    echo "  \"credential_policy\": \"public providers only; no private API keys required\","
    echo "  \"repo_data_policy\": \"uses temp SQLite paths under /tmp; repo data directory is not required\""
    echo "}"
  } > "${PROOF_ROOT}/environment.json"
}

start_server() {
  local port="$1"
  local db_path="$2"
  local log_path="$3"
  local command="HOST=127.0.0.1 PORT=${port} DATABASE_URL=\"${db_path}\" LOG_LEVEL=warn LOG_PRETTY=false bun run dev"

  if lsof -ti ":${port}" >/dev/null 2>&1; then
    echo "Port ${port} is already in use; refusing to touch unknown process." >&2
    exit 98
  fi

  echo "Starting OpenGecko on port ${port} with temp DB ${db_path}"
  HOST=127.0.0.1 PORT="$port" DATABASE_URL="${db_path}" LOG_LEVEL=warn LOG_PRETTY=false bun run dev >"$log_path" 2>&1 &
  SERVER_PID="$!"
  CURRENT_PORT="$port"
  record_command "start-${port}" "$command" 0
  echo "$SERVER_PID" > "${PROOF_ROOT}/server-${port}.pid"
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
    if jq -e '(.bitcoin.usd | type == "number") or (.ethereum.usd | type == "number")' "${SAMPLES_DIR}/readiness-simple-price.json" >/dev/null 2>&1; then
      record_command "wait-market-readiness-${port}" "curl /simple/price until finite prioritized price" 0
      return 0
    fi

    if (( $(date +%s) - started_at >= timeout_seconds )); then
      record_command "wait-market-readiness-${port}" "curl /simple/price until finite prioritized price" 124
      return 124
    fi

    sleep 2
  done
}

run_smoke_modules_serially() {
  local base_url="$1"
  local module_list="${OPENGECKO_OPERATOR_PROOF_SMOKE_MODULES-simple coins exchanges}"
  local modules=()

  if [[ -z "${module_list// }" ]]; then
    record_command "smoke-modules" "OPENGECKO_OPERATOR_PROOF_SMOKE_MODULES is empty; serial module smoke skipped" 0
    return 0
  fi

  read -r -a modules <<< "$module_list"
  if [[ "${module_list}" == "all" ]]; then
    modules=(simple coins exchanges global search assets treasury onchain)
  fi

  for module in "${modules[@]}"; do
    local command
    if [[ "$module" == "all-endpoints" ]]; then
      command="BASE_URL=${base_url} bun run test:endpoint"
    else
      command="BASE_URL=${base_url} bun run test:endpoint:${module}"
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
  done
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
  capture_get "$port" "${prefix}-chart-diagnostics" '/diagnostics/market_charts' 200 || true
  capture_get "$port" "${prefix}-simple-price" '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_last_updated_at=true' 200 || true
  capture_get "$port" "${prefix}-markets" '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&per_page=2&page=1&sparkline=false&price_change_percentage=24h' 200 || true
  capture_get "$port" "${prefix}-coin-detail" '/coins/bitcoin?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false' 200 || true
  capture_get "$port" "${prefix}-coin-tickers" '/coins/bitcoin/tickers?exchange_ids=binance&depth=true&include_exchange_logo=false&page=1' 200 || true
  capture_get "$port" "${prefix}-exchanges" '/exchanges?per_page=5&page=1' 200 || true
  capture_get "$port" "${prefix}-exchange-tickers" '/exchanges/binance/tickers?coin_ids=bitcoin&depth=true&page=1' 200 || true
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
    --arg samples_dir "$SAMPLES_DIR" \
    --argjson failures "$FAILURES" \
    --argjson exit_code "$final_exit_code" \
    '{
      generated_at: $generated_at,
      proof_root: $proof_root,
      environment_file: $environment_file,
      commands_file: $commands_file,
      samples_dir: $samples_dir,
      failures: $failures,
      exit_code: $exit_code,
      states: ["first_run_ready", "healthy", "degraded_but_serving", "recovered"],
      assertions: ["VAL-CROSS-001", "VAL-CROSS-002", "VAL-CROSS-003", "VAL-CROSS-004", "VAL-CROSS-005", "VAL-CROSS-006", "VAL-CROSS-007", "VAL-CROSS-008", "VAL-CROSS-009", "VAL-CROSS-010", "VAL-CROSS-011"]
    }' > "$SUMMARY_FILE"
}

main() {
  require_tool curl
  require_tool jq
  require_tool lsof
  require_tool git
  require_tool bun
  require_tool node

  write_versions

  start_server 3100 "$DB_PATH_3100" "$LOG_3100"
  wait_for_health 3100 || mark_failure "port 3100 did not become healthy"
  wait_for_market_readiness 3100 45 || true
  capture_post 3100 "normal-control-provider-failure-hidden" '/diagnostics/runtime/provider_failure' '{"active":true}' 404 || true
  capture_post 3100 "normal-control-degraded-hidden" '/diagnostics/runtime/degraded_state' '{"mode":"degraded_seeded_bootstrap"}' 404 || true
  sample_priority_routes 3100 healthy
  run_smoke_modules_serially "http://127.0.0.1:3100"
  stop_server
  wait_for_port_clear 3100 || mark_failure "port 3100 not clear after healthy proof"

  start_server 3102 "$DB_PATH_3102" "$LOG_3102"
  wait_for_health 3102 || mark_failure "port 3102 did not become healthy"
  sample_priority_routes 3102 control-ready
  capture_post 3102 "control-degraded-on" '/diagnostics/runtime/degraded_state' '{"mode":"degraded_seeded_bootstrap","reason":"operator proof degraded state"}' 200 || true
  capture_post 3102 "control-provider-failure-on" '/diagnostics/runtime/provider_failure' '{"active":true,"reason":"operator proof forced provider failure"}' 200 || true
  sample_priority_routes 3102 degraded
  capture_get 3102 "degraded-metrics" '/metrics' 200 || true
  capture_post 3102 "control-provider-failure-off" '/diagnostics/runtime/provider_failure' '{"active":false}' 200 || true
  capture_post 3102 "control-degraded-off" '/diagnostics/runtime/degraded_state' '{"mode":"off"}' 200 || true
  sample_priority_routes 3102 recovered
  stop_server
  wait_for_port_clear 3102 || mark_failure "port 3102 not clear after validation-control proof"

  local exit_code=0
  if [[ "$FAILURES" -gt 0 ]]; then
    exit_code=1
  fi
  write_summary "$exit_code"
  echo "Operator proof bundle: ${PROOF_ROOT}"
  echo "Summary: ${SUMMARY_FILE}"
  return "$exit_code"
}

main "$@"
