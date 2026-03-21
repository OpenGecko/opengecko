# OpenGecko Engineering Execution Plan

> **Strategic framing only.** For operational status, milestones, and workstream tracking, see `docs/status/implementation-tracker.md`.

## 1. Purpose

This document provides strategic and architectural framing for OpenGecko delivery.

It defines execution principles, delivery objectives, workstream strategy, and risk areas. It is intentionally a high-level document — day-to-day status lives in `docs/status/implementation-tracker.md`.

Primary inputs:

- `docs/plans/2026-03-20-opengecko-coingecko-compatible-api-prd.md`
- `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`
- `docs/status/implementation-tracker.md`

## 2. Current Baseline

### 2.1 Current repo state

The repository has reached R4 with the following in place:

- Bun + TypeScript + Fastify + Zod application scaffold
- SQLite + Drizzle storage, migrations, WAL mode, and FTS5 search
- Seeded registry and market data (coins, platforms, categories, exchanges, derivatives, treasury, onchain)
- CCXT provider abstraction and CCXT-backed market snapshot refresh job
- Deterministic stale-snapshot handling in market-facing routes
- Complete R0 endpoints: `/ping`, `/simple/*`, `/asset_platforms`, `/search`, `/global`, `/coins/list`
- Complete R1 core coin endpoints: `/coins/markets`, `/coins/{id}`, history, chart, OHLC, categories, contract-address variants
- Complete R2 exchange/derivatives endpoints: `/exchanges/*`, `/derivatives/*`
- Complete R3 public treasury endpoints: `/entities/list`, `/public_treasury/*`, holding charts, transaction history
- Partial R4 onchain endpoints: `/onchain/networks`, `/onchain/networks/{network}/dexes`

### 2.2 Current release focus

- Current target: `R4` partial — onchain DEX catalog expansion
- Current architecture: `Bun + TypeScript + Fastify + Zod + SQLite + Drizzle + better-sqlite3 + SQLite FTS5 + CCXT + Vitest`

### 2.3 Current priorities

The R4 phase focuses on:

1. Making hot market endpoints fresh by default via boot-time refresh and continuous internal snapshot updates
2. Expanding the onchain DEX family beyond the initial seeded network and DEX catalogs
3. Broadening repository-layer and fixture coverage across treasury, onchain, and remaining seeded data-fidelity edge cases
4. Replacing seeded ticker and history slices with CCXT-backed refresh and backfill paths where practical

## 3. Execution Principles

### 3.1 Harden before expanding

Do not widen surface area faster than contract fidelity improves.

### 3.2 Treat `partial` as real engineering debt

Any endpoint marked `partial` must have a known gap list, explicit divergence notes, and an exit plan to reach `compatible`.

### 3.3 Lock semantics before scale

Do not scale chart, ticker, exchange, or onchain families before default behaviors, granularity rules, and stale-data policy are explicit.

### 3.4 Build foundations once

Canonical entity resolution, fixture strategy, and freshness policy are cross-cutting systems. Solve them centrally instead of patching each endpoint independently.

### 3.5 Preserve the SQLite-first path

The OSS reference architecture should remain practical for local development and self-hosting even as managed-scale options are defined.

### 3.6 Treat fresh-by-default reads as a product guarantee

For supported hot-price endpoints, the system should maintain an always-hot internal snapshot layer so REST requests return current data by default rather than seeded placeholders or request-time upstream fetches.

### 3.7 Keep the public contract stable

The external CoinGecko-style HTTP contract is the product. Internal implementation changes must not break it.

## 4. Delivery Objectives

### 4.1 Near-term objective

Complete the R4 onchain DEX surface: network catalogs, DEX catalogs, pool detail/list, token detail, trades, and OHLCV endpoints — all with seeded curated data and explicit divergence notes.

### 4.2 Mid-term objective

Replace seeded market and history slices with CCXT-backed live refresh paths. Add exchange and derivatives tickers from live ingestion.

### 4.3 Long-term objective

Expand onchain analytics (trending, holders, traders), enrich treasury data coverage, and reach broader onchain DEX parity — without breaking the public contract.

## 5. Milestone Tracking

Milestones are tracked in `docs/status/implementation-tracker.md`, not in this document.

The tracker provides:
- **Workstream Status table** — operational status per workstream
- **Endpoint Family Progress table** — per-endpoint status with phase and notes
- **Completed Milestones** — narrative list of delivered work
- **Active Decisions** — confirmed engineering decisions
- **Open Questions / Blockers** — current unknowns

This execution plan provides strategic framing; the tracker is the operational truth.

## 6. Workstream Strategy

### WS-A: Compatibility fidelity

**Goal:** Existing endpoints maintain and improve CoinGecko contract compatibility.

