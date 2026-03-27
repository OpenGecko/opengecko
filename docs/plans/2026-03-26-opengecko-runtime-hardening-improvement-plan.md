# OpenGecko Improvement Plan

## Executive Summary

OpenGecko already has a solid modular foundation and a clear product direction around CoinGecko compatibility. The main gap is no longer basic architecture, but production-grade runtime behavior: low-latency responses, graceful degradation under upstream instability, and operational predictability under load.

To move the product closer to a “feels like CoinGecko” experience, the highest-value work is:

1. Add an HTTP response caching layer for hot endpoints
2. Optimize database access with targeted indexes and query review
3. Reuse CCXT exchange instances and enforce concurrency limits
4. Introduce circuit breakers and broader health/degradation reporting

These four items should be treated as the first delivery wave because they directly improve response time, resilience, and system stability without requiring major architectural rewrites.

---

# 1. Goals

## Primary Goal

Make OpenGecko feel fast, stable, and dependable for common CoinGecko-style read traffic.

## Secondary Goals

- Reduce repeated computation for hot endpoints
- Prevent SQLite from becoming the main bottleneck under load
- Avoid cascading failures when upstream exchanges degrade
- Improve observability for latency, error rate, and runtime health
- Introduce clear degradation modes rather than full service failure
- Preserve API compatibility and existing modular architecture

---

# 2. Current State Assessment

## What is already good

- The project appears modular and directionally sound
- The API compatibility focus is clear
- Structured logging already exists
- There is already some diagnostics coverage
- Existing tests suggest a healthy baseline for regression safety

## Main runtime gaps

Based on the analysis, the most important missing capabilities are:

- No HTTP response cache
- Potentially under-indexed SQLite access paths
- New CCXT instances created too frequently
- No circuit breaker protection around upstream failures
- No response compression
- No explicit request timeout/cancellation policy
- Limited metrics and latency visibility
- No clear degraded-mode serving strategy
- No startup prewarming for hottest data
- Some oversized modules reducing maintainability

---

# 3. Guiding Principles for Implementation

## Compatibility first

All changes should preserve CoinGecko-compatible paths, query semantics, and response formats.

## Performance without correctness drift

Caching and degradation must never silently return malformed or contract-incompatible payloads.

## Prefer incremental hardening

Introduce production behavior in small, testable slices rather than broad rewrites.

## Fail soft, not hard

If live data becomes temporarily unavailable, serve the freshest safe fallback available whenever possible.

## Keep dependencies minimal

Prefer built-in patterns and lightweight local implementations before adding external packages unless the operational payoff is clear.

---

# 4. Detailed Plan by Improvement Area

## 4.1 HTTP Response Caching Layer

### Problem

There is currently no response caching layer. Every request reaches the database and/or recomputes response data, which is especially expensive for high-frequency endpoints such as:

- `/simple/price`
- `/coins/markets`
- potentially selected coin detail and listing endpoints

This creates unnecessary repeated work, increases median latency, and makes the database the default bottleneck.

### Why this matters

CoinGecko-like traffic patterns are heavily skewed toward repeated reads of the same hot market data. Without caching, the system pays the full cost for every request even when the underlying data only changes on a short interval.

### Proposed solution

Implement an in-memory response cache for hot GET endpoints, keyed by normalized request identity.

### Scope

Phase 1 target endpoints:

- `/simple/price`
- `/coins/markets`
- `/search/trending` if present
- any top-traffic read-only endpoints with stable short-lived responses

### Design

#### Cache key strategy

Cache key should include:

- route path
- normalized query parameters
- localization/currency parameters if relevant
- any flags that alter the shape of the response

Example key model:

```ts
type CacheKeyParts = {
  route: string;
  query: Record<string, string | string[] | undefined>;
};
```

Normalize query ordering to avoid duplicate cache entries for semantically identical requests.

#### Cache value model

```ts
type CachedResponse = {
  body: unknown;
  statusCode: number;
  headers?: Record<string, string>;
  expiresAt: number;
  staleUntil?: number;
  createdAt: number;
};
```

#### TTL policy

Use endpoint-specific TTLs rather than one global TTL.

Suggested starting TTLs:

- `/simple/price`: 15–30 seconds
- `/coins/markets`: 30–60 seconds
- lower-priority listing endpoints: 60 seconds

#### Stale-while-revalidate behavior

Recommended for hot endpoints:

- If cache is fresh: serve immediately
- If cache is stale but within `staleUntil`: serve stale response and trigger async refresh
- If no cache exists: compute synchronously

This will significantly improve tail latency during brief refresh spikes.

#### Invalidation model

