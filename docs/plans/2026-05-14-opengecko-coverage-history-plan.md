# OpenGecko Data Coverage and History Depth Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move OpenGecko closer to CoinGecko replacement quality by improving source-backed data coverage and historical depth, starting with market chart/OHLCV targets and a planner-driven backfill workflow.

**Architecture:** Keep HTTP compatibility and data fidelity separate. Represent desired data coverage as explicit targets, let diagnostics expose missing/stale/shallow coverage, then add a planner that turns those gaps into executable sync/backfill work. Public CoinGecko-compatible response shapes must not change.

**Tech Stack:** Bun, TypeScript, Fastify, SQLite/better-sqlite3, Drizzle, CCXT, Vitest.

---

## Why this plan exists

The current project already has broad CoinGecko-compatible route coverage, but CoinGecko distance is now dominated by:

1. **Data source coverage** — which coins/exchanges/pools/routes have source-backed rows instead of seeded or fixture fallback.
2. **Data historical depth** — whether chart/OHLCV routes have enough recent and historical rows to satisfy real user windows.

Do not treat new endpoint surface as progress unless it improves one of these two outcomes or strengthens proof through diagnostics/tests.

## Near-term success criteria

The first implementation wave is successful when:

- Market chart/OHLCV coverage targets are represented in a reusable manifest/service, not only ad hoc env strings.
- The system can classify target gaps as `missing`, `stale`, `production_stale`, `shallow`, or `covered`.
- A planner can produce deterministic next sync/backfill tasks from those targets and existing source rows.
- Market chart/OHLCV sync jobs can consume planner output without changing public response shapes.
- `/diagnostics/market_charts`, `/diagnostics/ohlcv_sync`, and `/diagnostics/coverage_matrix` show the improvement after rows are written.
- Tests prove no fixture/seeded row is overclaimed as live.

## Scope guardrails

- Start with market charts and OHLCV only.
- Do not add onchain/supply/treasury expansion until the planner pattern is proven.
- Do not make TimescaleDB or external services mandatory.
- Do not use CoinGecko as a default data source; only use it for compatibility snapshots/diffs.
- Do not add provenance fields to default CoinGecko-compatible public payloads.
- Do not add more diagnostics fields unless they are consumed by planner/scheduler behavior or guard a concrete operator invariant.

## Implementation sequence

### Task 1: Add a coverage target manifest service

**Objective:** Parse and validate reusable target manifests for source-backed coverage work.

**Files:**
- Create: `src/services/coverage-targets.ts`
- Create or update: `docs/reference/default-coverage-targets.json`
- Test: `tests/coverage-targets.test.ts`

**Behavior:**
- Load target rows with fields: `family`, `provider`, `entity_type`, `entity_id`, `interval`, `vs_currency`, `tier`, `target_history_days`, `freshness_slo_seconds`, `production_freshness_slo_seconds`, `enabled`, `priority`.
- Support at least `family='market_charts'` and `family='ohlcv'`.
- Reject duplicate enabled targets by `family/provider/entity/interval/vs_currency`.
- Reject unsupported intervals in the first version except `1d`, `1h`, and `1m`.
- Provide helpers to convert market-chart manifest rows to existing `MarketChartSyncTarget` objects.

**Verification:**
- Write failing Vitest coverage first.
- Run: `bun test tests/coverage-targets.test.ts`
- Then implement minimal parser.

### Task 2: Align existing market chart manifest with coverage targets

**Objective:** Keep `docs/reference/market-chart-targets.json` and new default coverage manifest aligned.

**Files:**
- Modify: `docs/reference/market-chart-targets.json`
- Modify: `docs/reference/default-coverage-targets.json`
- Modify: `tests/market-chart-targets.test.ts`
- Modify: `tests/docs-drift.test.ts` if needed

**Behavior:**
- Existing documented `MARKET_CHART_TARGETS` must be derivable from enabled `market_charts` coverage targets.
- The default manifest should cover seeded chart coins with both `1d` and `1m` targets as currently documented, but now with tier/freshness/depth metadata.

**Verification:**
- `bun test tests/market-chart-targets.test.ts tests/coverage-targets.test.ts`

### Task 3: Add history backfill planner

**Objective:** Turn target gaps into deterministic work items.

**Files:**
- Create: `src/services/history-backfill-planner.ts`
- Test: `tests/history-backfill-planner.test.ts`

