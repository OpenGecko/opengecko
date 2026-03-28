# OpenGecko Comprehensive PRD: CoinGecko-Compatible Open-Source API Platform

## 1. Document Purpose

This document is the canonical product requirements document for OpenGecko.

It defines:

- what OpenGecko is
- who it is for
- what “CoinGecko-compatible” means in practice
- what will and will not be built
- how implementation should be phased
- what architecture and operational capabilities are required to make the product viable
- how success will be measured

This document is intentionally implementation-oriented. It is not a marketing brief. It is the source of truth for product scope, engineering priorities, compatibility policy, and release sequencing.

Important clarification: OpenGecko should be treated as a CoinGecko-compatible reimplementation, not a literal source-code fork of CoinGecko. The goal is API and behavior compatibility where legally and technically appropriate, without copying proprietary code, private datasets, or protected documentation text.

## 2. Executive Summary

OpenGecko is an open-source, self-hostable, CoinGecko-compatible API platform for crypto market data, metadata, historical charts, exchange data, treasury data, and onchain DEX data.

The core product promise is simple:

- existing CoinGecko integrations should be able to migrate with minimal code changes
- supported market endpoints should return fresh-by-default price data from OpenGecko's internal snapshot layer
- operators should be able to self-host the platform and control their own providers
- contributors should be able to extend the system without rewriting the public API contract

The key insight is that the hard part is not routing or JSON shaping. The hard part is the data platform underneath:

- canonical entity modeling
- provider reconciliation
- continuous market ingestion and hot snapshot serving
- historical retention and chart generation
- ranking and search behavior
- freshness management
- curation and override workflows
- testing for semantic compatibility, not just schema compatibility

OpenGecko therefore must be built as two products at once:

1. a compatibility layer that mirrors CoinGecko-style HTTP contracts
2. a modular crypto data platform that can supply those contracts reliably

The recommended strategy is:

- deliver compatibility by endpoint family in phases
- prioritize migration value over endpoint-count vanity
- separate compatibility grading from data-fidelity grading
- use provider-agnostic adapters from day one
- treat search, rankings, mappings, and historical retention as first-class systems
- ship an OSS reference implementation that is self-hostable and extensible

## 3. Product Vision

OpenGecko should become the default open-source API surface for teams that want CoinGecko-style integrations without vendor lock-in.

Long-term, OpenGecko should be able to serve three modes of use:

1. **Drop-in compatibility layer** for applications that already speak the CoinGecko API shape.
2. **Self-hosted crypto data platform** for teams that want control over providers, regional deployment, compliance boundaries, and cost.
3. **Extensible open ecosystem** where contributors can add providers, chains, exchanges, scoring logic, and tooling without breaking the external contract.

The strongest version of OpenGecko is not “a cheap clone.” It is a trustworthy compatibility-first open data platform with a stable external contract and modular internals.

## 4. Background and Opportunity

CoinGecko has become a de facto standard API shape for crypto apps, bots, dashboards, data pipelines, and SDKs. Many third-party integrations assume:

- familiar endpoint paths
- stable field names
- common query parameter semantics
- straightforward onboarding for prices, markets, charts, and metadata

The market gap is that there is no widely adopted, open-source, contract-compatible alternative with broad enough scope to serve as a serious replacement.

Most existing alternatives fail in one or more of these ways:

- they expose different HTTP contracts, forcing client rewrites
- they focus only on price feeds, not the broader object model
- they lack robust historical coverage
- they lack consistent entity resolution across coins, contracts, exchanges, and chains
- they cannot be self-hosted or extended cleanly
- they depend on opaque or fragile upstreams without explicit compatibility guarantees

This creates an opportunity for OpenGecko to win on:

- compatibility
- openness
- self-hostability
- provider flexibility
- implementation transparency
- modularity

## 5. Problem Statement

Teams that depend on CoinGecko-compatible APIs face three major problems:

1. **Vendor dependency**
   - migrating away is expensive when downstream clients depend on a familiar contract
   - teams lack control over outages, pricing, regional deployment, and provider selection

2. **Lack of open alternatives**
   - existing open alternatives do not cover enough of the API surface or do not match semantics closely enough

