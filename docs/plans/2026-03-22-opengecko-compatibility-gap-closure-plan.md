# OpenGecko Compatibility Gap Closure Plan (R4+)

## 1. Purpose

Translate the current compatibility assessment into an execution-ready milestone plan that:

- closes the highest-impact CoinGecko parity gaps first,
- preserves contract compatibility as the primary product constraint,
- moves seeded behavior toward live-backed ownership,
- and adopts broad chain coverage from CCXT metadata as an initial baseline.

This plan is aligned with:

- `docs/plans/2026-03-20-opengecko-coingecko-compatible-api-prd.md`
- `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`
- `docs/plans/2026-03-20-opengecko-engineering-execution-plan.md`
- `docs/status/implementation-tracker.md`

## 2. Scope and Assumptions

### 2.1 Current baseline (from latest assessment)

- Simple + General: 75% (9/12)
- Coins + Contracts + Categories: 80% (16/20)
- Exchanges + Derivatives: 80% (8/10)
- Public Treasury: 100% (5/5)
- Onchain DEX (GeckoTerminal): 7% (2/29)
- Total (excluding NFTs): ~53% (~40/76)

### 2.2 Chain coverage directive

Adopt the requirement to support "all CCXT-supported chains at first" as follows:

- For CEX-facing and contract-resolution surfaces, OpenGecko should ingest and expose network metadata for all chains discoverable from CCXT exchange currency/network metadata across the active exchange set.
- "Support" means normalized network identity, contract/address mapping compatibility where available, and deterministic fallback behavior where mappings are incomplete.
- This does not imply immediate full onchain indexer parity for every chain; it defines the baseline network universe and mapping layer used by public endpoints.

## 3. Strategic Priorities

1. Finish R4 primitive onchain coverage before advanced analytics.
2. Make live data the default owner for hot reads and historical series where practical.
3. Expand canonical ID and chain mapping quality to reduce compatibility drift.
4. Ship high-value missing public endpoints (`/search/trending`, `/coins/top_gainers_losers`) after data foundations are stable.
5. Keep premium/enterprise analytics explicitly out of first parity completion.

## 4. Milestone Plan

## M0 - Foundation Alignment (1 cycle)

Goal: lock decisions and data ownership rules before adding surface area.

Deliverables:

- Confirm chain normalization strategy for all CCXT-discovered networks.
- Define source-of-truth precedence: seeded bootstrap -> live snapshot -> historical store.
- Publish divergence policy per endpoint family for temporary incompatibilities.

Definition of done:

- Chain normalization rules documented and referenced in service/repository boundaries.
- Freshness and fallback policy is explicit for all hot endpoints.
- Tracker priorities updated to include CCXT chain-universe ingestion.

## M1 - Canonical Chain and ID Resolution Expansion (1-2 cycles)

Goal: remove ID/address/network ambiguity as a blocker for parity.

Deliverables:

- Expand canonical mapping coverage for coin slug <-> symbol <-> platform <-> contract.
- Ingest network metadata from all CCXT-supported chains available via active exchanges.
- Add mapping confidence states (exact, heuristic, unresolved) with deterministic behavior.

Definition of done:

- Contract-address endpoints resolve deterministically for supported networks.
- Unresolved mappings return explicit, test-covered compatibility errors (not silent degradation).
- Coverage report produced: mapped vs unresolved by chain.

## M2 - Onchain DEX Primitive Surface (R4 core) (2-3 cycles)

Goal: move Onchain DEX from catalog-only to migration-usable primitives.

Target endpoints (public-first):

- Pool detail/list and multi-fetch variants.
- Token detail/multi/info variants.
- Pool trades and pool OHLCV.
- Onchain simple token price endpoint.
- New pools (network/global) and pool search as secondary target.

Definition of done:

- At least 12-15 onchain endpoints reach contract-complete `partial` or better status.
- JSON:API relationship/include semantics are deterministic and fixture-backed.
- OHLCV and trade routes define explicit empty/stale/fallback behavior.
- Onchain family coverage improves from 7% to >= 45%.

## M3 - Historical Durability and Gap Recovery (1-2 cycles)

Goal: make charts and OHLC behavior resilient and less seed-dependent.

Deliverables:

