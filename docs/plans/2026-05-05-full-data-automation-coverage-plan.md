# Full Data Automation Coverage Plan

> **Goal**: Move OpenGecko from ~55% live/automated data coverage to a realistic ceiling of **~85–90%** by converting lazy/on-demand integrations into background workers, adding sweepers for currently fixture-only families, and standing up a unified job scheduler.
>
> **Date**: 2026-05-05
> **Status**: proposal — not yet executed
> **Companion docs**:
>
> - `docs/plans/2026-03-29-data-fidelity-uplift-plan.md`
> - `docs/plans/2026-03-23-top100-priority-ohlcv-worker-plan.md`
> - `docs/status/implementation-tracker.md`

## 1. Problem Statement

The current runtime automates only the hot path:

| Loop                          | Cadence | Owner                |
| ----------------------------- | ------- | -------------------- |
| Market snapshot refresh       | 60 s    | `market-runtime.ts`  |
| Currency rates                | 300 s   | `market-runtime.ts`  |
| Search index rebuild          | 900 s   | `market-runtime.ts`  |
| Continuous OHLCV (top-100)    | tick    | `ohlcv-runtime.ts`   |
| Cache eviction                | tick    | `market-runtime.ts`  |
| Boot-time initial sync        | once    | `initial-sync.ts`    |

Everything else is either:

- **Lazy / on-demand** — DeFiLlama pools/tokens, Subsquid trades, coin catalog discovery (boot-only).
- **Static fixture** — derivatives, treasury, onchain holders/traders, categories, supply charts, global market-cap chart.

Net effect: ~45% of the active endpoint surface either decays after boot or never updates at all.

## 2. Reachability Bands

```diagram
╭─────────────────────────────────────────────────────────────╮
│  Realistic ceiling: ~85–90% automated live coverage          │
│  100% is blocked by data-source economics, not engineering.  │
╰─────────────────────────────────────────────────────────────╯

   Now ~55% ─┐
             ├─→ Tier 1 (+15–20%) ─→ ~70–75%
             ├─→ Tier 2 (+10%)    ─→ ~85%
             └─→ Tier 3 (+3–5%)   ─→ ~88–90%
                                    └─→ Remaining ~10% requires
                                        paid on-chain indexers
                                        (Covalent / Moralis / Dune)
                                        or self-built indexer.
```

## 3. Architecture: Unified Job Scheduler

The first deliverable. All scheduled work today uses ad-hoc `setInterval` calls scattered across `market-runtime.ts` and `ohlcv-runtime.ts`. This must be replaced before we pile more sweepers in.

### 3.1 Requirements

- **Single registration surface** for every periodic job.
- **Per-job serialization** (no overlapping runs).
- **Failure backoff** with jitter; consecutive-failure counter.
- **Diagnostics endpoint** `/diagnostics/jobs` exposing for each job:
  - `name`, `interval_seconds`, `last_run_at`, `last_success_at`,
  - `last_duration_ms`, `last_error`, `error_count`, `lag_seconds`.
- **Stop semantics** wired into the existing runtime lifecycle.

### 3.2 Proposed Module Layout

```diagram
src/services/
  job-scheduler.ts         ← new: registry, lifecycle, backoff
  job-diagnostics.ts       ← new: snapshot for /diagnostics/jobs
  jobs/                    ← new directory, one file per worker
    market-refresh.job.ts
    currency-rates.job.ts
    search-rebuild.job.ts
    ohlcv-tick.job.ts
    defillama-pool-sweep.job.ts
    defillama-token-sweep.job.ts
    subsquid-trade-sweep.job.ts
    coin-catalog-rescan.job.ts
    exchange-metadata-rescan.job.ts
    derivatives-refresh.job.ts
    global-aggregator.job.ts
    category-aggregator.job.ts
    supply-aggregator.job.ts
    treasury-sweep.job.ts
```

`market-runtime.ts` and `ohlcv-runtime.ts` shrink to "construct scheduler + register existing jobs"; behavior is preserved.

## 4. Tier 1 — Background-ize Lazy Data (+15–20%)

These are pure scheduling additions: the providers already work; we just need to make them sweep proactively instead of waiting for a request.

