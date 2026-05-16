# Operator Validation Workflow

Use this workflow after changing source-backed provider targets, backfill settings, or data-quality logic. The goal is to prove that public CoinGecko-compatible routes are backed by more real source rows without inflating `live` claims from seed, fixture, or replay-only data.

## 0. Start From Baseline Diagnostics

Run the API locally, then capture diagnostics before any sync/backfill work:

```bash
export OPEN_GECKO_BASE_URL="${OPEN_GECKO_BASE_URL:-http://localhost:3000}"

curl -s "$OPEN_GECKO_BASE_URL/diagnostics/coverage_matrix" \
  | tee /tmp/opengecko-coverage-before.json \
  | jq '.data.entries[] | {family, ownership_class, last_successful_refresh_at, freshness: .freshness.state}'

curl -s "$OPEN_GECKO_BASE_URL/diagnostics/market_charts" \
  | tee /tmp/opengecko-market-charts-before.json \
  | jq '.data.summary, .data.gaps'

curl -s "$OPEN_GECKO_BASE_URL/diagnostics/ohlcv_sync" \
  | tee /tmp/opengecko-ohlcv-before.json \
  | jq '.data.history.completion_estimate, .data.history.queue_priority_summary'

curl -s "$OPEN_GECKO_BASE_URL/diagnostics/jobs" \
  | tee /tmp/opengecko-jobs-before.json \
  | jq '.data'
```

Treat this baseline as the proof target. A successful run should reduce missing/stale/shallow diagnostics, increase source-attributed row counts, or improve OHLCV depth. It does not need to force a family from `seeded` to `live` in one pass.

## 1. Validate Configuration Before Sync

Use small, bounded targets first. Do not enable the optional scheduler until standalone sync commands and diagnostics are clean.

```bash
# Optional adapter origins. Keep unset for jobs you are not validating.
export MARKET_CHART_BASE_URL="https://charts-adapter.example"
export EXCHANGE_VOLUME_BASE_URL="https://exchange-volume-adapter.example"
export ONCHAIN_TRADE_BASE_URL="https://onchain-trade-adapter.example"

# Planner-driven market chart sync path. This consumes docs/reference/default-coverage-targets.json.
export MARKET_CHART_USE_COVERAGE_PLAN=true
```

Before using a provider target copied from diagnostics, confirm the provider ID appears in the corresponding preset/reference document and that the target is not a stale-only retry when you intended to backfill missing history.

Useful references:

- `docs/reference/default-coverage-targets.json`: coverage manifest for market chart and OHLCV priority/depth.
- `docs/reference/market-chart-provider-presets.json`: documented market-chart adapter IDs and request paths.
- `docs/reference/market-chart-diagnostics-workflow.md`: target-suggestion triage for chart/OHLC fallback pressure.

## 2. Run Source-Backed Sync And Backfill

### Market charts

Prefer the planner-backed path for coverage work:

```bash
MARKET_CHART_USE_COVERAGE_PLAN=true bun run market:charts:sync
```

For an explicit retry-only batch after partial failures:

```bash
export MARKET_CHART_RETRY_TARGETS="$(curl -s "$OPEN_GECKO_BASE_URL/diagnostics/jobs" \
  | jq -r '.data.jobs[]? // empty | select(.id == "market_charts") | .last_partial_failure_retry_targets_template // empty')"

if [ -n "$MARKET_CHART_RETRY_TARGETS" ]; then
  MARKET_CHART_TARGETS="$MARKET_CHART_RETRY_TARGETS" bun run market:charts:sync
fi
```

### OHLCV

Run the OHLCV worker for bounded validation windows or under the normal scheduler:

```bash
bun run ohlcv:worker
```

Watch `/diagnostics/ohlcv_sync` for decreasing `remaining_depth_days`, fewer blocked targets, and retry-due targets being leased before long-tail expansion.

### Other source-backed families

Run only the providers you configured:

```bash
bun run exchange:volumes:sync
bun run derivatives:sync
bun run onchain:trades:sync
bun run onchain:analytics:sync
bun run coin:history:sync
bun run supply:charts:sync
```

## 3. Check Job Outcomes

Immediately inspect job diagnostics and sanitize any copied failure output before sharing it externally:

```bash
curl -s "$OPEN_GECKO_BASE_URL/diagnostics/jobs" \
  | tee /tmp/opengecko-jobs-after.json \
  | jq '.data.scheduler, .data.jobs, .data.optional_provider_jobs'
```

Pass criteria:

- Last run has a finish timestamp and no unsanitized secrets in failure samples.
- Partial failures have bounded retry samples and, when enough context exists, a retry-only target template.
- Retention/sweep outcomes are visible for append-style source tables.
- Market chart production freshness cadence is not slower than the strictest production freshness SLO for enabled targets when production freshness claims are being made.

## 4. Verify Coverage Improvements

Capture after-state diagnostics:

```bash
curl -s "$OPEN_GECKO_BASE_URL/diagnostics/market_charts" \
  | tee /tmp/opengecko-market-charts-after.json \
  | jq '.data.summary, .data.gaps'

curl -s "$OPEN_GECKO_BASE_URL/diagnostics/ohlcv_sync" \
  | tee /tmp/opengecko-ohlcv-after.json \
  | jq '.data.history.completion_estimate, .data.history.by_tier, .data.history.queue_priority_summary'

curl -s "$OPEN_GECKO_BASE_URL/diagnostics/coverage_matrix" \
  | tee /tmp/opengecko-coverage-after.json \
  | jq '.data.entries[] | {family, ownership_class, last_successful_refresh_at, freshness: .freshness.state, notes: .evidence.notes}'
```

Compare before/after snapshots:

```bash
jq -n \
  --slurpfile before /tmp/opengecko-coverage-before.json \
  --slurpfile after /tmp/opengecko-coverage-after.json \
  '{
    before: ($before[0].data.entries | map({family, ownership_class, last_successful_refresh_at})),
    after: ($after[0].data.entries | map({family, ownership_class, last_successful_refresh_at}))
  }'
```

Expected improvement signals:

- `market_charts`: fewer `configured_without_source_rows`, `stale_source_targets`, `production_stale_source_targets`, or `shallow_source_targets`.
- `ohlcv_sync`: lower `remaining_depth_days`, fewer `blocked` samples, or higher tier `coverage_ratio`.
- `coverage_matrix`: ownership only promotes when source-backed gates are satisfied; replay/fixture/seed rows can update evidence but must not become `live` by themselves.
- Public chart/OHLC responses keep CoinGecko-compatible shapes; diagnostics-only fields stay out of public responses.

## 5. Promote Or Roll Back

Promote scheduler-backed operation only when standalone validation passes:

```bash
export OPTIONAL_PROVIDER_SYNC_ENABLED=true
export OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS=900
```

Rollback is safe and shape-preserving:

```bash
export OPTIONAL_PROVIDER_SYNC_ENABLED=false
```

Then keep standalone sync commands under cron or an external scheduler until provider failures, depth gaps, or freshness misses are resolved.

## Non-Negotiable Data-Quality Rules

- Never call a family `live` just because seed, fixture, canonical validation snapshot, or replay rows exist.
- Treat replay rows as source-attributed evidence for route behavior and backfill shape, not as production-live freshness by themselves.
- Require both breadth and depth for historical chart live promotion.
- Use diagnostics deltas as the proof of improvement; do not hand-edit documentation counts without a matching diagnostics or test change.
