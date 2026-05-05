# OpenGecko Improvement Guide

## Purpose

This guide turns the current OpenGecko state into an execution plan for the next improvement wave. It should be read together with:

- `docs/status/implementation-tracker.md`
- `docs/status/compatibility-audit.md`
- `docs/plans/2026-03-26-opengecko-runtime-hardening-improvement-plan.md`
- `docs/plans/2026-03-29-data-fidelity-uplift-plan.md`

The project already has broad CoinGecko-compatible route coverage. The next step is to make the implementation easier to trust, operate, and extend without overstating the quality of fixture-backed or shallow-history surfaces.

## Current State

OpenGecko has a strong compatibility foundation:

- 76 / 76 active non-NFT CoinGecko-compatible routes are registered according to the compatibility audit.
- Runtime support already includes hot market snapshots, background refresh, OHLCV workers, FTS5 search, diagnostics, metrics, gzip transport compression, startup prewarm, replay/diff tooling, and route-family tests.
- Live data coverage is materially better than a seed-only implementation, with CCXT, DeFiLlama, Subsquid, and currency-api ownership across the strongest endpoint families.
- The documentation is explicit that some surfaces are fixture-backed, seeded, or hybrid rather than live.

The main gaps are:

- Data fidelity: derivatives, treasury, onchain analytics, supply charts, and some historical chart surfaces are still fixture-backed or shallow.
- Runtime complexity: market service readiness is represented by several booleans and override modes rather than one typed state machine.
- Quality gates: CI runs lint, typecheck, build, coverage-backed tests, and Docker; Vitest coverage thresholds are non-zero and tied to the 2026-05-05 baseline.
- Historical depth: OHLCV is top-100-first and durable, but long-horizon coverage is not yet production-grade across the catalog.
- Provider breadth: live onchain and derivatives coverage need more source diversity and better provider health controls.
- Maintainability: `tests/app.test.ts` and several route/service modules remain too large to reason about quickly.

## Tracking Model

Use this guide as a working task board, not only a reference document.

Status values:

- `not started`: no code or docs change has landed.
- `in progress`: a PR or local branch is actively changing the item.
- `blocked`: the next step depends on a decision, dependency, provider, or failing prerequisite.
- `partial`: some slices landed, but acceptance is not met.
- `done`: acceptance is met and verified.

Risk values:

- `low`: local or CI-only change with narrow runtime impact.
- `medium`: endpoint, test, or docs behavior changes with contained runtime impact.
- `high`: runtime state, provider behavior, storage, or public contract changes.

R5 should land in dependency order:

1. CI lint gate.
2. Coverage baseline and non-zero thresholds.
3. Documentation drift guard.
4. Runtime state-machine transition tests.
5. Runtime state-machine implementation.
6. Shared cache service extraction.
7. Cache transport semantics: ETag, `Cache-Control`, Brotli, coalescing.
8. Provider backoff and circuit breakers.
9. Module and test decomposition.

## Improvement Standard

Each slice should improve at least one of these project-level outcomes:

- **Freshness:** important market and onchain responses are backed by recent provider data, with explicit stale and fixture markers.
- **Stability:** startup, refresh, cache, provider failure, and diagnostics behavior are deterministic under test.
- **Performance:** hot routes avoid avoidable recomputation, support correct HTTP cache semantics, and have bounded memory behavior.
- **Truthfulness:** docs, diagnostics, and endpoint metadata make live, hybrid, seeded, synthetic, and fixture-backed data distinguishable.
- **Maintainability:** large modules and broad tests are split only after behavior is pinned by focused tests.

Do not count a slice as an improvement if it only adds an endpoint, provider, or surface area without improving one of these outcomes.

## Release Metrics

Use these metrics to decide whether a release is actually closer to CoinGecko-level freshness, stability, and performance.

| Metric | R5 target | R6 target | Evidence source |
| --- | --- | --- | --- |
| Local release gate | lint, typecheck, build, coverage, Docker pass | same, plus provider fixture replay suites | CI and local command output |
| Coverage thresholds | non-zero and tied to measured baseline | increased only when representative tests are added | `vitest.config.ts` and coverage report |
| Runtime readiness | one canonical phase in diagnostics | canonical phase plus provider coverage matrix | `/diagnostics/runtime` tests |
| Hot-route cache safety | bounded cache with TTL, revision invalidation, and coalescing | route-family cache policies documented | cache and endpoint tests |
| Transport efficiency | gzip and Brotli, correct `Vary` behavior | measured response-size and latency baselines | transport tests and benchmark notes |
| Provider resilience | breaker/backoff visible in diagnostics | provider coverage and stale duration tracked per source | refresh and diagnostics tests |
| Fixture honesty | docs drift guard blocks overclaims | fixture-backed endpoint count decreases by family | docs tests and compatibility audit |
| Historical depth | current OHLCV behavior documented and stable | deeper optional storage path without breaking SQLite | storage tests and migration docs |

## Further Improvement Priorities

The next improvements should be ranked by how much uncertainty they remove from the system, not by how much new surface area they add.

