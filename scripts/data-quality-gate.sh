#!/usr/bin/env bash
# Focused OpenGecko data-quality diagnostic gate.
# Usage: BASE_URL=http://127.0.0.1:3103 bash scripts/data-quality-gate.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ENDPOINT_CURL_MAX_TIME="${ENDPOINT_CURL_MAX_TIME:-20}"
MAX_EVIDENCE_CHARS="${MAX_EVIDENCE_CHARS:-1200}"

if [[ ! "$ENDPOINT_CURL_MAX_TIME" =~ ^[1-9][0-9]*$ ]]; then
  echo "ENDPOINT_CURL_MAX_TIME must be a positive integer number of seconds" >&2
  exit 2
fi

TMP_FILE="$(mktemp /tmp/opengecko-data-quality-gate.XXXXXX.json)"

cleanup() {
  rm -f "$TMP_FILE"
}

trap cleanup EXIT

echo "OpenGecko Focused Data Quality Gate"
echo "Target: ${BASE_URL}"
echo "Time:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Request: ${BASE_URL}/diagnostics/data_quality"
echo

curl -sS -f --max-time "$ENDPOINT_CURL_MAX_TIME" \
  "${BASE_URL}/diagnostics/data_quality" > "$TMP_FILE"

if ! jq -e '.data.gate.status and .data.families' "$TMP_FILE" >/dev/null; then
  echo "FAIL diagnostics/data_quality response does not expose .data.gate.status and .data.families" >&2
  jq '.data // .' "$TMP_FILE" >&2 || cat "$TMP_FILE" >&2
  exit 2
fi

status="$(jq -r '.data.gate.status' "$TMP_FILE")"
threshold="$(jq -r '.data.gate.threshold' "$TMP_FILE")"
below_count="$(jq -r '.data.gate.below_target_count // (.data.gate.below_target_families // [] | length)' "$TMP_FILE")"
gate_reasons="$(jq -r '(.data.gate.reason_codes // []) | join(",")' "$TMP_FILE")"

echo "Gate"
echo "  status: ${status}"
echo "  threshold: ${threshold}"
echo "  below_target_count: ${below_count}"
echo "  reason_codes: ${gate_reasons:-none}"
echo

if [[ "$below_count" -gt 0 ]]; then
  echo "Below-threshold families"
  jq -r --argjson maxEvidenceChars "$MAX_EVIDENCE_CHARS" '
    def compact_json:
      tojson
      | if length > $maxEvidenceChars then .[0:$maxEvidenceChars] + "...<truncated>" else . end;

    .data as $data
    | ($data.gate.below_target_families // [])[]
    | . as $gate
    | ($data.families[] | select(.family == $gate.family)) as $family
    | [
        "- family: \($family.family)",
        "  score: \($family.score) / threshold \($family.target_threshold // $data.gate.threshold)",
        "  status: \($family.status)",
        "  failing_dimensions: \((($gate.failing_dimensions // $family.failing_dimensions // []) | join(",")) // "none")",
        "  reason_codes: \((($gate.reason_codes // $family.reason_codes // []) | join(",")) // "none")",
        "  source: \({state: $family.source.state, fallback: $family.source.fallback, latest_source_at: $family.source.latest_source_at, provider_ids: $family.source.provider_ids} | compact_json)",
        "  counts: \(($family.counts // {}) | compact_json)",
        "  dimensions:",
        (
          ($family.dimensions // [])
          | map("    - \(.id): score=\(.score) status=\(.status) reasons=\((.reason_codes // []) | join(",")) message=\(.message)")
          | if length == 0 then ["    - none"] else . end
          | .[]
        ),
        "  evidence: \(($family.evidence // {}) | compact_json)"
      ]
      | .[]
  ' "$TMP_FILE"
  echo
fi

echo "Diagnostic gate result: ${status}"

if [[ "$status" == "pass" ]]; then
  exit 0
fi

exit 1