**Scope:** Parameter precedence, null vs omitted semantics, pagination, ordering, serializer parity, divergence tracking.

**Status:** Ongoing — R0-R3 endpoints are `done`; R4 onchain endpoints need compatibility work as surface expands.

### WS-B: Live market ingestion and freshness

**Goal:** Move from seeded confidence to fresh-by-default live-backed market behavior.

**Scope:** Boot-time refresh, continuous in-process or worker-driven refresh scheduling, stale snapshot policy, CCXT exchange set.

**Current cadence:** market refresh every `60s`, search rebuild every `900s`, live freshness threshold `300s`.

**Status:** Partial — scaffold exists; boot-time and continuous scheduling not fully locked.

### WS-C: Historical chart and OHLC semantics

**Goal:** Chart, OHLC, and OHLCV behavior is deterministic and compatible.

**Scope:** Granularity and downsampling rules, range behavior, onchain OHLCV support.

**Status:** Partial — seeded routes exist; retention policy is open.

### WS-D: Canonical entity resolution

**Goal:** Stable internal mapping layer for coins, contracts, networks, exchanges, venues, treasury entities.

**Scope:** Coin/platform ID resolution, contract-address resolution, exchange venue identity, onchain network/DEX IDs.

**Status:** Ongoing — works for seeded data; needs expansion for live ingestion and onchain families.

### WS-E: Contract testing and fixtures

**Goal:** Upgrade testing from smoke coverage to compatibility-grade confidence.

**Scope:** Representative fixture corpus, invalid-parameter matrices, repository/service-layer tests, freshness assertions.

**Status:** Partial — smoke tests exist; broader fixture and repository-layer coverage is ongoing.

### WS-F: Jobs, operations, and observability

**Goal:** Background jobs are reliable and observable.

**Scope:** Market refresh scheduling, search rebuild behavior, job failure handling, freshness reporting.

**Status:** Partial — jobs exist; scheduling, failure handling, and observability need hardening.

## 7. R4 Focus

The current phase is R4 — onchain DEX expansion. The recommended R4 build order:

1. **Catalogs first** — `/onchain/networks`, `/onchain/networks/{network}/dexes` (already done)
2. **Pool and token primitives** — pool detail, pool list, token detail, token multi, token info
3. **Trade and OHLCV** — pool trades, pool OHLCV, token OHLCV
4. **Trending and search** — trending pools, onchain pool search
5. **Advanced analytics** — top holders, top traders, holder charts (P3/premium scope)

Do not start advanced analytics before pool/token primitives are stable.

## 8. Immediate Backlog

The current implementation cycle should execute in order:

1. Expand onchain pool and token endpoints with seeded compatibility fixtures
2. Define fixture source policy for onchain compatibility tests
3. Add repository-layer tests for onchain queries
4. Add chart/OHLCV edge-case tests for onchain routes
5. Define retention/backfill assumptions for onchain OHLCV data
6. Encode seed-vs-live ownership for onchain data in services
7. Define pool ranking and trending signal inputs before starting trending endpoints
8. Expose scheduling/lag assumptions for local and hosted execution
9. Replace seeded ticker and history slices with CCXT-backed paths where practical

## 8.1 Data-Fidelity Remediation Plan

The largest product gap is no longer HTTP shape. It is data ownership. The system already has seeded compatibility scaffolding plus initial CCXT ingestion hooks, but the live path is not yet the default truth for hot reads and historical series.

Recommended execution order:

1. Make live snapshots the default owner for hot market reads.
2. Replace seeded chart and OHLC reads with canonical persisted history.
3. Add retention, gap-repair, and recovery rules so historical behavior survives missed refreshes and restarts.

### Phase 1: Hot Market Read Ownership

**Goal:** `/simple/*`, `/coins/markets`, `/coins/{id}`, `/coins/{id}/tickers`, and exchange ticker surfaces should prefer continuously refreshed live-backed snapshots over seeded records whenever live data is available and fresh.

**Code areas:**

- `src/services/market-refresh.ts`
- `src/services/market-runtime.ts`
- `src/modules/market-freshness.ts`
- `src/modules/coins.ts`
- `src/modules/simple.ts`
- `src/modules/exchanges.ts`

**Required changes:**

- Treat seeded rows as bootstrap-only fallback data, not the steady-state owner for hot market responses.
- Ensure boot-time refresh completes before the runtime claims fresh-by-default behavior.
- Tighten stale-snapshot handling so live snapshots that age past threshold degrade explicitly instead of silently falling back to seeded rows where that would hide freshness loss.
- Expose snapshot provenance consistently in services so endpoint code can distinguish bootstrap fallback from fresh live ownership.

**Exit criteria:**