### 1. Make Provider Health Actionable

Current provider failures are handled as a global cooldown. That prevents repeated upstream hammering, but it does not explain which provider is unhealthy, which providers are still usable, or when a blocked provider is allowed to recover.

Improve this by adding:

- Per-provider breaker state: `closed`, `open`, and `half_open`.
- Exponential backoff with deterministic jitter so tests can prove behavior without sleeping.
- Last success, last failure, failure reason, failure count, and next retry timestamp per provider.
- Provider health diagnostics that report state and timing without exposing credentials.
- Metrics that distinguish forced failure, blocked-by-breaker, partial provider failure, and recovery.

This is the highest-value next slice because freshness and stability both depend on provider behavior.

### 2. Define Freshness Budgets by Endpoint Family

The guide currently talks about freshness at the project level. It should also define endpoint-family budgets so runtime diagnostics and release claims can be judged objectively.

Recommended initial budgets:

| Endpoint family | Target freshness | Degraded threshold | Notes |
| --- | --- | --- | --- |
| `/simple/*` | 5-30 seconds for hot market data | 2 minutes | Favor cache coalescing and revision invalidation over long TTLs |
| `/coins/markets` | 30-60 seconds | 5 minutes | High-volume route; must stay bounded under fanout |
| `/coins/{id}` market fields | 1-5 minutes | 15 minutes | Metadata may be older than price fields |
| `/exchanges/*` volumes | 5-15 minutes | 1 hour | Depends on exchange ticker refresh coverage |
| `/onchain/*` pools/trades | 30-120 seconds once live-backed | 10 minutes | Mark fixture-backed responses explicitly until replaced |
| `/derivatives*` | 30-120 seconds once live-backed | 10 minutes | Requires per-venue capability diagnostics |
| historical charts | depends on interval | one missing retention window | Judge by continuity and retention, not only latest timestamp |

Acceptance should include tests or fixtures that prove stale classification for at least one endpoint in each family before claiming that family is production-grade.

### 3. Add a Coverage Matrix Endpoint

The project needs a machine-readable way to answer: "which endpoints are live, hybrid, seeded, synthetic, or fixture-backed right now?"

Add `GET /diagnostics/coverage_matrix` with:

- Endpoint family and representative routes.
- Data ownership class: `live`, `hybrid`, `seeded`, `synthetic`, `fixture`, or `unavailable`.
- Providers used by that family.
- Last successful refresh timestamp.
- Freshness threshold and current age.
- Test evidence file or fixture suite name.

This turns documentation honesty into runtime evidence and gives future SDK/OpenAPI work a trustworthy source.

### 4. Build Provider Replay Fixtures Before Adding More Providers

R6 adds real data breadth. Without replay fixtures, each new provider can make tests flaky and local setup harder.

Before live derivatives, onchain analytics, or treasury ingestion expands materially, add provider replay fixtures that capture:

- Raw provider response.
- Normalized internal rows.
- Expected public response shape.
- Provider timestamp and ingestion timestamp.
- Known edge cases such as missing fields, rate limits, partial responses, and provider divergence.

Provider integrations should be accepted only when their replay fixtures can run offline in CI.

### 5. Split Compatibility Evidence by Route Family

`tests/app.test.ts` still carries too much compatibility evidence. Splitting it should not be treated as cleanup; it is release infrastructure.

Prioritize the split by blast radius:

1. `simple` and exchange-rate routes, because cache and transport semantics now affect them.
2. Diagnostics and health routes, because they are used to judge release readiness.
3. Market and coin routes, because they are broad and performance-sensitive.
4. Onchain and derivatives routes, because R6 will change their data ownership.

Each moved suite should keep the same assertions first. Behavior changes belong in later PRs.

### 6. Add Performance Budgets to the Gate

R5 has functional gates, but not performance gates. Add a small deterministic benchmark suite before large provider and storage work.

Start with:

- Cold and warm `/simple/price` latency for representative ID and currency counts.
- `/coins/markets` latency and response size at common page sizes.
- Market refresh duration with fixture providers.
- Cache hit ratio, coalesced request count, and eviction count.
- Compressed versus uncompressed payload size for large JSON responses.

Do not block CI on noisy absolute wall-clock numbers until the benchmark has a stable baseline. First use it as tracked release evidence.

### 7. Make Provenance the Differentiator

CoinGecko-level compatibility is table stakes. OpenGecko can be better by explaining why a value is trusted.

For R6, prioritize provenance where users make financial decisions:

- Market price and volume aggregation.
- Exchange trust and volume.
- Derivatives funding/open interest.
- Treasury holdings.
- Onchain pool metrics.

For raw CoinGecko-compatible responses, keep provenance out of the default payload unless CoinGecko already exposes an envelope. Use explicit `include_provenance=true` flags or companion endpoints.

## R5 Task Board