3. **Data platform complexity**
   - even when the API shape is simple, delivering reliable outputs requires canonical mappings, historical stores, search indices, ranking logic, and fallback behavior

OpenGecko solves these problems by offering a stable compatibility contract backed by an extensible and observable data platform.

## 6. Product Goals

### 6.1 Primary goals

- Provide drop-in REST compatibility for the most-used CoinGecko endpoint families.
- Preserve path structure, query parameter semantics, pagination behavior, response field names, nesting, and core error behavior closely enough that many clients can migrate by changing only base URL and credentials.
- Offer a fully open-source core that can be self-hosted.
- Decouple API compatibility from provider choice so operators can use different data sources without changing downstream integrations.
- Keep internal hot-price data continuously refreshed so market-facing REST responses are up to date by default.
- Support phased rollout with explicit compatibility grades, freshness grades, and divergence notes.
- Provide a realistic path from MVP reference implementation to larger-scale managed deployments.

### 6.2 Secondary goals

- Build a contributor-friendly provider adapter model.
- Make provenance, freshness, and compatibility status visible.
- Support local-first development and low-friction self-hosting.
- Enable later managed-hosted offerings without breaking OSS credibility.

## 7. Non-Goals

OpenGecko should explicitly not promise the following in its first major phases:

- exact replication of proprietary CoinGecko ranking logic, trust scores, spam heuristics, editorial decisions, or premium analytics
- perfect historical parity for all assets and all time ranges on day one
- WebSocket parity in the initial product scope
- copy-paste reproduction of proprietary docs, datasets, or closed-source logic
- full premium and enterprise endpoint parity before the underlying data systems exist
- support for every chain, every exchange, and every NFT marketplace at launch

## 8. Product Principles

### 8.1 Compatibility first

External contract compatibility is the product wedge. Route names, field names, parameter names, defaults, and common behaviors matter more than internal elegance.

### 8.2 Compatibility and fidelity are different axes

An endpoint can be contract-compatible while still having lower fidelity than CoinGecko in freshness, ranking quality, or coverage. These must be measured separately.

### 8.3 Fresh-by-default market reads are a core value

For supported hot-price and market endpoints, OpenGecko should aim to return the freshest defensible internal snapshot available at request time.

This means REST handlers should read from an always-hot internal market data layer maintained by background ingestion, not depend on request-time upstream fetches.

### 8.4 Build by endpoint family, not by total endpoint count

The product should ship coherent value in phases rather than attempting broad but shallow parity.

### 8.5 Provider-agnostic internals

OpenGecko should not be structurally coupled to any single upstream. Adapters, reconciliation rules, and overrides should be replaceable.

### 8.6 Canonical entity modeling is a core system

Coins, contracts, networks, exchanges, NFT collections, treasury entities, and categories must all resolve through durable internal IDs.

### 8.7 Self-hostability is a product feature

The OSS distribution must remain practical to run locally and in small deployments, not just in a large hosted environment.

### 8.8 Divergences must be explicit

When OpenGecko intentionally differs from CoinGecko behavior, that difference should be documented and testable.

## 9. Target Users and Jobs to Be Done

### 9.1 Primary user segments

1. **Application developers**
   - want to reuse existing CoinGecko-compatible clients
   - care about low migration cost and stable contracts

2. **Self-hosting teams**
   - want control over hosting region, providers, quotas, and cost
   - care about deployment simplicity and observability

3. **Data and research teams**
   - want reproducible normalized crypto datasets and historical exports
   - care about provenance, freshness, and auditability

4. **OSS contributors and integrators**
   - want to add providers, exchanges, chains, and endpoint families
   - care about modularity and clear boundaries

5. **Future managed-service operators**
   - want an OSS trust anchor with premium operational capabilities layered on top
   - care about rate limiting, tenancy, metering, and SLOs

### 9.2 Core jobs to be done

- “Replace our CoinGecko base URL and keep the app working.”
- “Run our own crypto market API with controllable data sources.”
- “Ingest normalized coin, exchange, chart, and token data into internal systems.”
- “Add support for a new exchange, chain, or vertical without changing the public API.”
- “Know exactly where data came from and how fresh it is.”

## 10. Product Scope

Based on the current active roadmap, OpenGecko targets approximately 76 REST endpoints across five families:

