# Historical Data, Chart, and OHLCV Gap Analysis

**Date:** 2026-03-27  
**Scope:** Test failures root cause, OHLCV architecture, gap analysis, trending/gainers status

---

## 1. Root Cause of Test Failures

### 4 failing tests (3 in app.test.ts + 1 in frontend-contract-script.test.ts)

All failures share the same root cause: **timestamp drift due to Date.now()-based candle seeding combined with hardcoded expected timestamps.**

#### Test A: "returns a named global market cap chart series payload for the requested window" (app.test.ts:3908)

- **Failure:** `expected 0 to be greater than 0` — the `market_cap_chart` array is empty.
- **Root cause:** The `chartPoints` table is seeded with 7 days of static data from `2026-03-14` through `2026-03-20` (see `buildSeededChartPoints()` in `src/db/client.ts:648`). The endpoint at `/global/market_cap_chart?vs_currency=usd&days=7` uses `Date.now()` to compute the 7-day cutoff window (`Date.now() - 7 * 86400000`). On 2026-03-27, this cutoff is ~March 20 00:00 UTC or later, which means all seeded chart points (through March 20 at latest) now fall at or before the cutoff boundary. The query returns 0 points.
- **Why it used to pass:** The test was written when "today" was close enough (≤7 days) to the seeded data range.

#### Test B: "returns coin history, chart, and ohlc data" (app.test.ts:4976)

- **Failure:** Expected timestamp `1774483200000` (2026-03-26 00:00 UTC), received `1774569600000` (2026-03-27 00:00 UTC).
- **Root cause:** Candle data is seeded during `runInitialMarketSync` → `runMarketRefreshOnce`, which calls `upsertCanonicalCandle` with `toDailyBucket(Date.now())`. The daily bucket is computed as the current day's UTC midnight. The test assertions were hardcoded for March 26; today is March 27, so the bucket shifted by exactly 1 day.

#### Test C: "returns categories and contract-address variants" (app.test.ts:5149)

- **Failure:** Same as Test B — `contractChartResponse` expects `[1774483200000, 1]` but receives `[1774569600000, 1]`.
- **Root cause:** Identical timestamp drift. The USD Coin candle is also seeded via `toDailyBucket(Date.now())`.

#### Test D: "passes global contract checks" (frontend-contract-script.test.ts:163)

- **Failure:** The shell script `scripts/modules/global/global.sh` checks that `market_cap_chart` contains `>0` entries with valid `[timestamp, value]` tuples. The response is `{"market_cap_chart": []}`.
- **Root cause:** Same as Test A — seeded chartPoints have aged out of the 7-day window.

### Fix Pattern

These tests need one of:
1. **Dynamic timestamps in assertions** — compute expected timestamps from `toDailyBucket(Date.now())` rather than hardcoding.
2. **Time mocking** — freeze `Date.now()` via `vi.useFakeTimers()` during these tests.
3. **Relative seeding** — change `buildSeededChartPoints()` to seed relative to `Date.now()` instead of a fixed `2026-03-14` base date.

---

## 2. Current OHLCV Architecture

### Storage: `candle-store.ts`
- **Table:** `ohlcvCandles` with composite key `(coinId, vsCurrency, source, interval, timestamp)`.
- **Intervals:** `1m` (minute) and `1d` (daily).
- **Upsert strategy:** `upsertCanonicalOhlcvCandle` does insert-on-conflict-update. Default merge keeps existing open, updates close/volume, and takes max(high)/min(low). `replaceExisting: true` overwrites all OHLCV fields.
- **Helper buckets:** `toMinuteBucket()` floors to nearest minute; `toDailyBucket()` floors to UTC midnight.
- **Read path:** `getCanonicalCandles()` queries by coinId/vsCurrency/interval/range, ordered by timestamp ASC, filtering on `source='canonical'`.

### Chart Series Source
- **`getChartSeries()`** (catalog module) delegates to `getCanonicalCloseSeries()` which reads from the `ohlcvCandles` table (close price as the chart price).
- **`chartPoints`** table is a separate seeded-only legacy table used solely by the global market cap chart endpoint. It is NOT populated by the OHLCV worker.

### Sync: Two-mode approach in `ohlcv-sync.ts`
1. **`syncRecentOhlcvWindow()`** — catches up recent data (last 30 days or from latest cursor forward).
2. **`deepenHistoricalOhlcvWindow()`** — extends backward from the oldest cursor toward `targetHistoryDays` ago.

### Backfill: `ohlcv-backfill.ts`
- **`runOhlcvBackfillOnce()`** — one-shot blocking backfill (default 365 days lookback). This is the older approach that was removed from startup.

### Runtime: `ohlcv-runtime.ts`
- **Continuous worker loop** (`createOhlcvRuntime`) with configurable tick interval (default 60s).
- Each tick: refresh targets → lease next target (priority-sorted) → sync recent → optionally deepen historical → mark success/failure.
- Starts without awaiting at app boot (fire-and-forget in market-runtime.ts).