Because market data is naturally time-based, use TTL-first invalidation instead of event-driven invalidation initially. Keep it simple.

### Implementation options

#### Option A: Custom in-process cache
Best first step.

Pros:
- minimal dependency cost
- fully tailored keying and TTL behavior
- easy to add stale serving and metrics

Cons:
- memory-only
- no cross-process sharing if horizontally scaled later

#### Option B: Fastify cache plugin
Useful if plugin behavior fits exact requirements.

Pros:
- framework integration
- less boilerplate

Cons:
- may be less flexible for stale serving, metrics, and endpoint-specific semantics

### Recommendation

Start with a small custom in-memory cache in the application/service layer, not a generic plugin wrapper.

### Deliverables

- cache utility with TTL and stale support
- route integration for hot endpoints
- cache hit/miss/stale metrics
- tests for key normalization, TTL expiry, and stale serving

### Risks

- Incorrect cache key normalization could return wrong responses
- Overcaching can make freshness feel worse
- Memory growth if cache cardinality is not bounded

### Mitigations

- enforce max entry count or simple LRU eviction
- only cache known hot endpoints
- define strict key normalization tests

---

## 4.2 Database Query Optimization and Indexing

### Problem

SQLite performance will degrade if hot queries scan unnecessarily large portions of tables. The analysis suggests likely missing indexes on common query paths such as:

- coin symbol lookup
- market cap rank sorting/filtering
- OHLCV time range access
- snapshot recency lookups

### Why this matters

Even with caching, cache misses and refresh jobs still rely on the database. Bad index coverage increases response times and slows startup/refresh work.

### Proposed solution

Audit real query patterns and add targeted indexes through schema or migrations.

### Candidate indexes

```sql
CREATE INDEX idx_coins_symbol ON coins(symbol);
CREATE INDEX idx_coins_market_cap_rank ON coins(market_cap_rank);
CREATE INDEX idx_ohlcv_candles_coin_id_timestamp ON ohlcv_candles(coin_id, timestamp);
CREATE INDEX idx_market_snapshots_updated_at ON market_snapshots(updated_at);
```

### Additional likely candidates

Depending on actual query patterns:

- composite index on `(vs_currency, updated_at)` if snapshots are segmented by currency
- index on `coins(id, market_cap_rank)` if rank-sorted filtering is common
- index on slug/name fields if search is database-backed

### Execution plan

#### Step 1: Query inventory
Review the main repository queries used by:

- `/simple/price`
- `/coins/markets`
- coin detail endpoints
- OHLCV endpoints
- startup snapshot loading
- periodic refresh workers

#### Step 2: Map filters and sort order
For each query, identify:

- WHERE predicates
- ORDER BY fields
- LIMIT usage
- join columns

#### Step 3: Add only justified indexes
Avoid over-indexing because SQLite write cost and DB size both increase.

#### Step 4: Validate with explain plans
Use SQLite query planning to confirm the new indexes are actually used.

### Deliverables

- query-path audit
- migration(s) adding indexes
- before/after timing checks on representative queries
- regression tests if schema snapshots are tracked

### Risks

- Adding too many indexes can slow writes and refresh pipelines
- Wrong composite index order reduces benefit

### Mitigations

- prioritize only the endpoints with highest request volume
- validate with explain/query timing, not assumptions alone

---

## 4.3 CCXT Instance Reuse and Concurrency Control

### Problem

The current CCXT provider behavior appears to create fresh exchange instances too often and uses broad `Promise.allSettled` patterns without concurrency limits.

### Why this matters

This can lead to:

- higher connection/setup overhead
- redundant metadata loading
- avoidable memory churn
- upstream rate limit pressure
- load spikes when multiple exchanges are queried simultaneously

### Proposed solution

Introduce exchange instance reuse plus bounded concurrency.

### Design

#### Exchange instance reuse

Maintain a singleton-style registry keyed by exchange id:

```ts
const exchangePool = new Map<string, Exchange>();
```

Behavior:

- create once per exchange id
- reuse for repeated operations
- close/reset only on shutdown or fatal invalidation conditions

#### Concurrency limiting

Introduce a small concurrency limiter for upstream exchange requests.

Suggested starting values:

- global exchange request concurrency: 3–5
- per-exchange concurrency: 1–2 if needed

This is especially important for bulk ticker refresh flows.

#### Metadata reuse

If markets or exchange metadata are loaded repeatedly, cache them on the exchange instance or in a side registry with TTL.

### Deliverables

- pooled exchange accessor
- bounded concurrency wrapper around refresh jobs
- tests for instance reuse behavior
- tests or diagnostics for concurrency-limited execution

### Risks