| ID | Slice | Status | Risk | Depends on | First PR scope | Completion evidence |
| --- | --- | --- | --- | --- | --- | --- |
| R5-QG-1 | Add lint to CI | done | low | none | Add `bun run lint` to `.github/workflows/test.yml`; run locally | Local `bun run lint` passes; CI now includes the lint step |
| R5-QG-2 | Coverage baseline | done | low | R5-QG-1 | Run coverage, set thresholds above `0` with a documented baseline | `bun run test:coverage` passes at 90 / 82 / 92 / 90 thresholds |
| R5-QG-3 | Docs drift guard | done | medium | R5-QG-2 | Add a focused test that validates route/live-data claims against docs/status files | `tests/docs-drift.test.ts` covers route coverage, live/fixture wording, and release-readiness gates |
| R5-RT-1 | State-machine test harness | done | medium | R5-QG-1 | Add transition fixtures and expected state table without changing runtime behavior | `tests/market-runtime-state.test.ts` covers current derived runtime phases without mutating behavior |
| R5-RT-2 | State-machine implementation | done | high | R5-RT-1 | Route readiness mutations through helpers while preserving legacy fields | Production readiness mutations are centralized in `src/services/market-runtime-state.ts`; focused runtime tests and the full local gate pass |
| R5-CA-1 | Cache service extraction | done | medium | R5-QG-1 | Move `/simple/price` cache logic into `src/services/response-cache.ts` without behavior change | `src/services/response-cache.ts` owns revision-aware cache storage; simple-price/app tests and full local gate pass |
| R5-CA-2 | Cache semantics | done | high | R5-CA-1 | Add bounded eviction, stale handling, and request coalescing for hot endpoints | Shared response cache covers TTL, stale lookup, LRU bounds, and coalescing; `/simple/price` cold fills use coalescing; full local gate passes |
| R5-TR-1 | HTTP cache headers | done | medium | R5-CA-1 | Add route-level `Cache-Control` and ETag for safe GET endpoints | `/ping`, `/health`, `/simple/supported_vs_currencies`, `/exchange_rates`, `/asset_platforms`, `/token_lists/:asset_platform_id/all.json`, `/coins/list`, `/coins/list/new`, `/coins/categories/list`, `/coins/categories`, `/coins/top_gainers_losers`, `/coins/:id`, `/coins/:id/history`, `/coins/:id/tickers`, `/coins/:id/market_chart`, `/coins/:id/market_chart/range`, `/coins/:id/ohlc`, `/coins/:id/ohlc/range`, `/coins/:id/circulating_supply_chart`, `/coins/:id/circulating_supply_chart/range`, `/coins/:id/total_supply_chart`, `/coins/:id/total_supply_chart/range`, `/coins/:platform_id/contract/:contract_address`, `/coins/:platform_id/contract/:contract_address/market_chart`, `/coins/:platform_id/contract/:contract_address/market_chart/range`, `/exchanges/list`, `/exchanges`, `/exchanges/:id`, `/exchanges/:id/tickers`, `/exchanges/:id/volume_chart`, `/exchanges/:id/volume_chart/range`, `/search`, `/search/trending`, `/derivatives`, `/derivatives/exchanges`, `/derivatives/exchanges/list`, `/derivatives/exchanges/:id`, `/global`, `/global/decentralized_finance_defi`, `/global/market_cap_chart`, `/entities/list`, `/:entity/public_treasury/:coin_id`, `/public_treasury/:entity_id`, `/public_treasury/:entity_id/:coin_id/holding_chart`, `/public_treasury/:entity_id/transaction_history`, `/diagnostics/chain_coverage`, `/diagnostics/ohlcv_sync`, `/diagnostics/freshness_budgets`, `/diagnostics/coverage_matrix`, `/diagnostics/derivatives`, and every `/onchain/*` GET route emit `Cache-Control` and weak ETags with tested `304`; onchain discovery, metadata, token, and analytics routes use 60s policy while live trade and OHLCV routes use 30s policy; `/diagnostics/runtime` and `/metrics` remain intentionally uncached live operational surfaces |
| R5-TR-2 | Brotli transport | done | medium | R5-QG-1 | Add Brotli support next to gzip in `src/http/transport.ts` | Transport tests cover gzip, Brotli-only, Brotli-preferred negotiation, `Vary`, and thresholds; full local gate passes |
| R5-PR-1 | Provider breaker utility | done | high | R5-RT-2 | Add breaker/backoff utility with deterministic unit tests | `src/services/provider-breaker.ts` covers closed, open, half-open, recovery, jitter bounds, and capped backoff; exchange ticker refresh uses breaker filtering while preserving legacy cooldown behavior |
| R5-PR-2 | Provider diagnostics | done | high | R5-PR-1 | Surface breaker and provider health in diagnostics/metrics | `/diagnostics/runtime` includes provider breaker status, retry timing, last success, last failure, and failure reason without secrets; provider metrics distinguish breaker skips from legacy cooldown skips; focused diagnostics tests pass |
| R5-FR-1 | Freshness budget diagnostics | done | medium | R5-PR-2 | Make endpoint-family freshness budgets machine-readable | `GET /diagnostics/freshness_budgets` exposes simple, market, detail, exchange, onchain, derivatives, historical, and stable-catalog budgets with focused diagnostics route tests |
| R5-FR-2 | Coverage matrix diagnostics | done | medium | R5-FR-1 | Make endpoint-family data ownership machine-readable | `GET /diagnostics/coverage_matrix` exposes live, hybrid, seeded, fixture, and synthetic ownership classes, providers, last successful refresh timestamp, freshness state, and test evidence by endpoint family |
| R5-FR-3 | First provider replay fixtures | done | medium | R5-FR-2 | Add offline provider replay paths before broader R6 provider work | `tests/provider-replay-defillama.test.ts` replays raw DeFiLlama pool and DEX volume JSON through normalized provider rows into the public onchain pool detail response; `tests/provider-replay-derivatives.test.ts` replays raw CCXT-style futures ticker JSON through normalized derivative rows into `/derivatives` and derivatives exchange detail responses; `tests/provider-replay-treasury.test.ts` replays a source disclosure document into treasury entity, holding, transaction, and public treasury responses; `/diagnostics/coverage_matrix` links replay tests as onchain, derivatives, and treasury evidence |
| R5-FR-4 | Treasury disclosure ingestion seam | done | medium | R5-FR-3 | Promote one replay normalizer into an idempotent write path | `src/services/treasury-disclosure-ingestion.ts` upserts source-backed treasury entities, holdings, and transactions; `tests/provider-replay-treasury.test.ts` proves repeated ingestion does not duplicate disclosure transactions and public treasury routes read the ingested rows |
| R5-FR-5 | Derivatives ticker ingestion seam | done | medium | R5-FR-3 | Promote the derivatives replay normalizer into an idempotent, source-attributed write path | `src/services/derivatives-ingestion.ts` upserts replay-normalized derivative tickers by exchange and symbol with source kind, provider, and fetched timestamp provenance; `tests/provider-replay-derivatives.test.ts` proves repeated ingestion does not duplicate ticker rows, `/derivatives*` reads the ingested futures ticker, and `/diagnostics/coverage_matrix` only upgrades derivatives from fixture to hybrid when source-attributed rows exist |
| R5-FR-6 | Optional derivatives batch job | done | high | R5-FR-5 | Wire CCXT futures/swap fetch output to the source-attributed derivatives ingestion seam without requiring live providers in CI | `src/providers/ccxt.ts` can fetch derivative-market tickers only; `src/services/derivatives-sync.ts` syncs configured venues through source-attributed ingestion; `src/jobs/sync-derivatives.ts` exposes an optional `DERIVATIVES_CCXT_EXCHANGES`-gated job via `bun run derivatives:sync`; offline tests prove provider filtering, batch ingestion, source provenance, diagnostics ownership, and unchanged public derivatives shape |
| R5-FR-7 | Derivatives provider gap diagnostics | done | medium | R5-FR-6 | Make configured derivatives venues, source-backed rows, and fixture-only gaps visible without changing public derivatives payloads | `GET /diagnostics/derivatives` reports configured CCXT derivatives venue mappings, exchange-level source-backed/fixture ticker counts, latest source timestamp, fixture-only exchanges, configured venues without source rows, and missing exchanges; tests cover fixture-only and configured-pending states plus cache/ETag semantics |
| R5-MD-1 | Test suite split | done | medium | R5-QG-3 | Move one endpoint family out of `tests/app.test.ts` as the pattern | Health/liveness route assertions moved to `tests/health.test.ts`; diagnostics GET route assertions moved to `tests/diagnostics-routes.test.ts`; search and trending-search contracts moved to `tests/search-routes.test.ts`; global route contracts moved to `tests/global-routes.test.ts`; treasury route contracts moved to `tests/treasury-routes.test.ts`; derivatives route contracts moved to `tests/derivatives-routes.test.ts`; spot exchange route contracts moved to `tests/exchange-routes.test.ts`; focused split tests pass and `tests/app.test.ts` no longer owns those endpoint-family contracts |
| R5-MD-2 | Module split | done | high | R5-MD-1 | Extract one large module family without public route changes | Derivatives routes moved from `src/modules/exchanges.ts` into `src/modules/derivatives.ts` and are registered separately from spot exchange routes; derivative route, exchange metadata, HTTP cache, docs-drift, typecheck, lint, build, and full coverage gates pass without public payload drift |

