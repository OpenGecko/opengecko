# OpenGecko Engineering Execution Plan

## 1. Purpose

This document converts the OpenGecko PRD into a concrete engineering delivery plan.

It is grounded in the current repository state and should be used to drive implementation sequencing, milestone planning, and execution decisions.

Primary inputs:

- `docs/plans/2026-03-20-opengecko-coingecko-compatible-api-prd.md`
- `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`
- `docs/status/implementation-tracker.md`

## 2. Current Baseline

### 2.1 Current repo state

The current repository is beyond pure scaffolding.

Implemented or materially in place:

- Bun + TypeScript + Fastify + Zod application scaffold
- SQLite + Drizzle storage and migrations
- seeded registry and market data model
- CCXT provider abstraction
- CCXT-backed market refresh job scaffold
- SQLite FTS5-backed `/search`
- deterministic stale-snapshot handling in market-facing routes
- initial chart granularity/downsampling helpers
- passing tests for `/ping`, `/simple/*`, `/asset_platforms`, `/search`, `/global`, `/coins/list`, and the first wave of seeded `/coins/*` endpoints

### 2.2 Current release focus

- Current target: `R0` completed and hardened
- Current transition: move seeded early `R1` endpoints from `partial` toward reliable compatibility

### 2.3 Current execution truth

The next phase should not be broad endpoint expansion.

The next phase should be:

1. hardening compatibility fidelity on current endpoints
2. locking freshness and stale-data behavior
3. locking chart semantics and retention assumptions
4. widening test and fixture coverage
5. only then starting selective low-risk `R2` work

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

## 4. Delivery Objectives

### 4.1 Near-term objective

Turn the current R0 + early R1 implementation into a stable, well-tested, compatibility-labeled MVP surface.

### 4.2 Mid-term objective

Add live-backed confidence, deterministic historical semantics, and the first low-risk exchange-family endpoints.

### 4.3 Long-term objective

Expand into exchanges, derivatives, NFTs, treasury, and onchain in a controlled order without breaking the trustworthiness of the public contract.

## 5. Milestones

| Milestone | Scope | Depends on | Exit criteria |
| --- | --- | --- | --- |
| `M0` | R1 hardening plan lock | current codebase | stale-data policy, fixture policy, chart policy, and exchange-set decision documented |
| `M1` | Compatibility hardening for current R1 surface | `M0` | `/coins/*` seeded endpoints have expanded fixtures, edge-case tests, and explicit divergence tracking |
| `M2` | Live-data and freshness stabilization | `M0`, `M1` | refresh cadence, stale-response behavior, and freshness assertions are implemented and tested |
| `M3` | Historical semantics stabilization | `M0`, `M1` | chart/range/OHLC semantics are deterministic and protected by tests |
| `M4` | Low-risk R2 foundation | `M1`, `M2`, `M3` | first exchange registry/detail and token-list endpoints land as stable `partial` or `compatible` |
| `M5` | Ticker-heavy R2 expansion | `M4` | ticker normalization and venue semantics are defined before ticker endpoints broaden |

## 6. Workstreams

### 6.1 Workstream A: Compatibility fidelity

### Goal

Bring existing endpoints closer to CoinGecko contract behavior.

### Scope

- parameter precedence
- default handling
- null vs omitted semantics
- pagination behavior
- sort and order behavior
- invalid-parameter responses
- serializer parity for large objects such as `/coins/{id}`

### Concrete tasks

- audit each existing `/coins/*` endpoint against expected request and response semantics
- create endpoint-specific divergence notes for current known mismatches
- normalize inconsistent placeholder values and empty arrays/objects
- add compatibility-focused fixtures for pagination, ordering, precision, and optional flags

### Exit criteria

- every current seeded R1 endpoint has a documented parity checklist
- route-level and repository-level tests exist for major edge cases
- no endpoint remains `partial` without an explicit reason

### 6.2 Workstream B: Live market ingestion and freshness behavior

### Goal

Move from seeded confidence to controlled live-backed freshness behavior.

### Scope

- initial CCXT exchange set
- polling cadence
- stale snapshot policy
- fallback behavior when refresh jobs fail
- freshness metadata exposure and internal enforcement

### Concrete tasks

- choose a narrow default exchange set for the first live rollout
- define refresh cadence for hot endpoints
- define what happens when market data exceeds freshness thresholds
- encode stale-data behavior in services and tests
- add monitoring points for refresh failures and lag

### Proposed first exchange set

- `binance`
- `coinbase`
- `kraken`

This set should remain intentionally narrow until fidelity and mapping quality are validated.

### Current default live cadence