- stale exchange state if a reused instance enters a bad internal state
- too-low concurrency may slow refresh throughput

### Mitigations

- allow instance reset on repeated failures
- make concurrency configurable
- log pool creation/reuse/reset events

---

## 4.4 Circuit Breakers and Health Checks

### Problem

Repeated upstream failures currently appear to keep triggering further calls. Without a circuit breaker, transient provider failures can become persistent system pressure and cause cascading degradation.

### Why this matters

A CoinGecko-like API must remain responsive even when some exchanges are unhealthy. Continuing to hammer failing upstreams increases latency and wastes resources.

### Proposed solution

Add per-provider or per-exchange circuit breakers with structured health reporting.

### Design

#### Circuit state

```ts
type CircuitState = {
  failures: number;
  lastFailureAt: number | null;
  state: 'closed' | 'open' | 'half_open';
  openedAt: number | null;
};
```

#### Transition rules

- `closed` -> `open` after N consecutive failures
- `open` -> reject fast without upstream call
- after cooldown, move to `half_open`
- if probe succeeds, return to `closed`
- if probe fails, reopen

Suggested defaults:

- failure threshold: 3–5 consecutive failures
- open duration: 30–60 seconds
- half-open probes: 1 request at a time

#### Coverage

Apply to:

- CCXT exchange fetches
- any other network-bound provider integration

### Health endpoints

Expand diagnostics/health visibility into at least:

- overall app readiness
- provider health summary
- degraded-mode status
- cache freshness summary
- last successful refresh times

Potential endpoints:

- `/health`
- `/health/ready`
- `/health/degraded`
- existing diagnostics endpoint expansion

### Deliverables

- circuit breaker utility
- provider integration points
- health response schema
- tests for open/half-open/close transitions

### Risks

- overly aggressive thresholds can suppress recovery
- inconsistent health semantics can confuse operators

### Mitigations

- start conservative
- expose breaker state via diagnostics
- make thresholds configurable

---

## 4.5 API Response Compression

### Problem

Fastify does not automatically guarantee optimal compression behavior for larger JSON responses.

### Why this matters

Endpoints like `/coins/markets` can return large JSON payloads. Compression lowers bandwidth cost and improves perceived response speed, especially over slower networks.

### Proposed solution

Add response compression for sufficiently large payloads.

### Recommended policy

- enable compression globally
- apply threshold around 1 KB
- prefer gzip/br where supported by runtime/client

### Deliverables

- compression plugin registration
- compatibility verification with existing headers/tests
- benchmark on large payload endpoints

### Risks

- very small responses may pay unnecessary CPU cost
- header behavior may affect tests

### Mitigations

- threshold-based compression
- add response header tests where needed

---

## 4.6 Request Timeout and Cancellation Strategy

### Problem

Long-running requests can tie up resources and produce poor client experience if not bounded.

### Why this matters

Even read-heavy APIs need a clear timeout contract. Without it, bad provider latency or slow DB access can create queueing and worsen the entire service.

### Proposed solution

Define explicit timeout rules at request and upstream-call levels.

### Design

#### Request timeout
Set a server-side maximum request duration, for example:

- default request timeout: 10–30 seconds
- shorter budget for hot endpoints if feasible

#### Upstream timeout
Each provider call should have its own shorter timeout budget than the overall request.

#### Cancellation propagation
Where supported, propagate cancellation or abort signals to upstream operations.

### Deliverables

- timeout configuration
- abort/cancellation wiring for provider fetches where possible
- timeout error mapping tests

### Risks

- aggressive timeouts can create false failures
- poor interaction with stale-serving logic

### Mitigations

- set endpoint-class-specific budgets
- combine timeouts with cache fallback behavior

---

## 4.7 Observability and Metrics

### Problem

Structured logs exist, but there is not enough metrics coverage for production operations such as latency percentiles, cache hit rate, or degraded-mode visibility.

### Why this matters

Without metrics, it is hard to know whether improvements are working or which subsystem is responsible for regressions.

### Proposed solution

Introduce lightweight metrics instrumentation with endpoint and subsystem coverage.

### Minimum metrics set

#### HTTP metrics

- request count by route/method/status
- request duration histogram
- error count
- in-flight requests

#### Cache metrics

- cache hit count
- cache miss count
- stale-hit count
- refresh count
- cache entry count
- eviction count

#### Provider metrics

- provider request count
- provider error count
- provider latency histogram
- circuit breaker opens
- exchange pool reuse/reset counters

#### Data freshness metrics

- last snapshot refresh timestamp
- snapshot age
- OHLCV sync lag

### Output options

