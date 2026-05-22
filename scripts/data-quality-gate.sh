#!/usr/bin/env bash
# Focused OpenGecko data-quality diagnostic gate.
# Usage: BASE_URL=http://127.0.0.1:3103 bash scripts/data-quality-gate.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3103}"
ENDPOINT_CURL_MAX_TIME="${ENDPOINT_CURL_MAX_TIME:-20}"
MAX_EVIDENCE_CHARS="${MAX_EVIDENCE_CHARS:-1200}"
EVIDENCE_DIR="${OPENGECKO_QUALITY_EVIDENCE_DIR:-${QUALITY_EVIDENCE_DIR:-}}"

if [[ ! "$ENDPOINT_CURL_MAX_TIME" =~ ^[1-9][0-9]*$ ]]; then
  echo "ENDPOINT_CURL_MAX_TIME must be a positive integer number of seconds" >&2
  exit 2
fi

TMP_FILE="$(mktemp /tmp/opengecko-data-quality-gate.XXXXXX.json)"
RUNTIME_TMP_FILE="$(mktemp /tmp/opengecko-data-quality-runtime.XXXXXX.json)"
RUN_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REQUEST_URL="${BASE_URL}/diagnostics/data_quality"
RUNTIME_REQUEST_URL="${BASE_URL}/diagnostics/runtime"

cleanup() {
  rm -f "$TMP_FILE" "$RUNTIME_TMP_FILE"
}

trap cleanup EXIT

echo "OpenGecko Focused Data Quality Gate"
echo "Target: ${BASE_URL}"
echo "Time:   ${RUN_TIMESTAMP}"
echo "Request: ${REQUEST_URL}"
echo "Runtime request: ${RUNTIME_REQUEST_URL}"
echo

curl -sS -f --max-time "$ENDPOINT_CURL_MAX_TIME" \
  "$REQUEST_URL" > "$TMP_FILE"

curl -sS -f --max-time "$ENDPOINT_CURL_MAX_TIME" \
  "$RUNTIME_REQUEST_URL" > "$RUNTIME_TMP_FILE"

if ! jq -e '.data.gate.status and .data.families' "$TMP_FILE" >/dev/null; then
  echo "FAIL diagnostics/data_quality response does not expose .data.gate.status and .data.families" >&2
  jq '.data // .' "$TMP_FILE" >&2 || cat "$TMP_FILE" >&2
  exit 2
fi

if ! jq -e '.data.database and .data.validation_profile' "$RUNTIME_TMP_FILE" >/dev/null; then
  echo "FAIL diagnostics/runtime response does not expose .data.database and .data.validation_profile" >&2
  jq '.data // .' "$RUNTIME_TMP_FILE" >&2 || cat "$RUNTIME_TMP_FILE" >&2
  exit 2
fi