**Behavior:**
- Input: coverage targets, observed target state, `now`.
- Output: ordered tasks with `family`, `provider`, `coinId`, `interval`, `vsCurrency`, `from`, `to`, `reason`, `priority`.
- Reasons: `missing`, `stale`, `production_stale`, `shallow`, `gap_repair`.
- Priority order: tier S before A before B before long_tail; production stale before stale before missing/shallow long-tail; lower numeric priority wins within a tier.
- Chunk historical tasks to provider-safe windows; start with existing 180-day historical chunk convention for daily history.

**Verification:**
- Tests cover no task for covered targets.
- Tests cover missing target creates a first sync task.
- Tests cover stale target creates refresh task.
- Tests cover shallow target creates backfill task.
- Tests cover deterministic sorting.

### Task 4: Feed planner output into market chart sync

**Objective:** Let market chart sync consume planner tasks in addition to env targets.

**Files:**
- Modify: `src/services/market-chart-sync.ts`
- Modify: `src/jobs/sync-market-charts.ts`
- Test: `tests/market-chart-sync.test.ts`
- Test: `tests/optional-provider-jobs.test.ts` if job summary changes

**Behavior:**
- Preserve current `MARKET_CHART_TARGETS` behavior.
- Add an internal path that accepts planner tasks and converts them into provider fetches.
- Continue partial failure behavior: later targets still run; all-failed batches fail the job.
- Successful provider rows are written to `market_chart_source_points` and become visible through public chart/OHLC routes.

**Verification:**
- Existing market chart sync tests stay green.
- New test proves planner task writes source rows and `/coins/:id/market_chart/range` reads them.
- Public response shapes remain unchanged.

### Task 5: Feed planner priorities into OHLCV worker/backfill

**Objective:** Make canonical OHLCV history depth improve according to coverage target priority.

**Files:**
- Modify: `src/services/ohlcv-targets.ts`
- Modify: `src/services/ohlcv-runtime.ts`
- Modify: `src/services/ohlcv-sync.ts` only if chunk boundaries need adjustment
- Test: `tests/ohlcv-targets.test.ts`
- Test: `tests/ohlcv-runtime.test.ts`
- Test: `tests/ohlcv-worker-state.test.ts`

**Behavior:**
- Preserve top-100-first policy.
- Incorporate manifest tier/priority when leasing or generating OHLCV targets.
- Retry-due failed targets still beat ordinary complete targets.
- Incomplete high-tier history beats complete low-tier history.

**Verification:**
- Tests prove lease ordering respects retry due, tier, and remaining depth.
- `/diagnostics/ohlcv_sync` completion estimates reflect real row progress.

### Task 6: Tighten coverage matrix promotion rules

**Objective:** Make source-backed progress visible without overclaiming live parity.

**Files:**
- Modify: `src/services/coverage-matrix.ts`
- Test: `tests/diagnostics-routes.test.ts`
- Test: `tests/docs-drift.test.ts`
- Modify: `docs/status/implementation-tracker.md`

**Behavior:**
- `simple` and `coins_markets` can become `live` only when fresh source-backed market snapshots exist.
- `historical_charts` becomes `hybrid` when source-backed market chart or canonical OHLCV rows exist for configured targets.
- Future `historical_charts=live` requires a documented threshold, not just one row.
- Fixture rows must never promote a family to `live`.

**Verification:**
- Tests cover promotion and demotion.
- Docs drift prevents overclaims.

### Task 7: Add operator validation workflow

**Objective:** Give operators a concrete way to verify data coverage and historical depth improved.

**Files:**
- Modify: `README.md`
- Modify: `docs/reference/market-chart-diagnostics-workflow.md`
- Maybe create: `scripts/validate-coverage-history.sh`

**Behavior:**
- Document commands to run market chart sync/backfill.
- Document how to inspect:
  - `/diagnostics/coverage_matrix`
  - `/diagnostics/market_charts`
  - `/diagnostics/ohlcv_sync`
  - `/diagnostics/jobs`
- Document expected transition from configured-pending/missing/shallow to source-backed/fresh/deeper.

**Verification:**
- Docs drift tests guard command/env names.
- Optional smoke script exits non-zero if target diagnostics do not improve.

## First implementation cut

Start with Tasks 1–3 only. Do not modify runtime scheduler behavior until the target manifest and planner are tested and stable.

## Verification gate for every PR

Run at minimum:

```bash
export PATH=/home/whoami/.bun/bin:$PATH
bun test <focused test files>
bun run typecheck
bun run lint
bun run build
```

Before claiming the feature is complete, run:

```bash
export PATH=/home/whoami/.bun/bin:$PATH
bun run test
bun run test:coverage
```

## Current owner note

This is now the OpenGecko near-term implementation direction. Future work should continue from this plan before adding unrelated endpoint surface.
