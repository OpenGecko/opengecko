# Testable Behavioral Assertions: Milestones 4–6

---

## Milestone 4: Historical Durability (VAL-HIST)

### VAL-HIST-001: Rolling OHLCV backfill window respects configurable target days
When an OHLCV sync target is created with `targetHistoryDays = N`, `deepenHistoricalOhlcvWindow` computes `desiredOldest = now - N * DAY_MS` and fetches candles starting from that boundary. After a successful backfill cycle, the target's `oldestSyncedAt` must be ≤ `now - N * DAY_MS` (within one candle interval tolerance). Changing `targetHistoryDays` on an existing target must cause the next deepen cycle to extend further back.
Evidence: Unit test that seeds a target with `targetHistoryDays = 90`, runs `deepenHistoricalOhlcvWindow`, and asserts `oldestSyncedAt ≤ now - 90d`. Then updates `targetHistoryDays = 180` and reruns; `oldestSyncedAt` must shift further back.

### VAL-HIST-002: Interior gap detection identifies missing candle windows
Given a canonical candle series for coin X with daily interval where timestamps `[D-10, D-9, D-8, D-6, D-5, D-3]` are present (gaps at D-7 and D-4), a gap detection function must return at least two gap descriptors: `{from: D-8, to: D-6}` and `{from: D-5, to: D-3}`. Each descriptor must include the number of missing candle slots.
Evidence: Unit test that inserts a sparse candle series into `ohlcvCandles`, invokes gap detection, and asserts the returned gap list matches expected boundaries and counts.

### VAL-HIST-003: Interior gap repair fetches and fills missing candle windows
When gap detection identifies a missing window `[D-7]`, the repair function must call `fetchExchangeOHLCV` with `since = D-8 + DAY_MS` and persist returned candles via `upsertCanonicalOhlcvCandle`. After repair, re-running gap detection on the same series must return an empty gap list (or a reduced set).
Evidence: Integration test with mocked CCXT that: (1) seeds sparse candles, (2) runs repair, (3) asserts `getCanonicalCandles` returns a contiguous series and gap detection returns no gaps.

### VAL-HIST-004: OHLCV worker restart recovery resumes from persisted sync state
After the OHLCV runtime processes several targets and is stopped (via `stop()`), restarting the runtime and calling `tick()` must lease the next unprocessed target—not re-process already completed ones. The `lastSuccessAt` and `latestSyncedAt` fields from prior runs must survive across runtime instances.
Evidence: Test that creates a runtime, completes 3 ticks (processing 3 targets), stops the runtime. Creates a new runtime instance over the same database, calls `tick()`, and asserts the 4th target (not targets 1–3) is leased.

### VAL-HIST-005: Failed OHLCV targets use exponential backoff and remain recoverable
When a sync target fails with an error, `markOhlcvTargetFailure` must set `status = 'failed'`, increment `failureCount`, and compute `nextRetryAt = failedAt + 5 * 2^(failureCount-1) minutes`. The target must not be leased again until `now ≥ nextRetryAt`. After `nextRetryAt` passes, the target must be leasable again. A subsequent success must reset `failureCount` to 0 and `nextRetryAt` to null.
Evidence: Unit test sequence: fail a target twice (assert backoff = 5min then 10min), advance clock past `nextRetryAt`, lease and succeed, assert `failureCount = 0`.

### VAL-HIST-006: /coins/{id}/market_chart prefers canonical persisted OHLCV history
When canonical daily candles exist in the `ohlcvCandles` table for a coin, `GET /coins/{id}/market_chart?vs_currency=usd&days=30` must return `prices[]` derived from persisted candle close values—not only from live snapshots. The response timestamps must align with persisted candle timestamps for the historical portion, and the array length must reflect the stored candle count (within granularity downsampling).
Evidence: Seed 30 daily candles for `bitcoin` with known close prices. Call the endpoint. Assert that returned `prices` array contains entries whose values match the seeded close prices (after conversion rate application).

### VAL-HIST-007: /coins/{id}/ohlc prefers canonical persisted OHLCV candles
When canonical OHLCV candles (with distinct open/high/low/close) exist for a coin, `GET /coins/{id}/ohlc?vs_currency=usd&days=14` must return `[timestamp, open, high, low, close]` tuples derived from the persisted candle OHLCV fields—not synthesized from a single close price. At minimum, `open !== close` or `high !== low` when the source candle had distinct values.
Evidence: Seed 14 daily OHLCV candles with `open=100, high=110, low=90, close=105`. Call the endpoint. Assert returned tuples have `open ≈ 100`, `high ≈ 110`, `low ≈ 90`, `close ≈ 105` (within conversion tolerance).

