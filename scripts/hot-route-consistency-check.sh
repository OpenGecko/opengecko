#!/usr/bin/env bash
# Black-box OpenGecko hot-route consistency checks.
# Usage: BASE_URL=http://127.0.0.1:3100 bash scripts/hot-route-consistency-check.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3100}"
ENDPOINT_CURL_MAX_TIME="${ENDPOINT_CURL_MAX_TIME:-20}"
PRICE_TOLERANCE_RATIO="${PRICE_TOLERANCE_RATIO:-0.000001}"
MARKET_CAP_TOLERANCE_RATIO="${MARKET_CAP_TOLERANCE_RATIO:-0.000001}"
VOLUME_TOLERANCE_RATIO="${VOLUME_TOLERANCE_RATIO:-0.000001}"
GLOBAL_TOLERANCE_RATIO="${GLOBAL_TOLERANCE_RATIO:-0.000001}"
UPDATED_AT_TOLERANCE_SECONDS="${UPDATED_AT_TOLERANCE_SECONDS:-120}"
MARKET_PAGE_LIMIT="${MARKET_PAGE_LIMIT:-250}"
MARKET_MAX_PAGES="${MARKET_MAX_PAGES:-20}"
EVIDENCE_DIR="${OPENGECKO_CONSISTENCY_EVIDENCE_DIR:-${HOT_ROUTE_CONSISTENCY_EVIDENCE_DIR:-}}"