| Job                          | Cadence | Source     | Endpoints lifted                                        |
| ---------------------------- | ------- | ---------- | ------------------------------------------------------- |
| `defillama-pool-sweep`       | 300 s   | DeFiLlama  | `/onchain/networks/*/pools`, `*/dexes/*/pools`          |
| `defillama-token-sweep`      | 600 s   | DeFiLlama  | `/onchain/networks/*/tokens/*`, `tokens/multi/*`        |
| `subsquid-trade-sweep`       | 60 s    | Subsquid   | `/onchain/networks/*/pools/*/trades`                    |
| `coin-catalog-rescan`        | 1 h     | CCXT       | `/coins/list`, `/coins/list/new`                        |
| `exchange-metadata-rescan`   | 6 h     | CCXT       | `/exchanges`, `/exchanges/{id}`                         |
| `global-aggregator`          | 60 s    | internal   | `/global`, `/global/market_cap_chart`                   |
| `category-aggregator`        | 900 s   | internal   | `/coins/categories`, `/coins/categories/list`           |

### 4.1 Target Selection Policy

Sweepers must not blow the rate-limit. Use a **3-tier coverage list**:

```diagram
Tier            Size       Cadence     Notes
─────────────────────────────────────────────────────────────
Top-100 hot     ~100       1× / cycle  every sweep
Mid 101-1000    ~900       1× / 5 cyc  rotate slice each cycle
Long-tail       remainder  1× / 1 h+   opportunistic
```

This generalizes the OHLCV worker's existing top-100-first policy.

### 4.2 Storage

Reuse existing tables. Where new persistence is needed:

- `defillama_pool_snapshots` — pool discovery + reserve/volume rows.
- `global_market_snapshots` — append-only series for `/global/market_cap_chart`.
- `category_snapshots` — aggregate cap/volume per category per tick.

## 5. Tier 2 — Fill Fixture Holes (+10%)

| Family            | Approach                                                                                  | Effort |
| ----------------- | ----------------------------------------------------------------------------------------- | ------ |
| **Derivatives**   | Add `derivatives-refresh` job using CCXT's perpetual/futures support on binance/bybit/okx/bitget. Persist tickers and venue OI. Drop `meta.fixture: true`. | M      |
| **Categories**    | Replace fixture with: (a) seed canonical taxonomy (DeFi, L1, L2, Meme, …) once, (b) compute aggregates from live snapshots in `category-aggregator`.        | S      |
| **Supply charts** | Aggregator job snapshots `circulating_supply` / `total_supply` from existing market snapshots into a series table; chart endpoints read from it.            | M      |
| **Top gainers / losers** | Already computable from live snapshots; just remove fixture path.                                                                                  | S      |

## 6. Tier 3 — Bounded External Sources (+3–5%)

| Family       | Approach                                                                                 | Risk                |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------- |
| **Treasury** | Daily `treasury-sweep` job parsing `bitcointreasuries.net` JSON + SEC 13F RSS where available. Falls back to current fixture if upstream is unreachable. | scraping fragility  |
| **Onchain holders / traders / holders chart** | Stays fixture-marked unless a paid indexer is provisioned (see §7).                                       | cost                |
| **/search/trending**                          | Approximate using volume-weighted price-change ranking from live snapshots. Documented as "approximation".  | semantic divergence |

## 7. Out-of-Scope Without Paid Sources (~10%)

These cannot be made live at parity quality without significant cost or self-built indexing infrastructure:

- `/onchain/*/top_holders` — needs full address index per chain.
- `/onchain/*/top_traders` — needs wallet-level trade attribution + PnL.
- `/onchain/*/holders_chart` — needs historical holder snapshots.
- `/onchain/pools/megafilter` — needs an indexed pool warehouse.
- Deep historical OHLCV (>365 d) for long-tail coins — bounded by exchange-side history.

Recommendation: keep these explicitly fixture-marked (`meta.fixture: true`) and document them in the parity matrix. Revisit only when a concrete user need justifies the cost of Covalent / Moralis / Dune integration.

## 8. Diagnostics & Observability

Every new job MUST emit:

- A row visible in `/diagnostics/jobs`.
- A structured log line per run with `name`, `duration_ms`, `outcome`, `targets_processed`, `error?`.
- A metric counter for failures, increment-on-error.

Mirror the pattern already established by `/diagnostics/ohlcv_sync`.

## 9. Configuration Surface

