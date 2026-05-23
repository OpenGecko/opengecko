#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:3100}"
DB_PATH="${DATABASE_URL:-/tmp/opengecko-shared-worker-validation.sqlite}"
API_LOG="${API_LOG:-/tmp/opengecko-shared-worker-api.log}"
WORKER_LOG="${WORKER_LOG:-/tmp/opengecko-shared-worker-worker.log}"

if lsof -ti :3100 >/tmp/opengecko-shared-worker-port.pid 2>/dev/null; then
  existing_pid="$(cat /tmp/opengecko-shared-worker-port.pid | head -n 1)"
  existing_cmd="$(ps -p "${existing_pid}" -o args= || true)"
  echo "Port 3100 is already in use by PID ${existing_pid}: ${existing_cmd}" >&2
  echo "Stop the existing mission service with services.yaml before running this validation." >&2
  exit 1
fi

rm -f "${DB_PATH}" "${DB_PATH}-wal" "${DB_PATH}-shm"

cleanup() {
  if [[ -n "${worker_pid:-}" ]] && kill -0 "${worker_pid}" 2>/dev/null; then
    kill "${worker_pid}" 2>/dev/null || true
    wait "${worker_pid}" 2>/dev/null || true
  fi
  if [[ -n "${api_pid:-}" ]] && kill -0 "${api_pid}" 2>/dev/null; then
    kill "${api_pid}" 2>/dev/null || true
    wait "${api_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

(
  cd "${ROOT_DIR}"
  HOST=127.0.0.1 \
  PORT=3100 \
  DATABASE_URL="${DB_PATH}" \
  LOG_LEVEL=warn \
  LOG_PRETTY=false \
  CCXT_EXCHANGES="${CCXT_EXCHANGES:-}" \
  OPENGECKO_PROCESS_ROLE=api \
  bun run serve
) >"${API_LOG}" 2>&1 &
api_pid="$!"

for _ in {1..80}; do
  if curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${api_pid}" 2>/dev/null; then
    echo "API process exited before healthcheck succeeded. Log:" >&2
    cat "${API_LOG}" >&2
    exit 1
  fi
  sleep 0.25
done

curl -fsS "${BASE_URL}/health" >/dev/null

(
  cd "${ROOT_DIR}"
  DATABASE_URL="${DB_PATH}" \
  LOG_LEVEL=warn \
  LOG_PRETTY=false \
  CCXT_EXCHANGES="${WORKER_CCXT_EXCHANGES:-}" \
  OPENGECKO_PROCESS_ROLE=worker \
  OPENGECKO_VALIDATION_WORKER_HOLD_MS=1500 \
  bun run markets:refresh
) >"${WORKER_LOG}" 2>&1 &
worker_pid="$!"

for _ in {1..8}; do
  curl -fsS "${BASE_URL}/simple/price?ids=bitcoin&vs_currencies=usd" >/dev/null
  curl -fsS "${BASE_URL}/coins/markets?vs_currency=usd&ids=bitcoin&per_page=1&page=1" >/dev/null
  sleep 0.2
done

wait "${worker_pid}"
worker_pid=""

runtime_json="$(mktemp)"
curl -fsS "${BASE_URL}/diagnostics/runtime" >"${runtime_json}"

jq -e --arg db_path "${DB_PATH}" '
  .data.database.process_role == "api"
  and .data.database.effective_path == $db_path
  and .data.database.path_class == "tmp_validation_file"
  and .data.database.storage_mode == "file"
  and .data.database.shared_file == true
  and .data.database.wal_enabled == true
  and ((.data.database.busy_timeout_ms // 0) > 0)
  and .data.database.shared_safety.status == "safe"
  and .data.sqlite_coordination.shared_database.api_worker_shared == true
  and (.data.sqlite_coordination.shared_database.observed_roles | index("api") != null)
  and (.data.sqlite_coordination.shared_database.observed_roles | index("worker") != null)
' "${runtime_json}" >/dev/null

echo "SQLite shared API-worker validation passed for ${DB_PATH}"
