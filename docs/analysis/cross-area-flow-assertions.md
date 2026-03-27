# Cross-Area Flow Assertions

> Behavioral assertions that span multiple milestones in the OpenGecko gap closure mission.
> Each assertion has a clear pass/fail condition and specifies what evidence to collect.

### VAL-CROSS-001: Platform alias resolution enables contract-address routes
Platform ID normalization (milestone 1 — `src/lib/platform-id.ts` alias maps) must produce canonical IDs that `resolveRequestedPlatformIds` in `src/modules/catalog.ts` can match against `asset_platforms` rows seeded by CCXT chain discovery (milestone 2 — `syncChainCatalogFromExchanges`). Contract-address endpoints (`/coins/{platform_id}/contract/{contract_address}`, `/simple/token_price/{id}`) must resolve tokens when the caller uses any supported alias (`eth`, `ethereum`, `erc20`, chain identifier `1`) and the database stores the canonical form (`ethereum`).
**Pass condition:** For every alias in `PLATFORM_ID_BY_ALIAS` and every chain-identifier in `PLATFORM_ID_BY_CHAIN_IDENTIFIER`, calling `/simple/token_price/{alias}?contract_addresses=<known_address>&vs_currencies=usd` returns a 200 with a non-empty price map.
**Evidence:** Integration test that iterates alias variants and asserts HTTP 200 with `usd` key present for a seeded token.

### VAL-CROSS-002: CCXT chain discovery populates asset_platforms consumed by token_lists
`syncChainCatalogFromExchanges` (milestone 2) upserts `asset_platforms` rows with `chainIdentifier`, `name`, and `shortname`. The `/token_lists/{asset_platform_id}/all.json` endpoint (milestone 1 alias work in `src/modules/assets.ts`) reads those rows via `getAssetPlatformById` and uses `chainIdentifier` to populate the token-list `chainId` field and `resolveCoinPlatformContract` to match tokens to contracts.
**Pass condition:** After a fresh `runInitialMarketSync`, `/token_lists/ethereum/all.json` returns status 200 with a `tokens` array where every entry has a numeric `chainId` equal to `1` and a non-empty `address`.
**Evidence:** Test that boots the app, hits the token_lists endpoint, and asserts `chainId === 1` on all returned tokens.

### VAL-CROSS-003: OHLCV worker feeds chart endpoints that global market cap chart depends on
The OHLCV backfill worker (milestone 4 — `runOhlcvBackfillOnce`) writes candles via `upsertCanonicalOhlcvCandle` to the candle store. The live market refresh (milestone 5 — `runMarketRefreshOnce`) writes 1m and 1d candles via `upsertCanonicalCandle`. The `/global/market_cap_chart` endpoint (milestone 1 fix) reads from the `chartPoints` table. If OHLCV and live candle writes fail or produce gaps, the global chart shows missing intervals.
**Pass condition:** After initial sync + at least one OHLCV backfill cycle, `/global/market_cap_chart?vs_currency=usd&days=30` returns a `market_cap_chart` array with no gaps larger than 2× the expected granularity interval, and every value is > 0.
**Evidence:** Integration test that seeds candle data, requests the chart, and asserts monotonic timestamps with bounded gap size.

### VAL-CROSS-004: Live exchange ticker data populates coins/{id} market_data cross-referenced by onchain simple token price
`runMarketRefreshOnce` (milestone 5) writes `market_snapshots` rows consumed by `/coins/{id}` `market_data` fields and by `/simple/price`. The onchain `/onchain/simple/networks/{network}/token_price/{addresses}` endpoint (milestone 3) resolves token prices from pool data. When the same token exists in both CeFi (via CCXT ticker) and DeFi (via onchain pool), the CeFi price in `market_snapshots` and the onchain pool `priceUsd` must not diverge by more than a tolerance threshold for the identity mapping (`findCoinIdForToken`) to remain meaningful.
**Pass condition:** For tokens with both a `market_snapshots` entry (from exchange tickers) and an onchain pool price, the absolute percentage difference between the two prices is < 10% for top-100 coins, verifiable at query time.
**Evidence:** Characterization test that queries both `/simple/price?ids=usd-coin&vs_currencies=usd` and `/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` and compares the returned USD prices.

### VAL-CROSS-005: Full test suite remains green after every milestone
The foundation-fixes milestone (milestone 1) establishes the baseline test suite. Every subsequent milestone (2 through 6) must not introduce regressions. The test suite in `tests/` covers app startup, catalog sync, initial sync, and endpoint behavior.
**Pass condition:** `bun test` exits 0 after each milestone's changes are merged, with no skipped tests that were previously passing.
**Evidence:** CI run log showing `bun test` exit code 0 and test count ≥ previous milestone's count.

### VAL-CROSS-006: First-visit flow — fresh database through all endpoints returning valid responses
A completely fresh SQLite database (no prior state) must survive the full startup lifecycle: `createDatabase` → `migrateDatabase` → `runInitialMarketSync` (exchange metadata → coin catalog → chain catalog → market snapshots) → `seedStaticReferenceData` → `rebuildSearchIndex` → `runStartupPrewarm`. After startup, every registered R0-phase endpoint must return HTTP 200 (not 500 or empty).
**Pass condition:** Boot app with `DATABASE_URL=:memory:`, wait for `onReady`, then sequentially hit `/ping`, `/simple/price?ids=bitcoin&vs_currencies=usd`, `/simple/supported_vs_currencies`, `/asset_platforms`, `/exchange_rates`, `/search?query=bitcoin`, `/global`, `/coins/list`, and `/coins/markets?vs_currency=usd`. All return 200 with non-empty bodies.
**Evidence:** Integration test with in-memory DB that asserts HTTP 200 and `Content-Length > 2` for each endpoint.