## R6 Task Board

R6 should convert the R5 observability and replay seams into actual data-fidelity wins. Do not start live schedulers before the matching replay and diagnostics evidence exists.

| ID | Slice | Status | Risk | Depends on | First PR scope | Completion evidence |
| --- | --- | --- | --- | --- | --- | --- |
| R6-MD-1 | Spot exchange route suite split | done | medium | R5-MD-1 | Move `/exchanges*` contract assertions from `tests/app.test.ts` into `tests/exchange-routes.test.ts` without route changes | `tests/exchange-routes.test.ts` passes with 8 route-contract tests; escalated `tests/app.test.ts` passes with 143 tests after duplicate spot exchange assertions were removed; `R5-MD-1` evidence is updated |
| R6-MD-2 | Spot exchange module split | done | high | R6-MD-1 | Split `src/modules/exchanges.ts` into route registration plus exchange detail, ticker, and volume helpers | Spot exchange helpers moved into `src/modules/exchange-detail.ts`, `src/modules/exchange-tickers.ts`, and `src/modules/exchange-volume.ts`; `src/modules/exchanges.ts` now owns route registration and cache-policy wiring; exchange route suite, exchange module tests, docs drift, typecheck, lint, build, and full coverage pass with no public payload drift |
| R6-PF-1 | Deterministic performance baseline | done | medium | R5-CA-2 | Add a non-blocking benchmark command for `/simple/price`, `/coins/markets`, exchange tickers, and cache hit paths using fixture data | `bun run benchmark:hot-routes` emits JSON evidence for representative `/simple/price`, `/coins/markets`, and `/exchanges/:id/tickers` requests using the offline validation snapshot; the report includes cold/warm latency, payload bytes, gzip/Brotli size and ratios, cache headers, ETags, simple/markets cache hit/miss counts, coalesced fill count, and eviction count without enforcing noisy wall-clock thresholds; `tests/hot-route-benchmark.test.ts`, docs drift, typecheck, lint, build, and full coverage pass |
| R6-CM-1 | Coverage matrix contract hardening | done | medium | R5-FR-2 | Add tests that every coverage-matrix family has ownership class, freshness budget, providers, replay evidence, and stale classification | `tests/diagnostics-routes.test.ts` now fails if `/diagnostics/coverage_matrix` omits a known family, duplicates families, omits representative routes, ownership class, providers, last-refresh field, freshness state, test evidence, or notes; test evidence paths must exist, freshness states must align with budgeted/unbudgeted families, and onchain, derivatives, and treasury entries must link their provider replay tests; full coverage passes with 74 files and 624 tests |
| R6-DR-1 | Derivatives funding/open-interest replay | done | high | R5-FR-7 | Extend derivatives replay fixtures and storage to funding rate and open interest before live fetching | `tests/fixtures/provider-replay/ccxt-derivatives/binance-funding-open-interest.json` replays provider-style funding-rate and open-interest rows, including numeric strings; `tests/provider-replay-derivatives.test.ts` proves normalization, idempotent source-attributed ingestion, unchanged public `/derivatives` payload shape, and `/diagnostics/derivatives` source-backed gap reporting; `tests/providers-ccxt.test.ts` proves the CCXT adapter preserves numeric-string funding/open-interest fields for live ingestion |
| R6-OC-1 | Onchain OHLCV replay and ingestion seam | done | high | R5-FR-3 | Promote one DeFiLlama or source replay path into source-attributed pool OHLCV rows | `tests/fixtures/provider-replay/defillama/ethereum-pool-ohlcv.json` replays source-attributed pool OHLCV candles; `src/services/onchain-ohlcv-ingestion.ts` normalizes and idempotently upserts rows into `onchain_pool_ohlcv`; pool and token `/onchain/*/ohlcv*` routes read replay-ingested rows before synthetic fallback; `/diagnostics/coverage_matrix` uses source-fetched onchain OHLCV timestamps while holders/traders remain explicitly fixture-backed; focused replay, diagnostics, docs drift, typecheck, and lint gates pass |
| R6-TR-1 | Treasury source document table | done | medium | R5-FR-4 | Store disclosure source documents separately from normalized holdings and transactions | `treasury_source_documents` stores source URL, provider, document type, accepted timestamp, SHA-256 content hash, and raw disclosure JSON separately from normalized holdings and transactions; `ingestTreasuryDisclosureReplay` upserts the source document before normalized rows; `tests/provider-replay-treasury.test.ts` proves re-ingestion stays idempotent, same-URL corrections update the traceable source document and normalized holding, and public treasury payloads remain compatible; focused replay/diagnostics/docs tests, typecheck, lint, build, and full coverage pass |
| R6-HS-1 | Historical storage interface | done | high | R6-PF-1 | Define an OHLCV storage interface while keeping SQLite as the default implementation | `src/services/candle-store.ts` now exposes a backend-neutral `HistoricalOhlcvStore` contract plus `createSqliteHistoricalOhlcvStore` as the default implementation over the existing SQLite candle table; `tests/candle-store.test.ts` proves canonical reads, close-series reads, gap detection, gap repair, and retention-compatible writes through the interface; focused candle/ohlcv/docs tests, typecheck, lint, build, full coverage, and hot-route benchmark pass without route rewrites |
| R6-OA-1 | Onchain analytics replay coverage | done | high | R6-OC-1 | Add source-attributed replay rows for one holder/trader analytics source before live scheduler work | `tests/fixtures/provider-replay/onchain-analytics/eth-usdc-token-analytics.json` captures deterministic holder, trader, and holder-count analytics; `src/services/onchain-analytics-ingestion.ts` normalizes and idempotently upserts replay rows into `onchain_token_holders`, `onchain_token_traders`, and `onchain_token_holder_counts`; top holder, top trader, and holders-chart routes read source-attributed replay rows before fixture fallbacks while keeping metadata explicit that replay is not live; `/diagnostics/coverage_matrix` links `tests/provider-replay-onchain-analytics.test.ts` as onchain evidence |