- market refresh: every `60s`
- search rebuild: every `900s`
- live snapshot freshness threshold: `300s`

### Current stale-data policy

- seeded snapshots with no live providers remain usable during bootstrap
- live snapshots older than the freshness threshold are treated as stale
- stale live snapshots are omitted from simple-price and global aggregate responses
- stale live snapshots degrade market/detail response market fields to `null` rather than silently serving stale values

### Current seeded R1 divergence notes

- `/coins/{id}` still returns a reduced `market_data` object and placeholder empty structures for `tickers`, `community_data`, and `developer_data`
- `/coins/{id}/market_chart*` and `/ohlc` currently use a small seeded daily series instead of live/backfilled interval data
- `/coins/categories*` and contract-address routes only cover the seeded local catalog

### Exit criteria

- stale-data behavior is deterministic
- refresh cadence is encoded and tested
- freshness lag is measurable

### 6.3 Workstream C: Historical chart and OHLC semantics

### Goal

Make all current chart endpoints deterministic and compatible enough to trust.

### Scope

- `market_chart`
- `market_chart/range`
- `ohlc`
- contract-address chart variants
- granularity and downsampling rules
- explicit range behavior

### Concrete tasks

- define MVP interval support rules
- define rolling-window vs explicit-range behavior
- define `days=max` assumptions
- define downsampling behavior for larger windows
- ensure contract-address charts mirror coin-id chart behavior
- add fixtures for chart edge cases and interval rules

### Exit criteria

- chart and OHLC behavior is documented in code-facing tests
- edge cases are covered by fixtures
- range semantics do not depend on ad hoc implementation details

### 6.4 Workstream D: Canonical entity resolution

### Goal

Stabilize the internal mapping layer needed by current and next-phase endpoints.

### Scope

- coin IDs
- asset platform IDs
- contract addresses
- category IDs
- exchange IDs for upcoming R2 work
- inactive and aliased assets

### Concrete tasks

- audit current coin and contract resolution rules
- add tests for ambiguous symbol/name and contract mappings where relevant
- define inactive-asset behavior for list/history/detail endpoints
- prepare exchange/venue identity schema before exchange-family work starts

### Exit criteria

- contract-address detail and chart endpoints resolve deterministically
- identity assumptions for exchange-family work are locked

### 6.5 Workstream E: Contract testing and fixtures

### Goal

Upgrade testing from route-smoke coverage to compatibility-grade confidence.

### Scope

- representative fixture corpus
- invalid-parameter matrices
- repository/service-layer tests
- divergence tracking
- freshness assertions

### Concrete tasks

- define fixture source policy
- add repository-layer tests for market and history queries
- add fixture coverage for `/coins/markets`, `/coins/{id}`, charts, and categories
- add regression coverage for stale-data behavior
- maintain a gap list between current outputs and target outputs

### Exit criteria

- every current MVP endpoint has fixture-backed tests
- major edge cases are encoded as regressions
- the test suite can defend endpoint status labels

### 6.6 Workstream F: Jobs, operations, and observability

### Goal

Make background jobs reliable enough for continuous data refresh and index maintenance.

### Scope

- market refresh scheduling
- search rebuild behavior
- job failure handling
- lag reporting
- freshness reporting

### Concrete tasks

- define scheduler expectations for refresh jobs
- define rebuild cadence for search index updates
- expose refresh lag and failure counters
- document degraded-mode behavior when jobs fail or data is stale

### Exit criteria

- jobs are runnable, observable, and predictable in local and hosted modes
- degraded behavior is explicit rather than accidental

## 7. Concrete Phase Plan

### Phase A: Planning lock for current implementation

### Objective

Close the open design decisions blocking clean execution.

### Required decisions

1. stale-data API behavior
2. chart granularity and downsampling policy
3. first CCXT exchange set and polling cadence
4. compatibility fixture source policy

### Deliverables

- decisions written down in repo planning docs or implementation notes
- associated test plan defined per decision

### Phase B: R1 hardening sprint

### Objective

Turn seeded early R1 endpoints into a stable, testable contract surface.

### Scope

- `/coins/markets`
- `/coins/{id}`
- `/coins/{id}/history`
- `/coins/{id}/market_chart`
- `/coins/{id}/market_chart/range`
- `/coins/{id}/ohlc`
- `/coins/categories`
- `/coins/categories/list`
- contract-address detail/chart variants

### Deliverables

- response-shape audit completed
- explicit divergence list
- expanded fixtures and invalid-parameter coverage
- repository-layer tests for market/history reads

### Phase C: Freshness and live-data stabilization

### Objective

Make the API safe to run against live refresh behavior.