| Family | Approx endpoints | Product importance | Implementation difficulty |
| --- | ---: | --- | --- |
| Simple + General | 12 | Critical for migration | Medium |
| Coins + Contracts + Categories | 20 | Critical for migration | Medium-High |
| Exchanges + Derivatives | 10 | Important expansion | High |
| Public Treasury | 5 | Specialist expansion | Medium-High |
| Onchain DEX | 29 | Long-term strategic surface | Very High |

The endpoint-level rollout plan and priorities are maintained in `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`.

## 11. Compatibility Model

### 11.1 What compatibility means

For an endpoint to be considered CoinGecko-compatible, OpenGecko should aim to preserve:

- path structure
- supported HTTP method
- query parameter names and accepted values
- parameter precedence rules
- default behavior when optional parameters are omitted
- pagination behavior and ordering rules
- response JSON field names and nesting
- null vs omitted field semantics wherever feasible
- status code and error body behavior for common failure modes

### 11.2 What compatibility does not mean

Compatibility does not automatically imply:

- identical freshness
- identical ranking
- identical exchange coverage
- identical proprietary curation
- identical premium restrictions or commercial packaging

### 11.3 Compatibility grades

Each endpoint should have a machine-readable grade:

- `planned`
- `in_progress`
- `partial`
- `compatible`
- `intentionally_divergent`
- `unsupported`

Each endpoint family should also have two public-facing grades:

1. **Contract compatibility grade**
2. **Data fidelity/freshness grade**

### 11.4 Divergence policy

If OpenGecko diverges from CoinGecko behavior, it must record:

- the endpoint
- the parameter or field affected
- the reason for divergence
- whether the divergence is temporary or intentional
- the test coverage protecting the current behavior

## 12. Detailed Product Requirements

### 12.1 API and HTTP contract requirements

- OpenGecko must expose CoinGecko-compatible path patterns for supported endpoints.
- OpenGecko must normalize and validate parameters in the same order and precedence expected by common clients.
- OpenGecko must preserve response field naming and nesting for supported endpoints.
- OpenGecko must avoid silently dropping supported fields without an explicit divergence note.
- OpenGecko must support deterministic pagination semantics where the source endpoint is paginated.
- OpenGecko must preserve ordering semantics for common parameters such as `order`, `page`, `per_page`, `days`, `from`, `to`, and `interval`.
- OpenGecko must maintain a consistent compatibility policy for errors, including invalid input, unsupported assets, and rate-limit conditions.

### 12.2 Authentication, tenancy, and rate-limiting requirements

- OSS self-hosted mode must support no-auth and API-key modes.
- Managed mode must support per-tenant quotas and rate limiting.
- The compatibility layer must be able to preserve CoinGecko-style API key transport expectations where relevant, while still allowing OpenGecko-native auth configuration.
- Rate limit responses must be deterministic and documented.
- Sensitive keys and upstream credentials must never be exposed in logs or responses.

### 12.3 Data modeling requirements

OpenGecko must maintain canonical internal entities for:

- coins
- asset platforms / networks
- token contracts
- exchanges
- derivatives venues
- NFT collections
- treasury entities
- categories
- onchain networks and DEXes

Each canonical entity must support:

- stable internal identifier
- external IDs and aliases
- lifecycle state such as active, inactive, merged, deprecated, or spam/suppressed
- provenance metadata
- override metadata where human curation is required

### 12.4 Entity resolution requirements

- Contract-address endpoints must resolve platform + contract combinations deterministically.
- Symbol and name lookups must be explicit about ambiguity resolution.
- Coin, token, and pool relationships must be traceable.
- Inactive assets and rebranded assets must not break historical queries.
- Internal mappings must support manual correction workflows.

### 12.5 Market data requirements

OpenGecko must support market data primitives needed by the core CoinGecko surface:

- spot price
- quote conversion
- market cap
- fully diluted valuation where available
- total, circulating, and max supply where supported
- 24h volume and price change windows
- rankings and category aggregates
- optional sparkline-style compact history

For supported hot assets, the system must maintain an always-hot internal snapshot layer that is refreshed continuously by background ingestion, using streaming transports where worthwhile and polling fallbacks where necessary.

Market-facing REST reads should serve from that internal snapshot layer so users get fresh data without waiting for request-time provider calls.