## Next PR Queue

Keep upcoming work small enough that each PR can be reviewed by behavior, not by intention.

| Order | PR | Includes | Excludes | Exit check |
| --- | --- | --- | --- | --- |
| 1 | Add live onchain analytics sync seam | Wire one optional provider fetch path into the source-attributed onchain analytics ingestion tables | Required live scheduler dependencies in CI | Offline tests prove provider output can be ingested without changing public payload shape or overclaiming live coverage |

## Decision Rules

Use these rules when two improvements compete for the same release slot:

- Prefer work that makes runtime truth more observable over work that only improves docs wording.
- Prefer deterministic fixture replay over live-provider test coverage.
- Prefer per-provider isolation over global failure controls.
- Prefer preserving CoinGecko-compatible response shapes over adding useful metadata by default.
- Prefer moving tests before moving production modules.
- Prefer explicit stale, fixture, and seeded markers over silently hiding imperfect data.
- Prefer a slower release with reproducible evidence over a broader release with unverifiable freshness claims.

## Risk Register

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| State-machine migration changes boot behavior | Startup has several legacy readiness modes, including stale fallback and validation overrides | Preserve legacy fields while adding canonical phase; migrate one mutation site at a time with focused tests |
| Cache semantics break compatibility | CoinGecko-compatible responses must not gain fields or serve stale data where callers expect live data | Keep cache metadata out of default response bodies; test raw response shape and revision invalidation |
| Provider breakers hide real failures | Backoff can make the system look quiet while data silently goes stale | Expose breaker state, stale duration, and last success in diagnostics and metrics |
| Brotli changes small-response behavior | Compression thresholds and headers can affect clients and tests | Keep below-threshold bypass; test `Content-Encoding`, `Content-Length`, and `Vary` |
| R6 providers add unstable dependencies | Live provider breadth can create flaky tests and harder local setup | Use deterministic provider fixtures; keep external services optional |
| Module splits become accidental rewrites | Refactors can change public behavior while tests are being moved | Split tests first, then modules; avoid semantic changes in decomposition PRs |

