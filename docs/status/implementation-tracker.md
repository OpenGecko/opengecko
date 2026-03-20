# OpenGecko Implementation Tracker

## Purpose

This file tracks execution progress from the current repository state toward the target product defined in:

- `docs/plans/2026-03-20-opengecko-coingecko-compatible-api-prd.md`
- `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`

Use this tracker for current status, active priorities, completed milestones, and open blockers.

## Status Legend

- `not started`
- `in progress`
- `blocked`
- `partial`
- `done`

## Current Delivery Target

- Current release focus: `R0`
- Current architecture direction: `Bun + TypeScript + Fastify + Zod + SQLite + Drizzle + better-sqlite3 + SQLite FTS5 + CCXT + Vitest`
- Current repository state: `the SQLite-first scaffold, expanded schema, CCXT provider abstraction, complete R0 general/simple endpoints, `token_lists` support, early exchange endpoints, and a first wave of early R1 endpoints are implemented and passing validation`

## Current Priorities

1. Expand the compatibility shell for more faithful response shaping and edge-case handling.
2. Broaden repository-layer and fixture coverage across more market/history/detail edge cases.
3. Finalize chart granularity/downsampling rules and retention assumptions.
4. Deepen `/coins/{id}` fidelity beyond the current localization/detail-platform/community/developer baseline.
5. Expose scheduling and lag assumptions for live refresh jobs.

## Workstream Status

| Workstream | Scope | Status | Notes |
| --- | --- | --- | --- |
| Project scaffold | Fastify app, TypeScript config, test setup, logging | done | Package scripts, app entrypoints, and tests are in place |
| Storage | SQLite connection, migrations, Drizzle schema, WAL mode | done | SQLite bootstraps with Drizzle migrations and seed data, including seeded exchange registry and exchange volume history |
| Compatibility layer | Param normalization, error shapes, serializers | partial | Several endpoint serializers exist, `/exchange_rates`, `/token_lists/{asset_platform_id}/all.json`, the first `/exchanges*` routes, seeded `/coins/{id}/tickers`, and seeded `/exchanges/{id}/tickers` support are implemented; `/coins/markets` order/pagination handling improved, stale market snapshots are degraded deterministically, chart-style routes validate range inputs and missing coins explicitly, and `/coins/{id}` now includes richer baseline detail sections |
| Search | SQLite FTS5 indexing and `/search` support | done | FTS5 virtual table, rebuild job, and ranked `/search` queries are in place |
| Historical data | Local chart and OHLC storage | partial | Seeded chart and OHLC routes exist; initial granularity/downsampling helpers are implemented, but retention policy remains open |
| Background refresh jobs | Snapshot refresh and search rebuild jobs | partial | CCXT-backed market refresh and search rebuild scripts exist, and seed-vs-live ownership is now encoded in a shared snapshot service; scheduling is still not locked |
| Contract testing | Endpoint fixtures and schema assertions | partial | Fixture-backed, invalid-parameter, repository-level, stale-data, and chart-semantic tests are in place; broader fixture coverage is still missing |

## Endpoint Family Progress

| Family | Target phase | Status | Notes |
| --- | --- | --- | --- |
| `/ping` | R0 | done | CoinGecko-style ping response implemented and tested |
| `/simple/*` | R0 | done | `/simple/supported_vs_currencies`, `/simple/price`, `/simple/token_price/{id}`, and `/exchange_rates` are implemented and tested |
| `/asset_platforms` | R0 | done | Seeded platform registry route implemented and tested |
| `/token_lists/{asset_platform_id}/all.json` | R1 | done | Seeded token-list endpoint implemented and tested for Ethereum |
| `/search` | R0 | done | FTS5-backed grouped search route implemented and tested |
| `/global` | R0 | done | Aggregate market snapshot route implemented and tested |
| `/coins/list` | R0 | done | Seeded coin registry route implemented and tested |
| Core coin market endpoints | R1 | partial | `/coins/markets`, `/coins/{id}`, `/coins/{id}/tickers`, history, chart, OHLC, categories, and contract-address chart/detail routes are implemented from seeded data |
| Exchanges / derivatives | R2 | partial | `/exchanges/list`, `/exchanges`, `/exchanges/{id}`, `/exchanges/{id}/tickers`, and `/exchanges/{id}/volume_chart` are implemented from seeded exchange and ticker data |
| NFTs | R3 | not started | later phase |
| Public treasury | R3 | not started | later phase |
| Onchain DEX | R4 | not started | major milestone, intentionally deferred |

