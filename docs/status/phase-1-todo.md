# OpenGecko Phase 1 Todo

This checklist translates the PRD and endpoint parity matrix into a concrete Phase 1 execution plan.

## 1. Project/Foundation

- [x] Finalize Bun-first project scripts and workflow
- [x] Keep dependency set minimal and justified
- [x] Define env/config shape
- [ ] Add `.env` loading strategy if needed
- [x] Lock down logging format and error policy
- [partial] Add centralized request/response utilities
- [x] Add consistent error envelope for invalid params and internal failures

## 2. SQLite/Data Layer

- [partial] Finalize SQLite schema for coins
- [x] Finalize SQLite schema for asset platforms
- [partial] Finalize SQLite schema for market snapshots
- [partial] Finalize SQLite schema for historical chart points
- [partial] Finalize SQLite schema for categories
- [x] Finalize SQLite schema for search documents / FTS5 tables
- [x] Enable WAL mode and foreign keys
- [x] Add migrations workflow
- [partial] Add seed/reference data strategy
- [ ] Define canonical ID rules for coin IDs, symbols, and contract/platform mappings
- [ ] Add repository layer so handlers stay thin

## 3. Compatibility Layer

- [partial] Implement shared query parsing/defaulting helpers
- [ ] Match CoinGecko-style parameter names
- [partial] Match CoinGecko-style response field names
- [partial] Normalize booleans, arrays, precision, pagination inputs
- [partial] Define explicit behavior for unsupported/unknown params
- [partial] Add response serializers per endpoint family
- [ ] Add compatibility notes for any intentional divergence

## 4. Endpoint Delivery: R0

### Health
- [x] `/ping`

### Simple
- [x] `/simple/supported_vs_currencies`
- [x] `/simple/price`
- [x] `/simple/token_price/{id}`

### General
- [x] `/asset_platforms`
- [x] `/search`
- [x] `/global`

### Coins
- [x] `/coins/list`

## 5. Endpoint Delivery: Early R1 Core

- [x] `/coins/markets`
- [x] `/coins/{id}`
- [x] `/coins/{id}/history`
- [x] `/coins/{id}/market_chart`
- [x] `/coins/{id}/market_chart/range`
- [x] `/coins/{id}/ohlc`
- [x] `/coins/categories/list`
- [x] `/coins/categories`
- [x] contract-address detail endpoint
- [x] contract-address market chart endpoint
- [x] contract-address market chart range endpoint

## 6. Search

- [x] Design SQLite FTS5 search schema
- [x] Index coins, symbols, names, and categories
- [partial] Add ranking strategy for `/search`
- [x] Return CoinGecko-like grouped search payload
- [x] Add rebuild/index refresh job

## 7. Historical Data

- [x] Define chart point storage model
- [partial] Define OHLC generation/storage approach
- [x] Implement range query support
- [partial] Define granularity/downsampling rules
- [ ] Add retention/backfill assumptions for MVP

## 8. Provider/Ingestion

- [x] Choose first CCXT exchange set and upstream provider strategy
- [partial] Define seed vs live-refresh responsibilities
- [x] Implement CCXT-backed market snapshot refresh job
- [ ] Implement coin/platform metadata refresh job
- [x] Track provider freshness timestamps
- [partial] Define fallback behavior when data is stale/missing
- [partial] Only add custom exchange-specific support where important data is missing from CCXT

## 9. Testing/Validation

- [x] Add endpoint smoke tests
- [partial] Add schema/contract tests for each shipped endpoint
- [x] Add fixture-based response assertions
- [x] Add invalid-parameter tests
- [partial] Add DB/repository tests
- [partial] Add test coverage for serialization behavior
- [x] Make `bun run typecheck`, `bun run test`, and `bun run build` part of milestone validation

## 10. Status/Planning Discipline

- [x] Keep `docs/status/implementation-tracker.md` updated as work lands
- [partial] Mark each endpoint as `not started`, `partial`, or `done`
- [x] Record active blockers and architecture decisions
- [ ] Keep parity matrix aligned if scope/phase changes

## 11. Phase 1 Exit Criteria

- [x] R0 endpoints are implemented and tested
- [x] earliest R1 core endpoints are scaffolded or partially delivered
- [partial] compatibility layer is reusable across endpoint families
- [partial] SQLite schema supports current R0/R1 needs
- [partial] contract tests exist for every shipped endpoint
- [x] tracker reflects real status
- [x] no failing typecheck/tests/build
