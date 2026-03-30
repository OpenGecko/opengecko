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
- Current repository state: `SQLite-first scaffold with CCXT + DeFiLlama + Subsquid live providers, boot-time hot-snapshot sync, continuous top-100-priority OHLCV worker, 2D freshness model, canonical chain resolution, and broad route coverage across all 76 active non-NFT endpoints. Contract surface coverage is broad. Live data coverage is approximately 30% by endpoint count — most endpoints serve seeded, fixture, or hybrid data. The Graph provider was removed in 08e4b39.`

## Current Priorities

1. Restore the main Vitest suite to green so parity and milestone-sealing claims reflect actual repository state rather than planned state.
2. Finish the active `platform-and-catalog-discovery` milestone by landing live new-listings discovery plus the remaining `/search` relevance and `/global` breadth uplifts.
3. Continue the `onchain-discovery-uplift` milestone, including deterministic invalid-params coverage and multi-network DeFiLlama-backed discovery hardening.
4. Improve coin enrichment and chart fidelity while preserving the top-100-first OHLCV policy and honest fallback behavior.
5. Keep derivatives, treasury, categories, and unresolved supply-chart surfaces honest and contract-compatible as accepted fixture families while tightening observability, cache invalidation, and runtime failure behavior.

## Data Quality Summary (as of 2026-03-29 audit)

The system has 3 live data sources: **CCXT** (8 CEX, ticker/OHLCV/exchange metadata), **DeFiLlama** (Ethereum pool price/volume/reserve), **Subsquid** (Ethereum Uniswap V3 swap logs). All other data is seeded or synthetic.

| Tier | Coverage | Endpoints | Data source |
|------|----------|-----------|-------------|
| **Live** (~30%) | Real-time | `/simple/price`, `/simple/token_price`, `/exchange_rates` (currency-api), `/coins/markets`, `/asset_platforms` (canonical CCXT-discovered platforms), `/exchanges` metadata, `/exchanges/{id}/tickers` (live CCXT ticker ingestion persisted to DB), `/onchain/networks/eth/pools` (DeFiLlama-patched), `/onchain/networks/eth/pools/*/trades` (Subsquid) | CCXT snapshots/tickers → DB → read |
| **Hybrid** (~35%) | Partial live | `/coins/{id}` (market_data live, description/links/community/developer seeded/null), `/coins/markets` sparkline (seeded 7-day synthetic candles), `/coins/{id}/history`, `/coins/{id}/market_chart`, `/coins/{id}/ohlc`, `/coins/{id}/ohlc/range`, `/global`, `/search` (seeded index + live enrichment), `/search/trending` (live market-cap rank, not true trending), `/coins/top_gainers_losers`, `/token_lists/{asset_platform_id}/all.json` (canonical discovered platforms routed to seeded/reference-backed token-list payloads), `/exchanges/{id}/volume_chart*` (live refresh ownership accumulated from ticker ingestion; historical depth remains bounded to retained points), `/onchain/networks` (seeded networks, DeFiLlama enriches ETH), `/onchain/networks/*/tokens/*` (ETH live price), `/public_treasury/*` (USD from live snapshots, holdings/transactions seeded) | Mixed |
| **Fixture/Seeded** (~35%) | Zero live | `/derivatives*` (3 tickers, 2 exchanges, frozen data), `/public_treasury/holding_chart` (seeded), `/public_treasury/transaction_history` (seeded 6 tx), `/onchain/*/top_holders` (fixture USDC only), `/onchain/*/top_traders` (fixture USDC only), `/onchain/*/holders_chart` (fixture USDC only), `/onchain/pool OHLCV` (synthetic fallback), `/onchain/pool trades` (fixture fallback), `/coins/list/new` (seeded `createdAt`), `/coins/*/circulating_supply_chart`, `/coins/*/total_supply_chart`, `/global/market_cap_chart` | 100% seeded/fixture |

**Key gap**: "Route implemented" ≠ "has live data". The 76/76 parity claim refers to HTTP contract surface (routing, parameters, response structure), not data fidelity. Several families serve seeded, fixture, or hybrid data.

## Workstream Status