### Scope

- refresh cadence
- freshness thresholds
- stale snapshot policy
- service behavior on stale reads

### Deliverables

- job schedule assumptions
- service behavior for stale data
- freshness-focused tests and internal metrics

### Phase D: Historical semantics stabilization

### Objective

Make chart and OHLC behavior deterministic before higher-complexity expansion.

### Deliverables

- chart interval rules
- downsampling rules
- range behavior rules
- test matrix covering range and interval edge cases

### Phase E: Selective low-risk R2 foundation

### Objective

Start only the safest R2 surfaces after R1 is trustworthy.

### Recommended first R2 scope

- `/token_lists/{asset_platform_id}/all.json`
- `/exchanges/list`
- `/exchanges`
- `/exchanges/{id}`
- `/exchanges/{id}/volume_chart`
- `/derivatives/exchanges/list`

### Do not start yet

- `/coins/{id}/tickers`
- `/exchanges/{id}/tickers`
- `/derivatives`
- advanced movers, trending, or trust-score-heavy endpoints

These should wait until venue normalization, ticker semantics, and richer exchange metadata are defined.

## 8. Immediate Backlog

The next implementation cycle should execute the following in order:

1. extend the current chart granularity/downsampling rules into explicit documented policy
2. define fixture source policy for compatibility tests
3. audit `/coins/{id}` response shape and optional field behavior
4. add more pagination/order/default-param fixtures for `/coins/markets`
5. broaden repository-layer tests for market snapshot and history reads
6. add more chart/range edge-case tests for `/market_chart*` and `/ohlc`
7. encode seed-vs-live ownership more explicitly in jobs/services
8. design the exchange venue identity schema before starting exchange-family routes
9. expose scheduling/lag assumptions for local and hosted execution

## 9. 30 / 60 / 90 Day Plan

### 9.1 First 30 days

Primary goal: stabilize current scope.

Expected outputs:

- open policy decisions locked
- R1 endpoint parity audit completed
- fixture and regression coverage expanded
- stale-data behavior encoded and tested

Success condition:

OpenGecko can credibly present its current R0 + early R1 surface as a stable partial-compatibility MVP.

### 9.2 First 60 days

Primary goal: move from seeded confidence to live-backed confidence.

Expected outputs:

- live refresh cadence operating reliably
- chart semantics locked
- contract-address and market/history behavior hardened
- first exchange-family schema work completed

Success condition:

R1 is effectively complete for MVP scope and ready for selective R2 expansion.

### 9.3 First 90 days

Primary goal: land the first useful low-risk R2 surface.

Expected outputs:

- token-list support
- exchange registries and basic exchange detail endpoints
- exchange volume history
- derivatives venue list support

Success condition:

The public launch surface is strong on R0 + R1 + selective low-risk R2 while clearly deferring ticker-heavy and onchain-heavy complexity.

## 10. Definition of Done

An endpoint or workstream should not be considered done unless all of the following are true:

- behavior is implemented
- fixtures or regression tests exist for representative cases
- invalid-parameter behavior is covered where relevant
- freshness and fallback behavior is explicit where relevant
- known divergences are documented
- the implementation tracker status can be defended with evidence
- project validators pass

## 11. Sequencing Risks

### Risk 1: expanding endpoints before stabilizing semantics

Impact: rework, inconsistent outputs, and confusing endpoint status labels.

### Risk 2: treating the CCXT scaffold as sufficient for exchange-heavy surfaces

Impact: ticker and venue endpoints ship before identity and normalization are ready.

### Risk 3: leaving stale-data behavior undefined

Impact: live rollout behaves unpredictably during refresh gaps or provider failures.

### Risk 4: shipping chart endpoints without explicit interval rules

Impact: hard-to-debug parity drift across history consumers.

### Risk 5: starting R2 ticker work too early

Impact: the project gets pulled into venue normalization and trust logic before the core market surface is trustworthy.

## 12. Recommended Next Review Points

This execution plan should be revisited when any of the following happen:

- R1 hardening milestone completes
- stale-data policy changes
- chart retention or granularity policy changes
- the first live exchange set changes
- low-risk R2 work begins

## 13. Final Recommendation

The correct next move for OpenGecko is not “more endpoints.” It is making the current surface reliable, live-aware, and semantically defensible.

Execution should therefore follow this order:

1. lock the open cross-cutting decisions
2. harden existing R1 endpoints
3. stabilize live freshness behavior
4. stabilize historical semantics
5. only then expand into selective low-risk R2 work

That sequence gives the highest chance of shipping a trustworthy CoinGecko-compatible MVP instead of a broad but brittle clone.
