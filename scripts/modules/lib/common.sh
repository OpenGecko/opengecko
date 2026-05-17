#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
VERBOSE="${VERBOSE:-0}"
MAX_BODY_CHARS="${MAX_BODY_CHARS:-1200}"
ENDPOINT_CURL_MAX_TIME="${ENDPOINT_CURL_MAX_TIME:-20}"
PASS=0
FAIL=0
SKIP=0
TOTAL=0

if [[ ! "$ENDPOINT_CURL_MAX_TIME" =~ ^[1-9][0-9]*$ ]]; then
  echo "ENDPOINT_CURL_MAX_TIME must be a positive integer number of seconds" >&2
  exit 2
fi

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

TMP_DIR="$(mktemp -d /tmp/opengecko-module-tests.XXXXXX)"

print_rule() {
  printf '%0.s-' {1..72}
  echo
}

cleanup_module_test() {
  rm -rf "$TMP_DIR"
}

trap cleanup_module_test EXIT

module_title() {
  local name="$1"

  echo
  echo -e "${BOLD}${name}${NC}"
  echo -e "Target: ${CYAN}${BASE_URL}${NC}"
  echo -e "Time:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo -e "Timeout:${CYAN} ${ENDPOINT_CURL_MAX_TIME}s${NC} (set ENDPOINT_CURL_MAX_TIME to tune endpoint request budget)"
  print_rule
  echo
}

module_section() {
  local name="$1"

  echo -e "${BOLD}${name}${NC}"
}

log_request() {
  local path="$1"
  local expectation="$2"

  echo -e "     request: ${CYAN}${BASE_URL}${path}${NC}"
  echo -e "     expect:  ${expectation}"
}

log_detail() {
  local label="$1"
  local value="$2"

  echo -e "     ${label}: ${value}"
}

log_sample() {
  local label="$1"
  local value="$2"

  echo -e "     ${CYAN}${label}:${NC} ${value}"
}

log_response() {
  local body_file="$1"

  if [[ ! -s "$body_file" ]]; then
    echo -e "     ${CYAN}response:${NC} <empty>"
    return
  fi

  echo -e "     ${CYAN}response:${NC}"
  if jq . "$body_file" >/dev/null 2>&1; then
    jq . "$body_file" 2>/dev/null | sed 's/^/       /'
  else
    sed 's/^/       /' "$body_file"
  fi
  echo
}

check_status() {
  local desc="$1"
  local path="$2"
  local expected_status="${3:-200}"
  TOTAL=$((TOTAL + 1))

  local call_id="${TOTAL}"
  local body_file="$TMP_DIR/body-${call_id}.txt"
  local err_file="$TMP_DIR/curl-${call_id}.err"
  local metrics
  local curl_exit_code=0

  metrics=$(curl -sS -o "$body_file" -w '%{http_code}|%{time_total}|%{content_type}' --max-time "$ENDPOINT_CURL_MAX_TIME" "${BASE_URL}${path}" 2>"$err_file") || curl_exit_code=$?

  local http_code time_total content_type
  IFS='|' read -r http_code time_total content_type <<<"${metrics:-000|0|unknown}"

  if [[ "$curl_exit_code" -ne 0 && "$http_code" == "000" ]]; then
    echo -e "  ${RED}FAIL${NC} ${desc}"
    log_request "$path" "HTTP ${expected_status}"
    if [[ -s "$err_file" ]]; then
      sed 's/^/     curl: /' "$err_file"
    fi
    FAIL=$((FAIL + 1))
    return 1
  fi

  if [[ "$http_code" == "$expected_status" ]]; then
    echo -e "  ${GREEN}PASS${NC} ${desc}"
    log_request "$path" "HTTP ${expected_status}"
    log_detail "state" "status=${http_code} time=${time_total}s type=${content_type:-unknown}"
    log_response "$body_file"
    PASS=$((PASS + 1))
    return 0
  fi

  echo -e "  ${RED}FAIL${NC} ${desc}"
  log_request "$path" "HTTP ${expected_status}"
  echo -e "     ${YELLOW}state:   status=${http_code} time=${time_total}s type=${content_type:-unknown}${NC}"
  log_response "$body_file"
  FAIL=$((FAIL + 1))
  return 1
}

check_json() {
  local desc="$1"
  local path="$2"
  local jq_filter="$3"
  local expected="$4"
  TOTAL=$((TOTAL + 1))

  local call_id="${TOTAL}"
  local body_file="$TMP_DIR/body-json-${call_id}.txt"
  local body
  body=$(curl -sS --max-time "$ENDPOINT_CURL_MAX_TIME" "${BASE_URL}${path}") || body=""
  printf '%s' "$body" > "$body_file"

  local actual
  actual=$(printf '%s' "$body" | jq -r "$jq_filter" 2>/dev/null) || actual="JQ_ERROR"

  if [[ "$actual" == "$expected" ]]; then
    echo -e "  ${GREEN}PASS${NC} ${desc}"
    log_request "$path" "jq ${jq_filter} == ${expected}"
    log_detail "state" "actual=${actual}"
    log_response "$body_file"
    PASS=$((PASS + 1))
    return 0
  fi

  echo -e "  ${RED}FAIL${NC} ${desc}"
  log_request "$path" "jq ${jq_filter} == ${expected}"
  echo -e "     ${YELLOW}state:   actual=${actual}${NC}"
  log_response "$body_file"
  FAIL=$((FAIL + 1))
  return 1
}

check_json_expr() {
  local desc="$1"
  local path="$2"
  local jq_filter="$3"
  local expectation="$4"
  TOTAL=$((TOTAL + 1))

  local call_id="${TOTAL}"
  local body_file="$TMP_DIR/body-json-expr-${call_id}.txt"
  local body
  body=$(curl -sS --max-time "$ENDPOINT_CURL_MAX_TIME" "${BASE_URL}${path}") || body=""
  printf '%s' "$body" > "$body_file"

  local actual
  actual=$(printf '%s' "$body" | jq -r "$jq_filter" 2>/dev/null) || actual="JQ_ERROR"

  if [[ "$actual" == "true" ]]; then
    echo -e "  ${GREEN}PASS${NC} ${desc}"
    log_request "$path" "$expectation"
    log_detail "state" "actual=${actual}"
    log_response "$body_file"
    PASS=$((PASS + 1))
    return 0
  fi

  echo -e "  ${RED}FAIL${NC} ${desc}"
  log_request "$path" "$expectation"
  echo -e "     ${YELLOW}state:   actual=${actual}${NC}"
  log_response "$body_file"
  FAIL=$((FAIL + 1))
  return 1
}

skip_check() {
  local desc="$1"
  local reason="$2"
  TOTAL=$((TOTAL + 1))
  SKIP=$((SKIP + 1))

  echo -e "  ${YELLOW}SKIP${NC} ${desc}"
  echo -e "     ${YELLOW}state:   ${reason}${NC}"
}

module_summary() {
  echo
  echo -e "${BOLD}Results${NC}"
  echo -e "  ${GREEN}PASS${NC} ${PASS}"
  echo -e "  ${RED}FAIL${NC} ${FAIL}"
  echo -e "  ${YELLOW}SKIP${NC} ${SKIP}"
  echo -e "  ${BOLD}TOTAL${NC} ${TOTAL}"
  echo

  if [[ "$FAIL" -gt 0 ]]; then
    return 1
  fi

  return 0
}
