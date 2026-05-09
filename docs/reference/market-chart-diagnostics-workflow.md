# Market Chart Diagnostics Workflow

Use `GET /diagnostics/market_charts` to turn public chart/OHLC fallback pressure into source-backed `MARKET_CHART_TARGETS` work. All fields in this workflow are diagnostics-only and must not appear in public `/coins/:id/market_chart*` or `/coins/:id/ohlc*` responses.

## Read The Alert

Start with `response_source_fallback_alert.status`.

- `clear`: no recent chart/OHLC fallback pressure is visible in the diagnostics window.
- `watch`: fallback pressure is stale-only or already source-backed and suppressed from suggestions.
- `action_needed`: unresolved recent fallback pressure exists and should be reviewed.

For `watch`, inspect `response_source_target_suggestion_exclusions.stale_events` and `response_source_target_suggestion_exclusions.source_backed_events` before adding targets. For `action_needed`, inspect `response_source_target_suggestions` and the batch/overflow fields below.

## Choose Retry Or Backfill

Use `GET /diagnostics/jobs` before changing chart targets. If `summary.partial_failure > 0` or the `market_charts` job has `last_partial_failure_reason`, treat the run as degraded: inspect the sanitized `last_partial_failure_samples`, then retry or fix the provider target that failed before assuming the remaining chart gaps need new coverage. Use `last_partial_failure_retry_targets_template` as a retry-only `MARKET_CHART_TARGETS` batch when it is present.

```bash
export MARKET_CHART_RETRY_TARGETS="$(curl -s "http://localhost:3000/diagnostics/jobs" \
  | jq -r '.data.jobs[]
      | select(.id == "market_charts")
      | .last_partial_failure_retry_targets_template // empty')"

if [ -n "$MARKET_CHART_RETRY_TARGETS" ]; then
  MARKET_CHART_TARGETS="$MARKET_CHART_RETRY_TARGETS" bun run market:charts:sync
fi
```

Use this retry-only command after a partial run so successful source rows are not reprocessed unnecessarily. If partial-failure samples exist but the retry template is empty, the samples did not include enough provider, coin, currency, and interval context to build a safe `MARKET_CHART_TARGETS` batch; inspect the samples or provider logs before retrying a broad batch. If there is no partial-failure evidence, use the stale/shallow and fallback-suggestion checks below instead.

Then use `GET /diagnostics/market_charts` to separate target states:

- `gaps.configured_without_source_rows`: the target is configured but has no rows, so retry the sync or check provider support for that coin/interval/currency.
- `gaps.stale_source_targets`: rows exist but are older than the interval freshness threshold, so run a fresh sync before adding more targets.
- `gaps.production_stale_source_targets`: rows pass the first-run freshness SLO but miss the stricter production freshness target, so raise sync frequency or retry before making CoinGecko-level freshness claims.
- `gaps.shallow_source_targets`: rows exist but do not cover enough history for the user-facing window, so deepen provider history or backfill a broader range.
- `response_source_fallback_alert.status == "action_needed"` with returned suggestions: add or batch new `MARKET_CHART_TARGETS` after provider selection.

This keeps partial provider errors, stale source rows, shallow history depth, and missing target coverage from being treated as the same problem.

## Freshness SLOs

Treat `coverage.freshness` as source-sync recency, not proof that every public chart point has CoinGecko parity. A configured target can be called fresh only when diagnostics show source rows and the interval-specific thresholds pass:

- `1d`: `coverage.freshness_threshold_seconds=129600` and `coverage.depth_threshold_days=30`.
- `1m`: `coverage.freshness_threshold_seconds=1800` and `coverage.depth_threshold_days=1`.

These are first-run minimum SLOs. For production CoinGecko-style operation, also watch the stricter diagnostics-only targets:

- `1d`: `coverage.production_freshness_threshold_seconds=7200`.
- `1m`: `coverage.production_freshness_threshold_seconds=300`.

