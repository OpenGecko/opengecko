# OpenGecko Data Fidelity Uplift Plan

## Context

After a full data audit (2026-03-29), OpenGecko's live data coverage is approximately **30%** by endpoint count. The system has three live providers:

- **CCXT** — 8 CEX tickers, exchange metadata, OHLCV (for top coins)
- **DeFiLlama** — Ethereum pool price/volume/reserve
- **Subsquid** — Ethereum Uniswap V3 raw swap logs (primary; The Graph removed)

All other data is seeded, fixture, or hybrid. This plan addresses the fidelity gap systematically.

This plan is informed by:
- `docs/status/implementation-tracker.md`
- `docs/plans/2026-03-20-opengecko-coingecko-compatible-api-prd.md`
- `docs/plans/2026-03-22-opengecko-compatibility-gap-closure-plan.md`

---

## The Data Fidelity Landscape

For each family, we classify **what is live** vs **what is not**, and decide the uplift path:

### Family: Simple + Global

| Endpoint | Currently | Target |
|---|---|---|
| `/simple/price`, `/simple/token_price` | Live from CCXT snapshots | ✅ Done |
| `/exchange_rates` | Live from currency-api (fiat) + DB snapshot (BTC/ETH) | ✅ Done |
| `/global`, `/global/decentralized_finance_defi` | Live from snapshots (limited catalog) | In progress: expand catalog breadth |
| `/search` | Seeded index, live enrichment | In progress: improve exact-match relevance |
| `/search/trending` | Rank-honest top market-cap proxy (not true trending) | ✅ Done for current honest semantics |
| `/asset_platforms` | Canonical CCXT-discovered platforms | ✅ Done |

### Family: Coins

| Endpoint | Currently | Target |
|---|---|---|
| `/coins/markets` | Live from CCXT snapshots with canonical bootstrap backfill fixes | ✅ Done |
| `/coins/{id}` market_data | Live from snapshots | ✅ Done |
| `/coins/{id}` description/links | Seeded "fixture catalog" / null | In progress: enrich where approved providers can support it |
| `/coins/{id}` community/developer | All null | In progress: keep honest nulls unless a reliable source is added |
| `/coins/{id}` images | 8 coins: CoinGecko URLs; others: test placeholder | In progress: improve image fidelity without breaking contract shape |
| `/coins/{id}/history` | Recent: live snapshots; historical: seeded 7-day synthetic | In progress: tighten history fidelity |
| `/coins/{id}/market_chart` | Seeded synthetic candles (7 days) | In progress: real candles accumulate post-boot |
| `/coins/{id}/ohlc`, `/ohlc/range` | Seeded synthetic candles (7 days) | In progress: real candles accumulate post-boot |
| `/coins/list/new` | Seeded `createdAt` ordering | In progress: implement live coin discovery |
| `/coins/top_gainers_losers` | Live from snapshots, simple ranking | ✅ Done (ranking logic is honest) |
| `/coins/categories*` | Seeded 2 categories | Accepted fixture for this mission unless later follow-up expands it |
| `/coins/*/circulating_supply_chart` | Seeded | Accepted unresolved / fixture-backed |
| `/coins/*/total_supply_chart` | Seeded | Accepted unresolved / fixture-backed |

### Family: Exchanges + Derivatives

| Endpoint | Currently | Target |
|---|---|---|
| `/exchanges/list`, `/exchanges` | Live from CCXT metadata sync | ✅ Done |
| `/exchanges/{id}` | Live from CCXT metadata sync | ✅ Done |
| `/exchanges/{id}/tickers` | Live CCXT-backed ticker ingestion persisted to DB | ✅ Done |
| `/exchanges/{id}/volume_chart` | Hybrid-from-live accumulated from ticker refreshes | ✅ Done for current bounded-history target |
| `/exchanges/{id}/volume_chart/range` | Hybrid-from-live accumulated from ticker refreshes | ✅ Done for current bounded-history target |
| `/derivatives/exchanges/list` | Seeded 2 exchanges | Accepted fixture for now |
| `/derivatives/exchanges/{id}` | Seeded 2 exchanges | Accepted fixture for now |
| `/derivatives` | Seeded 3 tickers (BTC/ETH perpetual + 1 expired) | Accepted fixture for now |
| `/derivatives` ticker `price` | Frozen at 2026-03-20 | Accepted fixture for now |