- Fresh boot produces live-owned snapshots for supported coins and exchanges without manual intervention.
- Hot endpoints read fresh live snapshots by default during normal runtime.
- If refresh stops and live data becomes stale, endpoint behavior is explicit and test-covered.
- Tests assert seeded fallback only applies when no live snapshot has ever been materialized.

### Phase 2: Historical Source-of-Truth Migration

**Goal:** `/coins/{id}/history`, `/coins/{id}/market_chart*`, and `/coins/{id}/ohlc` should read from persisted canonical candles rather than the seeded historical window.

**Code areas:**

- `src/services/ohlcv-backfill.ts`
- `src/services/candle-store.ts`
- `src/modules/coins.ts`
- `src/modules/catalog.ts`
- `src/db/client.ts`

**Required changes:**

- Remove seeded chart points and seeded OHLC candles from being the default historical owner once canonical candles exist.
- Route historical reads through canonical candle storage first, with seeded fixtures reserved for bootstrap/dev-only fallback where necessary.
- Expand backfill so the initial canonical dataset is materialized early enough for market-chart and OHLC routes to serve real persisted history.
- Align history serializers so detail/history endpoints derive their price windows from the same canonical persisted series used by chart endpoints.

**Exit criteria:**

- Chart and OHLC responses are sourced from `ohlcvCandles` canonical history for supported assets.
- Seeded historical windows are no longer required for steady-state endpoint correctness.
- Tests cover empty-history behavior, partial backfill behavior, and seeded bootstrap fallback.

### Phase 3: Retention, Repair, and Historical Durability

**Goal:** Historical data should remain usable after process restarts, transient CCXT failures, and missed scheduled refreshes.

**Code areas:**

- `src/services/ohlcv-backfill.ts`
- `src/services/candle-store.ts`
- `src/jobs/backfill-ohlcv.ts`
- `src/services/market-runtime.ts`
- future migration files under `drizzle/`

**Required changes:**

- Define retention windows by interval, starting with `1d` and later extending to higher-frequency candles where justified.
- Add rolling backfill and gap-detection so missed periods are repaired automatically.
- Separate intraday aggregation policy from durable historical policy instead of treating both as the same candle stream.
- Add operational visibility for last successful backfill window and detected candle gaps.

**Exit criteria:**

- Historical series persists across restarts without reseeding.
- Backfill jobs can recover missing daily windows deterministically.
- Tests cover duplicate upserts, missing-window repair, and restart continuity.

### Sequencing Note

Do not treat Phase 2 as complete just because CCXT backfill exists. It is only complete when the API read path has been switched away from seeded chart windows. Likewise, Phase 1 is not complete until fresh-by-default behavior is true at runtime, not just available as a manual job.

## 9. Definition of Done

An endpoint or workstream should not be considered done unless all of the following are true:

- behavior is implemented
- fixtures or regression tests exist for representative cases
- invalid-parameter behavior is covered where relevant
- freshness and fallback behavior is explicit where relevant
- known divergences are documented
- the implementation tracker status can be defended with evidence
- project validators pass

## 10. Sequencing Risks

### Risk 1: expanding onchain endpoints before stabilizing pool/token semantics

Impact: rework, inconsistent outputs, confusing endpoint status labels.

### Risk 2: treating seeded data as sufficient for onchain families

Impact: endpoints ship with placeholder data that doesn't reflect real chain state.

### Risk 3: leaving stale-data behavior undefined for onchain routes

Impact: onchain data becomes stale with no clear policy for freshness vs. degraded responses.

### Risk 4: starting advanced analytics (holders, traders, trending) before primitives are stable

Impact: project gets pulled into complex ranking and attribution logic before basic data is trustworthy.

### Risk 5: shipping onchain routes without fixture coverage

Impact: compatibility drift is silent and hard to detect without regression tests.

## 11. Recommended Next Review Points

This execution plan should be revisited when:

- R4 onchain surface reaches `done` status for pool and token primitives
- Fresh-by-default market behavior is fully locked
- Live CCXT-backed paths replace seeded slices for core market endpoints
- Advanced onchain analytics (trending, holders) are considered for roadmap

## 12. Final Recommendation

The correct next move for OpenGecko is completing the R4 onchain DEX surface with strong fixture coverage, then moving to live-backed market behavior. The foundation (R0-R3) is solid. R4 should be executed with the same compatibility-first discipline — don't ship endpoints without fixtures, divergence notes, and explicit freshness policy.

The priority order:
1. Pool and token primitives with compatibility fixtures
2. Trade and OHLCV endpoints
3. Seeded-to-live market refresh replacement
4. Trending and advanced analytics (last)

That sequence gives the highest chance of shipping a trustworthy R4 surface without undermining the R0-R3 foundation.
