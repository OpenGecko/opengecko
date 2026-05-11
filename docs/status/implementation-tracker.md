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

- Current release focus: `R4 final data automation hardening`
- Current architecture direction: `Bun + TypeScript + Fastify + Zod + SQLite + Drizzle + better-sqlite3 + SQLite FTS5 + CCXT + Vitest`
- Current repository state: `SQLite-first scaffold with CCXT + DeFiLlama + Subsquid live providers, unified in-memory scheduler diagnostics, boot-time hot-snapshot sync, continuous top-100-priority OHLCV worker, Tier 1 through Tier 3 background jobs, 2D freshness model, canonical chain resolution, and broad route coverage across all 76 active non-NFT endpoints. Contract surface coverage is broad. Live/automated or source-attributed hybrid coverage is approximately 86% by endpoint count after the full data automation rollout. Remaining fixture/degraded areas are explicit: paid-indexer-style holder/trader analytics, fixture fallback envelopes, and deep long-tail historical OHLCV are not overclaimed as live.`

## Current Priorities

1. Keep the full validation gate green across test, coverage, typecheck, lint, build, and direct API smoke validation on port `3102`.
2. Operate the unified scheduler and data jobs with safe disable flags, sanitized provider failures, non-overlapping runs, and explicit diagnostics for fallback/degraded states.
3. Maintain retention bounds for append-style source snapshot tables so repeated Tier 1 through Tier 3 runs do not create unbounded SQLite growth.
4. Preserve honest data-quality labeling: live/source-attributed hybrid surfaces may report automated coverage, while paid-indexer-style onchain analytics and deep long-tail historical coverage remain fixture/degraded/out of scope.
5. Continue incremental fidelity improvements without breaking CoinGecko-compatible paths, query semantics, or response field names.

## Data Quality Summary (as of 2026-05-11 final automation hardening)

The system has 4 live/source-attributed data channels: **CCXT** (spot and derivatives metadata/tickers/OHLCV/exchange metadata, coin enrichment), **DeFiLlama** (multi-network pool/token discovery, price/volume/reserve), **Subsquid/SQD-compatible replay** (pool trade feeds with address labels), and **optional HTTP replay/source adapters** for exchange volume, market charts, supply, treasury disclosures, and onchain analytics. These adapters are automated through scheduler/optional-job ownership and retain explicit fallback diagnostics.

| Tier | Coverage | Endpoints | Data source |
|------|----------|-----------|-------------|
| **Live / automated source-backed** (~86%) | Real-time or scheduled source-attributed | `/simple/price`, `/simple/token_price`, `/exchange_rates`, `/coins/markets`, `/asset_platforms`, `/exchanges` metadata, `/exchanges/{id}/tickers`, `/exchanges/{id}/volume_chart*`, `/derivatives*` when CCXT venue rows are available, `/onchain/networks/*/pools`, `/onchain/networks/*/tokens/*`, `/onchain/networks/*/pools/*/trades`, `/coins/{id}`, `/coins/{id}/history`, `/coins/{id}/market_chart`, `/coins/{id}/ohlc`, `/global`, `/global/market_cap_chart`, `/coins/categories*`, `/coins/top_gainers_losers`, `/coins/*/circulating_supply_chart`, `/coins/*/total_supply_chart`, `/search`, `/search/trending` approximation, and treasury disclosure replay surfaces where configured | CCXT + DeFiLlama + Subsquid/SQD + optional source adapters |
| **Hybrid / fallback-safe** (~9%) | Partial live with seeded/degraded envelopes | Long-tail chart/OHLC coverage beyond retained top-100-first candles, source-replay history before live providers are configured, derivatives venues with unsupported/empty CCXT responses, treasury endpoints when no disclosure source rows are present, and onchain pool OHLCV synthetic fallback | Mixed live/replay + seeded fallback |
| **Fixture / out of scope** (~5%) | Explicitly not claimed as live | `/onchain/*/top_holders`, `/onchain/*/top_traders`, `/onchain/*/holders_chart`, paid-indexer-style deep analytics, megafilter-style surfaces, and deep long-tail historical OHLCV parity beyond the retained worker policy | Fixture / out of scope |

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
| WS-G Data fidelity uplift | Replace seeded/fixture data with live sources | done | Phase 2 complete: DeFiLlama multi-network pool/token discovery, CCXT coin enrichment, Subsquid address labels; Phase 3 complete: fixture documentation for derivatives, treasury, onchain analytics, categories, supply charts; live coverage increased from ~30% to ~55% |