### Family: Public Treasury

| Endpoint | Currently | Target |
|---|---|---|
| `/entities/list` | Seeded 2 entities | Accepted fixture for now |
| `/:entity/public_treasury/:coin_id` USD value | Live from snapshots | ✅ Done |
| `/public_treasury/{id}` holdings | Seeded (2 entities, fixed BTC amounts) | Accepted fixture for now |
| `/public_treasury/{id}/holding_chart` | Seeded synthetic price series + fixed holdings | Accepted fixture for now |
| `/public_treasury/{id}/transaction_history` | Seeded 6 transactions | Accepted fixture for now |

### Family: Onchain DEX

| Endpoint | Currently | Target |
|---|---|---|
| `/onchain/networks` | Seeded 2 networks (eth, sol) | **Uplift**: DeFiLlama discovers additional networks |
| `/onchain/networks/{id}/dexes` | Seeded 3 DEXes | **Uplift**: DeFiLlama discovers DEXes per network |
| `/onchain/networks/{id}/pools` | Seeded 4 pools + DeFiLlama patches (ETH only) | **Improve**: DeFiLlama pool discovery for ETH; Solana remains seed-only |
| `/onchain/networks/{id}/pools/{id}` | From seeded + DeFiLlama patches | **Improve**: DeFiLlama enrichment for ETH pools |
| `/onchain/networks/{id}/pools/{id}/trades` | Subsquid live swap logs | ✅ Done (ETH only) |
| `/onchain/networks/{id}/pools/{id}/ohlcv` | Subsquid → derived; fallback: 6 synthetic candles | ✅ Done (live path exists; fallback is explicit) |
| `/onchain/networks/{id}/tokens/{id}` | ETH: DeFiLlama price; others: seed-only | **Improve**: DeFiLlama for more tokens on ETH |
| `/onchain/*/top_holders` | Fixture USDC only; all others: empty | Accepted fixture for now |
| `/onchain/*/top_traders` | Fixture USDC only; all others: empty | Accepted fixture for now |
| `/onchain/*/holders_chart` | Fixture USDC only; all others: empty | Accepted fixture for now |
| `/onchain/pool` (OHLCV fallback) | 6 synthetic candles | ✅ Done (fallback is explicit) |
| `/onchain/pool` (trades fallback) | 6 synthetic trades | ✅ Done (fallback is explicit) |

---

## Resolved Decisions

These choices gate specific uplift tasks. Each has a **recommended position** below.

### D1: `/search/trending` semantics
> Rename to `/search/top_coins` and document that it returns top market-cap coins, or implement a real trending signal?

**Decision taken**: Keep the route shape and harden honest rank-driven semantics/documentation for this mission. True trending remains out of scope; the current response is explicitly treated as a top-market-cap proxy rather than a social trending feed.

### D2: `/asset_platforms` — CCXT-based discovery?
> Should we discover platforms dynamically from CCXT exchange metadata instead of 3 seeded platforms?

**Decision taken**: Yes, and this is now implemented. The runtime discovers canonical platforms from CCXT-backed chain metadata and suppresses legacy aliases as top-level platform ids.

### D3: `/derivatives/*` — live data or accept fixture?
> Should we invest in live CCXT derivatives fetch, or accept derivatives as a lower-priority seeded fixture family?

**Decision taken**: Accept fixture for now. Mission follow-up remains focused on keeping derivatives reachable and honestly documented rather than adding a new live derivatives provider path.

### D4: `/exchanges/{id}/tickers` — live ingestion?
> Should we implement live CCXT `fetchTickers` ingestion for exchange tickers, replacing the seeded table?

**Decision taken**: Yes, and this is complete. Exchange tickers are now live-backed via persisted CCXT ingestion and validated in the sealed `exchange-live-fidelity` milestone.

### D5: `/exchanges/{id}/volume_chart` — live accumulation?
> Should we accumulate volume from live tickers into `exchangeVolumePoints`, replacing seeded points?