runtime_errors="$(
  jq -r '
    .data as $data
    | ($data.database // {}) as $database
    | ($data.validation_profile // {}) as $profile
    | [
        if ($profile.service_role // "") != "data_quality_gate" then "runtime_service_role_not_data_quality_gate:\($profile.service_role // "null")" else empty end,
        if ($profile.current_port_approved // false) != true then "runtime_port_not_mission_approved:\($profile.current_port // "null")" else empty end,
        if (($profile | has("port_3000_required") | not) or $profile.port_3000_required != false) then "runtime_requires_port_3000" else empty end,
        if ($profile.service_backed_validation.serial_required // false) != true then "runtime_service_backed_validation_not_serial" else empty end,
        if (($database.path_class // "") == "in_memory") then "sqlite_path_class_in_memory" else empty end,
        if ($database.storage_mode // "") != "file" then "sqlite_storage_mode_not_file:\($database.storage_mode // "null")" else empty end,
        if ($database.shared_file // false) != true then "sqlite_shared_file_not_enabled" else empty end,
        if ($database.wal_enabled // false) != true then "sqlite_wal_not_enabled" else empty end,
        if (($database.busy_timeout_ms | type) != "number" or $database.busy_timeout_ms <= 0) then "sqlite_busy_timeout_not_positive:\($database.busy_timeout_ms // "null")" else empty end,
        if (($profile.service_backed_validation.database_path_class // "") == "in_memory") then "sqlite_validation_database_path_class_in_memory" else empty end
      ][]
  ' "$RUNTIME_TMP_FILE" || true
)"

if [[ -n "$runtime_errors" ]]; then
  echo "FAIL diagnostics/runtime unsafe SQLite runtime configuration" >&2
  echo "$runtime_errors" >&2
  jq '{database: .data.database, validation_profile: .data.validation_profile}' "$RUNTIME_TMP_FILE" >&2 || cat "$RUNTIME_TMP_FILE" >&2
  exit 2
fi

schema_errors="$(
  jq -r '
    def allowed_gate_statuses: ["pass", "fail"];
    def allowed_family_statuses: ["pass", "degraded", "fail", "out_of_scope"];
    def allowed_source_states: ["live", "hybrid", "seeded", "fixture", "replay", "synthetic", "fallback", "degraded", "stale", "unavailable", "out_of_scope"];
    def allowed_non_live_states: ["hybrid", "seeded", "fixture", "replay", "synthetic", "fallback", "degraded", "stale", "unavailable", "out_of_scope"];
    def allowed_ownership_classes: ["live", "hybrid", "seeded", "synthetic", "fixture", "unavailable"];
    def allowed_freshness_states: ["fresh", "degraded", "stale", "unbudgeted", "unknown"];
    def allowed_dimension_ids: ["contract_compatibility", "freshness_liveness", "completeness_coverage", "live_source_fidelity", "fixture_fallback_transparency", "metadata_truthfulness"];
    def allowed_reason_codes: [
      "below_target_threshold",
      "blocked_provider_counted_as_live",
      "degraded_only",
      "derivatives_live_fidelity_below_contract_score",
      "fallback_only",
      "fixture_only",
      "fixture_source",
      "hybrid_only",
      "missing_contract_evidence",
      "missing_coverage_entry",
      "missing_database",
      "missing_exchange_volume_chart_source",
      "missing_freshness_budget",
      "out_of_scope_only",
      "partial_coverage",
      "provider_blocked",
      "provider_degraded",
      "provider_error",
      "regional_block",
      "replay_only",
      "required_family_below_threshold",
      "runtime_degraded",
      "seeded_only",
      "seeded_source",
      "source_unavailable",
      "sparse_market_rows_or_aggregate_mismatch",
      "stale_only",
      "stale_source",
      "synthetic_only",
      "synthetic_source",
      "unavailable_only",
      "unbudgeted_source",
      "unknown_freshness"
    ];
    def finite_0_to_10: type == "number" and . >= 0 and . <= 10;
    def non_live_reason:
      . as $code
      | (
        ["hybrid_only", "seeded_only", "fixture_only", "replay_only", "synthetic_only", "fallback_only", "degraded_only", "stale_only", "unavailable_only", "out_of_scope_only", "fixture_source", "seeded_source", "synthetic_source", "source_unavailable", "stale_source", "runtime_degraded", "provider_error", "provider_degraded", "provider_blocked", "regional_block", "blocked_provider_counted_as_live"]
        | index($code)
      ) != null;

    . as $root
    | [
        if ($root.data | type) != "object" then "missing_data_object" else empty end,
        if ($root.data.gate | type) != "object" then "missing_gate_object" else empty end,
        if ($root.data.families | type) != "array" then "families_not_array" else empty end,
        if (($root.data.families // []) | length) == 0 then "families_empty" else empty end,
        if ($root.data.gate.status | type) != "string" or ((allowed_gate_statuses | index($root.data.gate.status)) == null) then "gate_status_unknown:\($root.data.gate.status // "null")" else empty end,
        if (($root.data.gate.threshold | finite_0_to_10) | not) then "gate_threshold_not_finite_0_to_10" else empty end,
        if (($root.data.gate.below_target_families // []) | type) != "array" then "below_target_families_not_array" else empty end,
        if (($root.data.gate.below_target_count // (($root.data.gate.below_target_families // []) | length)) != (($root.data.gate.below_target_families // []) | length)) then "below_target_count_mismatch" else empty end,
        (
          (($root.data.gate.reason_codes // []) | if type == "array" then . else ["__not_array__"] end) as $codes
          | if ($codes | any(. == "__not_array__")) then "gate_reason_codes_not_array" else empty end,
          ($codes[]? as $code | select((allowed_reason_codes | index($code)) == null) | "unknown_gate_reason_code:\($code)")
        ),
        (
          ([$root.data.families[]? | select((.required // false) == true and ((.score // -1) < (.target_threshold // $root.data.gate.threshold))) | .family] | sort) as $actual
          | ([$root.data.gate.below_target_families[]? | .family] | sort) as $reported
          | if $actual != $reported then "below_target_family_mismatch:actual=\($actual|join(",")):reported=\($reported|join(","))" else empty end
        ),
        (
          $root.data.families[]? as $family
          | ($family.family // "<missing>") as $family_id
          | [
              if ($family.family | type) != "string" or ($family.family | length) == 0 then "family_missing_id" else empty end,
              if ($family.required | type) != "boolean" then "family_required_not_boolean:\($family_id)" else empty end,
              if (($family.score | finite_0_to_10) | not) then "family_score_not_finite_0_to_10:\($family_id)" else empty end,
              if (($family.target_threshold | finite_0_to_10) | not) then "family_target_threshold_not_finite_0_to_10:\($family_id)" else empty end,
              if ($family.status | type) != "string" or ((allowed_family_statuses | index($family.status)) == null) then "family_status_unknown:\($family_id):\($family.status // "null")" else empty end,
              if (($family.reason_codes // []) | type) != "array" then "family_reason_codes_not_array:\($family_id)" else empty end,
              (($family.reason_codes // [])[]? as $code | select((allowed_reason_codes | index($code)) == null) | "unknown_family_reason_code:\($family_id):\($code)"),
              if ($family.source | type) != "object" then "family_source_missing:\($family_id)" else empty end,
              if ($family.source.state | type) != "string" or ((allowed_source_states | index($family.source.state)) == null) then "family_source_state_unknown:\($family_id):\($family.source.state // "null")" else empty end,
              if (($family.source.ownership_class != null) and ((allowed_ownership_classes | index($family.source.ownership_class)) == null)) then "family_ownership_class_unknown:\($family_id):\($family.source.ownership_class)" else empty end,
              if (($family.source.freshness_state != null) and ((allowed_freshness_states | index($family.source.freshness_state)) == null)) then "family_freshness_state_unknown:\($family_id):\($family.source.freshness_state)" else empty end,
              (($family.freshness_budget // $family.source.freshness_budget) as $freshness_budget
                | if ($freshness_budget | type) != "object" then "family_freshness_budget_missing:\($family_id)" else empty end,
                  if (($freshness_budget.current_age_seconds != null) and (($freshness_budget.current_age_seconds | type) != "number" or $freshness_budget.current_age_seconds < 0)) then "family_freshness_budget_age_invalid:\($family_id)" else empty end,
                  if (($freshness_budget.age_seconds != null) and (($freshness_budget.age_seconds | type) != "number" or $freshness_budget.age_seconds < 0)) then "family_freshness_budget_age_invalid:\($family_id)" else empty end,
                  if (($freshness_budget.last_success_at != null) and (($freshness_budget.last_success_at | type) != "string")) then "family_freshness_budget_last_success_invalid:\($family_id)" else empty end,
                  if (($freshness_budget.budget | type) != "object") then "family_freshness_budget_budget_missing:\($family_id)" else empty end,
                  if (($freshness_budget.budget.target_freshness_seconds != null) and (($freshness_budget.budget.target_freshness_seconds | type) != "number" or $freshness_budget.budget.target_freshness_seconds < 0)) then "family_freshness_budget_target_invalid:\($family_id)" else empty end,
                  if ($freshness_budget.status | type) != "string" or ((allowed_freshness_states | index($freshness_budget.status)) == null) then "family_freshness_budget_status_unknown:\($family_id):\($freshness_budget.status // "null")" else empty end,
                  if ($freshness_budget.reason | type) != "string" or ($freshness_budget.reason | length) == 0 then "family_freshness_budget_reason_missing:\($family_id)" else empty end,
                  if (($freshness_budget.counts_as_live_evidence | type) != "boolean") then "family_freshness_budget_live_evidence_invalid:\($family_id)" else empty end,
                  if (($freshness_budget.counts_as_live_freshness_evidence | type) != "boolean") then "family_freshness_budget_fresh_live_evidence_invalid:\($family_id)" else empty end,
                  if ((allowed_non_live_states | index($family.source.state)) != null) and (($freshness_budget.counts_as_live_evidence // false) == true or ($freshness_budget.counts_as_live_freshness_evidence // false) == true) then "non_live_source_counts_as_freshness_evidence:\($family_id):\($family.source.state)" else empty end
              ),
              if ((($family.dimensions // []) | type) != "array") then "family_dimensions_not_array:\($family_id)" else empty end,
              (($family.dimensions // [])[]? as $dimension
                | if ($dimension.id | type) != "string" or ((allowed_dimension_ids | index($dimension.id)) == null) then "family_dimension_id_unknown:\($family_id):\($dimension.id // "null")" else empty end,
                  if (($dimension.score | finite_0_to_10) | not) then "family_dimension_score_not_finite_0_to_10:\($family_id):\($dimension.id // "null")" else empty end,
                  if ($dimension.status | type) != "string" or ((allowed_family_statuses | index($dimension.status)) == null) then "family_dimension_status_unknown:\($family_id):\($dimension.id // "null"):\($dimension.status // "null")" else empty end,
                  if (($dimension.reason_codes // []) | type) != "array" then "family_dimension_reason_codes_not_array:\($family_id):\($dimension.id // "null")" else empty end,
                  (($dimension.reason_codes // [])[]? as $code | select((allowed_reason_codes | index($code)) == null) | "unknown_dimension_reason_code:\($family_id):\($dimension.id // "null"):\($code)")
              ),
              if $family.source.state == "live" and (($family.source.ownership_class // "live") != "live") then "live_source_ownership_mismatch:\($family_id):\($family.source.ownership_class)" else empty end,
              if $family.source.state == "live" and ($family.source.fallback // false) != false then "live_source_marked_fallback:\($family_id)" else empty end,
              if $family.source.state == "live" and ((($family.reason_codes // []) | any(non_live_reason)) or (($family.dimensions // []) | any((.reason_codes // []) | any(non_live_reason)))) then "live_source_has_non_live_reason:\($family_id)" else empty end,
              if ((allowed_non_live_states | index($family.source.state)) != null) and ((($family.score_scopes.live_source_fidelity // -1) >= ($family.target_threshold // $root.data.gate.threshold))) then "non_live_source_claims_live_fidelity:\($family_id):\($family.source.state)" else empty end,
              if (((["seeded", "fixture", "replay", "synthetic", "fallback", "unavailable", "out_of_scope"] | index($family.source.state)) != null) and (($family.source.fallback // false) != true)) then "non_live_source_not_marked_fallback:\($family_id):\($family.source.state)" else empty end,
              if (($family.source.state == "live") and (($family.required // false) == true) and (($family.source.freshness_state == "stale") or ((($family.freshness_budget // $family.source.freshness_budget).status // "") == "stale")) and (($family.score // 0) >= ($family.target_threshold // $root.data.gate.threshold))) then "stale_required_family_not_below_target:\($family_id)" else empty end
            ][]
        )
      ][]
  ' "$TMP_FILE" || true
)"

if [[ -n "$schema_errors" ]]; then
  echo "FAIL diagnostics/data_quality schema/classification validation failed" >&2
  echo "$schema_errors" >&2
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
    ],
    global_public_route_comparison: (
      [.data.families[]? | select(.family == "global") | .evidence.global_quality // {}][0]
      | {
          public_route_values: (.public_route_values // null),
          recomputation: (.recomputation // null),
          comparison: (.public_route_comparison // null)
        }
    )
  }' "$TMP_FILE" > "$parsed_metrics_path"

  {
    printf 'assertion_id\tstatus\tevidence\n'
    jq -r '
      "VAL-DQ-001\t" + (if (.data.families | length) > 0 and (.data.gate.status | type == "string") then "pass" else "fail" end) + "\tdata_quality gate schema exposes status and family entries",
      "VAL-DQ-003\t" + (if (([.data.families[] | select(.required == true and .score < .target_threshold) | .family] | sort) == ([.data.gate.below_target_families[]? | .family] | sort)) then "pass" else "fail" end) + "\trequired below-threshold families are enumerated",
      "VAL-DQ-004\t" + (if ([.data.families[] | .source.state] | all(. as $state | ["live","hybrid","seeded","fixture","replay","synthetic","fallback","degraded","stale","unavailable","out_of_scope"] | index($state) != null)) then "pass" else "fail" end) + "\tall family source states use the allowed classification set",
      "VAL-DQ-007\t" + (if ([.data.families[] | select(.source.state != "live") | .score_scopes.live_source_fidelity < .target_threshold] | all) then "pass" else "fail" end) + "\tnon-live states are not counted as live source fidelity",
      "VAL-DQ-009\t" + (if ([.data.families[] | (.freshness_budget // .source.freshness_budget) | type == "object" and (.status | type == "string") and (.reason | type == "string") and (.budget | type == "object")] | all) then "pass" else "fail" end) + "\tdata_quality exposes enforceable per-family freshness budget status and reason fields",
      "VAL-SCHED-001\t" + (if ([.data.families[] | (.freshness_budget // .source.freshness_budget) | has("current_age_seconds") and has("last_success_at") and has("budget") and has("status") and has("reason")] | all) then "pass" else "fail" end) + "\tfreshness budget records expose age, last-success, budget, status, and reason",
      "VAL-SCHED-002\t" + (if ([.data.families[] | select(.source.state != "live") | (.freshness_budget // .source.freshness_budget) | (.counts_as_live_evidence == false and .counts_as_live_freshness_evidence == false)] | all) then "pass" else "fail" end) + "\tnon-live data does not count as live freshness evidence"
    ' "$TMP_FILE"
    printf 'VAL-DQ-010\tpass\tvalidated negative-scenario-capable schema, classification, stale, overclaim, and unsafe SQLite runtime configuration checks\n'
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

if jq -e '[.data.families[]? | select(.family == "global") | .evidence.global_quality.public_route_comparison?] | length > 0' "$TMP_FILE" >/dev/null; then
  echo "Global public route comparison"
  jq -r '
    [.data.families[]? | select(.family == "global") | .evidence.global_quality][0] as $global
    | [
        "  public_total_market_cap_usd: \($global.public_route_values.total_market_cap_usd)",
        "  recomputed_total_market_cap_usd: \($global.recomputation.recomputed_total_market_cap_usd)",
        "  market_cap_delta_ratio: \($global.public_route_comparison.market_cap_delta_ratio)",
        "  public_total_volume_usd: \($global.public_route_values.total_volume_usd)",
        "  recomputed_total_volume_usd: \($global.recomputation.recomputed_total_volume_usd)",
        "  volume_delta_ratio: \($global.public_route_comparison.volume_delta_ratio)",
        "  tolerance_ratio: \($global.recomputation.tolerance_ratio)",
        "  within_tolerance: \($global.public_route_comparison.within_tolerance)"
      ]
      | .[]
  ' "$TMP_FILE"
  echo
fi

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
