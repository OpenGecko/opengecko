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
| `/global`, `/global/decentralized_finance_defi` | Live from snapshots (limited catalog) | **Improve**: expand catalog breadth |
| `/search` | Seeded index, live enrichment | **Improve**: true search relevance |
| `/search/trending` | Top market-cap rank, not trending | **Decide**: rename to reflect reality or implement real trending signal |
| `/asset_platforms` | 3 seeded platforms | **Decide**: implement CCXT-based platform discovery |

### Family: Coins

| Endpoint | Currently | Target |
|---|---|---|
| `/coins/markets` | Live from CCXT snapshots | ✅ Done |
| `/coins/{id}` market_data | Live from snapshots | ✅ Done |
| `/coins/{id}` description/links | Seeded "fixture catalog" / null | **Uplift**: enrich from CCXT or accept as known divergence |
| `/coins/{id}` community/developer | All null | **Decide**: accept null or fetch from optional source |
| `/coins/{id}` images | 8 coins: CoinGecko URLs; others: test placeholder | **Decide**: accept placeholder or fetch from CCXT |
| `/coins/{id}/history` | Recent: live snapshots; historical: seeded 7-day synthetic | **Uplift**: real candles accumulate post-boot |
| `/coins/{id}/market_chart` | Seeded synthetic candles (7 days) | **Uplift**: real candles accumulate post-boot |
| `/coins/{id}/ohlc`, `/ohlc/range` | Seeded synthetic candles (7 days) | **Uplift**: real candles accumulate post-boot |
| `/coins/list/new` | Seeded `createdAt` ordering | **Decide**: implement live coin discovery or accept as fixture |
| `/coins/top_gainers_losers` | Live from snapshots, simple ranking | ✅ Done (ranking logic is honest) |
| `/coins/categories*` | Seeded 2 categories | **Decide**: implement live category discovery |
| `/coins/*/circulating_supply_chart` | Seeded | **Accept**: no live source readily available |
| `/coins/*/total_supply_chart` | Seeded | **Accept**: no live source readily available |

### Family: Exchanges + Derivatives

| Endpoint | Currently | Target |
|---|---|---|
| `/exchanges/list`, `/exchanges` | Live from CCXT metadata sync | ✅ Done |
| `/exchanges/{id}` | Live from CCXT metadata sync | ✅ Done |
| `/exchanges/{id}/tickers` | Seeded `coinTickers` table (not live) | **Uplift**: implement live CCXT `fetchTickers` ingestion |
| `/exchanges/{id}/volume_chart` | Seeded `exchangeVolumePoints` (not accumulated) | **Uplift**: accumulate from live ticker volumes |
| `/exchanges/{id}/volume_chart/range` | Same as above | **Uplift**: same as above |
| `/derivatives/exchanges/list` | Seeded 2 exchanges | **Decide**: implement CCXT derivatives exchange discovery |
| `/derivatives/exchanges/{id}` | Seeded 2 exchanges | **Decide**: same as above |
| `/derivatives` | Seeded 3 tickers (BTC/ETH perpetual + 1 expired) | **Decide**: implement CCXT derivatives ticker fetch |
| `/derivatives` ticker `price` | Frozen at 2026-03-20 | **Decide**: same as above |

### Family: Public Treasury

| Endpoint | Currently | Target |
|---|---|---|
| `/entities/list` | Seeded 2 entities | **Decide**: add more entities or accept as dev fixture |
| `/:entity/public_treasury/:coin_id` USD value | Live from snapshots | ✅ Done |
| `/public_treasury/{id}` holdings | Seeded (2 entities, fixed BTC amounts) | **Decide**: accept as dev fixture or ingest real disclosures |
| `/public_treasury/{id}/holding_chart` | Seeded synthetic price series + fixed holdings | **Decide**: same as above |
| `/public_treasury/{id}/transaction_history` | Seeded 6 transactions | **Decide**: same as above |

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
| `/onchain/*/top_holders` | Fixture USDC only; all others: empty | **Decide**: no affordable source → accept fixture or deprecate |
| `/onchain/*/top_traders` | Fixture USDC only; all others: empty | **Decide**: no affordable source → accept fixture or deprecate |
| `/onchain/*/holders_chart` | Fixture USDC only; all others: empty | **Decide**: no affordable source → accept fixture or deprecate |
| `/onchain/pool` (OHLCV fallback) | 6 synthetic candles | ✅ Done (fallback is explicit) |
| `/onchain/pool` (trades fallback) | 6 synthetic trades | ✅ Done (fallback is explicit) |