**Decision taken**: Yes, and this is complete for the current target. Exchange volume routes now accumulate from live ticker refreshes, with bounded retained history rather than deep venue-native archives.

### D6: Onchain `top_holders`, `top_traders`, `holders_chart` — fixture or deprecate?
> These require on-chain indexer data (e.g., Dune Analytics, Nansen, Glassnode) which have prohibitive costs for open-source/self-hosted use. Should we keep them as documented fixture endpoints, or remove them from the router?

**Decision taken**: Keep as documented fixture. The pending onchain analytics workstream is scoped to honesty and contract hardening, not live holder/trader ingestion.

### D7: Treasury — live ingestion or accept fixture?
> Should we ingest real Strategy/MicroStrategy and El Salvador BTC disclosures, or accept the 2-entity fixture as sufficient for development?

**Decision taken**: Accept fixture. Remaining work is to keep treasury routes coherent and documented honestly, not to add disclosure ingestion.

### D8: Chart history — maintain top-100-first or deeper backfill?
> The OHLCV worker prioritizes top-100 coins. Should we keep this policy or implement broader backfill?

**Decision taken**: Keep top-100-first. Remaining chart work is scoped to broader recent active-coin coverage and honest fallback windows rather than full deep backfill for every discovered coin.

### D9: New coins discovery
> Should `/coins/list/new` be a true newly-listed feed, or is the current seeded ordering acceptable?

**Decision taken**: Implement live discovery. This remains one of the next pending platform-and-catalog-discovery tasks.

---

## Uplift Roadmap

### Phase 1: Quick Wins (1-2 cycles)

Status update: exchange ticker ingestion, exchange volume accumulation, rank-honest `/search/trending`, canonical platform discovery, BigNumber calculation foundation, bootstrap catalog repair, and related Bun test compatibility work are complete. The main remaining Phase 1/platform work is live newly-listed coin detection, followed by search/global fidelity uplift before the milestone can validate.

High impact, low effort. All items below are confirmed viable with existing providers.

| # | Task | Endpoints affected | Provider | Effort |
|---|---|---|---|---|
| 1.1 | Live exchange ticker ingestion | `/exchanges/{id}/tickers` | CCXT `fetchTickers` | Complete |
| 1.2 | Live exchange volume accumulation | `/exchanges/{id}/volume_chart`, `/volume_chart/range` | CCXT tickers → `exchangeVolumePoints` | Complete |
| 1.3 | Honest `/search/trending` semantics and docs | `/search/trending` | Market-rank proxy + docs | Complete |
| 1.4 | CCXT-based asset platform discovery at boot | `/asset_platforms` | CCXT exchange metadata scan | Complete |
| 1.5 | Live newly-listed coin detection | `/coins/list/new` | CCXT market diff | Pending |

### Phase 2: Meaningful Uplift (2-3 cycles)

Status update: no Phase 2 feature is sealed yet, but the mission backlog has already been refined into concrete worker tasks for search relevance, global breadth, onchain discovery, token scope, analytics honesty, coin-detail enrichment, and chart/OHLC fidelity.

Medium effort, significant fidelity improvement.

| # | Task | Endpoints affected | Provider | Effort |
|---|---|---|---|---|
| 2.1 | Extend DeFiLlama pool discovery beyond seeded pools | `/onchain/networks/eth/pools` | DeFiLlama `getPools()` | Medium |
| 2.2 | DeFiLlama-based token discovery for ETH | `/onchain/networks/eth/tokens/*` | DeFiLlama `getTokens()` | Medium |
| 2.3 | Multi-network DeFiLlama discovery (Solana, etc.) | `/onchain/networks` | DeFiLlama multi-chain | Medium |
| 2.4 | Coin enrichment: description/links from CCXT | `/coins/{id}` | CCXT exchange markets metadata | Low |
| 2.5 | Subsquid address-label enrichment for swap trades | `/onchain/*/pools/*/trades` | Subsquid → add address labels | Medium |

### Phase 3: Known Fixtures (Documentation + Deprecation)

Status update: the mission has already accepted fixture-first positions for derivatives, treasury, onchain analytics, categories, and unresolved supply-chart surfaces. The remaining work is to harden those runtime families and update canonical docs consistently.