Use `summary.production_freshness_counts` for the rollout-level view and `gaps.production_stale_source_targets` for the retry list. A target can be first-run fresh while production-stale; treat that as a sync-frequency or provider-latency problem, not as missing historical depth.

When `gaps.production_stale_source_targets` is non-empty, check `GET /diagnostics/jobs` for the `market_charts.production_freshness_cadence` advisory:

- `scheduler_disabled`: run `bun run market:charts:sync` manually or enable `OPTIONAL_PROVIDER_SYNC_ENABLED=true` before blaming provider latency.
- `interval_slower_than_production_freshness`: lower `OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS` to the reported `strictest_production_freshness_seconds` or less before making production freshness claims.
- `cadence_within_production_freshness`: inspect partial failures, adapter source timestamps, and provider latency before adding targets.

If a target is `live_backed` but `coverage.freshness=stale`, retry a fresh sync before expanding the target set. If it is `live_backed` but `coverage.depth=shallow`, keep the target and deepen provider history instead of treating the gap as missing provider support.

## Plan Batches

Use `response_source_target_suggestion_operator_summary` to decide whether the current returned suggestions are mostly `daily_history` or `intraday_history`.

Use `response_source_target_suggestion_batch_previews.groups.daily_history.market_chart_targets_template` or `response_source_target_suggestion_batch_previews.groups.intraday_history.market_chart_targets_template` to copy a batch after choosing a provider.

```bash
curl "http://localhost:3000/diagnostics/market_charts" \
  | jq '.data.response_source_target_suggestion_operator_summary'

curl "http://localhost:3000/diagnostics/market_charts" \
  | jq -r '.data.response_source_target_suggestion_batch_previews.groups.daily_history.market_chart_targets_template'
```

Only replace `<provider>` with a supported provider ID from `docs/reference/market-chart-provider-presets.json`. The diagnostics route does not choose providers, write `MARKET_CHART_TARGETS`, or apply targets automatically.

## Check Overflow

`response_source_target_suggestion_overflow` compares eligible unique targets against returned suggestions after stale and source-backed filtering. It is not a raw fallback event count.

```bash
curl "http://localhost:3000/diagnostics/market_charts" \
  | jq '.data.response_source_target_suggestion_overflow.target_history_counts
      | {
          daily_omitted: .daily_history.omitted_by_suggestion_cap,
          intraday_omitted: .intraday_history.omitted_by_suggestion_cap
        }'
```

If `response_source_target_suggestion_overflow.omitted_by_suggestion_cap > 0`, treat the current batch preview as the first page of remediation work. Use the daily/intraday omitted counts to decide whether the next batch should prioritize daily-history backfill, intraday-history backfill, or a smaller provider-specific target set.

## Apply And Verify

```bash
export MARKET_CHART_BASE_URL="https://charts-adapter.example"
export MARKET_CHART_TARGET_BATCH="$(curl -s "http://localhost:3000/diagnostics/market_charts" \
  | jq -r '.data.response_source_target_suggestion_batch_previews.groups.daily_history.market_chart_targets_template // empty')"
export MARKET_CHART_TARGETS="${MARKET_CHART_TARGET_BATCH//<provider>/ccxt.binance}"

bun run market:charts:sync
curl "http://localhost:3000/diagnostics/market_charts" \
  | jq --arg targets "$MARKET_CHART_TARGETS" '
      ($targets | split(",") | map(split("=")[1] | split(":") | {coin_id: .[0], interval: .[1], vs_currency: .[2]})) as $target_rows
      | .data.coins[]
      | select(. as $coin | $target_rows[] | .coin_id == $coin.coin_id and .interval == $coin.interval and .vs_currency == $coin.vs_currency)
      | {coin_id, interval, vs_currency, status, coverage}'
```

A target is not CoinGecko-fresh until it is `live_backed` with `coverage.freshness=fresh` and enough `coverage.depth` for the user-facing chart window. Suggestions, batch previews, and overflow counters are operator hints, not proof of freshness.