## Scope Guardrails

- Do not add streams before R5 cache, state, and provider hardening are at least partially complete.
- Do not generate SDKs before `GET /openapi.json` is generated from a verified contract source.
- Do not add provenance fields to default CoinGecko-compatible raw map or array responses if that changes response shape.
- Do not advertise fixture-backed endpoints as live because they use live USD conversion or live metadata around fixture rows.
- Do not make TimescaleDB required for local development or the default test path.
- Do not split large modules and rewrite endpoint semantics in the same PR.

## R5 Completion Gate

R5 is complete only when all of the following are true:

- [x] `.github/workflows/test.yml` runs lint, typecheck, build, tests, and Docker build.
- [x] `vitest.config.ts` has non-zero coverage thresholds tied to a measured baseline.
- [x] Docs drift tests cover route coverage, live-data coverage, fixture claims, and release-readiness claims.
- [x] Runtime readiness transitions are centralized behind typed helpers.
- [x] `/diagnostics/runtime` exposes a canonical runtime state while preserving existing useful fields.
- [x] Route-local `/simple/price` cache state has moved into a shared cache service.
- [x] Cache behavior is bounded and tested for TTL, revision invalidation, stale serving, and coalescing.
- [x] HTTP transport supports gzip and Brotli with correct `Vary` behavior.
- [x] Provider breaker/backoff state is visible in diagnostics and covered by deterministic tests.
- [x] `tests/app.test.ts` is no longer the only major compatibility evidence for endpoint-family behavior.
- [x] The full local gate passes: `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:coverage`, and `docker build -t opengecko-test .`.

### R5: Hardening and Release Truth

R5 is the next practical release target. It should not add major product surfaces until the repo can prove existing behavior reliably.

#### R5.1 Quality Gates

**Goal:** make the repository's automated checks match release claims.

Work:

- Add `bun run lint` to `.github/workflows/test.yml`.
- Treat lint warnings as CI failures.
- Raise `vitest.config.ts` coverage thresholds above `0` after measuring the current baseline.
- Add drift-guard tests for docs that make route coverage, live-data coverage, fixture, or release-readiness claims.
- Split `tests/app.test.ts` into endpoint-family suites so failures are easier to isolate.
- Keep the main Vitest suite green before updating docs to claim release readiness.

Acceptance:

- `bun run lint`
- `bun run typecheck`
- `bun run build`
- `bun run test:coverage`
- `docker build -t opengecko-test .`
- CI executes the same gate set.
- Coverage thresholds fail when coverage falls below the chosen baseline.

#### R5.2 Runtime State Machine

**Goal:** replace ad hoc readiness flags with an explicit market-service state model.

Current concerns to unify:

- `initialSyncCompleted`
- `allowStaleLiveService`
- `initialSyncCompletedWithoutUsableLiveSnapshots`
- `listenerBindDeferred`
- `providerFailureCooldownUntil`
- `forcedProviderFailure`
- `validationOverride`