- Rolling backfill windows and gap detection for historical candles.
- Recovery jobs for missed windows after restart or upstream failure.
- Operational signals for freshness lag and backfill health.

Definition of done:

- `/coins/*/market_chart*` and `/ohlc` read canonical persisted history for supported assets.
- Missing-window repair is deterministic and test-covered.
- 365-day cap is no longer a hidden constraint; retention policy is explicit.

## M4 - High-Impact Public Signal Endpoints (1 cycle)

Goal: improve practical migration coverage for common app experiences.

Target endpoints:

- `/search/trending`
- `/coins/top_gainers_losers`

Definition of done:

- Ranking logic is deterministic, documented, and regression-tested.
- Signal freshness windows and minimum-liquidity rules are explicit.
- Practical migration coverage moves from ~70-75% to >= 80% for public usage patterns.

## M5 - Exchange/Derivative Live-Fidelity Upgrade (1-2 cycles)

Goal: reduce seeded dependence in exchange and derivatives families.

Deliverables:

- Promote live ingestion ownership for exchange ticker/volume paths where practical.
- Expand derivatives venue/contract freshness and ordering parity.

Definition of done:

- `/exchanges*` and `/derivatives*` endpoints prefer live-backed records during normal operation.
- Stale behavior is explicit and observable.
- Remaining seeded-only fields are documented as known divergences.

## M6 - Compatibility Hardening and Release Gate (1 cycle)

Goal: freeze parity claims behind evidence.

Deliverables:

- Full endpoint-family compatibility audit against parity matrix.
- Expanded invalid-parameter and serializer parity fixture coverage.
- Release readiness report with per-family status and divergence list.

Definition of done:

- No endpoint marked `done` without fixture and invalid-parameter coverage.
- Each `partial` endpoint has explicit gap list + exit criteria.
- Total non-NFT parity target reaches >= 70% implemented endpoints with documented fidelity status.

## 5. Endpoint Family Definition of Done (Cross-Milestone)

Each family can be considered operationally complete for a phase only when:

1. Contract shape matches CoinGecko-compatible fields and semantics (including null/omit behavior).
2. Invalid-parameter behavior is explicit and test-covered.
3. Freshness/fallback behavior is explicit and test-covered.
4. Data ownership is documented (seeded vs live vs historical).
5. Known divergences are documented in tracker notes.

Family-specific extra criteria:

- Simple + General: search/global ranking and aggregate semantics are deterministic.
- Coins + Contracts + Categories: contract resolution and historical chart behavior are canonical-store first.
- Exchanges + Derivatives: ticker depth/order and venue ordering semantics are stable.
- Public Treasury: disclosure provenance and transaction chronology are explicit.
- Onchain DEX: include relationships, pool/token identity, and OHLCV/trade semantics are fixture-locked.

## 6. Risks and Mitigations

1. Over-claiming chain support based on partial metadata.
   - Mitigation: enforce mapping confidence states and explicit unresolved-path behavior.

2. Adding endpoints faster than data foundations mature.
   - Mitigation: require M1/M3 criteria before expanding advanced ranking/analytics.

3. Silent stale-data regressions in hot paths.
   - Mitigation: freshness SLO checks and explicit degraded behavior in tests.

4. Onchain scope explosion from premium analytics.
   - Mitigation: keep top traders/holders/megafilter out of first closure plan unless M2 stability is met.

## 7. Not in Scope for This Plan

- NFT endpoint family (intentionally removed from roadmap).
- Full enterprise analytics parity (holders/traders/megafilter and supply-chart families beyond baseline sequencing).
- Immediate support for every non-CCXT custom chain adapter.

## 8. Success Metrics

- Onchain DEX coverage: 7% -> >= 45% after M2.
- Total non-NFT implemented endpoint coverage: ~53% -> >= 70% by M6.
- Practical public migration coverage: ~70-75% -> >= 80% by M4.
- Live-owned read share for hot endpoints and historical endpoints reported in tracker.

## 9. Execution Notes

- Keep milestone updates and status truth in `docs/status/implementation-tracker.md`.
- Use this plan as sequencing guidance; use the parity matrix as endpoint-level scope control.
- Any scope change that affects rollout sequencing or compatibility assumptions must update this plan and the tracker together.