| Strategic workstream | Operational scope | Status | Notes |
| --- | --- | --- | --- |
| WS-A Compatibility fidelity | Parameter precedence, error shapes, serializers, divergence tracking | partial | Route coverage is broad and the compatibility audit records 76 / 76 active non-NFT parity-matrix endpoints as implemented, but current runtime regressions mean the practical release gate is not yet satisfied |
| WS-B Live market ingestion and freshness | CCXT provider abstraction, snapshot refresh, stale-data policy, fresh-by-default reads | done | Boot-time initial sync now materializes hot snapshots and continuous 60s refresh scheduling; live data owns hot reads after sync and stale fallback remains explicit |
| WS-C Historical chart and OHLC semantics | Chart, range, OHLC, and future onchain OHLCV behavior | partial | Continuous OHLCV worker now owns restart-safe `1d` ingestion with top-100-first scheduling, recent catch-up, backward deepening, gap repair, retention enforcement, and persisted-history preference; longer-horizon operational policy remains open |
| WS-D Canonical entity resolution | Coin, platform, contract, venue, treasury, network, and DEX identity mapping | done | Canonical chain/platform resolution, alias-aware contract lookup, multi-exchange chain merging, and onchain network/platform identity mapping now cover the active compatibility surface |
| WS-E Contract testing and fixtures | Endpoint fixtures, invalid-parameter coverage, repository/service-layer assertions | partial | Coverage is broad across active families, but the main Vitest suite is currently failing in parity and runtime-sensitive areas, so this workstream should not be treated as complete |
| WS-F Jobs, operations, and observability | Refresh scheduling, search rebuilds, job failure handling, lag visibility | partial | Initial-sync failure handling, serialized runtime jobs, standalone `ohlcv:worker`, diagnostics for runtime/ohlcv/chain coverage, exchange durability hardening, and startup prewarm are in place; hosted-worker deployment guidance and deeper alerting remain open |
| WS-G Data fidelity uplift | Replace seeded/fixture data with live sources | partial | Exchange live-fidelity is sealed; canonical platform discovery, bootstrap backfill repair, Bun compatibility, and BigNumber calculation foundation have landed; remaining per-family uplift work stays tracked in `docs/plans/2026-03-29-data-fidelity-uplift-plan.md` |

## Endpoint Family Progress

| Family | Target phase | Status | Data quality | Notes |
| --- | --- | --- | --- | --- |
| `/ping` | R0 | done | live | CoinGecko-style ping response implemented and tested |
| `/simple/*` | R0 | done | live | `/simple/supported_vs_currencies`, `/simple/price`, `/simple/token_price/{id}`, and `/exchange_rates` are implemented and tested; all backed by live CCXT snapshots or currency-api |
| `/asset_platforms` | R0 | done | live | Canonical CCXT-discovered platforms are now exposed; legacy aliases are suppressed as top-level ids |
| `/token_lists/{asset_platform_id}/all.json` | R1 | done | hybrid | Canonical platform ids and contract routing now align with the discovered platform catalog; token-list payloads remain seeded/reference-backed |
| `/search` | R0 | partial | hybrid | FTS5-backed search over seeded coin/exchange tables; exact-match relevance uplift is pending, while `search/trending` is now an explicitly rank-honest top-market-cap proxy |
| `/global` | R0 | partial | hybrid | Aggregate market routes exist and read live snapshots, but breadth uplift across the broader discovered catalog is still pending |
| `/coins/list` | R0 | done | seeded | Seeded coin registry remains in place; canonical identity propagation is improved, but true new-coin discovery is still pending |
| `/coins/list/new` | R0 | partial | seeded | Still returns seeded `createdAt` ordering today; live newly-listed detection is the next pending platform/discovery task |
| Core coin market endpoints | R1 | partial | hybrid | `/coins/markets` live snapshots now include canonical bootstrap backfill fixes; `/coins/{id}` detail enrichment plus history/chart/OHLC fidelity work remain pending, and sparklines still rely on seeded/synthetic history |
| `/exchanges/*` | R2 | partial | hybrid | Exchange metadata and list are live from CCXT; `/exchanges/{id}/tickers` is live-backed via persisted CCXT ticker ingestion; `/exchanges/{id}/volume_chart*` is hybrid-from-live, accumulated from the same ticker refresh ownership while historical depth remains limited to retained points |
| `/derivatives/*` | R2 | partial | seeded | 3 hardcoded tickers (BTC/ETH perpetual + 1 expired), 2 exchanges; data frozen at 2026-03-20 |
| NFTs | removed | removed | — | removed from the active roadmap |
| Public treasury | R3 | partial | hybrid | USD values from live snapshots; holdings (2 entities) and transactions (6 tx) are fully seeded; holding_chart is seeded synthetic |
| Onchain DEX | R4 | partial | hybrid | ETH pools get DeFiLlama live patches; Solana pools are seed-only; `top_holders`, `top_traders`, `holders_chart` are fixture (USDC only, fake addresses); `pool trades` fallback is 6 synthetic trades; `pool OHLCV` fallback is 6 synthetic candles |

