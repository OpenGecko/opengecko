# OpenGecko Improvement Guide

## Purpose

This guide turns the current OpenGecko state into an execution plan for the next improvement wave. It should be read together with:

- `docs/status/implementation-tracker.md`
- `docs/status/compatibility-audit.md`
- `docs/plans/2026-03-31-phase4-chart-history-implementation.md`

The project already has broad CoinGecko-compatible route coverage. The next step is to make the implementation easier to trust, operate, and extend without overstating the quality of fixture-backed or shallow-history surfaces.

## Current State

OpenGecko has a strong compatibility foundation:

- 77 / 77 active non-NFT CoinGecko-compatible routes are registered according to the compatibility audit.
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
| R5-TR-1 | HTTP cache headers | done | medium | R5-CA-1 | Add route-level `Cache-Control` and ETag for safe GET endpoints | `/ping`, `/health`, `/simple/supported_vs_currencies`, `/exchange_rates`, `/asset_platforms`, `/token_lists/:asset_platform_id/all.json`, `/coins/list`, `/coins/list/new`, `/coins/categories/list`, `/coins/categories`, `/coins/top_gainers_losers`, `/coins/:id`, `/coins/:id/history`, `/coins/:id/tickers`, `/coins/:id/market_chart`, `/coins/:id/market_chart/range`, `/coins/:id/ohlc`, `/coins/:id/ohlc/range`, `/coins/:id/circulating_supply_chart`, `/coins/:id/circulating_supply_chart/range`, `/coins/:id/total_supply_chart`, `/coins/:id/total_supply_chart/range`, `/coins/:platform_id/contract/:contract_address`, `/coins/:platform_id/contract/:contract_address/market_chart`, `/coins/:platform_id/contract/:contract_address/market_chart/range`, `/exchanges/list`, `/exchanges`, `/exchanges/:id`, `/exchanges/:id/tickers`, `/exchanges/:id/volume_chart`, `/exchanges/:id/volume_chart/range`, `/search`, `/search/trending`, `/derivatives`, `/derivatives/exchanges`, `/derivatives/exchanges/list`, `/derivatives/exchanges/:id`, `/global`, `/global/decentralized_finance_defi`, `/global/market_cap_chart`, `/entities/list`, `/:entity/public_treasury/:coin_id`, `/public_treasury/:entity_id`, `/public_treasury/:entity_id/:coin_id/holding_chart`, `/public_treasury/:entity_id/transaction_history`, `/diagnostics/chain_coverage`, `/diagnostics/ohlcv_sync`, `/diagnostics/freshness_budgets`, `/diagnostics/coverage_matrix`, `/diagnostics/derivatives`, `/diagnostics/coin_history`, `/diagnostics/exchange_volumes`, `/diagnostics/onchain_analytics`, `/diagnostics/onchain_trades`, `/diagnostics/supply_charts`, and every `/onchain/*` GET route emit `Cache-Control` and weak ETags with tested `304`; onchain discovery, metadata, token, and analytics routes use 60s policy while live trade and OHLCV routes use 30s policy; `/diagnostics/runtime` and `/metrics` remain intentionally uncached live operational surfaces |
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
| R6-OA-2 | Optional onchain analytics sync seam | done | high | R6-OA-1 | Wire one optional provider fetch path into source-attributed holder/trader/holder-count ingestion without requiring live providers in CI | `src/services/onchain-analytics-sync.ts` parses optional `ONCHAIN_ANALYTICS_TARGETS`, exposes an injectable fetcher, provides a default HTTP provider-facing fetch path, and writes fetched holder, trader, and holder-count rows as `source_kind='live'`; `src/jobs/sync-onchain-analytics.ts` exposes `bun run onchain:analytics:sync`; public top-holder, top-trader, and holders-chart route payloads keep their existing shape while route metadata distinguishes fixture, replay, and live source-attributed rows; `tests/onchain-analytics-sync.test.ts` proves config parsing, no-target no-op behavior, provider URL construction, live ingestion, and unchanged route resources with live metadata |
| R6-OA-3 | Onchain analytics provider gap diagnostics | done | medium | R6-OA-2 | Make configured onchain analytics targets, source-backed rows, and fixture-only token gaps visible without changing public onchain analytics payloads | `GET /diagnostics/onchain_analytics` reports configured `ONCHAIN_ANALYTICS_TARGETS`, per-token holder/trader/holder-count row counts split by live and replay source kind, source providers, latest source timestamp, configured targets without source rows, and fixture-only token gaps; `tests/diagnostics-routes.test.ts` proves fixture-only, configured-pending, replay-backed, and live-backed states; `tests/http-cache.test.ts` proves cache headers and `304` semantics for the new safe diagnostics route |
| R6-OT-1 | Onchain trade replay ingestion seam | done | high | R6-OA-3 | Promote deterministic token/pool trade replay rows into source-attributed storage before adding live trade workers | `onchain_pool_trades` stores network, pool, trade id, token, side, USD volume, USD price, transaction hash, block timestamp, source kind, provider, and fetched timestamp with pool/token timestamp indexes; `src/services/onchain-trade-ingestion.ts` normalizes and idempotently upserts replay rows; pool-scoped and token-aggregated `/onchain/*/trades` routes read source-attributed replay rows before fixture fallbacks while preserving trade resource shape and setting `meta.source='replay'`; `tests/provider-replay-onchain-trades.test.ts` proves ingestion idempotency, pool route filtering, token route aggregation, and coverage-matrix evidence |
| R6-OT-2 | Optional onchain trade sync seam | done | high | R6-OT-1 | Wire one optional provider fetch path into `onchain_pool_trades` source-attributed ingestion without requiring live providers in CI | `src/services/onchain-trade-sync.ts` parses optional `ONCHAIN_TRADE_TARGETS`, exposes an injectable fetcher, provides a default HTTP provider-facing fetch path, and writes fetched pool trade rows as `source_kind='live'`; `src/jobs/sync-onchain-trades.ts` exposes `bun run onchain:trades:sync`; public pool and token trade route resources keep their existing shape while route metadata distinguishes fixture, replay, and live source-attributed rows; `tests/onchain-trade-sync.test.ts` proves config parsing, no-target no-op behavior, provider URL construction, provider failure/no-data handling, live ingestion, and unchanged route resources with live metadata |
| R6-OT-3 | Onchain trade provider gap diagnostics | done | medium | R6-OT-2 | Make configured trade targets, source-backed trade rows, and fixture-only pool gaps visible without changing public trade payloads | `GET /diagnostics/onchain_trades` reports configured `ONCHAIN_TRADE_TARGETS`, per-pool trade row counts split by live and replay source kind, per-token row counts, source providers, latest source timestamp, configured targets without source rows, and fixture-only pool gaps; `tests/diagnostics-routes.test.ts` proves fixture-only, configured-pending, replay-backed, and live-backed trade states; `tests/http-cache.test.ts` proves cache headers and `304` semantics for the new safe diagnostics route |
| R6-SC-1 | Supply chart replay ingestion seam | done | high | R6-OT-3 | Promote deterministic circulating/total supply replay rows into source-attributed storage before live supply workers | `supply_chart_points` stores coin, supply type, timestamp, value, source kind, provider, and fetched timestamp with coin/type/timestamp and source-fetched indexes; `src/services/supply-chart-ingestion.ts` normalizes and idempotently upserts replay rows; `/coins/:id/circulating_supply_chart*` and `/coins/:id/total_supply_chart*` read source-attributed rows before empty fixture fallbacks while preserving the existing `{ data, meta }` envelope and explicitly marking replay rows as non-live; `/diagnostics/coverage_matrix` exposes `supply_charts` ownership and source evidence; `tests/provider-replay-supply-charts.test.ts` proves ingestion idempotency, rolling/range route reads, and coverage-matrix evidence |
| R6-SC-2 | Optional supply chart sync seam | done | high | R6-SC-1 | Wire one optional provider fetch path into `supply_chart_points` without requiring live providers in CI | `src/services/supply-chart-sync.ts` parses optional `SUPPLY_CHART_TARGETS`, exposes an injectable fetcher, provides a default HTTP provider-facing fetch path, and writes fetched circulating/total supply rows as `source_kind='live'`; `src/jobs/sync-supply-charts.ts` exposes `bun run supply:charts:sync`; public circulating and total supply chart envelopes keep their existing shape while route metadata distinguishes fixture, replay, and live source-attributed rows; `tests/supply-chart-sync.test.ts` proves config parsing, no-target no-op behavior, provider URL construction, provider failure/no-data handling, live ingestion, and unchanged route envelope shape with live metadata |
| R6-SC-3 | Supply chart provider gap diagnostics | done | medium | R6-SC-2 | Make configured supply chart targets, source-backed rows, and fixture-only coin gaps visible without changing public supply chart payloads | `GET /diagnostics/supply_charts` reports configured `SUPPLY_CHART_TARGETS`, per-coin circulating/total row counts split by live and replay source kind, source providers, latest source timestamp, configured targets without source rows, and fixture-only coin gaps; `tests/diagnostics-routes.test.ts` proves fixture-only, configured-pending, replay-backed, and live-backed supply chart states; `tests/http-cache.test.ts` proves cache headers and `304` semantics for the new safe diagnostics route |
| R6-EV-1 | Exchange volume replay ingestion seam | done | high | R6-SC-3 | Add source-attributed exchange volume chart storage and replay ingestion before replacing seeded exchange volume fixtures | `exchange_volume_source_points` stores exchange, timestamp, BTC volume, source kind, provider, and fetched timestamp with exchange/timestamp and source-fetched indexes; `src/services/exchange-volume-ingestion.ts` normalizes and idempotently upserts replay rows; `/exchanges/:id/volume_chart*` routes read source-attributed rows before canonical exchange volume fallback while preserving the existing tuple-array response shape; `/diagnostics/coverage_matrix` links exchange volume replay evidence and notes source-attributed volume rows separately from seeded exchange metadata; `tests/provider-replay-exchange-volumes.test.ts` proves ingestion idempotency, rolling/range route reads, and coverage-matrix evidence |
| R6-EV-2 | Optional exchange volume sync seam | done | high | R6-EV-1 | Wire one optional provider fetch path into `exchange_volume_source_points` without requiring live providers in CI | `src/services/exchange-volume-sync.ts` parses optional `EXCHANGE_VOLUME_TARGETS`, exposes an injectable fetcher, provides a default HTTP provider-facing fetch path, and writes fetched exchange volume rows as `source_kind='live'`; `src/jobs/sync-exchange-volumes.ts` exposes `bun run exchange:volumes:sync`; public exchange volume chart tuple arrays keep their existing shape while route precedence prefers live source rows before replay or canonical fallback; `tests/exchange-volume-sync.test.ts` proves config parsing, no-target no-op behavior, provider URL construction, provider failure/no-data handling, live ingestion, and unchanged route shape with live source rows |
| R6-EV-3 | Exchange volume provider gap diagnostics | done | medium | R6-EV-2 | Make configured exchange volume targets, source-backed rows, and fixture-only exchange volume gaps visible without changing public exchange volume payloads | `GET /diagnostics/exchange_volumes` reports configured `EXCHANGE_VOLUME_TARGETS`, per-exchange row counts split by live and replay source kind, source providers, latest source timestamp, configured targets without source rows, and fixture-only exchange gaps; `tests/diagnostics-routes.test.ts` proves fixture-only, configured-pending, replay-backed, and live-backed exchange volume states; `tests/http-cache.test.ts` proves cache headers and `304` semantics for the new safe diagnostics route |
| R6-CH-1 | Coin history source snapshot replay seam | done | high | R6-EV-3 | Add source-attributed historical detail snapshot storage and replay ingestion before replacing date-only seeded history behavior | `coin_history_snapshots` stores dated coin detail market snapshots with source kind, provider, fetched timestamp, raw payload trace, and market fields needed to build the existing coin detail response; `src/services/coin-history-ingestion.ts` normalizes and idempotently upserts replay rows; `/coins/:id/history` reads source-attributed date snapshots before the chart/current-snapshot fallback while preserving the public detail response shape and keeping provenance out of default response objects; `/diagnostics/coverage_matrix` now includes `/coins/:id/history` in coin-detail evidence and marks replay history rows as non-live; `tests/provider-replay-coin-history.test.ts` proves validation, idempotency, replay/live precedence, unchanged public shape, and coverage-matrix evidence |
| R6-CH-2 | Optional coin history sync seam | done | high | R6-CH-1 | Wire one optional provider fetch path into `coin_history_snapshots` without requiring live history providers in CI | `src/services/coin-history-sync.ts` parses optional `COIN_HISTORY_TARGETS` entries as `provider=coin:YYYY-MM-DD`, exposes an injectable fetcher, provides a default HTTP provider-facing fetch path, treats 404 or missing market data as no-data, and writes fetched dated snapshots as `source_kind='live'`; `src/jobs/sync-coin-history.ts` exposes `bun run coin:history:sync`; `/coins/:id/history` keeps the existing detail response shape while route precedence prefers live source snapshots before replay rows or seeded fallback; `tests/coin-history-sync.test.ts` proves config parsing, no-target no-op behavior, provider URL construction, provider failure/no-data handling, live ingestion, and unchanged route shape with live source rows |
| R6-CH-3 | Coin history provider gap diagnostics | done | medium | R6-CH-2 | Make configured coin history targets, source-backed rows, and fallback-only coin/date gaps visible without changing public history payloads | `GET /diagnostics/coin_history` reports configured `COIN_HISTORY_TARGETS`, per-coin/date history row counts split by live and replay source kind, source providers, latest source timestamp, configured targets without source rows, missing coin/date targets, and coins still using fallback-only seeded chart/current snapshot blending; `tests/diagnostics-routes.test.ts` proves fallback-only, configured-pending, replay-backed, and live-backed history states; `tests/http-cache.test.ts` proves cache headers and `304` semantics for the new safe diagnostics route |
| R6-MC-1 | Market chart source replay seam | done | high | R6-CH-3 | Add source-attributed market chart point storage and replay ingestion before replacing seeded `chart_points` history behavior | `market_chart_source_points` stores coin, currency, interval, timestamp, chart price, market cap, total volume, OHLC values, source kind, provider, and fetched timestamp with source and lookup indexes; `src/services/market-chart-ingestion.ts` normalizes and idempotently upserts replay rows, chooses live rows over replay rows at the same timestamp, and exposes source-backed day/range readers; `/coins/:id/market_chart*` and `/coins/:id/ohlc*` prefer source-attributed rows before seeded chart/canonical candle fallback while preserving existing raw array/map response shapes; `/diagnostics/coverage_matrix` links market-chart replay evidence and marks replay history rows as non-live; `tests/provider-replay-market-charts.test.ts` proves validation, idempotency, chart and OHLC route reads, live-over-replay precedence, and coverage-matrix evidence |
| R6-MC-2 | Optional market chart sync seam | done | high | R6-MC-1 | Wire one optional provider fetch path into `market_chart_source_points` without requiring live OHLCV/history providers in CI | `src/services/market-chart-sync.ts` parses optional `MARKET_CHART_TARGETS` entries as `provider=coin:interval:vs_currency`, exposes an injectable fetcher, provides a default HTTP provider-facing fetch path, treats 404 or empty point sets as no-data, and writes fetched market chart/OHLC rows as `source_kind='live'`; `src/jobs/sync-market-charts.ts` exposes `bun run market:charts:sync`; `/coins/:id/market_chart*` and `/coins/:id/ohlc*` keep their existing response shapes while route precedence prefers live source rows before replay or seeded/canonical fallback; `tests/market-chart-sync.test.ts` proves config parsing, no-target no-op behavior, provider URL construction, provider failure/no-data handling, live ingestion, and unchanged route shapes with live source rows |
| R6-MC-3 | Market chart provider gap diagnostics | done | medium | R6-MC-2 | Make configured market chart targets, source-backed rows, and fallback-only chart gaps visible without changing public chart payloads | `GET /diagnostics/market_charts` reports configured `MARKET_CHART_TARGETS`, per-coin/currency/interval row counts split by live and replay source kind, source providers, latest source timestamp, configured targets without source rows, missing coin chart targets, and coins still using fallback-only seeded OHLCV/current snapshot blending; `tests/diagnostics-routes.test.ts` proves fallback-only, configured-pending, replay-backed, and live-backed chart states; `tests/http-cache.test.ts` proves cache headers and `304` semantics for the new safe diagnostics route |
| R6-MC-4 | Market chart target coverage expansion | done | medium | R6-MC-3 | Add a small default target manifest or documented target list for top market-chart coins and intervals so operators know what to sync first | `docs/reference/market-chart-targets.json` documents a starter `MARKET_CHART_TARGETS` string for top seeded market-chart coins plus daily and bitcoin intraday intervals, explicitly gates live freshness claims on `/diagnostics/market_charts`, and records operator notes for provider base URL setup; `README.md` now lists the market chart target/base URL config, diagnostics route, and sync job; `tests/market-chart-targets.test.ts` proves the documented target string parses into the manifest rows and that diagnostics surface every target as `configured_pending` before source ingestion |
| R6-MC-5 | Broader history chart/OHLCV defaults | done | medium | R6-MC-4 | Make history chart and OHLCV coverage more comprehensive without changing public chart/OHLC response shapes | Default generated OHLCV targets now backfill and retain five years (`OHLCV_TARGET_HISTORY_DAYS=1825`, `OHLCV_RETENTION_DAYS=1825`) instead of one year; `docs/reference/market-chart-targets.json` now covers every seeded market-chart coin with daily source-backed targets and adds intraday targets for bitcoin, ethereum, and solana; `README.md` documents the five-year defaults and the broader starter target set; `tests/ohlcv-targets.test.ts`, `tests/market-chart-targets.test.ts`, and `tests/docs-drift.test.ts` guard the new defaults, operator override path, manifest breadth, and docs alignment |
| R6-JD-1 | Unified optional provider job diagnostics | done | medium | R6-MC-4 | Register optional source-backed sync jobs in one diagnostics view with last run, duration, target count, rows written, and failure reason | `GET /diagnostics/jobs` reports coin history, exchange volume, market chart, onchain analytics, onchain trade, and supply chart sync job commands, target env vars, provider-base-url env vars, configured target counts, last run timestamps, duration, rows written, and failure reason without exposing credentials; `src/services/optional-provider-jobs.ts` owns the in-process registry for running/succeeded/failed outcomes; `tests/optional-provider-jobs.test.ts` proves no-target, configured-pending, success, and failure states without network access; `tests/http-cache.test.ts` proves cache headers and `304` semantics for the safe diagnostics route |
| R6-JD-2 | Durable standalone optional sync outcomes | done | high | R6-JD-1 | Have each `bun run *:sync` entrypoint record its success/failure summary in durable job state so `/diagnostics/jobs` remains useful across process restarts | `optional_provider_job_runs` stores one durable last-run row per optional source-backed sync job with status, timestamps, target count, rows written, and failure reason; all six optional sync entrypoints record running, no-target success, normal success, and thrown failure while preserving CLI failure behavior; `/diagnostics/jobs` merges in-process registry state with persisted SQLite state; `tests/optional-provider-jobs.test.ts` proves no-target standalone job outcomes and provider-base-url failures survive app restart |
| R6-JD-3 | Optional provider scheduler hooks | done | medium | R6-JD-2 | Register optional source-backed sync jobs with an interval-capable scheduler that can run the existing ingestion paths under operator control | `OPTIONAL_PROVIDER_SYNC_ENABLED=false` keeps the scheduler disabled by default and `OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS=900` controls the interval when enabled; `src/services/optional-provider-scheduler.ts` registers coin history, exchange volume, market chart, onchain analytics, onchain trade, and supply chart jobs against the existing sync services, serializes overlapping runs, records success/failure into the in-process job registry, and is started/stopped by `createMarketRuntime`; `tests/optional-provider-scheduler.test.ts` proves disabled-by-default behavior, interval registration, non-overlap, and failure capture without network access |
| R6-JD-4 | Durable scheduler optional sync outcomes | done | high | R6-JD-3 | Have interval-triggered optional provider sync runs write the same durable `optional_provider_job_runs` state as standalone commands | `src/services/optional-provider-scheduler.ts` now records running, success, and failure outcomes through the same durable optional job run writers used by standalone commands when a database is supplied; `createMarketRuntime` passes the app database into the scheduler so `/diagnostics/jobs` can report scheduler-run outcomes after process restarts; diagnostics wording now covers standalone and scheduler execution; `tests/optional-provider-scheduler.test.ts` proves scheduler success and failure outcomes survive a fresh app instance and remain visible through `/diagnostics/jobs` |
| R6-JD-5 | Optional provider scheduler operations guide | done | medium | R6-JD-4 | Document a minimal operator playbook for enabling the scheduler safely, choosing target sets, checking diagnostics, and rolling back to standalone jobs | `README.md` now lists all optional provider target and base URL env vars, all standalone sync commands, the persisted `/diagnostics/jobs` semantics, and a staged scheduler playbook: verify standalone jobs first, expand target sets from diagnostics gaps, enable `OPTIONAL_PROVIDER_SYNC_ENABLED=true` only after success, tune `OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS` conservatively, and roll back to standalone commands without changing public API response shapes |
| R6-JD-6 | Optional provider scheduler drift guard | done | medium | R6-JD-5 | Add a docs drift test that keeps README optional-provider env vars, standalone commands, scheduler flags, and diagnostics routes aligned with `src/config/env.ts`, `package.json`, and route registrations | `tests/docs-drift.test.ts` now asserts the README names all optional target/base URL env vars, configured scheduler flags, standalone sync commands, and provider diagnostics routes, and cross-checks config-backed env vars, package scripts, and diagnostics route registrations so future optional-provider work cannot silently drift from the operator guide |
| R6-HS-2 | OHLCV chunked deepening | done | high | R6-MC-5 | Bound deep historical OHLCV backfill into provider-safe chunks while preserving the five-year target window | `deepenHistoricalOhlcvWindow` now fetches at most a 180-day historical chunk plus a two-day overlap per tick, skips provider calls when the target window is already covered, and still runs gap repair after each chunk; this keeps recent coverage prioritized while allowing the default five-year window to fill progressively; `tests/ohlcv-sync.test.ts` proves bounded fetch windows, persisted chunk candles, and no-op behavior once target depth is reached |
| R6-HS-3 | OHLCV deepening diagnostics detail | done | medium | R6-HS-2 | Add diagnostics fields that show historical backfill progress by target tier and oldest covered date so operators can tell whether five-year coverage is actually filled | `summarizeOhlcvSyncStatus` now reports configured target depth, desired oldest timestamp, global oldest/newest covered timestamps, counts for targets with any history and targets at target depth, plus top100/requested/long_tail tier breakdowns; `/diagnostics/ohlcv_sync` exposes this without provider credentials; `tests/ohlcv-runtime.test.ts` and `tests/ohlcv-diagnostics.test.ts` prove the service and HTTP boundary report real coverage progress rather than treating configured depth as completed coverage |
| R6-MC-6 | Market chart target provider presets | done | medium | R6-HS-3 | Add provider-specific examples for market chart targets and expected adapter paths so operators can move from `custom` placeholders to real source-backed chart coverage | `docs/reference/market-chart-provider-presets.json` documents the generic market-chart adapter contract, provider IDs for `ccxt.binance`, `ccxt.coinbase`, and `intraday.archive`, parseable `MARKET_CHART_TARGETS` examples, expected `/providers/{provider}/coins/{coin_id}/market_chart` paths, and diagnostics guidance; `README.md` links the presets from the optional provider playbook; `tests/market-chart-targets.test.ts` proves every preset target parses and each documented path matches `createHttpMarketChartFetcher`; `tests/docs-drift.test.ts` keeps the README and preset doc tied to current env names and path templates |
| R6-MC-7 | Market chart provider preset diagnostics smoke | done | medium | R6-MC-6 | Add a diagnostics smoke fixture that uses one provider preset target and proves the configured provider name appears in `/diagnostics/market_charts` before and after source ingestion | `tests/market-chart-targets.test.ts` now boots OpenGecko with a documented preset target, verifies `/diagnostics/market_charts` reports the provider ID in configured-pending state, syncs one mocked live source row through `syncMarketCharts`, and verifies the same provider ID appears as `live_backed` with live row counts and latest source timestamp |
| R6-MC-8 | Market chart preset operator README example | done | medium | R6-MC-7 | Add a copy-paste safe README example that combines a preset target string with `MARKET_CHART_BASE_URL`, standalone sync, diagnostics checks, and scheduler enablement order | `README.md` now includes a focused market chart preset example with `MARKET_CHART_BASE_URL`, a `ccxt.binance` `MARKET_CHART_TARGETS` string, `bun run market:charts:sync`, `/diagnostics/market_charts`, and scheduler flags; it points operators to `docs/reference/market-chart-provider-presets.json` for provider IDs and adapter request paths while keeping credentials behind the adapter service; `tests/docs-drift.test.ts` extracts that README section and proves the preset file, target/base envs, sync command, diagnostics route, and scheduler flags stay together |
| R6-MC-9 | Market chart adapter replay fixture contract | done | medium | R6-MC-8 | Add a small documented adapter response fixture and schema-style test proving preset adapter market-chart responses map into `RawMarketChartReplay` rows and live ingestion | `docs/reference/market-chart-provider-presets.json` now points the adapter contract at `tests/fixtures/provider-replay/market-charts/ccxt-binance-bitcoin-adapter-response.json`; the fixture models a `ccxt.binance` daily bitcoin adapter response with string timestamps/numbers and null market caps; `tests/market-chart-sync.test.ts` loads the documented preset target and fixture, sends it through `createHttpMarketChartFetcher` and `syncMarketCharts`, verifies live source-attributed rows, and proves existing market chart/OHLC public response shapes remain unchanged; `tests/docs-drift.test.ts` guards the fixture path in the preset contract |
| R6-MC-10 | Market chart preset freshness diagnostics thresholds | done | medium | R6-MC-9 | Add operator-facing diagnostics that classify configured market chart targets by latest source timestamp age and per-target row depth so stale or shallow chart coverage is obvious | `/diagnostics/market_charts` now reports per-target coverage metadata including oldest/newest source points, source age seconds, interval-aware freshness thresholds, fresh/stale/unknown status, source coverage days, depth thresholds, and deep/shallow/empty status; gaps now include `stale_source_targets` and `shallow_source_targets` for configured targets; README and provider preset docs explain using freshness/depth diagnostics before claiming live chart coverage; `tests/diagnostics-routes.test.ts` proves configured-empty, fresh/deep, stale, and shallow states from actual source rows |
| R6-MC-11 | Market chart intraday preset coverage expansion | done | medium | R6-MC-10 | Add documented intraday adapter fixture coverage beyond bitcoin so high-priority 1m targets have the same offline contract and diagnostics proof as daily targets | `docs/reference/market-chart-provider-presets.json` now includes an `intraday.archive=ethereum:1m:usd` request example with `tests/fixtures/provider-replay/market-charts/intraday-archive-ethereum-adapter-response.json`; `tests/market-chart-sync.test.ts` loads that documented 1m fixture through the HTTP fetcher and live sync path, verifies 1m live source rows, public hourly market chart/OHLC range response shapes, and 1m freshness/depth diagnostics (`fresh`, `deep`, 30-minute freshness threshold, one-day depth threshold); `tests/docs-drift.test.ts` guards the intraday fixture reference |
| R6-MC-12 | Market chart diagnostics README response example | done | low | R6-MC-11 | Add a compact README diagnostics sample showing `configured_pending`, `live_backed`, `stale_source_targets`, and `shallow_source_targets` interpretation for chart operators | `README.md` now includes a compact `/diagnostics/market_charts` JSON interpretation sample that distinguishes configured-but-unsynced targets, source-backed targets, stale targets, and shallow targets; it explicitly says targets should not be described as CoinGecko-fresh until they are `live_backed` with `coverage.freshness=fresh` and enough depth for the user-facing chart window; `tests/docs-drift.test.ts` guards the README section against losing the diagnostics field names and manifest links |
| R6-MC-13 | Market chart diagnostics rollup counters | done | medium | R6-MC-12 | Add aggregate counts to `/diagnostics/market_charts` for configured targets by status, freshness, and depth so operators do not have to scan every coin row manually | `/diagnostics/market_charts` now includes `summary.configured_targets`, `source_backed_configured_targets`, `status_counts`, `freshness_counts`, and `depth_counts` computed from configured targets; `tests/diagnostics-routes.test.ts` proves configured-pending, live-backed, fresh/stale, and deep/shallow totals match the per-target rows; README’s diagnostics example shows the rollup and `tests/docs-drift.test.ts` guards the rollup field names |
| R6-HS-4 | OHLCV history completion estimator | done | medium | R6-HS-3 | Add a diagnostics estimator that projects remaining OHLCV backfill chunks per target/tier from current oldest coverage and configured five-year depth | `/diagnostics/ohlcv_sync` now includes `history.completion_estimate` with chunk size, overlap, incomplete target count, remaining depth days, estimated remaining chunk calls, and max remaining target depth; `history.by_tier` now carries remaining depth days and estimated chunks for top100/requested/long_tail tiers; `tests/ohlcv-runtime.test.ts` proves estimates fall as oldest coverage approaches target depth and `tests/ohlcv-diagnostics.test.ts` proves the HTTP boundary preserves the fields |
| R6-HS-5 | OHLCV stale target drilldown | done | medium | R6-HS-4 | Add bounded per-tier samples of the most-behind OHLCV targets to `/diagnostics/ohlcv_sync` so operators can see which coin/exchange pairs are blocking depth completion | `/diagnostics/ohlcv_sync` now includes `history.most_behind_samples` for top100/requested/long_tail tiers, capped at five rows per tier and sorted by remaining depth days; each sample includes coin, exchange, symbol, currency, interval, status, target depth, oldest/latest sync cursors, remaining depth days, and estimated remaining chunks; `tests/ohlcv-runtime.test.ts` proves deterministic sorting and capping, `tests/ohlcv-diagnostics.test.ts` proves HTTP boundary preservation, and README describes the capped most-behind target samples |
| R6-HS-6 | OHLCV completion README interpretation | done | low | R6-HS-5 | Add a compact README sample for `/diagnostics/ohlcv_sync` showing completion estimates, tier remaining chunks, and most-behind samples | `README.md` now includes an OHLCV completion interpretation sample with `history.completion_estimate`, 180-day chunk and two-day overlap assumptions, tier-level `estimated_remaining_chunks`, and capped `most_behind_samples`; `tests/docs-drift.test.ts` guards the estimator field names, chunk constants, target-depth env vars, and the promise that public chart/OHLC response shapes remain unchanged |
| R6-HS-7 | OHLCV depth alert thresholds | done | medium | R6-HS-6 | Add diagnostics thresholds that classify OHLCV target depth as complete, catching up, or blocked by tier | `/diagnostics/ohlcv_sync` now includes `history.depth_status_counts`, per-tier `depth_status_counts`, and `depth_alert_thresholds` so operators can alert separately on complete, catching-up, and failed-but-incomplete OHLCV history targets without changing public chart/OHLC response shapes; `tests/ohlcv-runtime.test.ts` proves classification from target remaining depth and failed status, `tests/ohlcv-diagnostics.test.ts` proves the HTTP boundary preserves the fields, and README explains how to interpret the counts |
| R6-HS-8 | OHLCV blocked target retry detail | done | medium | R6-HS-7 | Add diagnostics samples for failed/backoff OHLCV targets with retry cursor and last error metadata | `/diagnostics/ohlcv_sync` now includes `history.blocked_target_samples` for failed incomplete targets, capped per tier and sorted by retry cursor then remaining depth; samples include target identity, remaining depth, failure count, retry cursor, retry seconds, last attempt/success cursors, and sanitized last error metadata; `tests/ohlcv-runtime.test.ts` proves deterministic capping, retry ordering, and secret redaction, `tests/ohlcv-diagnostics.test.ts` proves HTTP boundary preservation, and README documents the operator interpretation without changing public chart/OHLC response shapes |
| R6-HS-9 | OHLCV retry recovery visibility | done | medium | R6-HS-8 | Add diagnostics counters for failed targets whose retry window is due versus still in backoff, split by tier | `/diagnostics/ohlcv_sync` now includes global and per-tier `history.retry_recovery_counts` with `due` and `backoff` buckets for failed targets; `tests/ohlcv-runtime.test.ts` proves counts are derived from `next_retry_at` against current time and split by top100/requested/long_tail tiers, `tests/ohlcv-diagnostics.test.ts` proves HTTP boundary preservation, and README explains the alert interpretation without changing public chart/OHLC response shapes |
| R6-HS-10 | OHLCV failed-target requeue semantics | done | high | R6-HS-9 | Make retry-due failed OHLCV targets eligible for leasing again without skipping backoff windows | `leaseNextOhlcvTarget` now considers both idle targets and failed targets whose `next_retry_at` is due, while still skipping idle or failed targets with future retry cursors; `tests/ohlcv-worker-state.test.ts` proves due failed targets are leased and backoff targets remain skipped, `tests/ohlcv-runtime.test.ts` proves a successful retry clears failure metadata and reduces due retry diagnostics, and README clarifies that due failed targets are worker-eligible without changing public chart/OHLC response shapes |
| R6-HS-11 | OHLCV retry starvation guard | done | medium | R6-HS-10 | Add an age-based diagnostic counter for retry-due targets that remain failed across multiple scheduler ticks | `/diagnostics/ohlcv_sync` now includes global and per-tier `history.retry_starvation_counts` plus `retry_starvation_thresholds.due_age_seconds=120` so operators can tell when failed targets have remained retry-due across multiple worker ticks; `tests/ohlcv-runtime.test.ts` proves only retry-due targets past the due-age threshold count as starved and that the counts split by tier, `tests/ohlcv-diagnostics.test.ts` proves HTTP boundary preservation, and README explains when to intervene without changing public chart/OHLC response shapes |
| R6-HS-12 | OHLCV worker lease ordering by depth urgency | done | medium | R6-HS-11 | Prefer retry-due failed targets and incomplete top100 historical targets before already-complete long-tail targets | `leaseNextOhlcvTarget` now orders eligible targets by priority tier, retry-due failure state, remaining historical depth, last success cursor, and coin ID; this keeps due retries and deeper top100 backfill ahead of lower-urgency complete targets while preserving backoff skips; `tests/ohlcv-worker-state.test.ts` proves retry-due failed targets beat idle peers, deeper incomplete targets beat complete peers in the same tier, and top100 still beats long-tail without changing public chart/OHLC response shapes |
| R6-HS-13 | OHLCV lease ordering README note | done | low | R6-HS-12 | Add a short operator note describing how top100, retry-due failed targets, and remaining depth affect backfill order | `README.md` now documents OHLCV worker lease order by tier, retry-due failed state, `remaining_depth_days`, `last_success_at`, and deterministic coin-ID tie-breaks while explicitly avoiding a promise of an upstream provider call on every tick; `tests/docs-drift.test.ts` guards the operator wording against drifting from runtime behavior without changing public chart/OHLC response shapes |
| R6-HS-14 | OHLCV retry/backfill queue diagnostics summary | done | medium | R6-HS-13 | Add a compact queue-priority summary to `/diagnostics/ohlcv_sync` so operators can see the next likely retry/depth buckets without scanning samples | `/diagnostics/ohlcv_sync` now includes `history.queue_priority_summary` with global and top100/requested/long_tail counts for lease-eligible targets, retry-due failures, backoff failures, incomplete depth, complete depth, running targets, and starved retry-due targets; `tests/ohlcv-runtime.test.ts` proves counts match the same coarse lease-priority buckets used by the worker, `tests/ohlcv-diagnostics.test.ts` proves HTTP boundary preservation, and README explains that this is a coarse retry/backfill class estimate rather than an exact provider-call schedule |
| R6-HS-15 | Daily OHLC range provider fallback | done | medium | R6-HS-14 | Let `/coins/:id/ohlc/range` use the same daily provider fallback as `/coins/:id/ohlc` when local source/canonical storage is empty | Daily OHLC range requests now read source-backed rows first, canonical OHLCV second, and fall back to the configured ticker provider only for daily ranges; successful provider candles are filtered to the requested range, persisted into canonical OHLCV storage, and returned in the unchanged CoinGecko-compatible tuple shape; hourly ranges remain storage-backed; `tests/app.test.ts` proves provider call parameters, response tuple shape, and persistence, while README documents the route behavior |
| R6-HS-16 | Daily market chart range provider fallback | done | medium | R6-HS-15 | Let `/coins/:id/market_chart/range` use persisted provider OHLCV close rows when source-backed and canonical chart rows are empty | Daily market chart range requests now read source-backed chart rows first, canonical chart/candle storage second, and fall back to configured ticker-provider OHLCV only when local storage is empty; provider close prices become chart prices, market cap remains null when unavailable, total volume is preserved, and successful candles are persisted into canonical OHLCV storage without changing the public chart payload shape; `tests/app.test.ts` proves provider call parameters, chart array shape, and persistence, while README documents the shared daily fallback path |
| R6-HS-17 | Daily market chart days provider fallback | done | medium | R6-HS-16 | Let `/coins/:id/market_chart` use provider OHLCV close rows for daily day-window requests when source-backed and canonical chart rows are empty | Daily market chart day-window requests now read source-backed chart rows first, canonical chart/candle storage second, and fall back to configured ticker-provider OHLCV only when local storage is empty; provider close prices become chart prices, market cap remains null when unavailable, total volume is preserved, and successful candles are persisted into canonical OHLCV storage without changing the public chart payload shape; `tests/app.test.ts` proves provider call parameters, chart array shape, and persistence, while README documents the shared daily fallback path |
| R6-HS-18 | OHLCV fallback source diagnostics | done | medium | R6-HS-17 | Add diagnostics counters for public chart/OHLC fallbacks that distinguish source-backed, canonical, and provider-filled responses | `/diagnostics/market_charts` now includes `response_source_counts` for `market_chart_days`, `market_chart_range`, `ohlc_days`, and `ohlc_range`, split into `source_backed`, `canonical`, `provider_filled`, and `empty`; the counters do not alter public chart/OHLC payloads; `tests/diagnostics-routes.test.ts` proves canonical, source-backed, and provider-filled paths increment the right buckets, and README explains provider-filled counts as short-term fallback signals rather than source-backed coverage |
| R6-HS-19 | OHLCV fallback counter persistence | done | medium | R6-HS-18 | Persist public chart/OHLC response-source counters so fallback visibility survives process restarts | `chart_response_source_counts` stores durable route/source counters for `market_chart_days`, `market_chart_range`, `ohlc_days`, and `ohlc_range`; `createChartResponseSourceDiagnostics(database)` writes counters on public chart/OHLC requests and `/diagnostics/market_charts` reads the persisted snapshot without changing public response bodies; `tests/diagnostics-routes.test.ts` proves counters survive an app restart and remain absent from public chart/OHLC payloads, while README describes the counters as diagnostics-only durable fallback signals |
| R6-HS-20 | OHLCV fallback recent-event drilldown | done | medium | R6-HS-19 | Add a bounded diagnostics-only recent-event view for provider-filled and empty chart/OHLC responses so operators can see which coins/ranges still need source-backed coverage | `chart_response_source_events` stores the 50 most recent `provider_filled` and `empty` public chart/OHLC events with sanitized route, coin, currency, interval, and days/range request context; `/diagnostics/market_charts` exposes `response_source_recent_events` next to durable counters while public chart/OHLC bodies remain unchanged; `tests/chart-response-source-diagnostics.test.ts` proves event capping, source filtering, sanitization, and restart visibility, and `tests/diagnostics-routes.test.ts` proves provider-filled and empty route events are diagnostics-only |
| R6-HS-21 | OHLCV fallback event gap rollups | done | medium | R6-HS-20 | Add diagnostics rollups from recent provider-filled and empty chart/OHLC events by route and coin so operators can prioritize source-backed target expansion without scanning each event | `/diagnostics/market_charts` now includes `response_source_recent_event_rollups` derived from capped sanitized events with total event count, per-route provider-filled/empty counts, and the top coin/currency fallback pressure rows; `tests/chart-response-source-diagnostics.test.ts` proves rollups derive from capped persisted events, and `tests/diagnostics-routes.test.ts` proves route-level and coin-level rollups survive restart and remain diagnostics-only |
| R6-HS-22 | OHLCV fallback-to-target suggestions | done | medium | R6-HS-21 | Use recent provider-filled and empty chart/OHLC event rollups to suggest candidate `MARKET_CHART_TARGETS` entries for coins/windows still relying on fallback paths | `/diagnostics/market_charts` now includes `response_source_target_suggestions` with deterministic `<provider>=coin:interval:vs_currency` templates derived from capped sanitized fallback events; suggestions preserve provider choice for operators, never write config, and remain diagnostics-only; `tests/chart-response-source-diagnostics.test.ts` proves suggestions derive from capped persisted events, and `tests/diagnostics-routes.test.ts` proves suggested target templates survive restart and remain absent from public chart/OHLC payloads |
| R6-HS-23 | OHLCV suggested target docs example | done | low | R6-HS-22 | Add a README operator example showing how to turn `response_source_target_suggestions` into a concrete provider-backed `MARKET_CHART_TARGETS` entry using the preset provider docs | README now shows a copy-paste diagnostics workflow that reads `response_source_target_suggestions`, replaces `<provider>` with a supported preset provider such as `ccxt.binance`, runs `bun run market:charts:sync`, and verifies the target through `/diagnostics/market_charts` coverage status; `tests/docs-drift.test.ts` guards the suggestion field, preset docs reference, target syntax, and warning that suggestions are not proof of live freshness |
| R6-HS-24 | OHLCV target suggestion suppression | done | medium | R6-HS-23 | Suppress or de-prioritize `response_source_target_suggestions` for targets already configured and source-backed so old fallback events do not keep recommending solved work | `response_source_target_suggestions` now filters out coin/currency/interval targets that already have `live_backed` or `replay_backed` source rows while leaving unresolved fallback-only targets suggested; `tests/chart-response-source-diagnostics.test.ts` proves a configured live-backed bitcoin target is omitted while an unresolved ethereum fallback event remains suggested, and README explains the suppression rule |
| R6-HS-25 | OHLCV suggestion freshness window | done | medium | R6-HS-24 | Add age metadata or cutoff controls for `response_source_target_suggestions` so very old fallback events can be ignored once operations have stabilized | `/diagnostics/market_charts` now includes `response_source_target_suggestion_window` with a UTC-day-bucketed seven-day cutoff timestamp and ignored stale-event count; `response_source_target_suggestions` only uses fallback events observed inside that window while `response_source_recent_events` and rollups still expose the capped raw evidence; tests prove stale unresolved fallback events are excluded while recent unresolved events remain suggested, and README documents the cutoff as diagnostics-only |
| R6-HS-26 | OHLCV suggestion outcome summary | done | medium | R6-HS-25 | Add compact counters for recent fallback events considered, stale events ignored, source-backed suggestions suppressed, and final suggestion count so operators can understand why the suggestion list is empty | `/diagnostics/market_charts` now includes `response_source_target_suggestion_summary` with capped event total, stale ignored count, in-window event count, source-backed suppression count, eligible event count, unique eligible targets, returned suggestion count, and suggestion cap; tests prove the counters reconcile with freshness filtering, source-backed suppression, and final suggestions, and README documents the summary as diagnostics-only |
| R6-HS-27 | OHLCV suggestion request samples | done | medium | R6-HS-26 | Add capped request samples per suggested target so operators can see representative route/range pressure without scanning every recent event | Each `response_source_target_suggestions` row now includes up to three sanitized `sample_requests` sorted by newest observed fallback event, with route, source, observed timestamp, and sanitized days/range request context; tests prove samples are capped, deterministic, and attached only to diagnostics suggestions, and README documents them as operator evidence rather than public response metadata |
| R6-HS-28 | OHLCV suggestion stale/suppressed drilldown | done | medium | R6-HS-27 | Add capped diagnostics-only examples for stale ignored events and source-backed suppressed targets so empty suggestion lists explain whether work is solved or merely old | `/diagnostics/market_charts` now includes `response_source_target_suggestion_exclusions` with capped sanitized `stale_events` and `source_backed_events` samples; tests prove stale and source-backed exclusions reconcile with the suggestion outcome summary, remain capped, and are deterministic, while README documents them as diagnostics-only context for empty suggestion lists |
| R6-HS-29 | Market chart fallback alert status | done | medium | R6-HS-28 | Add a compact diagnostics status that classifies current public chart/OHLC fallback pressure as clear, watch, or action-needed from recent events, suggestions, and source-backed suppression | `/diagnostics/market_charts` now includes `response_source_fallback_alert` with deterministic `clear`, `watch`, and `action_needed` states derived from recent fallback events, stale-only pressure, source-backed suppression, eligible suggestion events, and returned suggestions; tests prove the status changes for no events, unresolved recent fallback pressure, stale-only pressure, and source-backed-only suppression, and README documents the operator interpretation |
| R6-HS-30 | Market chart fallback alert route smoke | done | low | R6-HS-29 | Add route-level diagnostics tests proving `/diagnostics/market_charts` exposes the fallback alert status through the HTTP boundary across restart-visible recent events | `tests/diagnostics-routes.test.ts` now proves `response_source_fallback_alert` appears on `/diagnostics/market_charts` with action-needed status for persisted provider-filled/empty fallback events, survives app restart through durable diagnostics storage, and remains absent from public chart/OHLC response bodies |
| R6-HS-31 | Market chart alert cache contract | done | low | R6-HS-30 | Add a focused cache/ETag assertion for fallback alert diagnostics so alert fields remain compatible with dynamic diagnostics caching as the payload grows | `tests/diagnostics-routes.test.ts` now sends a conditional `/diagnostics/market_charts` request after alert-bearing fallback events and proves the route returns `304` with the same `ETag` and `Cache-Control`, protecting the alert payload from unstable time-derived diagnostics fields |
| R6-HS-32 | Market chart alert README workflow | done | low | R6-HS-31 | Add a compact operator workflow for using `response_source_fallback_alert` to choose between doing nothing, watching stale/source-backed pressure, and applying suggested targets | README now documents how to interpret `clear`, `watch`, and `action_needed` alert states, where to inspect stale and source-backed suppression evidence, how to turn target suggestions into provider-backed `MARKET_CHART_TARGETS`, and how to verify the target becomes `live_backed` or `replay_backed` after `bun run market:charts:sync`; `tests/docs-drift.test.ts` guards the workflow, suggestions, suppression, and verification language |
| R6-HS-33 | Market chart fallback pressure ranking | done | low | R6-HS-32 | Add deterministic ranking metadata to `response_source_target_suggestions` so operators can see which history chart/OHLCV target has the highest recent unresolved fallback pressure | `response_source_target_suggestions` now includes diagnostics-only `priority.rank`, `priority.pressure_score`, and `priority.latest_observed_at`, with suggestions sorted by unresolved event count, provider-filled count, empty count, newest observation, and stable coin/currency/interval tie-breakers; service and route tests prove ranking metadata is present while request samples remain capped and sanitized, and README documents the prioritization contract |
| R6-HS-34 | Market chart suggestion latest-sample cache smoke | done | low | R6-HS-33 | Add a focused route/cache test that covers multiple ranked suggestions and proves ETag stability when priority metadata is present | `tests/diagnostics-routes.test.ts` now drives two unresolved chart/OHLC targets through `/diagnostics/market_charts`, proves ranked suggestion ordering and priority metadata before and after restart, and keeps the conditional `304` cache assertion in the ranked payload path |
| R6-HS-35 | Market chart suggestion route-pressure breakdown | done | low | R6-HS-34 | Add compact route-pressure metadata to each suggested target so operators can see whether the gap is mostly market-chart days, market-chart range, OHLC days, or OHLC range | `response_source_target_suggestions` now includes `route_pressure.dominant_route` and per-route `route_pressure.totals` derived from the capped recent fallback events; service, route, and docs drift tests prove the breakdown is deterministic, preserves existing ranking semantics, and remains diagnostics-only |
| R6-HS-36 | Market chart suggestion days-vs-range hints | done | low | R6-HS-35 | Add a compact request-kind breakdown to each suggested target so operators can distinguish persistent day-window pressure from specific range gaps | `response_source_target_suggestions` now includes `request_kind_pressure.dominant_kind` and days/range totals derived from capped recent fallback events; service, route, and docs drift tests prove the counts are deterministic, preserve capped samples, and remain diagnostics-only |
| R6-HS-37 | Market chart suggestion range-span hints | done | low | R6-HS-36 | Add compact observed range-span metadata to suggested targets so operators can tell whether range gaps are intraday-sized, single-day, or broader historical windows | `response_source_target_suggestions` now includes `range_span_pressure` with dominant bucket, intraday/single-day/multi-day bucket counts, range request count, and min/max span seconds derived from sanitized capped recent events; tests prove intraday, single-day, and multi-day classification remains deterministic and diagnostics-only |
| R6-HS-38 | Market chart suggestion coverage-target hints | done | low | R6-HS-37 | Add diagnostics-only target interval/window hints that explain whether a suggestion should likely expand daily history, intraday history, or both | `response_source_target_suggestions` now includes `coverage_target_hint` with target history, suggested action, request pattern, and range window derived from interval, request-kind pressure, and range-span pressure; tests prove daily and intraday hints remain deterministic and do not change ranking |
| R6-HS-39 | Market chart suggestion operator summary | done | low | R6-HS-38 | Add a compact top-level diagnostics summary of suggested daily vs intraday coverage expansion counts so operators can plan batch target updates without scanning every suggestion | `/diagnostics/market_charts` now includes `response_source_target_suggestion_operator_summary` with total returned suggestions, daily/intraday target-history counts, suggested-action counts, request-pattern counts, and range-window counts reconciled from the returned suggestion rows; service, route, and docs drift tests prove the summary remains deterministic and cache-safe |
| R6-HS-40 | Market chart operator summary docs example | done | low | R6-HS-39 | Add a README command example that reads `response_source_target_suggestion_operator_summary` before applying target templates | README now shows a preflight `jq` command for `response_source_target_suggestion_operator_summary`, tells operators to batch daily-history and intraday-history target expansion by provider capability before copying individual templates, and `tests/docs-drift.test.ts` guards the workflow text |
| R6-HS-41 | Market chart suggestion batch target preview | done | low | R6-HS-40 | Add diagnostics-only grouped target-template previews by daily/intraday target history so operators can copy a coherent batch after choosing a provider | `/diagnostics/market_charts` now includes `response_source_target_suggestion_batch_previews` derived only from returned suggestions, grouped by daily and intraday target history, preserving priority order, exposing comma-separated `<provider>` target templates, and remaining absent from public chart/OHLC responses; service, route, and docs drift tests prove the previews are deterministic and diagnostics-only |
| R6-HS-42 | Market chart batch preview docs example | done | low | R6-HS-41 | Add a README command example that copies a daily-history or intraday-history batch preview into `MARKET_CHART_TARGETS` after provider replacement | README now shows a batch-oriented command that reads the daily-history preview, replaces the `<provider>` placeholder with a supported provider, runs `bun run market:charts:sync`, and verifies every target in the batch through `/diagnostics/market_charts`; `tests/docs-drift.test.ts` guards the provider replacement and whole-batch verification text |
| R6-HS-43 | Market chart batch preview route cache smoke | done | low | R6-HS-42 | Add a focused route/cache assertion that covers batch previews with both daily and intraday groups through `/diagnostics/market_charts` | `tests/diagnostics-routes.test.ts` now records daily and hourly fallback events, proves `/diagnostics/market_charts` returns daily and intraday batch preview groups in priority order, preserves the conditional `304` cache contract, persists the previews across restart, and keeps the preview field absent from public chart/OHLC responses |
| R6-HS-44 | Market chart batch preview cap metadata | done | low | R6-HS-43 | Add explicit batch preview cap metadata so operators know previews are bounded by the returned suggestion limit | `response_source_target_suggestion_batch_previews` now includes `cap.preview_source`, `cap.suggestions_returned`, and `cap.suggestions_limit` reconciled from returned suggestions and the existing suggestion cap; service, route, and docs drift tests prove cap metadata is deterministic and documented |
| R6-HS-45 | Market chart batch preview empty-state docs | done | low | R6-HS-44 | Document how to interpret empty daily/intraday batch preview groups when fallback pressure is stale, source-backed, or outside the returned suggestion cap | README now warns that empty daily/intraday batch preview groups are not proof that no chart/OHLCV work remains, points operators to `response_source_fallback_alert.status`, stale/source-backed exclusions, and batch preview cap metadata, and `tests/docs-drift.test.ts` guards the empty-state workflow |
| R6-HS-46 | Market chart batch preview empty-state tests | done | low | R6-HS-45 | Add service-level tests for empty daily/intraday batch preview groups across clear, stale-only, source-backed-only, and capped-suggestion states | `tests/chart-response-source-diagnostics.test.ts` now proves empty batch preview groups reconcile with clear alerts, stale-only watch states, source-backed-only suppression, and cap-limited suggestion output where lower-priority intraday work can be omitted from the returned preview |
| R6-HS-47 | Market chart suggestion overflow counters | done | low | R6-HS-46 | Add diagnostics-only overflow counters for eligible targets omitted by the returned suggestion cap, split by daily vs intraday history | `/diagnostics/market_charts` now includes `response_source_target_suggestion_overflow` with eligible target count, returned suggestion count, omitted-by-cap count, and daily/intraday target-history breakdowns; service, route, and docs drift tests prove the counters reconcile with returned suggestions, batch preview groups, and the suggestion cap |
| R6-HS-48 | Market chart suggestion overflow route smoke | done | low | R6-HS-47 | Add route/cache coverage for `response_source_target_suggestion_overflow` with a capped suggestion set crossing daily and intraday history | `tests/diagnostics-routes.test.ts` now drives 20 daily and one lower-priority intraday fallback target through `/diagnostics/market_charts`, proves overflow counters identify the intraday omission, preserves conditional `304` caching, persists the counters across restart, and keeps overflow diagnostics absent from public chart/OHLC responses |
| R6-HS-49 | Market chart suggestion overflow docs workflow | done | low | R6-HS-48 | Add README guidance for using overflow counters to raise the suggestion limit or split daily/intraday remediation batches | README now tells operators to treat capped batch previews as the first page of remediation, use daily/intraday omitted-by-cap counters to choose the next batch focus, re-check diagnostics after syncing, and remember overflow counters never choose providers or write config automatically; `tests/docs-drift.test.ts` guards the workflow |
| R6-HS-50 | Market chart suggestion overflow cap source note | done | low | R6-HS-49 | Add a compact diagnostics note that clarifies overflow is based on eligible unique targets after stale/source-backed filtering, not raw event count | `response_source_target_suggestion_overflow` now includes `basis=eligible_unique_targets_after_stale_and_source_backed_filtering`; README documents the interpretation and tests prove the field remains deterministic through service and route diagnostics |
| R6-HS-51 | Market chart overflow summary consistency smoke | done | low | R6-HS-50 | Add route-level assertions that overflow eligible/returned counts match `response_source_target_suggestion_summary.unique_eligible_targets` and `suggestions_returned` | `tests/diagnostics-routes.test.ts` now proves overflow eligible target count, returned suggestion count, omitted-by-cap count, and suggestion limit reconcile with the suggestion summary before and after restart |
| R6-HS-52 | Market chart overflow group reconciliation | done | low | R6-HS-51 | Add service-level assertions that daily/intraday overflow returned counts reconcile with batch preview target counts | `tests/chart-response-source-diagnostics.test.ts` now proves each overflow target-history `returned_suggestions` count matches the corresponding batch preview group `target_count`, including cap-limited cases where intraday eligible work is omitted |
| R6-HS-53 | Market chart overflow group route reconciliation | done | low | R6-HS-52 | Add route-level assertions that daily/intraday overflow returned counts reconcile with batch preview target counts before and after restart | `tests/diagnostics-routes.test.ts` now proves each overflow target-history `returned_suggestions` count matches the corresponding batch preview group `target_count` through the HTTP diagnostics route and after app restart |
| R6-HS-54 | Market chart overflow docs command example | done | low | R6-HS-53 | Add a README command that extracts overflow daily/intraday omitted counts for operator triage | README now includes a `jq` command that reads `response_source_target_suggestion_overflow.target_history_counts` and prints daily/intraday omitted-by-cap counts; `tests/docs-drift.test.ts` guards the command |
| R6-HS-55 | Market chart fallback diagnostics consolidation review | done | low | R6-HS-54 | Review the accumulated OHLCV fallback diagnostics fields for redundant wording, unstable naming, or missing operator invariants before the next functional slice | Consolidation review found the diagnostics field names consistently use the `response_source_target_suggestion_*` namespace, public chart/OHLC response-shape invariants are covered in route tests, restart/cache invariants are covered for the mutable diagnostics fields, and overflow/batch/summary reconciliation is now covered; follow-ups should avoid more field proliferation unless a missing operator invariant is found, compress README wording later, and pivot back to source-backed chart coverage work |
| R6-HS-56 | Market chart diagnostics workflow page | done | low | R6-HS-55 | Extract the chart/OHLC fallback remediation workflow into a focused reference page while keeping a README pointer | Added `docs/reference/market-chart-diagnostics-workflow.md` with alert interpretation, batch planning, overflow triage, provider replacement, sync, and verification steps; README now points to the page and docs drift tests guard the new reference |
| R6-HS-57 | Market chart README compression | done | low | R6-HS-56 | Replace the long README market chart diagnostics prose with a compact summary now that the detailed workflow has a reference page | README now keeps the representative diagnostics payload, sync command, provider preset link, and concise public-shape/freshness warning while delegating detailed alert, batch, overflow, sync, and verification workflow steps to `docs/reference/market-chart-diagnostics-workflow.md`; docs drift guards now split README payload coverage from reference workflow invariants |
| R6-HS-58 | Market chart seeded intraday target expansion | done | medium | R6-HS-57 | Expand documented source-backed chart/OHLC target batches from high-priority intraday assets to every seeded chart coin | `docs/reference/market-chart-targets.json` now includes both daily and 1m `MARKET_CHART_TARGETS` for every seeded chart coin, provider presets include broader Binance daily and intraday archive target batches, README describes the starter set as bounded daily+intraday seeded coverage, and `tests/market-chart-targets.test.ts` proves both daily and intraday manifest targets align with seeded chart coins |
| R6-HS-59 | Market chart provider replay breadth | done | medium | R6-HS-58 | Add offline adapter fixtures for more seeded daily/intraday target examples so broader target batches have concrete parser and sync proof | Added fixture-backed Solana daily and 1m market chart adapter examples alongside the existing Bitcoin daily and Ethereum 1m examples; provider presets now point at all four fixtures, `tests/market-chart-sync.test.ts` syncs every documented fixture-backed preset example through the HTTP adapter contract into live source rows offline, and docs drift guards keep the fixture references present |
| R6-HS-60 | Market chart partial sync resilience | done | medium | R6-HS-59 | Keep broader market chart sync batches useful when one provider target fails instead of aborting the whole batch | `syncMarketCharts` now records per-target `failed` results with error text, continues syncing later targets, returns `targets_failed`, and still throws when every attempted target fails so standalone job failure semantics remain intact; `tests/market-chart-sync.test.ts` proves a failed Bitcoin target does not block Solana source-row writes and all-failed batches still reject |
| R6-HS-61 | Market chart partial failure job diagnostics | done | medium | R6-HS-60 | Surface partial market chart sync failures in optional job diagnostics so broad-batch runs do not look like clean success | Optional provider job success state now carries `last_partial_failure_reason` and summary `partial_failure` counts while preserving `failed` for all-failed runs; standalone market chart sync and scheduler runs persist partial-failure reasons when some targets fail and later targets write rows; README documents partial-failure job diagnostics and tests prove in-memory, persisted standalone, and persisted scheduler diagnostics |
| R6-HS-62 | Market chart retry-vs-backfill workflow | done | low | R6-HS-61 | Document how operators should choose between retrying failed provider targets, refreshing stale chart rows, deepening shallow rows, or adding new targets | `docs/reference/market-chart-diagnostics-workflow.md` now starts remediation with `/diagnostics/jobs` partial-failure checks, then maps `configured_without_source_rows`, `stale_source_targets`, `shallow_source_targets`, and action-needed fallback suggestions to retry, fresh sync, deeper backfill, or target expansion actions; docs drift tests guard the workflow so partial provider errors are not conflated with stale or shallow source coverage |
| R6-HS-63 | Market chart partial failure target samples | done | medium | R6-HS-62 | Preserve bounded per-target failure samples from market chart sync runs so operators can identify which targets failed without reading logs | Optional job success state now persists partial-failure samples in a typed JSON envelope stored in the existing failure-reason column, `/diagnostics/jobs` exposes `last_partial_failure_samples` alongside the human reason, standalone and scheduler tests prove samples survive restart, and README/workflow docs tell operators to inspect samples before treating stale or shallow market-chart gaps as target-expansion work |
| R6-HS-64 | Market chart partial failure redaction | done | medium | R6-HS-63 | Redact secrets from persisted partial-failure reasons and samples before they appear in `/diagnostics/jobs` | Partial-failure serialization now redacts URL credentials, query strings, and token-like key/value fragments before persistence and diagnostics rendering; tests prove API keys, passwords, and token values are absent from partial-failure job payloads while still preserving provider/coin/interval failure context |
| R6-HS-65 | Market chart retry target template | done | medium | R6-HS-64 | Let operators turn failed market chart target samples into a retry-only `MARKET_CHART_TARGETS` batch without reprocessing successful broad-batch targets | `/diagnostics/jobs` now derives `last_partial_failure_retry_targets_template` from bounded partial-failure samples that include provider, coin, currency, and interval; standalone and scheduler tests prove the template persists through restart, and README/workflow docs explain using it as a retry-only chart sync batch |
| R6-HS-66 | Market chart retry template cache smoke | done | low | R6-HS-65 | Add route/cache coverage for partial-failure retry target templates in `/diagnostics/jobs` | `tests/http-cache.test.ts` now records an in-process market chart partial success, proves `/diagnostics/jobs` exposes `last_partial_failure_retry_targets_template` and `summary.partial_failure`, and keeps the route covered by the existing cache header and conditional `304` assertion |
| R6-HS-67 | Market chart retry-only docs command | done | low | R6-HS-66 | Add a copy-paste command that exports `MARKET_CHART_TARGETS` from `last_partial_failure_retry_targets_template` and reruns only failed targets | `docs/reference/market-chart-diagnostics-workflow.md` now shows a `MARKET_CHART_RETRY_TARGETS` command sourced from `/diagnostics/jobs`, runs `bun run market:charts:sync` only when the retry template is present, and warns that successful source rows should not be reprocessed unnecessarily; docs drift tests guard the command |
| R6-HS-68 | Market chart retry template empty-state docs | done | low | R6-HS-67 | Clarify what operators should do when partial-failure samples exist but no retry template can be derived | The workflow now explains that an empty retry template with partial-failure samples means the samples lack enough provider/coin/currency/interval context for a safe `MARKET_CHART_TARGETS` batch, tells operators to inspect samples or provider logs before retrying a broad batch, and keeps no-partial-failure cases pointed at stale/shallow and fallback-suggestion diagnostics |
| R6-HS-69 | Market chart freshness SLO review | done | low | R6-HS-68 | Review whether current fresh/stale thresholds for daily and 1m market chart rows are explicit enough for CoinGecko-level freshness claims | The workflow now states that market-chart freshness is source-sync recency, not full public chart parity, and locks the current SLOs: daily targets need `freshness_threshold_seconds=129600` plus 30 days depth, while 1m targets need `freshness_threshold_seconds=1800` plus one day depth; docs drift tests guard the thresholds and the stale-vs-shallow operator actions |
| R6-HS-70 | Market chart freshness threshold route guard | done | low | R6-HS-69 | Add a focused route-level assertion that daily and 1m market chart freshness/depth thresholds remain exposed through `/diagnostics/market_charts` | `tests/diagnostics-routes.test.ts` now configures daily and 1m market chart targets and proves the HTTP diagnostics payload exposes the documented 36-hour/30-day daily SLO and 30-minute/one-day intraday SLO |
| R6-HS-71 | Market chart production freshness diagnostics | done | medium | R6-HS-70 | Record the SLO tightening decision without breaking first-run freshness semantics | `/diagnostics/market_charts` keeps the existing 36-hour daily and 30-minute intraday `coverage.freshness` thresholds as first-run minimum SLOs, and adds diagnostics-only `coverage.production_freshness_threshold_seconds` targets of two hours for daily rows and five minutes for 1m rows so operators can distinguish minimum source-sync freshness from production CoinGecko-style freshness; route and docs drift tests guard the distinction |
| R6-HS-72 | Market chart production freshness alerting | done | medium | R6-HS-71 | Make targets that pass first-run freshness but miss production freshness visible at summary and gap-list level | `/diagnostics/market_charts` now includes `summary.production_freshness_counts` and `gaps.production_stale_source_targets`, so operators can identify source-backed chart/OHLC targets that are first-run fresh but not production-fresh without changing public chart/OHLC payloads; route and docs drift tests guard the new rollout view and operator workflow |
| R6-HS-73 | Market chart backfill verification breadth | done | medium | R6-HS-72 | Verify documented fixture-backed daily and 1m preset examples through public chart and OHLC routes, not only source-row ingestion | `tests/market-chart-sync.test.ts` now syncs every fixture-backed market chart provider preset example through the offline HTTP adapter contract and then asserts the public `/coins/:id/market_chart/range` and `/coins/:id/ohlc/range` responses read the source-backed candle values while preserving CoinGecko-compatible response shapes |
| R6-HS-74 | Market chart production freshness remediation | done | medium | R6-HS-73 | Connect production-stale market chart targets to scheduler cadence and provider-latency actions | `/diagnostics/jobs` now exposes `production_freshness_cadence` for the `market_charts` job, comparing configured daily/1m targets against `OPTIONAL_PROVIDER_SYNC_ENABLED` and `OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS`; the advisory distinguishes no targets, disabled scheduler, intervals slower than production freshness, and cadence-within-threshold cases, while docs explain when to run manual sync, tighten cadence, or investigate provider latency |
| R6-HS-75 | Market chart production freshness route smoke | done | low | R6-HS-74 | Add HTTP route/cache assertions for the market chart production freshness cadence advisory | `tests/http-cache.test.ts` now drives configured daily and 1m market chart targets through `/diagnostics/jobs`, proves `production_freshness_cadence` is returned under the existing safe diagnostics cache/304 contract, and asserts public market chart/OHLC responses do not expose the advisory |