These families are accepted as fixture or have no affordable live source.

| # | Task | Endpoints affected | Action |
|---|---|---|---|
| 3.1 | Document derivatives as fixture | `/derivatives/*` | Add `fixture: true` note in tracker; accept frozen data |
| 3.2 | Document treasury as fixture | `/public_treasury/*` | Add `fixture: true` note in tracker; accept 2-entity scope |
| 3.3 | Document onchain holders/traders as fixture | `/onchain/*/top_holders`, `top_traders`, `holders_chart` | Add `fixture: true` note; document USDC-only scope |
| 3.4 | Document seeded categories as fixture | `/coins/categories*` | Add `fixture: true` note in tracker |
| 3.5 | Remove or stub unresolved supply charts | `/coins/*/circulating_supply_chart`, `total_supply_chart` | Either remove or return empty arrays |

### Phase 4: Chart History (Continuous Worker, No New Provider)

Status update: the top-100-first worker policy remains in force and BigNumber math has been introduced in active calculation-heavy paths. Remaining work is focused on extending recent real-candle coverage and shrinking fallback windows honestly.

| # | Task | Endpoints affected | Notes |
|---|---|---|---|
| 4.1 | Extend OHLCV worker to 7d candles for all active coins | `/coins/{id}/market_chart`, `/ohlc`, `/ohlc/range` | Top-100 already covered; extend to "coins seen in last 30d" |
| 4.2 | Reduce seeded synthetic data window | All chart endpoints | Keep synthetic data only for coins with no real candles; document fallback behavior |

---

## Effort Summary

| Phase | Tasks | Total effort | Impact |
|---|---|---|---|
| Phase 1 | 5 | 4 complete, 1 pending | Exchange and platform fidelity gaps substantially reduced |
| Phase 2 | 5 | pending | Significant onchain coverage uplift, coin enrichment |
| Phase 3 | 5 | pending | Runtime honesty + documentation alignment for accepted fixture families |
| Phase 4 | 2 | pending | Chart history improvement |
| **Total** | **17** | mission in progress | Live coverage target remains approximately **~30% → ~55%** |

---

## Non-Goals (Explicitly Out of Scope)

- **NFT endpoints**: removed from roadmap
- **True social/trending signals** for `/search/trending`: requires separate data pipeline
- **Live derivatives data**: accepted as fixture unless a concrete use case emerges
- **On-chain holder/trader indexer data**: no affordable source for open-source/self-hosted use
- **365-day backfill for all coins**: rate-limit and storage prohibitive; top-100-first is the right policy
- **Real-time WebSocket feeds**: HTTP REST is the primary delivery model
- **Custom exchange adapters** beyond CCXT: only if CCXT materially lacks required data

---

## Success Metrics

| Metric | Before | After (target) |
|---|---|---|
| Live data coverage by endpoint count | ~30% | ~55% |
| Endpoints with explicit fixture label | 0 | 5 families |
| Endpoints served from seeded-only data | ~35% | ~20% |
| Exchange ticker data freshness | Seeded (frozen) | Live (60s refresh) |
| Exchange volume data source | Seeded | Live (accumulated) |
| Onchain pool coverage | 4 seeded ETH pools | DeFiLlama-discovered ETH pools |
| Onchain multi-network coverage | 2 seeded networks | DeFiLlama-discovered networks |

---

## Execution Notes

- Execute by phase: the exchange-live-fidelity milestone is sealed; platform-and-catalog-discovery is the current active milestone.
- Each task should update the tracker: mark family status, update "Data quality" column.
- After Phase 3 documentation, the tracker should accurately reflect fixture families with explicit labels.
- Any task that requires a new external provider dependency must be approved as a new Active Decision before implementation.
- Current next tasks: `new-listings-discovery-propagation`, `search-relevance-uplift`, and `global-catalog-breadth-uplift`.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 24 issues, 1 critical gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

- **UNRESOLVED:** 0
- **VERDICT:** Mission execution proceeded with user approval despite open eng-review findings; continue reconciling plan/tracker/docs with actual shipped behavior.