The system must define precedence rules for conflicting provider values.

### 12.6 Historical chart requirements

OpenGecko must support retained historical series for:

- market charts
- explicit chart ranges
- OHLC
- exchange volume history
- supply history where supported
- NFT collection history where supported
- treasury holdings history where supported
- onchain pool and token OHLCV where supported

Historical systems must define:

- storage granularity
- downsampling policy
- late-arriving data policy
- recomputation rules
- gap handling rules
- cold storage or archival policy

### 12.7 Search requirements

`/search` and related discovery endpoints must support:

- grouped results by coins, exchanges, categories, and NFTs where applicable
- deterministic ranking behavior
- alias, symbol, and name lookups
- typo tolerance only when it does not make results unstable or misleading
- override capability for known ambiguities, spam, and curated rankings

Search ranking is not a trivial convenience feature. It is a core product behavior and must be treated as such.

### 12.8 Exchange and derivatives requirements

For exchange and derivatives families, OpenGecko must support:

- venue registries
- normalized ticker ingestion
- base/quote asset mapping
- exchange metadata and logos where licensed or operator-supplied
- volume history
- depth or order-book derived fields when supported
- stale, anomalous, or unreliable market flags where applicable

### 12.9 NFT roadmap status

NFT endpoints are removed from the active OpenGecko roadmap.

They are not part of the current phased delivery plan and should not block public treasury or onchain work.

Any future reconsideration should be treated as a new scope decision rather than an assumed follow-on milestone.

### 12.10 Public treasury requirements

For public treasury families, OpenGecko must support:

- curated company and government registries
- holdings and transaction histories where sourced from public disclosures
- pricing enrichment for held assets
- derived values such as total holdings value and supply share where defensible

Treasury data should be treated as curation-heavy and should never imply certainty where the underlying disclosure is incomplete.

### 12.11 Onchain DEX requirements

For onchain families, OpenGecko must eventually support:

- network catalogs
- DEX catalogs
- pool detail and pool list endpoints
- token detail and token price endpoints
- trade feeds
- OHLCV by pool and token
- trending pools, search, top holders, and top traders where data support exists

Onchain delivery should start with catalog and pool/token detail primitives before advanced analytics, rankings, and wallet-level leaderboards.

### 12.12 Self-hosting and configurability requirements

The OSS distribution must allow operators to:

- run with seeded or local data only
- configure provider adapters by environment
- disable endpoint families without required data support
- tune caching and refresh cadence
- run boot-time and continuous market-refresh workers locally
- rebuild search indices and refresh market snapshots via jobs
- inspect freshness and provider errors locally

## 13. Success Metrics

### 13.1 Product success metrics

- By end of the core-market milestone, at least 80% of common public CoinGecko integration scenarios should work with only a base URL change.
- Endpoints marked `compatible` should achieve at least 95% schema and contract compatibility on maintained fixture suites.
- Less than 1% of requests to `compatible` endpoints should fail because expected contract fields are missing.
- Freshness SLOs must be met for all endpoints included in the public compatibility grade.
- At least three meaningful provider adapters or integrations should be viable in the ecosystem over time.

### 13.2 Operational success metrics

- P95 latency under 300 ms for cached simple endpoints in managed environments.
- P95 latency under 800 ms for most cached market endpoints.
- Freshness under 60 seconds stale for supported hot-price endpoints in managed environments.
- Clear visibility into provider failures, lag, cache hit rates, and endpoint compatibility status.

## 14. Solution Approaches Considered

### Option A: Compatibility-first API facade over a modular data platform

This is the recommended strategy.

Build the external API contract first, but back it with modular internal services, storage, adapters, and validation. This captures migration value early without forcing all long-term data systems to be perfect before launch.

**Pros**

- fastest route to developer adoption
- lowest migration cost
- works well with phased rollout
- allows contributors to improve internals without changing the public API

**Cons**

- early data fidelity may be uneven
- requires disciplined compatibility testing
- requires explicit divergence tracking

### Option B: Fully integrated data platform first, public API later

Build the entire ingestion, reconciliation, retention, and scoring stack before exposing the API.

**Pros**

- best long-term foundation
- fewer compromises in the API layer

**Cons**

- very slow time to first value
- very high upfront cost
- weak fit for an OSS adoption strategy