## Active Decisions

- Use SQLite for MVP and local-first self-hosting.
- Use Bun as the default package manager.
- Prefer the smallest practical dependency set.
- Use CCXT first for exchange and market integrations; only add custom exchange support when required data is missing.
- Use `binance`, `coinbase`, and `kraken` as the initial live CCXT exchange set.
- Use a default market refresh cadence of `60s`, a search rebuild cadence of `900s`, and a live freshness threshold of `300s`.
- Keep the codebase as a modular monolith before considering service splits.
- Prioritize HTTP contract compatibility before data fidelity.
- Track rollout by endpoint family and release phase.

## Open Questions / Blockers

- Define fixture sources for compatibility-oriented contract tests.

## Known Seeded R1 Divergences

- `/coins/{id}` still serves a reduced market-data object, and `/coins/{id}/tickers` is currently backed by a small seeded ticker set rather than live venue ingestion.
- `/coins/*/market_chart*` and `/ohlc` currently operate on a small seeded daily series rather than live/backfilled interval data.
- `/coins/categories*` and contract-address variants are limited to the current seeded catalog subset.
- `/token_lists/{asset_platform_id}/all.json` is currently backed by the seeded platform catalog and limited token metadata/decimals.
- `/exchanges*` currently uses a small seeded exchange registry, seeded ticker rows, and seeded BTC volume history rather than live exchange ingestion.

## Completed Milestones

- Finalized product direction in the PRD.
- Finalized endpoint family rollout in the parity matrix.
- Chosen MVP API stack and SQLite-first architecture direction.
- Scaffolded the TypeScript + Fastify + SQLite application structure.
- Added Drizzle schema, migration generation, and SQLite bootstrap logic.
- Added a CCXT-first provider abstraction for exchange integrations.
- Added a CCXT-backed market snapshot refresh job scaffold.
- Added SQLite FTS5 search indexing and a rebuild job.
- Added fixture-backed, invalid-parameter, and freshness-focused tests.
- Added initial repository-level tests and `/coins/markets` ordering/pagination coverage.
- Added deterministic stale-snapshot behavior in market-facing endpoints.
- Added initial chart granularity/downsampling helpers and tests.
- Added explicit seeded-vs-live snapshot ownership helpers for refresh jobs and services.
- Added `/exchange_rates` and stricter chart-route validation for invalid ranges and missing coins.
- Added a richer `/coins/{id}` baseline with localization, detail-platforms, structured community/developer sections, and additional market-data fields backed by current seeded history.
- Added `/token_lists/{asset_platform_id}/all.json` with seeded Ethereum token-list output and coverage for missing platform behavior.
- Added seeded exchange registry and volume history support for `/exchanges/list`, `/exchanges`, `/exchanges/{id}`, and `/exchanges/{id}/volume_chart`.
- Added seeded `/coins/{id}/tickers` support with filtering, ordering, and coverage for missing coins and invalid order values.
- Added seeded `/exchanges/{id}/tickers` support with filtering, ordering, and ticker-rich exchange detail responses.
- Added passing tests for `/ping`, `/simple/*`, `/asset_platforms`, `/search`, `/global`, `/coins/list`, and the first seeded `/coins/*` market endpoints.

## Update Rules

- Update this file whenever implementation status changes.
- Update this file whenever current priorities or release focus changes.
- Keep statuses factual; do not mark work `done` without code and verification.
