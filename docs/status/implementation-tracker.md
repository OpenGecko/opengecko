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
- Current repository state: `the SQLite-first scaffold, expanded schema, CCXT provider abstraction, boot-time hot-snapshot sync, continuous top-100-priority OHLCV worker runtime, 2D freshness model, complete R0-R3 endpoint families, and the first seeded onchain catalog endpoints are implemented with passing validation`

## Current Priorities

1. Expand canonical chain coverage by ingesting and normalizing all CCXT-discoverable networks from the active exchange set.
2. Expand the onchain DEX family beyond the initial seeded network and DEX catalogs.
3. Harden the continuous OHLCV worker with deeper retention, repair, and hosted-worker operating guidance.
4. Broaden repository-layer and fixture coverage across treasury, onchain, and remaining data-fidelity edge cases.
5. Replace remaining seeded ticker and history slices with live/backfilled canonical paths where practical.

## Workstream Status

| Strategic workstream | Operational scope | Status | Notes |
| --- | --- | --- | --- |
| WS-A Compatibility fidelity | Parameter precedence, error shapes, serializers, divergence tracking | partial | R0, R1, R2, and R3 endpoint families are implemented with passing validation; the remaining compatibility work is concentrated in the expanding R4 onchain surface |
| WS-B Live market ingestion and freshness | CCXT provider abstraction, snapshot refresh, stale-data policy, fresh-by-default reads | done | Boot-time initial sync now materializes hot snapshots and continuous 60s refresh scheduling; live data owns hot reads after sync and stale fallback remains explicit |
| WS-C Historical chart and OHLC semantics | Chart, range, OHLC, and future onchain OHLCV behavior | partial | Continuous OHLCV worker now owns restart-safe `1d` ingestion with top-100-first scheduling, recent catch-up, and backward deepening; longer retention and repair policy remain open |
| WS-D Canonical entity resolution | Coin, platform, contract, venue, treasury, network, and DEX identity mapping | partial | Multi-exchange coin discovery via syncCoinCatalogFromExchanges(), COIN_ID_OVERRIDES shared in src/lib/coin-id.ts, exchange records from CCXT metadata |
| WS-E Contract testing and fixtures | Endpoint fixtures, invalid-parameter coverage, repository/service-layer assertions | partial | 110 tests passing, integration tests for full live pipeline, stale-data tests adapted to 2D model |
| WS-F Jobs, operations, and observability | Refresh scheduling, search rebuilds, job failure handling, lag visibility | partial | Initial-sync failure handling, serialized runtime jobs, standalone `ohlcv:worker` entrypoint, and OHLCV diagnostics are in place; hosted-worker deployment guidance and deeper alerting remain open |

## Endpoint Family Progress

| Family | Target phase | Status | Notes |
| --- | --- | --- | --- |
| `/ping` | R0 | done | CoinGecko-style ping response implemented and tested |
| `/simple/*` | R0 | done | `/simple/supported_vs_currencies`, `/simple/price`, `/simple/token_price/{id}`, and `/exchange_rates` are implemented and tested |
| `/asset_platforms` | R0 | done | Seeded platform registry route implemented and tested, with dedicated module smoke coverage in `scripts/modules/assets/assets.sh` |
| `/token_lists/{asset_platform_id}/all.json` | R1 | done | Seeded token-list endpoint implemented and tested for Ethereum, with dedicated module smoke coverage in `scripts/modules/assets/assets.sh` |
| `/search` | R0 | done | FTS5-backed grouped search route implemented and tested, with dedicated module smoke coverage in `scripts/modules/search/search.sh` |
| `/global` | R0 | done | Aggregate market snapshot route implemented and tested, with dedicated module smoke coverage in `scripts/modules/global/global.sh` |
| `/coins/list` | R0 | done | Seeded coin registry route implemented and tested, with dedicated module smoke coverage in `scripts/modules/coins/coins.sh` |
| Core coin market endpoints | R1 | done | `/coins/markets`, `/coins/{id}`, history, chart, OHLC, categories, token lists, and contract-address chart/detail routes are implemented and validated with seeded compatibility coverage, including category filters/details, category ordering, richer history payloads, interval-aware chart semantics, and dedicated module smoke coverage in `scripts/modules/coins/coins.sh` |
| Exchanges / derivatives | R2 | done | `/exchanges/list`, `/exchanges`, `/exchanges/{id}`, `/exchanges/{id}/tickers`, `/exchanges/{id}/volume_chart`, `/derivatives/exchanges/list`, `/derivatives/exchanges`, and `/derivatives` are implemented and validated with seeded compatibility coverage, including exchange status filtering, dex pair formatting, ticker depth toggles, derivatives venue ordering, seeded contract-level derivatives rows, and dedicated module smoke coverage in `scripts/modules/exchanges/exchanges.sh` |
| NFTs | removed | removed | removed from the active roadmap |
| Public treasury | R3 | done | `/entities/list`, grouped `/:entity/public_treasury/:coin_id`, `/public_treasury/{entity_id}`, `/public_treasury/{entity_id}/{coin_id}/holding_chart`, and `/public_treasury/{entity_id}/transaction_history` are implemented from seeded curated holdings and transaction data |
| Onchain DEX | R4 | partial | `/onchain/networks` and `/onchain/networks/{network}/dexes` are implemented from seeded network and DEX catalog data |