#### Option A: Prometheus-compatible metrics endpoint
Best if production monitoring stack is expected.

#### Option B: Internal diagnostics JSON only
Faster initial implementation, less ecosystem-friendly

### Recommendation

Start with a small internal metrics abstraction and expose either:

- `/metrics` in Prometheus format, or
- diagnostics JSON now, Prometheus later

### Deliverables

- metrics collector abstraction
- route/provider/cache instrumentation
- docs not required unless requested, but endpoint behavior should be self-evident in code/tests

---

## 4.8 Graceful Degradation Strategy

### Problem

If live upstream data becomes unavailable, the API may become partially or fully unusable instead of falling back to older but still useful data.

### Why this matters

Users generally prefer slightly stale data over hard failures for market overview endpoints.

### Proposed solution

Introduce an explicit degradation policy.

### Degradation levels

#### Normal mode
Fresh live or recent database-backed data available.

#### Stale-serve mode
Live refresh unhealthy, but recent cached/database snapshots available.

#### Read-only degraded mode
No upstream refresh available; serve historical or last-known-good market data with freshness metadata where possible.

#### Hard-fail mode
Only when no safe compatible response can be produced.

### Endpoint policy examples

- `/simple/price`: serve stale cached result if within stale window
- `/coins/markets`: serve latest persisted market snapshot even if refresh is delayed
- OHLCV endpoints: serve persisted historical data even if latest sync is behind

### Health signaling

Expose degradation clearly via health endpoints and logs. Avoid changing main response format unless compatibility allows it.

### Deliverables

- degradation state evaluator
- fallback selection logic
- health endpoint visibility
- tests for fallback scenarios

### Risks

- stale data may be misunderstood as current
- adding extra metadata to main responses may hurt compatibility

### Mitigations

- prefer health/diagnostic visibility over payload changes
- only add headers if compatible and useful

---

## 4.9 Data Prewarming

### Problem

Even with caching, cold starts can produce a slow first-user experience.

### Why this matters

A “feels fast” API should already have top-requested data available when traffic begins.

### Proposed solution

Warm the most-requested cache entries and market datasets at startup.

### Prewarm targets

- top-ranked coins
- major quote currencies
- most common `/simple/price` combinations
- first page(s) of `/coins/markets`

### Constraints

Prewarming should not block the app from becoming available for too long. It should be bounded and observable.

### Deliverables

- startup prewarm task
- timeout/budget guard
- startup progress metrics/logging

---

## 4.10 Maintainability Refactors

### Problem

Some modules are becoming too large, notably:

- `src/modules/coins.ts`
- `src/services/market-refresh.ts`

### Why this matters

Large files slow safe iteration, increase review difficulty, and make compatibility work riskier.

### Proposed solution

Refactor after the P0/P1 runtime hardening work, not before.

### Refactor direction

For `coins.ts`, split into:

- query parsing/normalization
- response shaping
- route handlers
- shared market/coin helpers

For `market-refresh.ts`, split into:

- scheduling/orchestration
- provider fetch layer
- normalization/merging
- persistence
- error handling/backoff logic

### Deliverables

- file decomposition without behavior change
- characterization tests to freeze behavior during refactor

---

# 5. Recommended Delivery Phases

## Phase 0: Baseline Measurement
Before major changes, capture current metrics.

### Tasks
- measure latency for hot endpoints
- identify hottest database queries
- document current refresh/provider failure behavior
- inspect current test and diagnostics coverage

### Outcome
A baseline for proving the impact of later work.

---

## Phase 1: Highest-Impact Runtime Hardening
This should be the first implementation wave.

### Included
1. HTTP response caching for hot endpoints
2. Database indexes for critical query paths
3. CCXT instance reuse
4. Concurrency limiting
5. Circuit breakers for upstream providers

### Expected impact
- lower median and p95 latency
- lower database load
- lower upstream pressure
- fewer cascading failures

### Estimated effort
About 4–6 engineering days depending on test coverage and query complexity.

---

## Phase 2: Transport and Operational Hardening

### Included
1. response compression
2. request/upstream timeouts
3. expanded health endpoints
4. first metrics implementation

### Expected impact
- lower bandwidth
- clearer operational visibility
- more predictable failure behavior

### Estimated effort
2–3 engineering days

---

## Phase 3: Availability and Warm-Start Improvements

### Included
1. graceful degradation policies
2. stale serving improvements
3. startup prewarming

### Expected impact
- better resilience during provider incidents
- better cold-start user experience

### Estimated effort
2–4 engineering days

---

## Phase 4: Maintainability Refactor

### Included
1. split oversized modules
2. extract shared helpers
3. strengthen characterization tests