Work:

- Introduce a typed market runtime state machine in `src/services/market-runtime-state.ts`.
- Model states such as `cold_boot`, `syncing`, `live_ready`, `stale_ready`, `zero_live_ready`, `provider_degraded`, and `validation_override`.
- Route all state changes through transition helpers instead of mutating booleans directly.
- Keep diagnostics stable while adding the new canonical state to `/diagnostics/runtime`.
- Add transition tests for boot success, zero-live boot, provider failure cooldown, stale fallback, listener binding, and validation modes.

Acceptance:

- No direct runtime readiness mutation remains outside the transition helper, except narrowly documented test setup.
- `tests/market-runtime.test.ts`, `tests/runtime-diagnostics.test.ts`, `tests/initial-sync.test.ts`, and `tests/startup-initial-sync-progress.test.ts` cover the state graph.
- Existing endpoint behavior remains compatible during live, stale, zero-live, and validation boot modes.

#### R5.3 Cache and Transport Semantics

**Goal:** make hot-read caching explicit, observable, and safe.

Current state:

- `/simple/price` and `/coins/markets` use bounded in-process response caching keyed by normalized request identity and hot-data revision.
- Transport compression supports gzip and Brotli for JSON payloads above the configured threshold.
- Route-level `Cache-Control` and weak JSON ETags are present for stable catalog, hot market, coin detail, chart, exchange, safe diagnostics, treasury, global, search, derivatives, and every `/onchain/*` GET route.
- `/diagnostics/runtime` and `/metrics` are intentionally excluded from JSON HTTP caching because they are live operational monitoring surfaces.

Work:

- Replace route-local `simplePriceCache` with a small cache service keyed by normalized request identity and hot-data revision.
- Add bounded size or LRU eviction.
- Support endpoint-specific TTLs and stale-while-revalidate only where response freshness semantics are safe.
- Add route-level `Cache-Control` for stable GET endpoints.
- Add ETag support derived from hot-data revision plus normalized request identity.
- Add Brotli support alongside gzip when the client advertises `br`.
- Add request coalescing for expensive cold cache fills.

Acceptance:

- Cache tests cover key normalization, TTL expiry, revision invalidation, stale serving, LRU eviction, and coalescing.
- Transport tests cover gzip, Brotli, `Vary: Accept-Encoding`, content length, and below-threshold bypass.
- Endpoint tests prove cached responses preserve CoinGecko-compatible response shapes.

#### R5.4 Provider Robustness

**Goal:** prevent upstream instability from becoming runtime instability.

Work:

- Replace fixed provider cooldowns with exponential backoff and jitter.
- Add per-provider and per-exchange circuit breaker state.
- Track success rate, latency, error count, stale duration, open-circuit duration, and last-success timestamp.
- Surface provider health in diagnostics and metrics.
- Make failure behavior deterministic in tests without relying on live providers.

Acceptance:

- Market refresh tests cover breaker closed, open, half-open, recovery, and forced failure paths.
- Diagnostics expose provider-level health without leaking secrets.
- Stale fallback behavior remains explicit and tested.

#### R5.5 Module Decomposition

**Goal:** reduce blast radius before adding more data providers and product surfaces.

Targets:

- `src/modules/onchain.ts`
- `src/modules/coins.ts`
- `src/modules/exchanges.ts`
- `src/services/bootstrap.ts`
- `tests/app.test.ts`

Work:

- Split route registration by endpoint family.
- Move large response builders and query helpers into family-local service modules.
- Keep public route behavior and schemas stable.
- Decompose `tests/app.test.ts` into focused suites that mirror route families and runtime concerns.

Acceptance:

- No public endpoint is removed or renamed.
- Existing route-family tests still pass.
- Compatibility audit evidence can point to family-specific tests instead of one giant app suite.

### R6: Data Fidelity

R6 should replace the largest remaining fixture-backed claims with live or source-attributed data.

#### R6.1 Provenance Metadata

**Goal:** make monetary and count responses verifiable.

Work:

- Add an optional `meta.provenance` block to responses where the payload already has a metadata envelope.
- For raw CoinGecko-compatible array/map responses, avoid breaking compatibility by adding provenance only behind an explicit query flag or companion endpoint.
- Capture provider name, provider timestamp, ingestion timestamp, latency, freshness, sample size, confidence, and divergence.
- Define confidence from reproducible inputs: spread, volume sanity, anomaly flags, freshness, and provider agreement.

Candidate endpoints:

- `/provenance/{coin_id}`
- `/trust/explain/{exchange_id}`
- `/search/explain?query=...`

Acceptance:

- Provenance can be reproduced from stored source rows or documented runtime samples.
- Compatibility responses do not gain unexpected fields by default.
- Tests cover single-provider, multi-provider agreement, divergent-provider, stale-provider, and fixture-backed cases.

#### R6.2 Live Derivatives

**Goal:** replace derivatives fixtures with CCXT futures/swap ingestion.

Work:

- Add derivatives-capable CCXT adapter methods for `fetchTickers`, `fetchFundingRate`, and `fetchOpenInterest` where supported.
- Start with Binance, Bybit, OKX, Kraken, and Deribit.
- Store contract type, base/quote, expiry, funding rate, open interest, mark price, index price, and source timestamp.
- Keep fixture markers until the endpoint family is materially live.

Acceptance:

- `/derivatives*` responses can be produced from live-backed rows in offline tests via deterministic provider fixtures.
- Fixture metadata remains present only when fixture rows are actually used.
- Provider gaps are visible per exchange.

#### R6.3 Onchain Coverage

**Goal:** make onchain analytics useful beyond pool discovery.

Provider candidates:

- DeFiLlama
- Birdeye or Helius for Solana
- EVM RPC log workers
- Bitquery or Substreams-style providers

Priority order:

1. Real pool OHLCV
2. Real token/pool trades
3. Real holders
4. Real traders
5. MEV and sandwich detection

Acceptance:

- Fixture-only USDC holder/trader responses are replaced or explicitly scoped behind fixture metadata.
- `/onchain/networks/{network}/pools/{address}/mev` has source-attributed detections before being advertised as a production endpoint.
- Diagnostics expose network and provider coverage.

#### R6.4 Treasury Ingestion

**Goal:** replace static treasury fixtures with public disclosure ingestion.

Sources:

- SEC EDGAR
- ETF issuer holdings files
- Government and public treasury disclosures

Work:

- Store source URL, accepted date, source type, parsed date, asset, amount, and confidence.
- Keep a source document table separate from normalized holdings.
- Make parsing idempotent and replayable.

Acceptance:

- Every treasury holding and transaction has a source URL and accepted/published date.
- Fixture data is marked as fixture until replaced.
- Tests cover source parsing, idempotent re-ingestion, correction handling, and historical reconstruction.

#### R6.5 Historical Storage Scale Path

**Goal:** keep SQLite as the local default while enabling deeper production history.

Work:

- Define a storage interface for OHLCV and high-write historical data.
- Add an optional Postgres/TimescaleDB backend for deep OHLCV history.
- Keep SQLite behavior as the default and fully tested path.

Acceptance:

- SQLite tests continue to pass without external services.
- Timescale integration is optional and isolated behind configuration.
- Migration and retention behavior are documented for both backends.

### R7: Product Leap

R7 should happen after R5 hardening and enough R6 fidelity work to avoid streaming or federating low-trust data.

Work:

- Add `/stream/*` via SSE or WebSocket for `simple.price`, `coins.markets`, `onchain.pools`, and `derivatives.funding`.
- Use sequence numbers so clients can reconcile missed events against REST snapshots.
- Generate and serve `GET /openapi.json` and `GET /docs`.
- Generate TypeScript and Python SDKs first; consider Go/Rust later.
- Add a peer snapshot protocol for signed, verified market snapshots.
- Add semantic search only after search relevance has measurable baseline tests.
- Add IPFS-backed asset mirrors only after image identity and cache invalidation rules are stable.

Acceptance:

- Streams are reconnect-safe and reconcile against REST snapshots.
- OpenAPI output is generated from runtime route/schema definitions or a checked contract source, not hand-maintained separately.
- SDK generation is reproducible in CI.
- Federation payloads are signed, versioned, and reject stale or malformed peers.

## New Endpoint Backlog

Do not add all of these at once. Each endpoint should have source ownership, compatibility impact, and tests before implementation.

- `GET /provenance/{coin_id}`
- `GET /trust/explain/{exchange_id}`
- `GET /search/explain?query=...`
- `GET /onchain/networks/{network}/pools/{address}/mev`
- `GET /openapi.json`
- `GET /docs`
- `GET /federation/peers`
- `WS /stream/v1`
- `SSE /stream/v1/*`

## Documentation Rules

- Route coverage claims must link to route registration plus tests.
- Live-data coverage claims must distinguish live, hybrid, seeded, fixture, and synthetic data.
- Release-readiness claims require the full gate set to pass.
- Fixture-backed endpoints must say so in runtime metadata or endpoint-family documentation.
- Any generated OpenAPI/SDK documentation must be checked against runtime behavior in CI.

## Immediate Execution Plan

The original first-week quality-gate, runtime-state, cache-extraction, bounded-cache, transport, provider-breaker, diagnostics freshness-budget, coverage-matrix, first DeFiLlama, derivatives, and treasury provider replays, the treasury disclosure ingestion seam, the source-attributed derivatives ticker ingestion seam, the optional derivatives batch job, derivatives provider gap diagnostics, and safe-route HTTP cache policy work is complete. Every public JSON route family that is safe to cache now has short `Cache-Control`, weak ETags, and tested `304` semantics; live operational monitoring endpoints remain uncached. Continue from the current R5 state in this order:

1. Broaden source-attributed replay coverage for onchain OHLCV before adding more live provider jobs.

## Core Thesis

CoinGecko's edge is brand, breadth, and hosted convenience. OpenGecko can win where a closed commercial API cannot: provenance, open trust scoring, self-hosted real-time streams, federation, reproducible data quality, and verifiable open-data lineage.