Extend `src/config/runtime-policy.ts` with named defaults; expose all in env:

```
DEFILLAMA_POOL_SWEEP_INTERVAL_SECONDS=300
DEFILLAMA_TOKEN_SWEEP_INTERVAL_SECONDS=600
SUBSQUID_TRADE_SWEEP_INTERVAL_SECONDS=60
COIN_CATALOG_RESCAN_INTERVAL_SECONDS=3600
EXCHANGE_METADATA_RESCAN_INTERVAL_SECONDS=21600
GLOBAL_AGGREGATOR_INTERVAL_SECONDS=60
CATEGORY_AGGREGATOR_INTERVAL_SECONDS=900
DERIVATIVES_REFRESH_INTERVAL_SECONDS=120
SUPPLY_AGGREGATOR_INTERVAL_SECONDS=900
TREASURY_SWEEP_INTERVAL_SECONDS=86400
```

Each job should also support `*_DISABLED=true` for self-hosters who want to opt out (e.g. no DeFiLlama key available).

## 10. Execution Sequence

```diagram
Week 1   ┃ Unified Job Scheduler + diagnostics endpoint
         ┃   ├─ migrate existing 5 timers into the registry
         ┃   ├─ /diagnostics/jobs live
         ┃   └─ no behavior change yet
─────────╋────────────────────────────────────────────────
Week 2   ┃ Tier 1: DeFiLlama / Subsquid / Catalog / Global
         ┃   → coverage 55% → 70–75%
─────────╋────────────────────────────────────────────────
Week 3   ┃ Tier 2a: Derivatives + Categories
         ┃   → coverage 75% → 82%
─────────╋────────────────────────────────────────────────
Week 4   ┃ Tier 2b: Supply aggregator + Top gainers/losers
         ┃   → coverage 82% → 85%
─────────╋────────────────────────────────────────────────
Week 5   ┃ Tier 3: Treasury sweep + trending approximation
         ┃   → coverage 85% → 88–90%
─────────╋────────────────────────────────────────────────
Long-term ┃ Optional paid indexer evaluation for holders/traders.
```

## 11. Verification Plan

For each tier:

1. Add or extend Vitest coverage that asserts:
   - Job registers, runs, and writes to its target table.
   - REST endpoint reads from the new table and drops `meta.fixture: true` where applicable.
2. Add a smoke script under `scripts/modules/<family>/<family>.sh` that hits the relevant endpoints and asserts non-fixture markers.
3. Update `docs/status/implementation-tracker.md`:
   - Move the family from `fixture` / `hybrid` to `live`.
   - Update the "Data Quality Summary" percentages.
4. Bump `package.json` version per the project's SemVer rules in `CLAUDE.md`:
   - Tier 1 / Tier 2 endpoint-family uplift → minor.
   - Tier 3 fragile scraping additions → minor + explicit divergence note.

## 12. Risks

| Risk                                                            | Mitigation                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| DeFiLlama / Subsquid rate limits with broader sweeping          | Tiered target list; provider breaker; jittered backoff                     |
| Treasury scraping breakage                                      | Fixture fallback; daily cadence; failure does not break route              |
| CCXT derivatives feature gaps across exchanges                  | Allow per-exchange opt-out in config; document divergence                  |
| Job scheduler regression breaks hot path                        | Migrate existing 5 timers first with no logic change; ship behind tests    |
| Disk growth from new snapshot tables                            | Apply retention policy mirroring `ohlcv-targets` retention enforcement     |

## 13. Non-Goals

- No build of a generic on-chain indexer.
- No NFT family revival.
- No vendor lock-in to a single paid data provider.
- No removal of the fixture-fallback escape hatch — it remains the safety net when upstream sources fail.

## 14. Success Criteria

- `/diagnostics/jobs` reports all registered jobs healthy with `lag_seconds` within budget.
- Implementation tracker's "Live coverage" line moves from ~55% to ≥85%.
- Vitest main suite green.
- No remaining `meta.fixture: true` markers in Tier 1/2 families after rollout.
- Self-hosters can disable any individual job via env flag and the rest of the system continues running.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 9 issues, 3 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

- **UNRESOLVED:** Scope reduction, persistent job state, schema/retention details, and outside voice decision were not confirmed interactively.
- **VERDICT:** ENG REVIEW HAS OPEN ISSUES — revise before implementation.