### Option C: Thin reshaping proxy over existing third-party APIs

Use one or more third-party APIs as a source and reshape them into CoinGecko-compatible outputs.

**Pros**

- fastest prototype path
- low short-term engineering effort

**Cons**

- fragile and difficult to trust
- weak control over quality and outages
- terms-of-service and licensing risks
- poor long-term OSS story

**Recommendation:** choose Option A.

## 15. Technical and Product Architecture

### 15.1 Architecture layers

OpenGecko should be designed as a modular monolith first, with clean seams for later scaling.

Core layers:

1. **Compatibility API layer**
   - route handlers mirroring CoinGecko paths
   - parameter normalization and validation
   - response shaping and serializers
   - auth and rate limiting

2. **Domain services**
   - coins and markets
   - chart and historical queries
   - exchanges and derivatives
   - search and indexing
   - NFTs
   - treasury
   - onchain DEX

3. **Ingestion and reconciliation layer**
   - scheduled refresh jobs
   - continuous streaming ingestors where supported
   - backfills
   - adapter fetchers
   - snapshot import pipelines
   - reconciliation and override processing

4. **Storage and indexing layer**
   - metadata store
   - hot snapshot store
   - historical time-series store
   - search index
   - raw snapshot and artifact storage

### 15.2 Reference implementation architecture

The current reference implementation direction is:

- Bun
- TypeScript
- Fastify
- Zod
- SQLite
- Drizzle
- better-sqlite3
- SQLite FTS5
- CCXT
- Vitest

This stack is appropriate for:

- local development
- OSS reference distribution
- low-friction self-hosting
- early R0 and R1 delivery

### 15.3 Scale-up architecture path

As OpenGecko grows, larger deployments may add or substitute:

- Redis for response caching and rate-limit counters
- Postgres for richer operational metadata and multi-writer workflows
- ClickHouse or TimescaleDB for larger historical workloads
- Meilisearch or OpenSearch for larger search workloads
- object storage for raw backfill artifacts and snapshot archives
- job queues or streams for refresh pipelines and backfills

The key rule is that these scale-path changes must not alter the public API contract.

## 16. Data Source and Provider Strategy

OpenGecko must be provider-agnostic from day one.

### 16.1 Source categories

- spot and exchange data from direct exchange APIs and CCXT-supported venues
- token metadata from token lists, chain registries, project metadata, and curated overrides
- market cap and supply from chain reads, issuer metadata, and curated sources where necessary
- NFT data from marketplace APIs and NFT indexers
- treasury data from public disclosures and curated ingestion
- onchain DEX data from RPC providers, indexers, or analytics pipelines

### 16.2 Provider policy requirements

For each domain, OpenGecko must define:

- preferred provider order
- preferred ingestion mode such as streaming vs polling
- freshness expectations
- fallback behavior
- merge or conflict-resolution rules
- provenance capture
- licensing and ToS review

### 16.3 CCXT policy

CCXT should be the default first-choice integration layer for exchange and market data whenever it provides required data with acceptable fidelity. OpenGecko should support broad exchange coverage over time, but the default runtime exchange set should remain a curated allowlist rather than enabling every CCXT venue automatically. Only add custom exchange-specific adapters when important required fields or behaviors are materially missing.

### 16.4 Legal and licensing constraints

OpenGecko must avoid:

- scraping or storing restricted proprietary data in violation of terms
- copying protected documentation language
- representing derived or estimated values as authoritative without provenance

## 17. Canonical Data Model Requirements

The canonical model is one of the most important parts of the product.

OpenGecko needs durable mappings for:

- coin IDs
- asset platform IDs
- contract addresses
- exchange IDs
- derivatives venue IDs
- NFT collection IDs
- treasury entity IDs
- onchain network IDs
- DEX IDs
- category IDs

The model must support:

- aliases and historical identifiers
- spam or suppression flags
- merged and deprecated assets
- inactive but historically queryable entities
- per-source provenance
- manual correction and override metadata

Without this, even seemingly easy endpoints such as `/coins/list`, `/simple/token_price/{id}`, and contract-address detail endpoints become unreliable.

## 18. Historical Data and Retention Requirements

Historical correctness is one of the biggest differentiation and risk areas.