for numeric_setting in \
  ENDPOINT_CURL_MAX_TIME \
  UPDATED_AT_TOLERANCE_SECONDS \
  MARKET_PAGE_LIMIT \
  MARKET_MAX_PAGES; do
  if [[ ! "${!numeric_setting}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${numeric_setting} must be a positive integer" >&2
    exit 2
  fi
done

TMP_DIR="$(mktemp -d /tmp/opengecko-hot-route-consistency.XXXXXX)"
RUN_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RESULT_FILE="${TMP_DIR}/result.json"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

fetch_json() {
  local label="$1"
  local path="$2"
  local output="${TMP_DIR}/${label}.json"

  curl -sS -f --max-time "$ENDPOINT_CURL_MAX_TIME" \
    "${BASE_URL}${path}" > "$output"

  if ! jq -e 'type == "object" or type == "array"' "$output" >/dev/null; then
    echo "FAIL ${path} did not return a JSON object or array" >&2
    cat "$output" >&2
    exit 2
  fi
}

fetch_json simple '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true&precision=full'
fetch_json markets_selected '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&per_page=2&page=1&sparkline=false&precision=full'
fetch_json coin_bitcoin '/coins/bitcoin?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false'
fetch_json coin_ethereum '/coins/ethereum?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false'
fetch_json global '/global'
fetch_json diagnostics_data_quality '/diagnostics/data_quality'

market_page_files=()
for page in $(seq 1 "$MARKET_MAX_PAGES"); do
  label="markets_page_${page}"
  fetch_json "$label" "/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${MARKET_PAGE_LIMIT}&page=${page}&sparkline=false&precision=full"
  market_page_files+=("${TMP_DIR}/${label}.json")
  row_count="$(jq 'length' "${TMP_DIR}/${label}.json")"
  if [[ "$row_count" -lt "$MARKET_PAGE_LIMIT" ]]; then
    break
  fi
done

jq -s 'add' "${market_page_files[@]}" > "${TMP_DIR}/markets_all.json"

jq -n \
  --arg run_timestamp "$RUN_TIMESTAMP" \
  --arg base_url "$BASE_URL" \
  --argjson price_tolerance "$PRICE_TOLERANCE_RATIO" \
  --argjson market_cap_tolerance "$MARKET_CAP_TOLERANCE_RATIO" \
  --argjson volume_tolerance "$VOLUME_TOLERANCE_RATIO" \
  --argjson global_tolerance "$GLOBAL_TOLERANCE_RATIO" \
  --argjson updated_tolerance "$UPDATED_AT_TOLERANCE_SECONDS" \
  --argjson assets '["bitcoin","ethereum"]' \
  --slurpfile simple "${TMP_DIR}/simple.json" \
  --slurpfile markets_selected "${TMP_DIR}/markets_selected.json" \
  --slurpfile markets_all "${TMP_DIR}/markets_all.json" \
  --slurpfile coin_bitcoin "${TMP_DIR}/coin_bitcoin.json" \
  --slurpfile coin_ethereum "${TMP_DIR}/coin_ethereum.json" \
  --slurpfile global "${TMP_DIR}/global.json" \
  --slurpfile diagnostics "${TMP_DIR}/diagnostics_data_quality.json" '
    def abs: if . < 0 then -. else . end;
    def finite_number: type == "number";
    def n0($value): if ($value | finite_number) then $value else 0 end;
    def delta_ratio($left; $right):
      if $left == null and $right == null then 0
      elif (($left | finite_number) | not) or (($right | finite_number) | not) then 1
      elif $left == 0 then (if $right == 0 then 0 else 1 end)
      else ((($left - $right) | abs) / ($left | abs))
      end;
    def parse_time($value):
      if ($value | type) == "number" then $value
      elif ($value | type) == "string" then ($value | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)
      else null
      end;
    def timestamp_delta_seconds($left; $right):
      (parse_time($left)) as $left_ts
      | (parse_time($right)) as $right_ts
      | if $left_ts == null or $right_ts == null then null else (($left_ts - $right_ts) | abs) end;
    def market_for($id):
      ($markets_selected[0][]? | select(.id == $id)) // null;
    def all_market_for($id):
      ($markets_all[0][]? | select(.id == $id)) // null;
    def detail_for($id):
      if $id == "bitcoin" then $coin_bitcoin[0] else $coin_ethereum[0] end;
    def check_ratio($asset; $route_pair; $field; $left; $right; $tolerance):
      {
        asset: $asset,
        route_pair: $route_pair,
        field: $field,
        left: $left,
        right: $right,
        delta_ratio: delta_ratio($left; $right),
        tolerance_ratio: $tolerance,
        pass: ((delta_ratio($left; $right)) <= $tolerance)
      };
    def check_timestamp($asset; $route_pair; $field; $left; $right; $tolerance):
      {
        asset: $asset,
        route_pair: $route_pair,
        field: $field,
        left: $left,
        right: $right,
        delta_seconds: timestamp_delta_seconds($left; $right),
        tolerance_seconds: $tolerance,
        pass: ((timestamp_delta_seconds($left; $right)) != null and (timestamp_delta_seconds($left; $right)) <= $tolerance)
      };
    def check_rank($asset; $left; $right):
      {
        asset: $asset,
        route_pair: "/coins/{id} vs /coins/markets",
        field: "market_cap_rank",
        left: $left,
        right: $right,
        comparable: ($left != null and $right != null),
        pass: ($left == $right or $left == null or $right == null)
      };
    def diagnostic_family($family):
      ($diagnostics[0].data.families[]? | select(.family == $family)) // null;
    def allowed_source_states: ["live","hybrid","seeded","fixture","replay","synthetic","fallback","degraded","stale","unavailable","out_of_scope"];
    def diagnostic_summary($family; $route_pass):
      (diagnostic_family($family)) as $entry
      | if $entry == null then
          {
            family: $family,
            present: false,
            route_consistency_passed: $route_pass,
            live_promotion_proof: false,
            pass: false,
            failures: ["diagnostic_family_missing:\($family)"]
          }
        else
          ($entry.source.state // "missing") as $state
          | ($entry.freshness_budget // $entry.source.freshness_budget // {}) as $freshness
          | ($route_pass
              and $state == "live"
              and (($entry.source.ownership_class // "") == "live")
              and ($entry.source.fallback == false)
              and (($freshness.counts_as_live_evidence // false) == true)
              and (($freshness.counts_as_live_freshness_evidence // false) == true)
              and ((["stale","degraded","unknown"] | index($freshness.status // "")) == null)
            ) as $live_proof
          | {
              family: $family,
              present: true,
              route_consistency_passed: $route_pass,
              source_state: $state,
              family_status: $entry.status,
              ownership_class: $entry.source.ownership_class,
              freshness_status: $freshness.status,
              reason_codes: (($entry.reason_codes // []) + ($freshness.reason_codes // []) | unique),
              provider_ids: $entry.source.provider_ids,
              live_promotion_proof: $live_proof,
              counts_as_live_evidence: ($freshness.counts_as_live_evidence // false),
              counts_as_live_freshness_evidence: ($freshness.counts_as_live_freshness_evidence // false),
              pass: (
                ((allowed_source_states | index($state)) != null)
                and (
                  $state != "live"
                  or $live_proof
                )
              ),
              failures: [
                if ((allowed_source_states | index($state)) == null) then "diagnostic_source_state_unknown:\($family):\($state)" else empty end,
                if $state == "live" and ($live_proof | not) then "diagnostic_live_evidence_incomplete:\($family)" else empty end
              ]
            }
        end;
    def pass_all($checks): all($checks[]?; .pass == true);
    def failure_codes($checks; $prefix):
      [$checks[]? | select(.pass != true) | "\($prefix):\(.asset // "global"):\(.field)"];

    ($assets | map(
      . as $id
      | (market_for($id)) as $market
      | ($simple[0][$id] // {}) as $simple_row
      | [
          check_ratio($id; "/simple/price vs /coins/markets"; "usd"; $simple_row.usd; $market.current_price; $price_tolerance),
          check_ratio($id; "/simple/price vs /coins/markets"; "usd_market_cap"; $simple_row.usd_market_cap; $market.market_cap; $market_cap_tolerance),
          check_ratio($id; "/simple/price vs /coins/markets"; "usd_24h_vol"; $simple_row.usd_24h_vol; $market.total_volume; $volume_tolerance),
          check_timestamp($id; "/simple/price vs /coins/markets"; "last_updated_at"; $simple_row.last_updated_at; $market.last_updated; $updated_tolerance)
        ]
    ) | add) as $simple_market_checks
    | ($assets | map(
      . as $id
      | (market_for($id)) as $market
      | (detail_for($id)) as $detail
      | [
          check_ratio($id; "/coins/{id} vs /coins/markets"; "current_price.usd"; $detail.market_data.current_price.usd; $market.current_price; $price_tolerance),
          check_ratio($id; "/coins/{id} vs /coins/markets"; "market_cap.usd"; $detail.market_data.market_cap.usd; $market.market_cap; $market_cap_tolerance),
          check_ratio($id; "/coins/{id} vs /coins/markets"; "total_volume.usd"; $detail.market_data.total_volume.usd; $market.total_volume; $volume_tolerance),
          check_rank($id; $detail.market_data.market_cap_rank; $market.market_cap_rank),
          check_timestamp($id; "/coins/{id} vs /coins/markets"; "last_updated"; $detail.market_data.last_updated; $market.last_updated; $updated_tolerance)
        ]
    ) | add) as $coin_detail_checks
    | ($global[0].data // $global[0]) as $global_data
    | (reduce $markets_all[0][]? as $row (0; . + n0($row.market_cap))) as $recomputed_market_cap
    | (reduce $markets_all[0][]? as $row (0; . + n0($row.total_volume))) as $recomputed_volume
    | ([
        check_ratio("global"; "/global vs /coins/markets"; "total_market_cap.usd"; $global_data.total_market_cap.usd; $recomputed_market_cap; $global_tolerance),
        check_ratio("global"; "/global vs /coins/markets"; "total_volume.usd"; $global_data.total_volume.usd; $recomputed_volume; $global_tolerance)
      ] + (["bitcoin","ethereum","usd-coin"] | map(
        . as $id
        | (if $id == "bitcoin" then "btc" elif $id == "ethereum" then "eth" else "usdc" end) as $symbol
        | (all_market_for($id).market_cap // 0) as $coin_market_cap
        | (if $recomputed_market_cap > 0 then ($coin_market_cap / $recomputed_market_cap) * 100 else 0 end) as $recomputed_dominance
        | check_ratio("global"; "/global vs /coins/markets"; "market_cap_percentage.\($symbol)"; $global_data.market_cap_percentage[$symbol]; $recomputed_dominance; $global_tolerance)
      ))) as $global_checks
    | (pass_all($simple_market_checks)) as $simple_markets_pass
    | (pass_all($coin_detail_checks)) as $coin_detail_pass
    | (pass_all($global_checks)) as $global_pass
    | ([
        diagnostic_summary("simple"; $simple_markets_pass),
        diagnostic_summary("coins"; $coin_detail_pass),
        diagnostic_summary("global"; $global_pass)
      ]) as $diagnostic_checks
    | {
        schema_version: "opengecko.hot-route-consistency.v1",
        generated_at: $run_timestamp,
        base_url: $base_url,
        tolerances: {
          price_tolerance_ratio: $price_tolerance,
          market_cap_tolerance_ratio: $market_cap_tolerance,
          volume_tolerance_ratio: $volume_tolerance,
          global_tolerance_ratio: $global_tolerance,
          updated_at_tolerance_seconds: $updated_tolerance
        },
        routes: {
          simple_price: "/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true&precision=full",
          selected_markets: "/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&per_page=2&page=1&sparkline=false&precision=full",
          all_markets: "/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=<limit>&page=<n>&sparkline=false&precision=full",
          coin_details: ["/coins/bitcoin", "/coins/ethereum"],
          global: "/global",
          diagnostics_data_quality: "/diagnostics/data_quality"
        },
        evidence: {
          simple_market_checks: $simple_market_checks,
          coin_detail_checks: $coin_detail_checks,
          global_checks: $global_checks,
          global_recomputation: {
            market_row_count: ($markets_all[0] | length),
            recomputed_total_market_cap_usd: $recomputed_market_cap,
            recomputed_total_volume_usd: $recomputed_volume,
            public_total_market_cap_usd: $global_data.total_market_cap.usd,
            public_total_volume_usd: $global_data.total_volume.usd
          },
          diagnostics: $diagnostic_checks
        },
        assertions: [
          {
            id: "VAL-CROSS-001",
            status: (if $simple_markets_pass then "pass" else "fail" end),
            summary: "/simple/price and /coins/markets agree for bitcoin/ethereum USD values within documented tolerance.",
            failures: failure_codes($simple_market_checks; "simple_markets_mismatch")
          },
          {
            id: "VAL-CROSS-002",
            status: (if $coin_detail_pass then "pass" else "fail" end),
            summary: "/coins/{id} market_data agrees with /coins/markets for bitcoin/ethereum within documented tolerance.",
            failures: failure_codes($coin_detail_checks; "coin_detail_markets_mismatch")
          },
          {
            id: "VAL-CROSS-003",
            status: (if $global_pass then "pass" else "fail" end),
            summary: "/global totals and dominance agree with recomputed /coins/markets snapshot aggregates within documented tolerance.",
            failures: failure_codes($global_checks; "global_markets_mismatch")
          },
          {
            id: "VAL-CROSS-004",
            status: (if all($diagnostic_checks[]; .pass == true) then "pass" else "fail" end),
            summary: "Hot route consistency evidence maps to matching /diagnostics/data_quality classifications; non-live classifications are not counted as live promotion proof.",
            failures: [$diagnostic_checks[] | .failures[]?]
          }
        ]
      }
  ' > "$RESULT_FILE"

if [[ -n "$EVIDENCE_DIR" ]]; then
  mkdir -p "$EVIDENCE_DIR"
  cp "${TMP_DIR}/simple.json" "${EVIDENCE_DIR}/simple-price.json"
  cp "${TMP_DIR}/markets_selected.json" "${EVIDENCE_DIR}/coins-markets-selected.json"
  cp "${TMP_DIR}/markets_all.json" "${EVIDENCE_DIR}/coins-markets-all.json"
  cp "${TMP_DIR}/coin_bitcoin.json" "${EVIDENCE_DIR}/coin-bitcoin.json"
  cp "${TMP_DIR}/coin_ethereum.json" "${EVIDENCE_DIR}/coin-ethereum.json"
  cp "${TMP_DIR}/global.json" "${EVIDENCE_DIR}/global.json"
  cp "${TMP_DIR}/diagnostics_data_quality.json" "${EVIDENCE_DIR}/diagnostics-data-quality.json"
  cp "$RESULT_FILE" "${EVIDENCE_DIR}/hot-route-consistency-result.json"
fi

echo "OpenGecko Hot Route Consistency Check"
echo "Target: ${BASE_URL}"
echo "Time:   ${RUN_TIMESTAMP}"
echo "Tolerances: price=${PRICE_TOLERANCE_RATIO} market_cap=${MARKET_CAP_TOLERANCE_RATIO} volume=${VOLUME_TOLERANCE_RATIO} global=${GLOBAL_TOLERANCE_RATIO} updated_at_seconds=${UPDATED_AT_TOLERANCE_SECONDS}"
if [[ -n "$EVIDENCE_DIR" ]]; then
  echo "Evidence artifacts: ${EVIDENCE_DIR}"
fi
echo

jq -r '
  .assertions[]
  | "\(.id): \(.status) - \(.summary)"
' "$RESULT_FILE"
echo

echo "Diagnostic route quality mapping"
jq -r '
  .evidence.diagnostics[]
  | "  \(.family): source_state=\(.source_state // "missing") family_status=\(.family_status // "missing") freshness_status=\(.freshness_status // "missing") route_consistency_passed=\(.route_consistency_passed) live_promotion_proof=\(.live_promotion_proof)"
' "$RESULT_FILE"
echo

if jq -e 'all(.assertions[]; .status == "pass")' "$RESULT_FILE" >/dev/null; then
  echo "Hot route consistency result: pass"
  exit 0
fi

echo "Hot route consistency result: fail" >&2
jq -r '
  .assertions[]
  | select(.status != "pass")
  | .id as $id
  | (.failures[]? // "unspecified_failure")
  | "\($id): \(.)"
' "$RESULT_FILE" >&2
exit 1