### Expected impact
- faster future iteration
- lower regression risk for parity work

### Estimated effort
2–3 engineering days

---

# 6. Priority Matrix

## P0 — Do First

### 1. HTTP response caching
Impact: Very high  
Effort: Medium  
Reason: Biggest direct latency win for hot read endpoints

### 2. Database indexes
Impact: High  
Effort: Low to medium  
Reason: Supports both cache misses and background jobs

### 3. CCXT instance reuse + concurrency limits
Impact: High  
Effort: Medium  
Reason: Reduces upstream overhead and rate-limit risk

### 4. Circuit breakers
Impact: High  
Effort: Medium  
Reason: Essential for resilience under provider instability

---

## P1 — Do Next

### 5. Response compression
Impact: Medium  
Effort: Low

### 6. Request timeout/cancellation
Impact: Medium  
Effort: Medium

### 7. Health checks + metrics
Impact: Medium to high  
Effort: Medium

---

## P2 — After runtime hardening

### 8. Graceful degradation strategy
Impact: High  
Effort: Medium

### 9. Data prewarming
Impact: Medium  
Effort: Low to medium

---

## P3 — Structural cleanup

### 10. Module refactors
Impact: Medium  
Effort: Medium to high

---

# 7. Suggested Technical Architecture Additions

## New or expanded components

### Cache layer
A small service such as:

- `src/services/response-cache.ts`

Responsibilities:
- key normalization
- TTL evaluation
- stale serving
- bounded entry count
- cache metrics hooks

### Provider resilience layer
Possible file:

- `src/services/provider-resilience.ts`

Responsibilities:
- circuit breaker state
- retry/backoff policy if added later
- provider health summary

### Metrics layer
Possible file:

- `src/services/metrics.ts`

Responsibilities:
- counters/histograms abstraction
- route/provider/cache instrumentation

### Exchange pool
Likely in or near:

- `src/providers/ccxt.ts`

Responsibilities:
- exchange singleton registry
- reset/invalidate hooks
- shared metadata reuse

---

# 8. Testing Strategy

## Unit tests

Add focused tests for:

- cache key normalization
- cache TTL and stale behavior
- circuit breaker transitions
- exchange pooling/reuse
- timeout handling
- degraded-mode decision rules

## Integration tests

Add route-level tests for:

- cached endpoint returns identical compatible payload
- stale response served during refresh failure
- compressed responses on large payloads
- health endpoints reflect provider failure states

## Performance/regression checks

For a small representative dataset:

- compare hot endpoint latency before/after cache
- compare query cost before/after indexes
- validate no compatibility drift in response shape

---

# 9. Rollout Strategy

## Step 1: Introduce behind configuration flags where useful

Feature flags/config for:

- response cache enablement
- stale serving
- circuit breakers
- compression
- prewarming

## Step 2: Start with one or two hot endpoints

Best initial target:

- `/simple/price`
- `/coins/markets`

## Step 3: Observe before expanding

Check:

- cache hit rate
- p95 latency
- stale serve frequency
- provider failure/open-breaker counts

## Step 4: Expand to more endpoints only after proven stable

---

# 10. Success Metrics

The plan is successful if it produces measurable improvements in:

## User-facing

- lower median and p95 latency on hot endpoints
- fewer 5xx responses during upstream instability
- faster cold-start response for top endpoints

## System-facing

- fewer duplicate DB reads
- lower provider call volume for repeated requests
- reduced upstream timeout/failure amplification
- clearer diagnostics during incidents

## Operational

- visibility into cache hit rate
- visibility into provider health
- visibility into request latency distribution
- visible degraded mode instead of silent instability

---

# 11. Recommended First Sprint

## Sprint objective

Deliver the highest-impact runtime improvements without broad refactors.

## Sprint scope

1. Implement in-memory response caching for `/simple/price` and `/coins/markets`
2. Add the first set of validated DB indexes
3. Rework CCXT access to reuse exchange instances
4. Add concurrency limits for provider refreshes
5. Introduce basic per-exchange circuit breakers
6. Add tests for all of the above

## Expected result

At the end of this sprint, OpenGecko should already feel noticeably faster and more stable under repeated read traffic and partial upstream failures.

---

# 12. Final Recommendation

If the goal is to make OpenGecko feel close to CoinGecko in responsiveness and stability, the most important change is not a broad refactor but runtime hardening.

The best implementation order is:

1. Response cache
2. Database indexes
3. CCXT pooling and concurrency control
4. Circuit breakers
5. Compression, timeout, and metrics
6. Graceful degradation and prewarming
7. Structural refactors

This sequence maximizes user-visible impact early while keeping risk controlled.
