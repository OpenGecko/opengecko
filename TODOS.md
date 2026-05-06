# TODOS

## Review

### Add plan/tracker drift guard tests

**What:** Add automated tests that fail when `docs/status/implementation-tracker.md` and `docs/status/compatibility-audit.md` claim states that contradict runtime behavior.

**Why:** Prevent planning drift and wasted implementation cycles caused by stale documentation.

**Context:** The data-fidelity review found that exchange ticker ingestion and exchange volume accumulation were documented as pending even though `src/services/market-refresh.ts` already performs both live paths. Add a docs consistency guard so this type of mismatch is caught in CI.

**Effort:** M
**Priority:** P1
**Depends on:** None

### Add onchain TTL cache reliability tests

**What:** Add targeted tests for onchain live-catalog TTL cache behavior, including hit, expiry refresh, and degraded fallback.

**Why:** Cache regressions create silent stale data issues and upstream pressure under load.

**Context:** The review decision is to add a 60s TTL cache for `buildLiveOnchainCatalog()` in `src/modules/onchain.ts`. Tests should verify provider call dedupe within TTL, refresh after TTL, and clear fallback behavior when refresh fails.

**Effort:** M
**Priority:** P1
**Depends on:** Implement 60s onchain live-catalog TTL cache

### Time-box renewable enrichment source evaluation

**What:** Run a time-boxed evaluation of renewable external data sources for coin description/links/community/developer enrichment.

**Why:** The prior CCXT-based enrichment task is not technically feasible for CoinGecko-style metadata.

**Context:** Keep current seeded enrichment for now, then evaluate source options with explicit criteria: licensing, update cadence, schema coverage, quality, and fallback policy. Deliverable is a go/no-go recommendation and integration plan.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Completed
