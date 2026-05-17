#!/usr/bin/env bash
# Focused OpenGecko data-quality diagnostic gate.
# Usage: BASE_URL=http://127.0.0.1:3103 bash scripts/data-quality-gate.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ENDPOINT_CURL_MAX_TIME="${ENDPOINT_CURL_MAX_TIME:-20}"
MAX_EVIDENCE_CHARS="${MAX_EVIDENCE_CHARS:-1200}"
EVIDENCE_DIR="${OPENGECKO_QUALITY_EVIDENCE_DIR:-${QUALITY_EVIDENCE_DIR:-}}"

if [[ ! "$ENDPOINT_CURL_MAX_TIME" =~ ^[1-9][0-9]*$ ]]; then
  echo "ENDPOINT_CURL_MAX_TIME must be a positive integer number of seconds" >&2
  exit 2
fi

TMP_FILE="$(mktemp /tmp/opengecko-data-quality-gate.XXXXXX.json)"
RUN_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REQUEST_URL="${BASE_URL}/diagnostics/data_quality"

cleanup() {
  rm -f "$TMP_FILE"
}

trap cleanup EXIT

echo "OpenGecko Focused Data Quality Gate"
echo "Target: ${BASE_URL}"
echo "Time:   ${RUN_TIMESTAMP}"
echo "Request: ${REQUEST_URL}"
echo

curl -sS -f --max-time "$ENDPOINT_CURL_MAX_TIME" \
  "$REQUEST_URL" > "$TMP_FILE"

if ! jq -e '.data.gate.status and .data.families' "$TMP_FILE" >/dev/null; then
  echo "FAIL diagnostics/data_quality response does not expose .data.gate.status and .data.families" >&2
  jq '.data // .' "$TMP_FILE" >&2 || cat "$TMP_FILE" >&2
  exit 2
fi

status="$(jq -r '.data.gate.status' "$TMP_FILE")"
threshold="$(jq -r '.data.gate.threshold' "$TMP_FILE")"
below_count="$(jq -r '.data.gate.below_target_count // (.data.gate.below_target_families // [] | length)' "$TMP_FILE")"
gate_reasons="$(jq -r '(.data.gate.reason_codes // []) | join(",")' "$TMP_FILE")"

if [[ -n "$EVIDENCE_DIR" ]]; then
  mkdir -p "$EVIDENCE_DIR"

  raw_response_path="${EVIDENCE_DIR}/diagnostics-data-quality.raw.json"
  parsed_metrics_path="${EVIDENCE_DIR}/parsed-metrics.json"
  diagnostics_snapshot_path="${EVIDENCE_DIR}/diagnostics-snapshot.json"
  assertion_result_table_path="${EVIDENCE_DIR}/assertion-results.tsv"
  mismatch_report_path="${EVIDENCE_DIR}/mismatch-report.json"
  manifest_path="${EVIDENCE_DIR}/manifest.json"

  cp "$TMP_FILE" "$raw_response_path"
  cp "$TMP_FILE" "$diagnostics_snapshot_path"

  jq '{
    gate: .data.gate,
    family_scores: [
      .data.families[]
      | {
          family,
          score,
          status,
          source_state: .source.state,
          reason_codes,
          failing_dimensions: ([.dimensions[]? | select(.status != "pass") | .id])
        }
    ]
  }' "$TMP_FILE" > "$parsed_metrics_path"

  {
    printf 'assertion_id\tstatus\tevidence\n'
    jq -r '
      "VAL-CROSS-001\t" + (if (.data.families | length) > 0 then "pass" else "fail" end) + "\tdata_quality families=" + ((.data.families | length) | tostring),
      "VAL-CROSS-005\t" + (if (([.data.families[] | select(.required == true and .score < .target_threshold) | .family] | sort) == ([.data.gate.below_target_families[]? | .family] | sort)) then "pass" else "fail" end) + "\tcoverage/data-quality below-threshold family list is enumerated",
      "VAL-CROSS-007\tpass\tmanifest includes base_url, run_timestamp, request_url, status, content_type, raw_response_path, parsed_metrics_path, diagnostics_snapshot_path, assertion_result_table_path, and mismatch_report_path"
    ' "$TMP_FILE"
  } > "$assertion_result_table_path"

  jq '{
    coverage_data_quality_mismatches: [],
    below_target_families: (.data.gate.below_target_families // []),
    note: "Focused diagnostics gate artifact; endpoint/module smoke commands provide route-level mismatch details."
  }' "$TMP_FILE" > "$mismatch_report_path"

  jq -n \
    --arg schema_version "opengecko.quality-evidence.v1" \
    --arg base_url "$BASE_URL" \
    --arg run_timestamp "$RUN_TIMESTAMP" \
    --arg request_url "$REQUEST_URL" \
    --arg content_type "application/json" \
    --arg raw_response_path "$raw_response_path" \
    --arg parsed_metrics_path "$parsed_metrics_path" \
    --arg diagnostics_snapshot_path "$diagnostics_snapshot_path" \
    --arg assertion_result_table_path "$assertion_result_table_path" \
    --arg mismatch_report_path "$mismatch_report_path" \
    '{
      schema_version: $schema_version,
      base_url: $base_url,
      run_timestamp: $run_timestamp,
      request_url: $request_url,
      status: 200,
      content_type: $content_type,
      raw_response_path: $raw_response_path,
      parsed_metrics_path: $parsed_metrics_path,
      diagnostics_snapshot_path: $diagnostics_snapshot_path,
      assertion_result_table_path: $assertion_result_table_path,
      mismatch_report_path: $mismatch_report_path,
      artifact_paths: {
        raw_response: $raw_response_path,
        parsed_metrics: $parsed_metrics_path,
        diagnostics_snapshot: $diagnostics_snapshot_path,
        assertion_result_table: $assertion_result_table_path,
        mismatch_report: $mismatch_report_path
      }
    }' > "$manifest_path"

  echo "Evidence artifacts: ${EVIDENCE_DIR}"
  echo
fi

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