### VAL-HIST-008: Retention policy enforces a maximum persisted history window
When a retention policy is configured (e.g., max 365 days), candles older than `now - retentionDays * DAY_MS` must be prunable. After running retention enforcement, `getCanonicalCandles` for the affected coin must not return any candles with `timestamp < now - retentionDays * DAY_MS`. Candles within the retention window must remain untouched.
Evidence: Seed 500 daily candles spanning 500 days. Run retention enforcement with `retentionDays = 365`. Assert candle count ≤ 365 and all remaining candle timestamps are ≥ `now - 365d`.

### VAL-HIST-009: OHLCV sync summary reports freshness lag and backfill health
`summarizeOhlcvSyncStatus(database, now)` must return: `top100.total` (count of top-100 tier targets), `top100.ready` (count with `latestSyncedAt ≥ now - 1d`), `targets.waiting`/`running`/`failed` counts, `lag.oldest_recent_sync_ms` (maximum age of any target's `latestSyncedAt`), and `lag.oldest_historical_gap_ms` (maximum shortfall between `oldestSyncedAt` and desired oldest). All fields must be non-negative numbers.
Evidence: Seed 5 targets with varying `latestSyncedAt` and `oldestSyncedAt` values. Call `summarizeOhlcvSyncStatus`. Assert each field matches expected computed values.

### VAL-HIST-010: /diagnostics/ohlcv_sync exposes operational sync health
`GET /diagnostics/ohlcv_sync` must return a JSON body with `data.top100`, `data.targets`, and `data.lag` sub-objects matching the `OhlcvSyncSummary` shape. The endpoint must be accessible without authentication and respond with 200.
Evidence: Start the app, seed some OHLCV targets, call the endpoint, assert 200 status and the presence of all expected nested fields.

### VAL-HIST-011: syncRecentOhlcvWindow fills forward from latestSyncedAt
When a target has `latestSyncedAt = D-5`, calling `syncRecentOhlcvWindow(database, target, now)` must fetch candles with `since = D-5 + DAY_MS` (i.e., D-4). When `latestSyncedAt` is null, it must default to `now - 30 * DAY_MS`. Returned candles must be persisted to the canonical candle store.
Evidence: Unit test: set target `latestSyncedAt = now - 5d`, mock `fetchExchangeOHLCV` to return 4 candles, call `syncRecentOhlcvWindow`, assert CCXT was called with `since = latestSyncedAt + DAY_MS` and 4 candles were persisted.

### VAL-HIST-012: Priority tier ordering ensures top-100 coins sync first
When the OHLCV runtime has targets in both `top100` and `long_tail` tiers, `leaseNextOhlcvTarget` must always prefer `top100` targets over `long_tail` targets (given equal `lastSuccessAt`). After all `top100` targets have recent syncs, `long_tail` targets must become leasable.
Evidence: Seed 3 `top100` and 3 `long_tail` targets with `lastSuccessAt = null`. Lease 3 targets sequentially. Assert all 3 are from `top100`. Lease 1 more; assert it is from `long_tail`.

---

## Milestone 5: Exchange Live Fidelity (VAL-EXLF)

### VAL-EXLF-001: Live ticker ingestion populates coin_tickers during normal operation
After `runMarketRefreshOnce` completes successfully with at least one exchange returning tickers, the `coinTickers` table must contain rows with non-null `last`, `lastTradedAt`, and `lastFetchAt` values. For each matched symbol, `convertedLastUsd` and `convertedVolumeUsd` must be computed and non-null.
Evidence: Call `runMarketRefreshOnce` with mocked CCXT returning 2 tickers. Query `coinTickers` and assert ≥ 2 rows with non-null `last`, `convertedLastUsd`, and `convertedVolumeUsd`.

### VAL-EXLF-002: Exchange volume points are recorded with each refresh cycle
After `runMarketRefreshOnce` completes, the `exchangeVolumePoints` table must contain a new row per active exchange with a timestamp close to `now` and a positive `volumeBtc` value. The exchange's `tradeVolume24hBtc` field in the `exchanges` table must also be updated.
Evidence: Call `runMarketRefreshOnce`. Query `exchangeVolumePoints` and assert ≥ 1 row per exchange. Query `exchanges` and assert `tradeVolume24hBtc` > 0 for each active exchange.

### VAL-EXLF-003: /exchanges endpoint returns live-backed trade volume
`GET /exchanges` must return exchange summary objects where `trade_volume_24h_btc` reflects the most recent `runMarketRefreshOnce` cycle's volume data—not stale or zero values. When live data is available and fresh, the volume must be positive for exchanges with known trading activity.
Evidence: Run `runMarketRefreshOnce`, then call `GET /exchanges`. Assert response contains at least one exchange with `trade_volume_24h_btc > 0`.

### VAL-EXLF-004: /exchanges/{id}/tickers returns live-backed ticker records
`GET /exchanges/{id}/tickers` must return `tickers[]` where each ticker has `last`, `volume`, `converted_last`, `converted_volume`, `last_traded_at`, and `last_fetch_at` fields populated from live ingestion. The `is_stale` flag must be `false` when data was fetched within the freshness threshold.
Evidence: Refresh market data, then call `GET /exchanges/binance/tickers`. Assert returned tickers have non-null `last`, `converted_last.usd`, and `is_stale === false`.

### VAL-EXLF-005: Provider failure cooldown prevents refresh during outage
When all exchange ticker fetches fail, `runMarketRefreshOnce` must set `runtimeState.providerFailureCooldownUntil` to `now + 60_000ms` and throw. A subsequent call within the cooldown window must skip processing entirely (no CCXT calls made). After the cooldown expires, the next call must attempt fetches again.
Evidence: Mock all exchanges to reject. Call `runMarketRefreshOnce`, assert it throws. Call again immediately with a spy on `fetchExchangeTickers`—assert the spy was not called. Advance clock past 60s, call again—assert the spy was called.

### VAL-EXLF-006: Partial exchange failure degrades gracefully
When 1 of 3 configured exchanges fails, `runMarketRefreshOnce` must still process tickers from the 2 successful exchanges and not throw. The cooldown must not activate. The log must record the individual exchange failure. Market snapshots and coin tickers must be populated from the successful exchanges.
Evidence: Mock 2 exchanges to succeed, 1 to reject. Call `runMarketRefreshOnce`. Assert no throw, `providerFailureCooldownUntil` is null, and `coinTickers` has rows from the 2 successful exchanges.

### VAL-EXLF-007: Derivatives venue and contract data is fresh and queryable
`GET /derivatives/exchanges` must return venue summary rows with `open_interest_btc` and `trade_volume_24h_btc` fields. `GET /derivatives` must return derivative ticker rows with `funding_rate`, `open_interest_btc`, `spread`, and `last_traded_at` fields. When derivatives data has been ingested, these fields must be non-null.
Evidence: Seed derivatives exchange and ticker rows. Call both endpoints. Assert returned objects contain the expected fields with non-null values.

### VAL-EXLF-008: /exchanges/{id}/volume_chart returns time-bucketed volume history
`GET /exchanges/{id}/volume_chart?days=7` must return an array of `[timestamp, volume_btc]` tuples spanning the last 7 days. For `days ≤ 2`, the granularity must be hourly; for `days > 2`, daily. Timestamps must be sorted ascending. All volume values must be finite numbers.
Evidence: Seed 14 days of `exchangeVolumePoints`. Call with `days=7`. Assert result is a sorted array, all values are `[number, number]`, and timestamps span ≈7 days. Call with `days=1` and assert finer granularity.

### VAL-EXLF-009: Stale ticker data is flagged appropriately
When a coin ticker's `lastTradedAt` is older than the market freshness threshold, the `is_stale` field on the ticker response object must be `true`. When `lastTradedAt` is within the threshold, `is_stale` must be `false`.
Evidence: Seed a coin ticker with `lastTradedAt = now - 2 * thresholdSeconds`. Query the ticker endpoint. Assert `is_stale === true`. Update to a recent time. Re-query. Assert `is_stale === false`.

### VAL-EXLF-010: Exchange detail includes tickers from live data
`GET /exchanges/{id}` must include a `tickers` array populated from the `coinTickers` table for that exchange. The tickers must include `market.name`, `market.identifier`, `base`, `target`, `last`, `volume`, `trust_score`, and conversion fields. If no tickers exist for the exchange, the array must be empty (not missing or null).
Evidence: Seed exchange and coin ticker rows. Call `GET /exchanges/binance`. Assert `tickers` is an array, each entry has `market.identifier === 'binance'` and required fields present.

### VAL-EXLF-011: Forced provider failure blocks market refresh deterministically
When `POST /diagnostics/runtime/provider_failure` sets `active: true`, subsequent `runMarketRefreshOnce` calls must throw immediately with the forced failure reason without making any CCXT calls. When deactivated, refresh must resume normally.
Evidence: Activate forced failure. Call `runMarketRefreshOnce` with a spy on `fetchExchangeTickers`. Assert it throws and the spy was not called. Deactivate. Call again. Assert the spy was called.

### VAL-EXLF-012: Known divergences from CoinGecko exchange data are documented
For each exchange or derivatives endpoint where OpenGecko intentionally diverges from CoinGecko behavior (e.g., trust score calculation, depth approximation, bid-ask spread formula), the divergence must be recorded in a machine-readable or markdown document. The count of documented divergences must be ≥ 1.
Evidence: Check for the existence and non-empty content of a divergence documentation file (e.g., `docs/analysis/exchange-divergences.md` or equivalent) listing at least one known divergence with endpoint, field, and description.

---

## Milestone 6: Compatibility Hardening (VAL-HARD)

### VAL-HARD-001: Full parity matrix audit has been executed and recorded
A compatibility audit document must exist that cross-references every endpoint in the parity matrix (`docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`) with its current implementation status. Each endpoint must be marked as: implemented, partially-implemented, stub, or not-started. The audit must cover all 76 endpoints listed in the matrix.
Evidence: Check for existence of an audit document with ≥ 76 endpoint entries, each having a status classification.

### VAL-HARD-002: All implemented endpoint families have invalid-parameter test coverage
For every endpoint family (simple, coins, exchanges, derivatives, onchain, treasury) with at least one implemented endpoint, `tests/invalid-params.test.ts` must contain at least one test case exercising invalid parameter rejection. The test must assert a 400 status code and an error body with `error` and `message` fields.
Evidence: Parse `tests/invalid-params.test.ts` and assert it contains `it(...)` blocks covering: simple (≥2 tests), coins (≥3 tests), exchanges (≥2 tests), derivatives (≥1 test), onchain (≥2 tests), treasury (≥1 test).

### VAL-HARD-003: Error envelope format is consistent across all endpoint families
All 400-level responses must use the envelope `{ error: string, message: string }`. All 404-level responses must use `{ error: 'not_found', message: string }`. No endpoint may return a different error shape (e.g., Fastify's default `{ statusCode, error, message }` triple) for client errors.
Evidence: The `invalid-params.test.ts` already includes a cross-family consistency test. Extend to cover every implemented family. Assert all error responses match `{ error: string, message: string }` exactly (no extra keys).

### VAL-HARD-004: Serializer fixture coverage exists for all implemented response shapes
For each implemented endpoint that returns a non-trivial response (more than a status object), a response fixture file or inline snapshot must exist that captures the expected field names, types, and nesting structure. The fixture must be used in at least one test assertion.
Evidence: Count distinct endpoint response fixtures in `tests/fixtures/` and inline `toMatchObject` or `toMatchSnapshot` calls in test files. Assert coverage ≥ number of implemented non-trivial endpoints.

### VAL-HARD-005: No endpoint is marked "done" without fixture + invalid-param coverage
The implementation tracker or audit document must enforce a rule: an endpoint's status cannot be "done" or "implemented" unless (a) an invalid-parameter test exists for it in `tests/invalid-params.test.ts` and (b) a response shape fixture or snapshot assertion exists for it. Any endpoint marked "done" without both must be flagged as non-compliant.
Evidence: Cross-reference the audit/tracker "done" endpoints with `invalid-params.test.ts` coverage and fixture presence. Assert zero non-compliant entries.

### VAL-HARD-006: Parity target of ≥ 70% is met across all endpoint families
Compute `parity_percentage = (implemented_endpoints / total_matrix_endpoints) * 100` across the entire parity matrix. The result must be ≥ 70%. Additionally, no individual family (simple, coins, exchanges, derivatives, treasury, onchain) may have 0% implementation if it is in phase R0–R2.
Evidence: Count implemented endpoints per family from the audit. Compute overall and per-family percentages. Assert overall ≥ 70% and no R0–R2 family is at 0%.

### VAL-HARD-007: Per-family compatibility report includes field-level analysis
For each endpoint family, a compatibility report section must document: (a) which response fields are faithfully reproduced, (b) which fields are stubbed or absent, (c) which fields have known value divergences. Each section must list specific field names.
Evidence: Check for a per-family compatibility report (structured document or JSON) with field-level entries. Assert each implemented family has ≥ 1 field-level comparison entry.

### VAL-HARD-008: Pagination parameters are validated uniformly across paginated endpoints
All paginated endpoints (`/coins/markets`, `/exchanges`, `/exchanges/{id}/tickers`, `/derivatives/exchanges`, `/onchain/networks`, etc.) must reject `page=0`, `page=-1`, and `page=abc` with 400 and `{ error: 'invalid_parameter', message: 'Invalid integer value: ...' }`. They must also reject `per_page=0` where applicable.
Evidence: The existing `invalid-params.test.ts` includes a cross-family paging test. Extend to cover all paginated endpoints. Assert uniform error format.

### VAL-HARD-009: Not-found responses are consistent across entity lookups
All entity-lookup endpoints (`/coins/{id}`, `/exchanges/{id}`, `/derivatives/exchanges/{id}`, `/onchain/networks/{network}/dexes`, `/public_treasury/{entity_id}`) must return 404 with `{ error: 'not_found', message: '... not found: {id}' }` when the entity does not exist. No endpoint may return 200 with an empty body or a different error structure.
Evidence: The existing `invalid-params.test.ts` includes a cross-family 404 test. Verify it covers all entity-lookup endpoints. Assert uniform 404 envelope.

### VAL-HARD-010: Chart and time-range endpoints validate bounds consistently
All range-based chart endpoints (`/coins/{id}/market_chart/range`, `/coins/{id}/ohlc/range`, `/exchanges/{id}/volume_chart/range`) must reject: (a) non-numeric `from`/`to` values with 400, (b) `from > to` with 400 and a message about invalid time range. The error envelope must match `{ error: 'invalid_parameter', message: string }`.
Evidence: Existing coverage in `invalid-params.test.ts`. Verify all range endpoints are covered. Assert error messages are consistent.

### VAL-HARD-011: Response field names match CoinGecko snake_case conventions
For all implemented endpoints, response JSON keys must use snake_case naming (e.g., `market_cap_rank`, not `marketCapRank`). No camelCase keys may appear in any response body. This applies to nested objects as well (e.g., `converted_last.usd`, `market.has_trading_incentive`).
Evidence: For each implemented endpoint, call it with valid parameters and recursively inspect all response keys. Assert zero camelCase keys found.

### VAL-HARD-012: Ordering parameter values are validated with helpful error messages
All endpoints accepting an `order` parameter (`/coins/markets`, `/coins/categories`, `/exchanges/{id}/tickers`, `/derivatives/exchanges`, `/coins/{id}/tickers`) must reject unsupported values with 400 and `{ error: 'invalid_parameter', message: 'Unsupported order value: {value}' }`. The message must include the rejected value.
Evidence: Existing coverage in `invalid-params.test.ts`. Verify all order-supporting endpoints are covered. Assert error messages include the bad value.

### VAL-HARD-013: Boolean query parameters reject non-boolean values uniformly
All endpoints accepting boolean query parameters (e.g., `include_platform`, `include_exchange_logo`, `depth`, `include_tickers`, `sparkline`) must reject non-boolean strings (e.g., `maybe`, `yes`, `1`) with either a Zod validation error (400) or a custom `{ error: 'invalid_parameter', message: 'Invalid boolean query value: ...' }` response.
Evidence: Existing partial coverage. Extend to systematically test all boolean params across families. Assert consistent rejection.

### VAL-HARD-014: Precision parameter is validated on all chart endpoints
All endpoints accepting a `precision` parameter (`/simple/price`, `/coins/markets`, `/coins/{id}/market_chart`, `/coins/{id}/ohlc`) must reject non-numeric or out-of-range values with 400. Valid precision values must cause numeric fields to be rounded to the specified decimal places.
Evidence: Test each precision-supporting endpoint with `precision=not-a-number`. Assert 400. Test with `precision=2` and a known price; assert the response value has ≤ 2 decimal places.