## Active Decisions

- Use SQLite for MVP and local-first self-hosting.
- Use Bun as the default package manager.
- Prefer the smallest practical dependency set.
- Use CCXT first for exchange and market integrations; only add custom exchange support when required data is missing.
- Use `binance`, `bybit`, `coinbase`, `kraken`, `okx`, `gate`, `mexc`, and `bitget` as the default active CCXT exchange set, while treating default enablement as a curated allowlist rather than "all CCXT exchanges".
- Treat CCXT-discoverable chains from the active exchange set as the baseline network universe for contract and platform compatibility mapping.
- Use a default market refresh cadence of `60s`, a search rebuild cadence of `900s`, and a live freshness threshold of `300s`.
- Treat fresh-by-default market responses as a central product value; REST reads should come from continuously updated internal snapshots.
- Treat historical OHLCV durability as a continuous worker concern: startup only needs hot snapshots, while the worker prioritizes top-100 recent catch-up before historical deepening.
- Keep the codebase as a modular monolith before considering service splits.
- Prioritize HTTP contract compatibility before data fidelity.
- Track rollout by endpoint family and release phase.
- **Seeded data serves as intentional fixtures for development, not production data**: the data quality gap is acknowledged and tracked; the engineering execution plan prioritizes uplifting data fidelity in WS-G.

## Open Questions / Blockers

- Define fixture sources for compatibility-oriented contract tests.
- Decide the long-term deployment default for the OHLCV worker: in-process sidecar for local dev, separate hosted worker, or both.
- **Derivatives data source**: Should we implement live CCXT derivatives fetch (not currently in CCXT provider), or accept derivatives as a lower-priority seeded family?
- **Onchain holder/trader data**: No affordable on-chain data provider exists for historical holder/trader snapshots. Should these endpoints remain fixture-only until a cost-effective source is found?
- **Treasury live ingestion**: Is there a real-world use case that requires live Strategy/Spot ETF or El Salvador BTC disclosures, or is the current 2-entity seeded fixture sufficient for development?
- **Chart history depth**: Should the system prioritize deeper OHLCV backfill (365 days for all coins) vs keeping top-100-first policy and accepting shallow history for most coins?

## Key Gaps

1. **Data fidelity (~30% live coverage)**: The largest remaining gap. Route coverage is broad but several families serve seeded, fixture, or hybrid data. The "76/76 endpoints implemented" claim refers to HTTP contract surface, not data quality.
2. **Derivatives are 100% fixture**: 3 hardcoded tickers, 2 exchanges, data frozen at 2026-03-20. No live CCXT derivatives fetch exists.
3. **Exchange history depth is still bounded even after live ownership uplift**: `/exchanges/{id}/tickers` is now live-backed and `/exchanges/{id}/volume_chart*` accumulates from live ticker refreshes, but long-range history remains limited to retained snapshot coverage rather than deep backfilled venue history.
4. **Onchain holders/traders are fake**: `top_holders`, `top_traders`, `holders_chart` return fixture data for USDC only; all other tokens return empty arrays.
5. **Chart history is synthetic**: All `/coins/*/market_chart`, `/ohlc`, `/ohlc/range` serve seeded 7-day synthetic candles. Real OHLCV accumulates after boot but top-100-first policy means most coins never get real candles.
6. **Treasury is static**: 2 entities, 6 transactions, fixed holdings. No live disclosure ingestion.
7. **Platform-and-catalog-discovery is not sealed yet**: live newly-listed discovery, exact-match search relevance, and broader global breadth still need to land and validate, and the main Vitest suite is still failing in parity/runtime-sensitive areas.
8. **Historical chart and OHLC** now has canonical persistence, but longer-horizon policy and hosted-worker operations remain open.
9. **Removed NFT rows** remain intentionally unactioned in the parity matrix and are excluded from the active parity target.