## Endpoint Family Progress

| Family | Target phase | Status | Data quality | Notes |
| --- | --- | --- | --- | --- |
| `/ping` | R0 | done | live | CoinGecko-style ping response implemented and tested |
| `/simple/*` | R0 | done | live | `/simple/supported_vs_currencies`, `/simple/price`, `/simple/token_price/{id}`, and `/exchange_rates` are implemented and tested; all backed by live CCXT snapshots or currency-api |
| `/asset_platforms` | R0 | done | live | Canonical CCXT-discovered platforms are now exposed; legacy aliases are suppressed as top-level ids |
| `/token_lists/{asset_platform_id}/all.json` | R1 | done | hybrid | Canonical platform ids remain the discovery surface, token-list rows stay deterministic/symbol-sorted, and supported aliases like `eth` still resolve downstream while unknown platforms fail closed with `404` |
| `/search` | R0 | done | hybrid | FTS5-backed search preserves stable grouped-family keys, rejects blank queries, bounds each family, and `/search/trending` is an explicit volume/price-change approximation rather than CoinGecko social telemetry parity |
| `/global` | R0 | done | automated hybrid | Global aggregators compute current totals and market-cap chart points from market snapshots with fixture fallback only when source data is unavailable |
| `/coins/list` | R0 | done | automated hybrid | Seeded coin registry remains the canonical floor while catalog rescan/discovery jobs can refresh canonical entries without changing contract shape |
| `/coins/list/new` | R1 | partial-live | ccxt-backed canonical discovery | Returns `coins` ordered by canonical `activated_at` from exchange discovery, collapsing duplicate exchange discoveries to the earliest activation while keeping ids reusable across list/search/detail/history surfaces |
| Core coin market endpoints | R1 | partial | hybrid | `/coins/markets` live snapshots now include canonical bootstrap backfill fixes; `/coins/{id}` now includes CCXT-enriched description/links; history/chart/OHLC fidelity work remain pending, and sparklines still rely on seeded/synthetic history |
| `/exchanges/*` | R2 | partial | hybrid | Exchange metadata and list are live from CCXT; `/exchanges/{id}/tickers` is live-backed via persisted CCXT ticker ingestion; `/exchanges/{id}/volume_chart*` is hybrid-from-live, accumulated from the same ticker refresh ownership while historical depth remains limited to retained points |
| `/derivatives/*` | R2 | done | automated hybrid | CCXT derivatives refresh supports configured venues with per-venue degraded/empty diagnostics and fixture fallback clarity; seeded rows remain only as fallback and are not claimed as live when no source rows exist.
| NFTs | removed | removed | — | removed from the active roadmap |
| Public treasury | R3 | done | automated hybrid | Seeded treasury rows remain a safe fallback; disclosure sweep/replay can update source documents, holdings, and transactions with explicit fixture/degraded markers when source-backed data is absent. |
| Onchain DEX | R4 | done | live/hybrid | DeFiLlama multi-network pool/token discovery and Subsquid/source-attributed trade rows are automated; pool OHLCV and token analytics can read source rows when configured; `top_holders`, `top_traders`, and `holders_chart` remain explicitly fixture/out-of-scope without paid indexers. |

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
- **Chart history depth**: Should the system prioritize deeper OHLCV backfill (five-year default for generated targets) vs keeping top-100-first policy and accepting shallow history for most coins?

## Key Gaps