### Worker State: `ohlcv-worker-state.ts`
- **`ohlcvSyncTargets`** table tracks per-coin/exchange/symbol/interval sync state.
- Fields: `latestSyncedAt`, `oldestSyncedAt`, `targetHistoryDays`, `status` (idle/running/failed), retry metadata with exponential backoff.
- **Leasing:** `leaseNextOhlcvTarget()` picks idle targets sorted by priority tier (top100 > requested > long_tail), then by last success time.

### Target Discovery: `ohlcv-targets.ts`
- **`buildOhlcvSyncTargets()`** resolves coin→exchange symbol pairs by checking CCXT market data for USD-quoted pairs (USDT, USD priority).
- Default `targetHistoryDays: 365`.

### Priority: `ohlcv-priority.ts`
- **`refreshOhlcvPriorityTiers()`** queries top-100 coins by market cap and promotes their sync targets to `top100` tier.

---

## 3. Retention Policy and Gap Analysis

### Current Retention
- **Target history:** 365 days (`targetHistoryDays` default in `ohlcv-targets.ts`).
- **No explicit retention/purge policy.** Data grows unbounded. No TTL or max-age cleanup exists.
- **chartPoints table:** Only has 7 fixed days (March 14-20). This is entirely static/seeded; the OHLCV worker does NOT write to it. This is a **data source mismatch** — the global market cap chart reads from a table the worker never touches.

### Gap Detection Today
- **`summarizeOhlcvSyncStatus()`** in `ohlcv-runtime.ts` computes:
  - `oldest_recent_sync_ms`: max lag of any target's `latestSyncedAt` from now
  - `oldest_historical_gap_ms`: max gap between a target's `oldestSyncedAt` and its desired oldest date
- **Exposed via** `/diagnostics/ohlcv_sync` endpoint.
- **No automatic gap repair.** If candles are missing between `oldestSyncedAt` and `latestSyncedAt`, there is no mechanism to detect or fill interior gaps. The deepening only extends backward from the oldest frontier.

### What's Planned (from docs)
- Per `implementation-tracker.md`: "long-range retention, rolling repair, and explicit recovery-after-gap policies remain open"
- The worker plan (`2026-03-23-top100-priority-ohlcv-worker-plan.md`) describes the current architecture but does not include interior gap detection/repair.
- The compatibility gap closure plan acknowledges chart/OHLC behavior is "partial" — series come from "current seeded historical window" rather than fully live/backfilled sources.

### Key Gaps
1. **chartPoints ↔ ohlcvCandles disconnect:** Global market cap chart reads from `chartPoints` which is seeded-only. Should read from `ohlcvCandles` or be populated by the worker.
2. **Interior gap detection:** No mechanism to find missing candles between cursors.
3. **Retention/purge policy:** Undefined. Data grows forever.
4. **Minute-resolution persistence:** Market refresh writes `1m` candles from ticker data, but no chart endpoints use `1m` interval. Storage cost with no current consumer.
5. **Recovery after restart:** Worker resumes from cursors correctly, but if a provider was down for N days, only forward catch-up is attempted (no detection of the gap period).

---

## 4. Trending and Gainers/Losers Endpoint Status

### `/search/trending` — ✅ IMPLEMENTED
- **Location:** `src/modules/search.ts`
- Returns coins sorted by market cap rank (top N, default 7, configurable via `show_max` query param).
- Returns categories sorted by market cap (top N).
- Returns `nfts: []` stub.
- **Limitation:** "Trending" is approximated by market cap rank, not actual search/view trending data. CoinGecko's trending uses real traffic/engagement signals; this is a static proxy.

### `/coins/top_gainers_losers` — ✅ IMPLEMENTED
- **Location:** `src/modules/coins.ts:217`
- Accepts `vs_currency`, `duration` (24h/7d/14d/30d/60d/200d/1y), `top_coins` query params.
- Computes price change percentage over the requested window using candle series data.
- Returns `{ top_gainers: [...], top_losers: [...] }`.
- **Limitation:** Quality depends on candle data completeness. With only 1 day of live candle data (from market refresh), windows beyond 1 day will produce sparse or empty results until the OHLCV worker builds up history.

---

## 5. Summary of Findings

| Area | Status | Key Issue |
|------|--------|-----------|
| Test failures (3 in app.test.ts) | **Timestamp drift** | Hardcoded timestamps (2026-03-26 midnight) vs Date.now()-based seeding (now 2026-03-27) |
| Test failure (global contract) | **chartPoints aged out** | Static seed data (March 14-20) fell outside the 7-day window |
| OHLCV storage | ✅ Solid | Composite-key upsert, proper bucketing, source-tagged |
| OHLCV sync worker | ✅ Functional | Two-mode (recent/deepen), priority-tiered, retry with backoff |
| Chart data source | ⚠️ Split | `chartPoints` (static seed) vs `ohlcvCandles` (live worker) — global chart reads only from stale seed |
| Gap detection | ⚠️ Frontier-only | Tracks newest/oldest cursors but no interior gap detection |
| Retention policy | ❌ Missing | No purge/TTL defined |
| `/search/trending` | ✅ Implemented | Uses market cap rank as proxy (not real engagement data) |
| `/coins/top_gainers_losers` | ✅ Implemented | Dependent on candle history depth |
