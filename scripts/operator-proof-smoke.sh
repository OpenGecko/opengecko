#!/usr/bin/env bash
# Operator-proof OpenGecko smoke bundle.
# Starts isolated validation runtimes on ports 3100, 3102, and 3103, runs serial route
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
LOG_3103="${PROOF_ROOT}/server-3103.log"
DB_PATH_3100="${PROOF_ROOT}/opengecko-3100.sqlite"
DB_PATH_3102=":memory:"
DB_PATH_3103="${PROOF_ROOT}/opengecko-quality.sqlite"
SMOKE_EXECUTED_FILE="${PROOF_ROOT}/smoke-modules-executed.jsonl"
SMOKE_SKIPPED_FILE="${PROOF_ROOT}/smoke-modules-skipped.jsonl"
PORT_CHECKS_FILE="${PROOF_ROOT}/port-checks.jsonl"
CROSS_OVERLAP_FILE="${PROOF_ROOT}/cross-overlap-readiness.json"
RESERVED_PORTS=(3100 3102 3103)
DEFAULT_SMOKE_MODULES=(exchanges)
ALL_SMOKE_MODULES=(simple coins exchanges global search assets treasury onchain)
# Startup proof command fragments intentionally use:
# PORT=3100
# PORT=3102
# PORT=3103
# DATABASE_URL="${DB_PATH_3100}"
# DATABASE_URL="${DB_PATH_3102}"
# DATABASE_URL="${DB_PATH_3103}"
SERVER_PID=""
CURRENT_PORT=""
FAILURES=0

mkdir -p "$SAMPLES_DIR"
: > "$COMMANDS_FILE"
: > "$SMOKE_EXECUTED_FILE"
: > "$SMOKE_SKIPPED_FILE"
: > "$PORT_CHECKS_FILE"

# shellcheck source=scripts/lib/operator-proof-helpers.sh
source "${REPO_ROOT}/scripts/lib/operator-proof-helpers.sh"

main() {
  require_tool curl
  require_tool jq
  require_tool lsof
  require_tool git
  require_tool bun
  require_tool node

  write_versions

  if ! check_reserved_ports_clear "preflight"; then
    write_summary 98
    echo "Operator proof bundle: ${PROOF_ROOT}"
    echo "Summary: ${SUMMARY_FILE}"
    return 98
  fi

  start_server 3100 "$DB_PATH_3100" "$LOG_3100"
  wait_for_health 3100 || mark_failure "port 3100 did not become healthy"
  wait_for_cross_overlap_readiness 3100 90 || mark_failure "finite BTC/ETH market, ticker, chart, and OHLC overlap was not ready within proof window"
  capture_post 3100 "normal-control-provider-failure-hidden" '/diagnostics/runtime/provider_failure' '{"active":true}' 404 || true
  capture_post 3100 "normal-control-degraded-hidden" '/diagnostics/runtime/degraded_state' '{"mode":"degraded_seeded_bootstrap"}' 404 || true
  sample_priority_routes 3100 healthy
  run_hot_route_consistency_check_serially "http://127.0.0.1:3100"
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

  start_server 3103 "$DB_PATH_3103" "$LOG_3103"
  wait_for_health 3103 || mark_failure "port 3103 did not become healthy"
  sample_priority_routes 3103 data-quality-ready
  run_data_quality_gate_serially "http://127.0.0.1:3103"
  stop_server
  wait_for_port_clear 3103 || mark_failure "port 3103 not clear after data-quality proof"
  check_reserved_ports_clear "post-cleanup" || mark_failure "one or more reserved ports remained occupied after cleanup"

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