1. **Deep long-tail historical OHLCV remains policy-bounded**: top-100-first worker ownership and retention are intentional; full long-tail historical parity is not claimed.
2. **Paid-indexer-style onchain analytics remain fixture/out of scope by default**: `top_holders`, `top_traders`, `holders_chart`, and megafilter-style surfaces require an approved cost-effective source before they can be promoted.
3. **Replay/source adapters are only live when configured and fresh**: derivatives, supply, treasury, onchain analytics, and chart replay rows expose source/freshness diagnostics; fallback rows remain explicitly marked.
4. **Exchange and market history depth is retained, not infinite**: volume, chart, trade, supply, and source snapshot rows are retention-bounded to protect SQLite deployments.
5. **Removed NFT rows** remain intentionally unactioned in the parity matrix and are excluded from the active parity target.

## Known Data-Fidelity Follow-ups

- `/simple/*` and `/coins/markets`: live from CCXT snapshots — data quality is good for supported coins/exchanges.
- `/exchange_rates`: live from currency-api (fiat) and DB snapshot (BTC/ETH) — data quality is good.
- `/coins/{id}`: market_data is live from snapshots; description/links now enriched from CCXT; community/developer remain seeded/null.
- `/coins/{id}/market_chart`, `/ohlc`, `/ohlc/range`, `/history`: can read source-attributed replay/live rows and canonical OHLCV where present; seeded 7-day synthetic fallback remains for gaps, and top-100-first policy means long-tail history is intentionally bounded.
- `/exchanges/{id}/tickers`: live CCXT ticker ingestion now persists venue rows into `coinTickers`; remaining divergence is mainly depth/trust approximation rather than seeded ownership.
- `/exchanges/{id}/volume_chart*`: accumulated from live ticker refresh cycles into `exchangeVolumePoints`; recent windows are live-backed, but historical breadth is still bounded to retained runtime snapshots rather than deep venue-native archives.
- `/derivatives/*`: CCXT derivatives refresh can ingest source-backed venue rows with degraded/empty diagnostics; seeded fixture rows remain an explicit fallback when no source rows are available.
- `/public_treasury/*`: seeded fixtures remain the default fallback, while disclosure replay/sweep paths can ingest source documents into holdings and transactions; USD values still derive from live snapshots where available.
- `/onchain/networks/*/pools`: now live from DeFiLlama multi-network discovery (ETH, Solana, Avalanche, Fantom); pools are dynamically discovered and enriched with live price/volume/reserve data.
- `/onchain/networks/*/tokens/*`: now live from DeFiLlama with price and decimals enrichment for ETH tokens.
- `/onchain/*/top_holders`, `/onchain/*/top_traders`, `/onchain/*/holders_chart`: fixture/out of scope without an approved paid-indexer-style source; source-attributed analytics rows are supported only when configured.
- `/onchain/pool OHLCV` (fallback): source-attributed rows are preferred when configured; synthetic candles remain an explicit fallback when providers return nothing.
- `/onchain/pool trades` (fallback): source-attributed Subsquid/SQD rows are preferred; synthetic trades remain a fallback and include address labels for known DEX routers and pool addresses.
- `/asset_platforms`: now live-backed via canonical CCXT-discovered platform rows.
- `/coins/list/new`: now uses canonical discovery `activated_at` ordering from CCXT-backed catalog sync.
- `/search`: family-grouped output, blank-query rejection, per-family result bounds, and `/search/trending` approximation semantics are covered; exact-match relevance can still improve incrementally.
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
- **Phase 2 Data Fidelity Uplift (2026-03-31)**: Extended DeFiLlama pool discovery beyond seeded pools with dynamic discovery; added DeFiLlama-based token discovery for ETH with live price/decimals; implemented multi-network DeFiLlama discovery (Solana, Avalanche, Fantom); enriched coin details with CCXT metadata (description/links); added Subsquid address-label enrichment for swap trades. Live data coverage increased from ~30% to ~55%.

## Update Rules

- Update this file whenever implementation status changes.
- Update this file whenever current priorities or release focus changes.
- Keep statuses factual; do not mark work `done` without code and verification.