---

## Open Decisions (Must Answer Before Executing)

These choices gate specific uplift tasks. Each has a **recommended position** below.

### D1: `/search/trending` semantics
> Rename to `/search/top_coins` and document that it returns top market-cap coins, or implement a real trending signal?

**Recommended**: Rename. True trending requires a separate data pipeline (social volume, search volume, news) that is out of scope for a CEX/DEX API. The current "top market-cap" behavior is honest — rename it in the route handler and docs.

### D2: `/asset_platforms` — CCXT-based discovery?
> Should we discover platforms dynamically from CCXT exchange metadata instead of 3 seeded platforms?

**Recommended**: Yes. CCXT's exchange metadata already lists which chains each exchange supports. A one-time scan at boot can populate `asset_platforms` dynamically. This removes the need for a hardcoded seed list and makes platform discovery self-sustaining.

### D3: `/derivatives/*` — live data or accept fixture?
> Should we invest in live CCXT derivatives fetch, or accept derivatives as a lower-priority seeded fixture family?

**Recommended**: Accept fixture for now. CCXT derivatives support varies by exchange and requires significant endpoint-specific work. Derivatives are low-frequency compared to spot. Mark derivatives as `fixture` in the tracker and revisit if a real use case demands live derivatives data.

### D4: `/exchanges/{id}/tickers` — live ingestion?
> Should we implement live CCXT `fetchTickers` ingestion for exchange tickers, replacing the seeded table?

**Recommended**: Yes. This is high-value: exchange tickers are a core API surface. Implement a periodic `fetchTickers` from each configured exchange and upsert into `coinTickers` during market refresh. Estimated: 1 task.

### D5: `/exchanges/{id}/volume_chart` — live accumulation?
> Should we accumulate volume from live tickers into `exchangeVolumePoints`, replacing seeded points?

**Recommended**: Yes. During market refresh, sum all `quoteVolume` values from tickers per exchange and write one volume snapshot point per refresh cycle. Estimated: 1 task.

### D6: Onchain `top_holders`, `top_traders`, `holders_chart` — fixture or deprecate?
> These require on-chain indexer data (e.g., Dune Analytics, Nansen, Glassnode) which have prohibitive costs for open-source/self-hosted use. Should we keep them as documented fixture endpoints, or remove them from the router?

**Recommended**: Keep as documented fixture. These endpoints exist in the CoinGecko API and removing them would create a contract gap. Document them clearly as "fixture data for USDC on Ethereum; returns empty for all other tokens" in the tracker and route comments.

### D7: Treasury — live ingestion or accept fixture?
> Should we ingest real Strategy/MicroStrategy and El Salvador BTC disclosures, or accept the 2-entity fixture as sufficient for development?

**Recommended**: Accept fixture. Real treasury disclosures require manual curation (Strategy's SEC filings, El Salvador's official announcements). No automated feed exists. Keep the fixture, add a note that this is intentionally limited, and revisit if a specific use case requires it.

### D8: Chart history — maintain top-100-first or deeper backfill?
> The OHLCV worker prioritizes top-100 coins. Should we keep this policy or implement broader backfill?

**Recommended**: Keep top-100-first. A full 365-day backfill for all discovered coins would be prohibitively expensive in API rate limits and storage. Top-100-first is the right policy. The 7-day seeded synthetic candles provide a graceful degradation for coins without real history.

### D9: New coins discovery
> Should `/coins/list/new` be a true newly-listed feed, or is the current seeded ordering acceptable?

**Recommended**: Implement live discovery. During each market refresh, newly discovered coins (not in the existing catalog) can be marked as `newly_listed` based on when they first appeared in CCXT exchange markets. Estimated: 1 task.

---

## Uplift Roadmap

### Phase 1: Quick Wins (1-2 cycles)

High impact, low effort. All items below are confirmed viable with existing providers.

| # | Task | Endpoints affected | Provider | Effort |
|---|---|---|---|---|
| 1.1 | Live exchange ticker ingestion | `/exchanges/{id}/tickers` | CCXT `fetchTickers` | Low |
| 1.2 | Live exchange volume accumulation | `/exchanges/{id}/volume_chart`, `/volume_chart/range` | CCXT tickers → `exchangeVolumePoints` | Low |
| 1.3 | Rename `/search/trending` → documented "top market-cap" | `/search/trending` | N/A (route rename + docs) | Trivial |
| 1.4 | CCXT-based asset platform discovery at boot | `/asset_platforms` | CCXT exchange metadata scan | Medium |
| 1.5 | Live newly-listed coin detection | `/coins/list/new` | CCXT market diff | Medium |