## Active Decisions

- Use SQLite for MVP and local-first self-hosting.
- Use Bun as the default package manager.
- Prefer the smallest practical dependency set.
- Use CCXT first for exchange and market integrations; only add custom exchange support when required data is missing.
- Use `binance`, `coinbase`, `kraken`, and `okx` as the primary validated live CCXT exchange set in tests and worker diagnostics.
- Treat CCXT-discoverable chains from the active exchange set as the baseline network universe for contract and platform compatibility mapping.
- Use a default market refresh cadence of `60s`, a search rebuild cadence of `900s`, and a live freshness threshold of `300s`.
- Treat fresh-by-default market responses as a central product value; REST reads should come from continuously updated internal snapshots.
- Treat historical OHLCV durability as a continuous worker concern: startup only needs hot snapshots, while the worker prioritizes top-100 recent catch-up before historical deepening.
- Keep the codebase as a modular monolith before considering service splits.
- Prioritize HTTP contract compatibility before data fidelity.
- Track rollout by endpoint family and release phase.

## Open Questions / Blockers

- Define fixture sources for compatibility-oriented contract tests.
- Decide the long-term deployment default for the OHLCV worker: in-process sidecar for local dev, separate hosted worker, or both.

## Key Gaps

1. Data sources are still the largest fidelity gap. Most market-facing endpoints continue to read from seeded static snapshots and seeded historical windows instead of a continuously refreshed live market dataset.
2. Canonical chain and contract-address mapping coverage remains uneven; CCXT metadata is available, but normalized chain-universe ingestion and confidence reporting are not yet complete.
3. The CCXT provider abstraction is in place, but live ingestion still needs more hardening around exchange breadth, repair behavior, and deployment ergonomics before it can be treated as fully finished.
4. Historical chart and OHLC behavior now has a continuous worker path, but long-range retention, rolling repair, and explicit recovery-after-gap policies remain open.

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
- Added dedicated module smoke scripts for exchanges, global, search, assets, and coins under `scripts/modules/*`, plus package scripts to run each family directly.
- Extracted shared coin-id utilities (buildCoinId, buildCoinName, COIN_ID_OVERRIDES) into src/lib/coin-id.ts.
- Split seedReferenceData into seedStaticReferenceData (non-market) and seedMarketData (market).
- Created initial-sync service that boot-time syncs exchanges, coins, chains, and hot market snapshots from the active CCXT exchange set.
- Generalized coin catalog sync from Binance-only to multi-exchange via syncCoinCatalogFromExchanges().
- Implemented boot-time exchange metadata sync from CCXT.
- Added persistent OHLCV sync-target state, deterministic leasing/cursor updates, split recent-vs-historical sync modes, and a continuous top-100-priority OHLCV worker runtime.
- Added a standalone `ohlcv:worker` job entrypoint plus `/diagnostics/ohlcv_sync` health reporting.
- Replaced 1D freshness model (allowSeededFallback) with 2D model (initialSyncCompleted + allowStaleLiveService).
- Wired initial-sync into startup: runtime runs sync before refresh loop, handles failure with stale fallback.
- Added live exchange volume snapshots during market refresh with downsampling in volume_chart endpoint.
- Added end-to-end integration tests for full live CCXT data pipeline (6 tests covering /simple/price, /coins/markets, /coins/:id, /exchanges, /ohlc, /exchange_rates).

## Update Rules

- Update this file whenever implementation status changes.
- Update this file whenever current priorities or release focus changes.
- Keep statuses factual; do not mark work `done` without code and verification.
