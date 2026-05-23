#!/usr/bin/env bash
# Deterministic black-box validation for VAL-SCHED-004.
# The script uses the validation-control runtime on 127.0.0.1:3102 to force a
# scheduler job failure, then asserts /diagnostics/jobs exposes retry/backoff
# status, attempt counters, next retry time, and a sanitized last error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BASE_URL="${BASE_URL:-http://127.0.0.1:3102}"
VALIDATION_JOB_NAME="validation-scheduler-backoff"
STARTED_SERVER_PID=""
SERVER_LOG="${OPENGECKO_SCHEDULER_BACKOFF_LOG:-$(mktemp /tmp/opengecko-scheduler-backoff.XXXXXX.log)}"

cleanup() {
  if [[ -n "$STARTED_SERVER_PID" ]]; then
    kill "$STARTED_SERVER_PID" >/dev/null 2>&1 || true
    wait "$STARTED_SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required tool: $1" >&2
    exit 127
  fi
}

is_healthy() {
  curl -fsS "${BASE_URL}/health" >/dev/null 2>&1
}

start_validation_control_if_needed() {
  if is_healthy; then
    return
  fi

  if [[ "$BASE_URL" != "http://127.0.0.1:3102" ]]; then
    echo "BASE_URL is not healthy: ${BASE_URL}" >&2
    exit 2
  fi

  if lsof -ti :3102 >/dev/null 2>&1; then
    echo "port 3102 is occupied but ${BASE_URL}/health is not healthy; refusing to touch unknown process" >&2
    exit 98
  fi

  HOST=127.0.0.1 \
  PORT=3102 \
  DATABASE_URL=:memory: \
  LOG_LEVEL=warn \
  LOG_PRETTY=false \
  DEFILLAMA_BASE_URL="${DEFILLAMA_BASE_URL:-https://coins.llama.fi}" \
  CCXT_EXCHANGES="${CCXT_EXCHANGES:-coinbase,kraken,okx,kucoin,gateio,bitstamp}" \
  PROVIDER_FANOUT_CONCURRENCY="${PROVIDER_FANOUT_CONCURRENCY:-3}" \
    bun run serve >"$SERVER_LOG" 2>&1 &
  STARTED_SERVER_PID="$!"

  for _ in $(seq 1 60); do
    if is_healthy; then
      return
    fi
    if ! kill -0 "$STARTED_SERVER_PID" >/dev/null 2>&1; then
      echo "validation-control server exited before health check; log: ${SERVER_LOG}" >&2
      exit 1
    fi
    sleep 1
  done

  echo "validation-control server did not become healthy; log: ${SERVER_LOG}" >&2
  exit 1
}

require_tool bun
require_tool curl
require_tool jq
require_tool lsof

start_validation_control_if_needed

failure_payload="$(
  jq -nc --arg reason 'scheduler validation forced refresh failure token=validator-secret-token /tmp/opengecko-validation-secret.sqlite' \
    '{reason: $reason}'
)"

trigger_json="$(
  curl -fsS \
    -H 'content-type: application/json' \
    -X POST \
    -d "$failure_payload" \
    "${BASE_URL}/diagnostics/runtime/scheduler_backoff_validation"
)"

printf '%s\n' "$trigger_json" | jq -e --arg job "$VALIDATION_JOB_NAME" '
  .data.validation_path == {
    route: "/diagnostics/runtime/scheduler_backoff_validation",
    diagnostics_route: "/diagnostics/jobs",
    validation_port: 3102,
    cache_independent: true,
    public_route_read_required: false,
    forced_job_failure: true
  }
  and .data.job.name == $job
  and .data.job.status == "retrying"
  and .data.job.status_reason == "retry_backoff_active"
  and .data.job.retry_attempt_count >= 1
  and .data.job.error_count >= 1
  and .data.job.next_retry_at != null
  and .data.job.backoff.active == true
  and .data.job.backoff.attempt_count >= 1
  and .data.job.backoff.next_retry_at == .data.job.next_retry_at
  and (.data.job.last_error | type == "string")
  and (.data.job.last_error | contains("scheduler validation forced refresh failure"))
  and (.data.job.last_error | contains("validator-secret-token") | not)
  and (.data.job.last_error | contains("/tmp/opengecko-validation-secret.sqlite") | not)
' >/dev/null

jobs_json="$(curl -fsS "${BASE_URL}/diagnostics/jobs")"

printf '%s\n' "$jobs_json" | jq -e --arg job "$VALIDATION_JOB_NAME" '
  (.data.scheduler.enabled == true)
  and (.data.scheduler.allowed_job_statuses | index("retrying") != null)
  and ([.data.jobs[] | select(.name == $job)] | length == 1)
  and (
    .data.jobs[] | select(.name == $job) |
    .status == "retrying"
    and .status_reason == "retry_backoff_active"
    and .retry_attempt_count >= 1
    and .error_count >= 1
    and .last_failure_at != null
    and .next_retry_at != null
    and .backoff.active == true
    and .backoff.attempt_count >= 1
    and .backoff.next_retry_at == .next_retry_at
    and (.last_error | type == "string")
    and (.last_error | contains("validator-secret-token") | not)
    and (.last_error | contains("/tmp/opengecko-validation-secret.sqlite") | not)
  )
' >/dev/null

echo "VAL-SCHED-004 scheduler retry/backoff diagnostics validation passed against ${BASE_URL}"