### Phase 2: Meaningful Uplift (2-3 cycles)

Medium effort, significant fidelity improvement.

| # | Task | Endpoints affected | Provider | Effort |
|---|---|---|---|---|
| 2.1 | Extend DeFiLlama pool discovery beyond seeded pools | `/onchain/networks/eth/pools` | DeFiLlama `getPools()` | Medium |
| 2.2 | DeFiLlama-based token discovery for ETH | `/onchain/networks/eth/tokens/*` | DeFiLlama `getTokens()` | Medium |
| 2.3 | Multi-network DeFiLlama discovery (Solana, etc.) | `/onchain/networks` | DeFiLlama multi-chain | Medium |
| 2.4 | Coin enrichment: description/links from CCXT | `/coins/{id}` | CCXT exchange markets metadata | Low |
| 2.5 | Subsquid address-label enrichment for swap trades | `/onchain/*/pools/*/trades` | Subsquid → add address labels | Medium |

### Phase 3: Known Fixtures (Documentation + Deprecation)

These families are accepted as fixture or have no affordable live source.

| # | Task | Endpoints affected | Action |
|---|---|---|---|
| 3.1 | Document derivatives as fixture | `/derivatives/*` | Add `fixture: true` note in tracker; accept frozen data |
| 3.2 | Document treasury as fixture | `/public_treasury/*` | Add `fixture: true` note in tracker; accept 2-entity scope |
| 3.3 | Document onchain holders/traders as fixture | `/onchain/*/top_holders`, `top_traders`, `holders_chart` | Add `fixture: true` note; document USDC-only scope |
| 3.4 | Document seeded categories as fixture | `/coins/categories*` | Add `fixture: true` note in tracker |
| 3.5 | Remove or stub unresolved supply charts | `/coins/*/circulating_supply_chart`, `total_supply_chart` | Either remove or return empty arrays |

### Phase 4: Chart History (Continuous Worker, No New Provider)

| # | Task | Endpoints affected | Notes |
|---|---|---|---|
| 4.1 | Extend OHLCV worker to 7d candles for all active coins | `/coins/{id}/market_chart`, `/ohlc`, `/ohlc/range` | Top-100 already covered; extend to "coins seen in last 30d" |
| 4.2 | Reduce seeded synthetic data window | All chart endpoints | Keep synthetic data only for coins with no real candles; document fallback behavior |

---

## Effort Summary

| Phase | Tasks | Total effort | Impact |
|---|---|---|---|
| Phase 1 | 5 | ~1.5 cycles | Removes 2 major seeded gaps (exchange tickers/volume), improves 3 |
| Phase 2 | 5 | ~2.5 cycles | Significant onchain coverage uplift, coin enrichment |
| Phase 3 | 5 | ~0.5 cycles | Documentation; no code changes |
| Phase 4 | 2 | ~1 cycle | Chart history improvement |
| **Total** | **17** | **~5.5 cycles** | **Live coverage: ~30% → ~55%** |

---

## Non-Goals (Explicitly Out of Scope)

- **NFT endpoints**: removed from roadmap
- **True social/trending signals** for `/search/trending`: requires separate data pipeline
- **Live derivatives data**: accepted as fixture unless a concrete use case emerges
- **On-chain holder/trader indexer data**: no affordable source for open-source/self-hosted use
- **365-day backfill for all coins**: rate-limit and storage prohibitive; top-100-first is the right policy
- **Real-time WebSocket feeds**:bun: bun: HTTP REST is the primary delivery model
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

- Execute by phase: complete Phase 1 before starting Phase 2.
- Each task should update the tracker: mark family status, update "Data quality" column.
- After Phase 3 documentation, the tracker should accurately reflect fixture families with explicit labels.
- Any task that requires a new external provider dependency must be approved as a new Active Decision before implementation.
- Update `docs/plans/2026-03-22-opengecko-compatibility-gap-closure-plan.md` Milestone M5 (Exchange/Derivative Live-Fidelity Upgrade) to reference this plan's Phase 1 tasks.