### R6-HS Consolidation Notes

The OHLCV fallback diagnostics now have clear layers: durable counters, recent fallback evidence, rollups, suggestion window/summary, alert status, exclusions, ranked suggestions, operator summary, batch previews, and overflow counters. The naming is verbose but stable and intentionally diagnostics-only. Do not rename these fields in the near term; route and docs drift tests now depend on them, and public CoinGecko-compatible chart/OHLC payloads must remain unchanged.

Covered invariants:
- Public `/coins/:id/market_chart*` and `/coins/:id/ohlc*` responses do not expose fallback alert, overflow, or batch preview fields.
- Suggestions are capped, deterministic, source-backed suppressed, and ranked by unresolved pressure before stable tie-breakers.
- Batch preview counts reconcile with returned suggestions, and overflow counts reconcile with summary counts and batch preview group counts before and after restart.
- Empty preview groups are documented as ambiguous until alert status, exclusions, and overflow cap counters are inspected.

Known follow-ups:
- Move from OHLCV fallback observability to actual source-backed coverage expansion: broader documented target batches, provider preset replay breadth, sync/backfill reliability, and production freshness remediation.
- Avoid adding more OHLCV diagnostics fields unless they protect a concrete invariant not already covered by summary, overflow, or batch previews.

## Next PR Queue