## Known Data-Fidelity Follow-ups

- `/simple/*` and `/coins/markets`: live from CCXT snapshots — data quality is good for supported coins/exchanges.
- `/exchange_rates`: live from currency-api (fiat) and DB snapshot (BTC/ETH) — data quality is good.
- `/coins/{id}`: market_data is live from snapshots; description/links/community/developer are seeded/null — significant gap in enrichment data.
- `/coins/{id}/market_chart`, `/ohlc`, `/ohlc/range`, `/history`: backed by seeded 7-day synthetic candles; real OHLCV accumulates post-boot but top-100-first means most coins stay synthetic.
- `/exchanges/{id}/tickers`: live CCXT ticker ingestion now persists venue rows into `coinTickers`; remaining divergence is mainly depth/trust approximation rather than seeded ownership.
- `/exchanges/{id}/volume_chart*`: accumulated from live ticker refresh cycles into `exchangeVolumePoints`; recent windows are live-backed, but historical breadth is still bounded to retained runtime snapshots rather than deep venue-native archives.
- `/derivatives/*`: fully seeded fixture — 3 tickers, 2 exchanges, frozen at 2026-03-20. No CCXT derivatives fetch exists.
- `/public_treasury/*`: USD values from live snapshots; holdings and transactions are 100% seeded (2 entities, 6 transactions).
- `/onchain/*/top_holders`, `/onchain/*/top_traders`, `/onchain/*/holders_chart`: fixture only (USDC on ETH, fake addresses). All other tokens return empty arrays.
- `/onchain/pool OHLCV` (fallback): 6 synthetic candles when Subsquid returns nothing.
- `/onchain/pool trades` (fallback): 6 synthetic trades when Subsquid returns nothing.
- `/asset_platforms`: now live-backed via canonical CCXT-discovered platform rows; remove older references that still describe it as the original 3-platform seed.
- `/coins/list/new`: still sorted by seeded `createdAt`; live newly-listed discovery is pending in the active platform milestone.
- `/search`: exact-match relevance uplift remains pending even though `/search/trending` has been hardened to honest rank-driven semantics.
- The Graph provider was removed in 08e4b39 — Subsquid is now the sole live-trade provider for onchain pool trades.

## Completed Milestones

Historical delivery log. Entries below record what shipped in each phase; they are not a substitute for the current regression status above.

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
- Completed the R1 core coin endpoint family with seeded compatibility coverage at the time of delivery.
- Added seeded derivatives exchange registry support for `/derivatives/exchanges/list` and `/derivatives/exchanges`, including ordering, pagination, and invalid-order coverage.
- Added the remaining R2 compatibility semantics for `/exchanges/list`, `/exchanges/{id}`, `/exchanges/{id}/tickers`, and `/derivatives`, including exchange status filtering, dex pair formatting, ticker depth toggles, seeded derivatives contracts, and invalid-parameter coverage.
- Completed the R2 exchanges and derivatives endpoint family with seeded compatibility coverage at the time of delivery.
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
- Removed The Graph provider (08e4b39): deleted `src/providers/thegraph.ts`, removed The Graph fallback path from `onchain.ts`, removed `THEGRAPH_API_KEY` env var, removed associated tests. Subsquid is now the sole live-trade provider.

## Update Rules

- Update this file whenever implementation status changes.
- Update this file whenever current priorities or release focus changes.
- Keep statuses factual; do not mark work `done` without code and verification.
