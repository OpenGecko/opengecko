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
- `removed`

## Current Delivery Target

- Current release focus: `R4`
- Current architecture direction: `Bun + TypeScript + Fastify + Zod + SQLite + Drizzle + better-sqlite3 + SQLite FTS5 + CCXT + Vitest`
- Current repository state: `the SQLite-first scaffold, expanded schema, CCXT provider abstraction, complete R0 general/simple endpoints, complete R1 core coin endpoints, complete R2 exchange/derivatives endpoints, the complete seeded R3 public treasury family, and the first seeded onchain catalog endpoints are implemented with passing validation`

## Current Priorities

1. Make hot market endpoints fresh by default via boot-time refresh and continuous internal snapshot updates.
2. Expand the onchain DEX family beyond the initial seeded network and DEX catalogs.
3. Broaden repository-layer and fixture coverage across treasury, onchain, and remaining seeded data-fidelity edge cases.
4. Replace seeded ticker and history slices with CCXT-backed refresh and backfill paths where practical.

## Workstream Status

| Workstream | Scope | Status | Notes |
| --- | --- | --- | --- |
| Project scaffold | Fastify app, TypeScript config, test setup, logging | done | Package scripts, app entrypoints, and tests are in place |
| Storage | SQLite connection, migrations, Drizzle schema, WAL mode | done | SQLite bootstraps with Drizzle migrations and seed data, including seeded exchange, derivatives, treasury, and onchain registries |
| Compatibility layer | Param normalization, error shapes, serializers | partial | Several endpoint serializers exist across the complete R0, R1, R2, and R3 surfaces plus the first `/onchain/*` routes; the full R1 coin family includes category filtering, extra price-change windows, category-detail flags, category ordering, richer history responses, and interval-aware chart-style routes |
| Search | SQLite FTS5 indexing and `/search` support | done | FTS5 virtual table, rebuild job, and ranked `/search` queries are in place |
| Historical data | Local chart and OHLC storage | partial | Seeded chart and OHLC routes exist; initial granularity/downsampling helpers are implemented, but retention policy remains open |
| Background refresh jobs | Snapshot refresh and search rebuild jobs | partial | CCXT-backed market refresh and search rebuild scripts exist, and seed-vs-live ownership is now encoded in a shared snapshot service; scheduling and fresh-by-default read guarantees are not yet locked |
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
| Core coin market endpoints | R1 | done | `/coins/markets`, `/coins/{id}`, history, chart, OHLC, categories, token lists, and contract-address chart/detail routes are implemented and validated with seeded compatibility coverage, including category filters/details, category ordering, richer history payloads, and interval-aware chart semantics |
| Exchanges / derivatives | R2 | done | `/exchanges/list`, `/exchanges`, `/exchanges/{id}`, `/exchanges/{id}/tickers`, `/exchanges/{id}/volume_chart`, `/derivatives/exchanges/list`, `/derivatives/exchanges`, and `/derivatives` are implemented and validated with seeded compatibility coverage, including exchange status filtering, dex pair formatting, ticker depth toggles, derivatives venue ordering, and seeded contract-level derivatives rows |
| NFTs | removed | removed | removed from the active roadmap |
| Public treasury | R3 | done | `/entities/list`, grouped `/:entity/public_treasury/:coin_id`, `/public_treasury/{entity_id}`, `/public_treasury/{entity_id}/{coin_id}/holding_chart`, and `/public_treasury/{entity_id}/transaction_history` are implemented from seeded curated holdings and transaction data |
| Onchain DEX | R4 | partial | `/onchain/networks` and `/onchain/networks/{network}/dexes` are implemented from seeded network and DEX catalog data |

## Active Decisions

- Use SQLite for MVP and local-first self-hosting.
- Use Bun as the default package manager.
- Prefer the smallest practical dependency set.
- Use CCXT first for exchange and market integrations; only add custom exchange support when required data is missing.
- Use `binance`, `coinbase`, and `kraken` as the initial live CCXT exchange set.
- Use a default market refresh cadence of `60s`, a search rebuild cadence of `900s`, and a live freshness threshold of `300s`.
- Treat fresh-by-default market responses as a central product value; REST reads should come from continuously updated internal snapshots.
- Keep the codebase as a modular monolith before considering service splits.
- Prioritize HTTP contract compatibility before data fidelity.
- Track rollout by endpoint family and release phase.

## Open Questions / Blockers

- Define fixture sources for compatibility-oriented contract tests.
- Decide the default runtime model for fresh-by-default market ingestion: in-process scheduler, separate worker, or both.

## Known Data-Fidelity Follow-ups After Treasury/Onchain Kickoff

- `/coins/{id}` and `/coins/{id}/history` now satisfy the intended R1 contract shape, but their values still come from the current seeded market/history slices rather than live/backfilled sources.
- `/coins/*/market_chart*` and `/ohlc` now support interval-aware semantics, but the underlying series still comes from the current seeded historical window.
- `/coins/categories*`, contract-address variants, and `/token_lists/{asset_platform_id}/all.json` are contract-complete for the current seed set, but broader taxonomy/platform coverage still depends on larger catalogs.
- `/exchanges*` currently uses a small seeded exchange registry, seeded ticker rows, and seeded BTC volume history rather than live exchange ingestion.
- `/derivatives*` now satisfies the intended R2 contract surface, but it is backed by a small seeded derivatives venue and contract set rather than live venue ingestion.
- `/public_treasury*` now exposes holding-chart and transaction-history routes, but it still uses a tiny seeded disclosure/transaction set and reconstructed daily value series rather than a broad curated ledger.
- `/onchain/*` currently uses a small seeded network/DEX catalog and does not yet include pools, token detail, trades, or OHLCV.

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
- Added the remaining R1 compatibility semantics for `/coins/markets`, `/coins/{id}`, `/coins/{id}/history`, `/coins/categories`, and contract chart routes, including category filters/details, extra price-change windows, category ordering, richer history payloads, and optional chart intervals.
- Completed the R1 core coin endpoint family with passing validation coverage.
- Added seeded derivatives exchange registry support for `/derivatives/exchanges/list` and `/derivatives/exchanges`, including ordering, pagination, and invalid-order coverage.
- Added the remaining R2 compatibility semantics for `/exchanges/list`, `/exchanges/{id}`, `/exchanges/{id}/tickers`, and `/derivatives`, including exchange status filtering, dex pair formatting, ticker depth toggles, seeded derivatives contracts, and invalid-parameter coverage.
- Completed the R2 exchanges and derivatives endpoint family with passing validation coverage.
- Removed NFTs from the active roadmap and shifted post-R2 delivery focus to public treasury and onchain DEX work.
- Added seeded public treasury support for `/entities/list`, `/:entity/public_treasury/:coin_id`, and `/public_treasury/{entity_id}`.
- Added the remaining seeded public treasury endpoints for `/public_treasury/{entity_id}/{coin_id}/holding_chart` and `/public_treasury/{entity_id}/transaction_history`, backed by a treasury transaction ledger and reconstructed daily holdings/value series.
- Added seeded onchain catalog support for `/onchain/networks` and `/onchain/networks/{network}/dexes`.
- Added passing tests for `/ping`, `/simple/*`, `/asset_platforms`, `/search`, `/global`, `/coins/list`, and the first seeded `/coins/*` market endpoints.

## Update Rules

- Update this file whenever implementation status changes.
- Update this file whenever current priorities or release focus changes.
- Keep statuses factual; do not mark work `done` without code and verification.