### VAL-CROSS-007: Version bump reflects highest user-visible impact across milestones
Per CLAUDE.md versioning rules, `package.json` version must be bumped based on the highest user-visible impact in each change set. Milestone 1 (bug fixes) requires a patch bump. Milestone 2 (new chain-id resolution) requires at least a minor bump. Milestone 3 (new onchain live data endpoints) requires a minor bump. No milestone should ship without a version bump if it contains externally observable behavior changes.
**Pass condition:** After each milestone merge, `package.json` `version` field has been incremented according to SemVer, and the increment type matches or exceeds the highest-impact change (patch for fixes, minor for new endpoints/fields).
**Evidence:** Git diff of `package.json` version field across milestone boundary commits; automated check that version string is strictly greater than the previous milestone's.

### VAL-CROSS-008: Chain normalization (milestone 1-2) feeds onchain network identity (milestone 3)
`resolveCanonicalPlatformId` in `src/lib/platform-id.ts` (milestone 1) normalizes CCXT network IDs into CoinGecko-compatible `asset_platforms` IDs. The onchain module (milestone 3 — `src/modules/onchain.ts`) maps `onchainNetworks.coingeckoAssetPlatformId` back to asset platforms. If chain normalization produces IDs that don't match `onchainNetworks` rows, the onchain `/onchain/networks` endpoint will show networks disconnected from the asset platform catalog.
**Pass condition:** Every `onchainNetworks` row with a non-null `coingeckoAssetPlatformId` has a matching row in `asset_platforms` with the same ID, and `/onchain/networks` response `coingecko_asset_platform_id` values all appear in `/asset_platforms` response IDs.
**Evidence:** Integration test that fetches both endpoints and asserts set inclusion.

### VAL-CROSS-009: Market snapshot freshness gate protects all price-dependent endpoints
The `getSnapshotAccessPolicy` / `getUsableSnapshot` freshness gate (used by `/simple/price`, `/coins/markets`, `/coins/{id}`, `/global`, `/exchange_rates`) depends on `marketFreshnessThresholdSeconds` and `runtimeState.initialSyncCompleted`. If the live exchange data worker (milestone 5) fails to refresh within the threshold, all these endpoints must degrade gracefully (return stale-but-valid data or empty results) rather than crash.
**Pass condition:** With `marketFreshnessThresholdSeconds = 1` and no market refresh for 5 seconds, `/simple/price?ids=bitcoin&vs_currencies=usd` returns either an empty object `{}` or valid stale data without HTTP 500. Same for `/global` and `/coins/markets?vs_currency=usd`.
**Evidence:** Test that boots app, waits past freshness threshold without refresh, and asserts no 5xx responses.

### VAL-CROSS-010: Startup prewarm observes cache benefit from initial sync data
`runStartupPrewarm` (called at end of `onReady` in `src/app.ts`) fires requests against configured target endpoints to warm the `simplePriceCache`. The prewarm depends on `hotDataRevision` being incremented after initial sync populates `market_snapshots`. If initial sync (milestone 1) fails silently or `hotDataRevision` is not bumped, prewarm targets report `cacheHit: false` and first real user requests pay cold-path latency.
**Pass condition:** After app startup with background jobs disabled, `marketDataRuntimeState.startupPrewarm.firstRequestWarmBenefitsObserved` is `true` and at least one prewarm target has `firstObservedRequest.cacheHit === true`.
**Evidence:** Unit test that boots app, inspects `app.marketDataRuntimeState.startupPrewarm` state, and asserts warm benefit observed.

### VAL-CROSS-011: Coin catalog sync feeds search index which feeds /search endpoint
`syncCoinCatalogFromExchanges` (milestone 1-2) populates the `coins` table. `rebuildSearchIndex` (called during startup after coin sync) indexes coin names, symbols, and IDs for the `/search` endpoint. If coin catalog sync discovers new coins (milestone 2 chain-id expansion) but `rebuildSearchIndex` is not re-run, those coins are invisible to search.
**Pass condition:** After `runInitialMarketSync` + `rebuildSearchIndex`, `/search?query=bitcoin` returns a `coins` array containing at least one entry with `id === 'bitcoin'`. After a second `syncCoinCatalogFromExchanges` that adds a new coin followed by `rebuildSearchIndex`, that new coin appears in search results.
**Evidence:** Integration test with two sync cycles, asserting search result inclusion after each rebuild.

### VAL-CROSS-012: Compatibility hardening audit (milestone 6) validates all cross-area flows
The compatibility hardening milestone produces a parity report comparing OpenGecko responses to CoinGecko reference fixtures. This audit must cover at minimum: (a) field-name compatibility for `/simple/price`, `/coins/{id}`, `/coins/markets`, `/global`, `/asset_platforms`; (b) contract resolution via platform aliases; (c) chart granularity rules; (d) onchain JSON:API envelope structure. Any field-name or structural divergence must be documented as an intentional incompatibility per CLAUDE.md product principles.
**Pass condition:** The parity report lists every endpoint family with a compatibility score ≥ 95% for field names and structural shape. Any score < 95% is accompanied by an explicit incompatibility note in the report.
**Evidence:** Automated fixture comparison tool output stored in `docs/status/` with per-endpoint compatibility percentages and linked incompatibility notes.