Keep upcoming work small enough that each PR can be reviewed by behavior, not by intention.

The near-term implementation direction is now captured in `docs/plans/2026-05-14-opengecko-coverage-history-plan.md`. Prioritize data source coverage and historical depth work before adding unrelated endpoint surface.

| Order | PR | Includes | Excludes | Exit check |
| --- | --- | --- | --- | --- |
| 1 | Coverage target manifest service | Add a reusable target manifest/parser for market chart and OHLCV coverage targets, with tier, freshness, production freshness, and depth metadata | Runtime scheduler rewrites, live provider calls in tests, automatic target writes | `tests/coverage-targets.test.ts` proves parse/validation/deduplication and existing market chart targets are derivable |
| 2 | History backfill planner | Add a deterministic planner that turns missing, stale, production-stale, shallow, and gap-repair states into ordered sync/backfill tasks | Changing public CoinGecko-compatible response payloads or adding more diagnostics-only fields without planner use | Planner tests prove task reasons, chunk bounds, and tier/priority ordering |
| 3 | Market chart sync consumes planner tasks | Let market chart source sync execute planner output while preserving existing `MARKET_CHART_TARGETS` behavior and partial-failure semantics | Broad onchain/supply/treasury scope, mandatory external services, or response-shape changes | Provider fixture tests prove planner tasks write source rows and public chart/OHLC routes read them |
| 4 | OHLCV worker uses coverage priority | Feed target tier/depth priority into OHLCV target generation/leasing while preserving top-100-first and retry-due behavior | Replacing SQLite or removing existing worker diagnostics | OHLCV tests prove high-tier incomplete depth and retry-due targets lease before low-urgency targets |
| 5 | Coverage matrix promotion hardening | Tighten family promotion rules so source-backed rows improve `coverage_matrix` without fixture/live overclaims | Claiming `live` from seeded/fixture rows or changing default public payloads | Diagnostics/docs-drift tests prove promotion/demotion and tracker wording stay honest |

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
