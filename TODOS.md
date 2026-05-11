# TODOS

## Review

No active review items.

## Completed

### Add plan/tracker drift guard tests

**Status:** Completed.

**Resolution:** Covered by `tests/docs-drift.test.ts`, including assertions that:

- `docs/status/implementation-tracker.md` coverage counts, percentages, and family ownership rows are derived from `src/services/coverage-matrix.ts`.
- `docs/status/implementation-tracker.md` cannot claim a family is `live` unless the coverage matrix builder reports `live`.
- `docs/status/compatibility-audit.md` active non-NFT endpoint counts and implemented route rows match the registered CoinGecko-compatible GET routes.

**References:** `tests/docs-drift.test.ts`, `docs/status/implementation-tracker.md`, `docs/status/compatibility-audit.md`, and `/diagnostics/coverage_matrix`.

## Deferred with rationale

### Add onchain TTL cache reliability tests

**Status:** Deferred.

**Rationale:** The scoped TTL helper does not exist in `src/modules/onchain.ts`. Current route code imports `buildLiveOnchainCatalog()` from `src/modules/onchain/pools.ts`, where the existing module-level promise only coalesces in-flight provider discovery; it does not implement a 60-second hit/expiry cache surface with deterministic time injection for hit, expiry refresh, and degraded fallback assertions.

**Responsible plan:** Defer to the provider resilience and hot-route cache work tracked in `docs/plans/2026-05-05-opengecko-improvement-guide.md`, where a future implementation can add the cache helper and focused tests together.

**Depends on:** Implement a 60-second onchain live-catalog TTL cache with injectable time/provider seams.

### Time-box renewable enrichment source evaluation

**Status:** Deferred.

**Rationale:** Renewable external sources for CoinGecko-style description, links, community, and developer metadata need a licensing/schema/update-cadence review before implementation. The current API remains explicit that coin detail enrichment is seeded/source-capable rather than full live metadata parity.

**Responsible plan:** Track source evaluation criteria and go/no-go planning in `docs/plans/2026-05-05-opengecko-improvement-guide.md` under the data fidelity and improvement prioritization work.