OpenGecko must define explicit policies for:

- sampling intervals by endpoint and time window
- source-of-truth snapshots vs derived bar generation
- late backfills and repair jobs
- recomputing affected history after provider corrections
- gap marking vs interpolation
- archival vs hot retention

At minimum, the product must support retained historical data for:

- prices
- market caps
- volumes
- OHLC candles
- exchange volumes where supported
- supply history where supported
- treasury holdings history where supported
- NFT market history where supported
- onchain OHLCV where supported

## 19. Search, Ranking, and Curation Requirements

Search and ranking are core product behaviors, not afterthoughts.

OpenGecko must support:

- deterministic ranking inputs
- entity popularity signals where available
- suppression or spam handling
- manual overrides for obvious bad results
- stable grouped result formatting
- clear separation between factual lookup and editorial ranking

Endpoints such as `/search`, `/search/trending`, `/coins/top_gainers_losers`, `/coins/{id}/tickers`, and onchain trending endpoints all depend on ranking and curation systems that go beyond simple data fetching.

## 20. Validation and QA Strategy

OpenGecko must validate more than JSON shape.

### 20.1 Required validation layers

1. **Schema validation**
   - field presence, types, nesting

2. **Contract and semantic validation**
   - parameter precedence
   - defaults
   - null vs omitted behavior
   - ordering and pagination
   - interval behavior
   - error responses

3. **Differential validation**
   - compare selected OpenGecko responses against curated CoinGecko fixtures and public reference expectations

4. **Freshness and provenance validation**
   - ensure outputs meet declared freshness grades
   - ensure data sources are traceable internally

5. **Operational validation**
   - job success rates
   - cache effectiveness
   - lag monitoring
   - degraded mode behavior

### 20.2 Release gates

An endpoint should not be labeled `compatible` until it has:

- fixture coverage for representative parameter combinations
- semantic coverage for defaults and edge cases
- explicit divergence notes where needed
- freshness expectations defined
- provenance and observability hooks in place

## 21. Release Phasing and Milestones

### Release 0: Compatibility Foundation

Goal: establish the compatibility shell, low-complexity endpoints, seeded data flows, contract testing patterns, and local-first self-hosting.

Primary scope:

- `/ping`
- `/simple/price`
- `/simple/token_price/{id}`
- `/simple/supported_vs_currencies`
- `/asset_platforms`
- `/exchange_rates`
- `/coins/list`
- `/search`
- `/global`

Implementation note: inside R0, the build should prioritize truly low-risk endpoints first, then layer search and global aggregation after foundational registry and summary primitives exist.

Exit criteria:

- compatibility shell is stable
- seeded or live-backed data refresh jobs exist
- basic compatibility fixtures exist
- search indexing path is defined
- freshness tracking is visible

### Release 1: Core Coins and Historical Charts

Goal: unlock the highest migration value for applications using the public coins surface.

Primary scope:

- `/coins/markets`
- `/coins/{id}`
- `/coins/{id}/history`
- `/coins/{id}/market_chart`
- `/coins/{id}/market_chart/range`
- `/coins/{id}/ohlc`
- categories endpoints
- contract-address detail and chart variants

Exit criteria:

- canonical coin and contract resolution is stable
- chart and OHLC retention behavior is defined
- key market endpoints have semantic compatibility tests

### Release 2: Exchanges, Derivatives, and Deeper Market Fidelity

Goal: expand market coverage and richer compatibility beyond the main coin endpoints.

Primary scope:

- `/exchanges*`
- `/derivatives*`
- `/coins/{id}/tickers`
- premium-like movers or newly listed feeds where data support exists
- richer global and category aggregates

Exit criteria:

- first exchange set is selected and polled reliably
- venue normalization is stable
- volume history policies are implemented

### Release 3: Public Treasury

Goal: add the first curated off-chain holdings surface while preserving the compatibility-first delivery model.

Primary scope:

- `/entities/list`
- `/public_treasury*`

Exit criteria:

- treasury entity models are stable
- curation workflows exist for manual correction
- provenance is visible for curated data

### Release 4: Onchain DEX and Advanced Analytics

Goal: deliver GeckoTerminal-style onchain coverage and the hardest analytical endpoints.

Primary scope:

- all `/onchain/*` families in staged order
- pool and token catalogs first
- pool/token detail and OHLCV next
- advanced trending, search, holders, and traders last

NFT endpoints remain out of roadmap unless explicitly reintroduced in a later product decision.

Exit criteria:

- network and pool indexing is reliable
- multi-chain freshness is measurable
- advanced ranking and analytics endpoints have explicit quality caveats or grades

> **Endpoint-level detail:** Release phase scoping, endpoint-by-endpoint priority, and difficulty ratings are maintained in `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`.

## 22. Non-Functional Requirements

### 22.1 Availability and latency

- Managed deployments should target 99.9% availability for core public endpoints.
- P95 latency should be under 300 ms for cached simple endpoints.
- P95 latency should be under 800 ms for most cached market endpoints.

### 22.2 Freshness

- Simple price endpoints should target under 60 seconds staleness for supported assets in managed mode.
- Freshness targets must be declared per endpoint family.
- Onchain freshness must be documented by network and endpoint type.

### 22.3 Observability

The system must expose:

- request volume and latency metrics
- provider error counts
- cache hit rates
- ingestion lag
- freshness lag
- job health
- endpoint compatibility status

### 22.4 Data provenance

OpenGecko should retain internal provenance metadata even when not exposed directly to clients.

### 22.5 Security

The system must support:

- secure secret handling
- API key management
- abuse controls
- request logging without leaking credentials
- auditability in managed deployments

## 23. Risks and Mitigations

### Risk 1: Chasing endpoint count instead of migration value

Mitigation: ship by endpoint family and prioritize the highest-value public surfaces first.

### Risk 2: Weak canonical mapping causes systemic correctness bugs

Mitigation: treat entity modeling as a first-class foundation and build manual override workflows early.

### Risk 3: Historical data becomes inconsistent or too expensive

Mitigation: define retention, downsampling, and recomputation policies before expanding chart-heavy families.

### Risk 4: Search and ranking quality undercuts perceived compatibility

Mitigation: treat ranking and curation as product features with explicit inputs, overrides, and tests.

### Risk 5: Provider outages or licensing changes break large portions of the API

Mitigation: require pluggable adapters, multi-source fallback, and domain-specific provider policies.

### Risk 6: `/coins/{id}` and ticker-heavy endpoints pull too much complexity too early

Mitigation: stage large detail endpoints carefully and break them into delivery slices internally.

### Risk 7: Onchain scope overwhelms the project

Mitigation: keep onchain as a late, explicitly separate milestone with its own quality bar.

### Risk 8: OSS reference architecture and managed architecture drift apart

Mitigation: enforce a stable public contract and shared compatibility tests across both deployment modes.

## 24. Resourcing and Delivery Assumptions

### Indicative effort bands

- High-value contract-compatible MVP: roughly 4-8 weeks for a strong 2-3 engineer team
- Broad public parity excluding hardest onchain and premium analytics: roughly 3-6 months for a 4-6 engineer team
- Near-full parity with serious operational maturity: roughly 9-18 months for a 6-10 person cross-functional team

For a solo founder or very small team, broad trustworthy parity is realistically a multi-quarter effort and should be aggressively phased.

## 25. Required Follow-Up Design Documents

This PRD is comprehensive, but a few implementation-critical design docs should be authored before pushing deeper into the higher-risk families:

1. Canonical entity and ID model
2. Historical storage, retention, and bar-generation policy
3. Provider reconciliation and fallback rules by domain
4. Compatibility test strategy and fixture policy
5. Search ranking and curation model
6. Override and manual-correction workflow design

## 26. Final Recommendation

OpenGecko is a viable and strategically strong product if it is framed correctly.

It should not be treated as “just a fork” or “just an API wrapper.” It is a compatibility-first crypto data platform.

The correct execution strategy is:

- preserve the external CoinGecko contract where it matters most
- build internal systems for entity resolution, history, ranking, and reconciliation early
- ship by endpoint family in phases
- keep the OSS reference implementation self-hostable and contributor-friendly
- publish compatibility, freshness, and divergence status openly

If OpenGecko follows this approach, it can become a credible open-source default for CoinGecko-style integrations. If it tries to pursue full parity everywhere at once, product and engineering risk rise sharply.
