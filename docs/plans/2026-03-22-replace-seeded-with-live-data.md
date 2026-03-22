# Replace Seeded Market Data with Live CCXT Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove ~1200 lines of hardcoded seeded market data; boot the server by fetching real data from CCXT exchanges (binance/coinbase/kraken) and serving it through a hardened freshness/staleness policy.

**Architecture:** Three phases — (1) extract shared utilities + split seed data + create boot-time sync service, (2) integrate OHLCV backfill + rework exchange volumes, (3) two-dimensional freshness model + remove all seeded market constants. Each phase is independently shippable.

**Tech Stack:** Bun + TypeScript + Fastify + SQLite + Drizzle + CCXT + Vitest

---

## Phase 1: Boot-time Live Sync (Core Pipeline)

### Task 1.1: Extract shared coin-id utilities

**Files:**
- Create: `src/lib/coin-id.ts`
- Modify: `src/services/coin-catalog-sync.ts` (import from new module)

**Step 1: Write the failing test**

Create `tests/coin-id.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildCoinId, buildCoinName, COIN_ID_OVERRIDES } from '../src/lib/coin-id';

describe('buildCoinId', () => {
  it('returns override for known symbols', () => {
    expect(buildCoinId('BTC', 'Bitcoin')).toBe('bitcoin');
    expect(buildCoinId('ETH', 'Ethereum')).toBe('ethereum');
    expect(buildCoinId('DOGE', 'Dogecoin')).toBe('dogecoin');
  });

  it('falls back to slugified name for unknown symbols', () => {
    expect(buildCoinId('XYZ', 'Some Token')).toBe('some-token');
  });

  it('falls back to lowercase symbol when name is null', () => {
    expect(buildCoinId('FOO', null)).toBe('foo');
  });
});

describe('buildCoinName', () => {
  it('returns trimmed name when available', () => {
    expect(buildCoinName('BTC', 'Bitcoin')).toBe('Bitcoin');
  });

  it('returns uppercased symbol when name is null', () => {
    expect(buildCoinName('btc', null)).toBe('BTC');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test tests/coin-id.test.ts
```

Expected: FAIL with "Cannot find module '../src/lib/coin-id'"

**Step 3: Create `src/lib/coin-id.ts`**

Extract `COIN_ID_OVERRIDES`, `slugify()`, `buildCoinId()`, `buildCoinName()` from `src/services/coin-catalog-sync.ts` into `src/lib/coin-id.ts`. The code is identical — just move it.

**Step 4: Update `src/services/coin-catalog-sync.ts`**

Replace local definitions with imports from `../lib/coin-id`:

```typescript
import { buildCoinId, buildCoinName, COIN_ID_OVERRIDES } from '../lib/coin-id';
```

Remove the local `COIN_ID_OVERRIDES`, `slugify`, `buildCoinId`, `buildCoinName` definitions.

**Step 5: Run tests to verify they pass**

```bash
bun run test tests/coin-id.test.ts
bun run test
```

Expected: All PASS.

**Step 6: Commit**

```bash
git add src/lib/coin-id.ts tests/coin-id.test.ts src/services/coin-catalog-sync.ts
git commit -m "refactor: extract shared coin-id utilities into src/lib/coin-id.ts"
```

---

### Task 1.2: Split seedReferenceData into static + market

**Files:**
- Modify: `src/db/client.ts` (lines 1244-1281)

**Step 1: Write the failing test**

Create `tests/seed-split.test.ts`:

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq, count } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData } from '../src/db/client';
import { assetPlatforms, categories, coins, marketSnapshots, treasuryEntities } from '../src/db/schema';

describe('seedStaticReferenceData', () => {
  let tempDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-seed-split-'));
    db = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(db);
  });

  afterEach(() => {
    db.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds static reference data without market data', () => {
    seedStaticReferenceData(db);

    const platformCount = db.db.select({ value: count() }).from(assetPlatforms).all()[0].value;
    expect(platformCount).toBeGreaterThan(0);

    const categoryCount = db.db.select({ value: count() }).from(categories).all()[0].value;
    expect(categoryCount).toBeGreaterThan(0);

    const treasuryCount = db.db.select({ value: count() }).from(treasuryEntities).all()[0].value;
    expect(treasuryCount).toBeGreaterThan(0);

    // Market data should NOT be seeded
    const coinCount = db.db.select({ value: count() }).from(coins).all()[0].value;
    expect(coinCount).toBe(0);

    const snapshotCount = db.db.select({ value: count() }).from(marketSnapshots).all()[0].value;
    expect(snapshotCount).toBe(0);
  });

  it('is idempotent', () => {
    seedStaticReferenceData(db);
    seedStaticReferenceData(db);

    const platformCount = db.db.select({ value: count() }).from(assetPlatforms).all()[0].value;
    // Should not double-insert
    expect(platformCount).toBe(3);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test tests/seed-split.test.ts
```

Expected: FAIL with "seedStaticReferenceData is not a function"

**Step 3: Refactor `src/db/client.ts`**

Split the existing `seedReferenceData()` into two functions:

1. `seedStaticReferenceData(database)` — only inserts non-market data:
   - `assetPlatforms` (seededAssetPlatforms)
   - `categories` (seededCategories)
   - `derivativesExchanges` (seededDerivativesExchanges)
   - `derivativeTickers` (seededDerivativeTickers)
   - `treasuryEntities` (seededTreasuryEntities)
   - `treasuryHoldings` (seededTreasuryHoldings)
   - `treasuryTransactions` (seededTreasuryTransactions)
   - `onchainNetworks` (seededOnchainNetworks)
   - `onchainDexes` (seededOnchainDexes)

2. Keep `seedReferenceData(database)` calling `seedStaticReferenceData()` + market data seeds for now (backwards compat until Phase 3).

3. Export both. `initializeDatabase` still calls `seedReferenceData()` for now.

**Step 4: Run test to verify it passes**

```bash
bun run test tests/seed-split.test.ts
bun run test
```

Expected: All PASS.

**Step 5: Commit**

```bash
git add src/db/client.ts tests/seed-split.test.ts
git commit -m "refactor: split seedReferenceData into static and market seed functions"
```

---

### Task 1.3: Create initial-sync service

**Files:**
- Create: `src/services/initial-sync.ts`
- Create: `tests/initial-sync.test.ts`

**Step 1: Write the failing test**

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq, count } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData } from '../src/db/client';
import { coins, exchanges, marketSnapshots, coinTickers } from '../src/db/schema';
import { runInitialMarketSync } from '../src/services/initial-sync';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
}));

import { fetchExchangeMarkets, fetchExchangeTickers } from '../src/providers/ccxt';

describe('initial market sync', () => {
  let tempDir: string;
  let database: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-initial-sync-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    vi.mocked(fetchExchangeMarkets).mockReset();
    vi.mocked(fetchExchangeTickers).mockReset();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('discovers coins and populates market snapshots from CCXT exchanges', async () => {
    vi.mocked(fetchExchangeMarkets).mockResolvedValue([
      { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    ]);
    vi.mocked(fetchExchangeTickers).mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 90_000, bid: 89_950, ask: 90_050, high: null, low: null, baseVolume: 1_000, quoteVolume: 90_000_000, percentage: 2, timestamp: Date.now(), raw: {} },
      ];
      return [];
    });

    const result = await runInitialMarketSync(database, {
      ccxtExchanges: ['binance', 'coinbase', 'kraken'],
      marketFreshnessThresholdSeconds: 300,
    });

    expect(result.coinsDiscovered).toBeGreaterThan(0);
    expect(result.snapshotsCreated).toBeGreaterThan(0);

    const coinCount = database.db.select({ value: count() }).from(coins).all()[0].value;
    expect(coinCount).toBeGreaterThan(0);

    const liveSnapshots = database.db.select().from(marketSnapshots).all();
    expect(liveSnapshots.length).toBeGreaterThan(0);
    for (const snap of liveSnapshots) {
      expect(snap.sourceCount).toBeGreaterThan(0);
    }
  });

  it('creates exchange records from CCXT metadata', async () => {
    vi.mocked(fetchExchangeMarkets).mockResolvedValue([]);
    vi.mocked(fetchExchangeTickers).mockResolvedValue([]);

    await runInitialMarketSync(database, {
      ccxtExchanges: ['binance', 'coinbase', 'kraken'],
      marketFreshnessThresholdSeconds: 300,
    });

    const exchangeRecords = database.db.select().from(exchanges).all();
    expect(exchangeRecords.length).toBe(3);
    const binance = exchangeRecords.find(e => e.id === 'binance');
    expect(binance).toBeDefined();
    expect(binance!.name).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test tests/initial-sync.test.ts
```

Expected: FAIL with "Cannot find module '../src/services/initial-sync'"

**Step 3: Create `src/services/initial-sync.ts`**

The function `runInitialMarketSync(database, config)` does:

1. Call `syncCoinCatalogFromExchanges()` for all configured exchanges (reuse `syncCoinCatalogWithBinance` logic, but generalized — or just call it 3 times, one per exchange)
2. Build symbol index from DB coins
3. For each exchange, call `fetchExchangeTickers()`, upsert market_snapshots, coin_tickers, write quote_snapshots
4. Sync exchanges table from CCXT metadata (id, name, url from exchange instance)
5. Write daily OHLCV candles from snapshot data
6. Return `{ coinsDiscovered, snapshotsCreated, tickersWritten }`

Key design:
- Reuses `buildRequestedSymbolIndex()`, `upsertLiveCoinTicker()`, accumulator logic from `market-refresh.ts`
- Extracts a shared `syncCoinsFromExchange(database, exchangeId)` function
- Reuses `upsertCanonicalCandle()`, `toDailyBucket()` from `candle-store.ts`
- Runs OHLCV backfill for 30 days after snapshot sync

**Step 4: Run test to verify it passes**

```bash
bun run test tests/initial-sync.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/initial-sync.ts tests/initial-sync.test.ts
git commit -m "feat: add initial-sync service for boot-time market data population"
```

---

### Task 1.4: Wire initial-sync into startup flow

**Files:**
- Modify: `src/app.ts` (lines 45-49)
- Modify: `src/services/market-runtime.ts` (add `runInitialSync()` method)
- Modify: `src/db/client.ts` (change `initializeDatabase` to call `seedStaticReferenceData` only)

**Step 1: Write the failing test**

Modify `tests/market-runtime.test.ts` — add:

```typescript
it('runs initial sync before starting refresh loop', async () => {
  const runInitialMarketSync = vi.fn().mockResolvedValue({ coinsDiscovered: 5, snapshotsCreated: 5, tickersWritten: 10 });
  const runCurrencyRefreshOnce = vi.fn().mockResolvedValue(undefined);
  const runMarketRefreshOnce = vi.fn().mockResolvedValue(undefined);
  const runSearchRebuildOnce = vi.fn().mockResolvedValue(undefined);
  const state = { initialSyncCompleted: false, allowStaleLiveService: false, syncFailureReason: null as string | null };

  const runtime = createMarketRuntime({} as never, {
    ccxtExchanges: ['binance'],
    currencyRefreshIntervalSeconds: 300,
    marketRefreshIntervalSeconds: 60,
    searchRebuildIntervalSeconds: 900,
  }, logger, state, {
    runInitialMarketSync,
    runCurrencyRefreshOnce,
    runMarketRefreshOnce,
    runSearchRebuildOnce,
  });

  await runtime.start();

  expect(runInitialMarketSync).toHaveBeenCalledTimes(1);
  expect(state.initialSyncCompleted).toBe(true);
  expect(state.syncFailureReason).toBeNull();
  // Refresh loop should start after initial sync
  expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(1);
  expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test tests/market-runtime.test.ts
```

Expected: FAIL — `runInitialMarketSync` not called, state shape mismatch

**Step 3: Update `src/services/market-runtime-state.ts`**

Replace the 1D state with the 2D state model:

```typescript
export type MarketDataRuntimeState = {
  initialSyncCompleted: boolean;
  allowStaleLiveService: boolean;
  syncFailureReason: string | null;
};

export function createMarketDataRuntimeState(): MarketDataRuntimeState {
  return {
    initialSyncCompleted: false,
    allowStaleLiveService: false,
    syncFailureReason: null,
  };
}
```

**Step 4: Update `src/services/market-runtime.ts`**

Add `runInitialMarketSync` to overrides. In `start()`:
1. Call `runInitialMarketSync()` first
2. On success: set `state.initialSyncCompleted = true`
3. On failure: set `state.syncFailureReason`, check for residual data in DB, set `allowStaleLiveService` if residual data exists
4. Rebuild search index
5. Start refresh loop timers

**Step 5: Update `src/app.ts`**

Change `initializeDatabase` call to only seed static data. The `onReady` hook already calls `runtime.start()` which will now do initial-sync first.

Change `src/db/client.ts`:
- `initializeDatabase()` now calls `migrateDatabase()` + `seedStaticReferenceData()` + `rebuildSearchIndex()`
- Remove the market data from `seedReferenceData()` (keep it as a deprecated function for Phase 3 compat)

**Step 6: Run tests**

```bash
bun run test
```

Expected: All PASS (existing tests that relied on seeded data will need adaptation in later tasks).

**Step 7: Commit**

```bash
git add src/app.ts src/services/market-runtime.ts src/services/market-runtime-state.ts src/db/client.ts tests/market-runtime.test.ts
git commit -m "feat: wire initial-sync into startup flow, remove seeded market data from boot"
```

---

### Task 1.5: Generalize coin catalog sync to multi-exchange

**Files:**
- Modify: `src/services/coin-catalog-sync.ts`
- Create: `tests/coin-catalog-sync.test.ts`

**Step 1: Write the failing test**

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase } from '../src/db/client';
import { coins } from '../src/db/schema';
import { syncCoinCatalogFromExchanges } from '../src/services/coin-catalog-sync';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
}));

import { fetchExchangeMarkets } from '../src/providers/ccxt';

describe('syncCoinCatalogFromExchanges', () => {
  let tempDir: string;
  let database: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-catalog-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    vi.mocked(fetchExchangeMarkets).mockReset();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('discovers coins from multiple exchanges without duplication', async () => {
    vi.mocked(fetchExchangeMarkets).mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId: 'coinbase', symbol: 'SOL/USD', base: 'SOL', quote: 'USD', active: true, spot: true, baseName: 'Solana', raw: {} },
      ];
      return [];
    });

    await syncCoinCatalogFromExchanges(database, ['binance', 'coinbase']);

    const coinRecords = database.db.select().from(coins).all();
    const coinIds = coinRecords.map(c => c.id).sort();
    expect(coinIds).toContain('bitcoin');
    expect(coinIds).toContain('ethereum');
    expect(coinIds).toContain('solana');
    // bitcoin should NOT be duplicated
    expect(coinIds.filter(id => id === 'bitcoin')).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Add `syncCoinCatalogFromExchanges()` to `coin-catalog-sync.ts`**

This function iterates over multiple exchanges, calls `fetchExchangeMarkets()` for each, and uses `buildCoinId()` / `buildCoinName()` from `src/lib/coin-id.ts` to normalize. It deduplicates by canonical coin ID and preserves existing coin data.

**Step 4: Update `initial-sync.ts`** to use `syncCoinCatalogFromExchanges()` instead of `syncCoinCatalogWithBinance()`.

**Step 5: Run tests. Commit.**

---

### Task 1.6: Sync exchange records from CCXT metadata

**Files:**
- Modify: `src/services/initial-sync.ts`

**Step 1: Write the failing test** (add to `tests/initial-sync.test.ts`)

```typescript
it('creates exchange records with CCXT metadata', async () => {
  vi.mocked(fetchExchangeMarkets).mockResolvedValue([]);
  vi.mocked(fetchExchangeTickers).mockResolvedValue([]);

  await runInitialMarketSync(database, {
    ccxtExchanges: ['binance', 'coinbase', 'kraken'],
    marketFreshnessThresholdSeconds: 300,
  });

  const binanceExchange = database.db.select().from(exchanges).where(eq(exchanges.id, 'binance')).get();
  expect(binanceExchange).toBeDefined();
  expect(binanceExchange!.url).toBeTruthy();
});
```

**Step 2: Implement exchange sync in `initial-sync.ts`**

Add a `syncExchangesFromCCXT()` helper that:
- For each configured exchange ID, creates an exchange instance via CCXT
- Reads `exchange.name`, `exchange.urls?.www`
- Upserts into the `exchanges` table with `onConflictDoNothing()` for trust_score/other fields
- Sets `updatedAt` to now

**Step 3: Run tests. Commit.**

---

### Task 1.7: Integrate OHLCV backfill into initial sync

**Files:**
- Modify: `src/services/initial-sync.ts`
- Modify: `src/services/ohlcv-backfill.ts` (extract reusable `runOhlcvBackfillForTargets`)

**Step 1: Write the failing test** (add to `tests/initial-sync.test.ts`)

```typescript
it('runs OHLCV backfill after snapshot sync', async () => {
  vi.mocked(fetchExchangeMarkets).mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
  ]);
  vi.mocked(fetchExchangeTickers).mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 90_000, bid: null, ask: null, high: null, low: null, baseVolume: null, quoteVolume: null, percentage: null, timestamp: Date.now(), raw: {} },
  ]);
  // mock OHLCV
  const { fetchExchangeOHLCV } = await import('../src/providers/ccxt');
  vi.mocked(fetchExchangeOHLCV).mockResolvedValue([
    { timestamp: Date.parse('2026-03-01T00:00:00Z'), open: 80_000, high: 82_000, low: 79_000, close: 81_000, volume: 1_000 },
    { timestamp: Date.parse('2026-03-02T00:00:00Z'), open: 81_000, high: 83_000, low: 80_500, close: 82_500, volume: 1_200 },
  ]);

  const result = await runInitialMarketSync(database, {
    ccxtExchanges: ['binance'],
    marketFreshnessThresholdSeconds: 300,
  });

  expect(result.ohlcvCandlesWritten).toBeGreaterThan(0);
});
```

**Step 2: Extract backfill logic**

Move the core backfill logic from `runOhlcvBackfillOnce()` in `ohlcv-backfill.ts` into a reusable `runOhlcvBackfillForTargets(database, targets, options)` function. Keep `runOhlcvBackfillOnce()` as a wrapper.

**Step 3: Call backfill from `runInitialMarketSync()`**

After snapshot/ticker sync, call `runOhlcvBackfillForTargets()` with `lookbackDays: 30` for subsequent runs, `365` for first-ever runs (check if ohlcv_candles table has any existing rows).

**Step 4: Run tests. Commit.**

---

### Task 1.8: End-to-end integration test

**Files:**
- Create: `tests/integration-live-data.test.ts`

**Step 1: Write the integration test**

Test the full boot flow with mocked CCXT:
1. `buildApp({ config: { startBackgroundJobs: false } })` — should fail to serve market data because no initial sync
2. `buildApp({ config: { startBackgroundJobs: true } })` with mocked CCXT — should serve live data after ready

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockImplementation(async (exchangeId) => {
    if (exchangeId === 'binance') return [
      { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 90_000, bid: 89_950, ask: 90_050, high: 91_000, low: 89_000, baseVolume: 5_000, quoteVolume: 450_000_000, percentage: 3.5, timestamp: Date.now(), raw: {} },
    ];
    return [];
  }),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
}));

describe('live data integration', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-live-'));
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
        startBackgroundJobs: true,
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves live data from /simple/price after boot', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.bitcoin.usd).toBe(90_000);
  });

  it('serves live data from /coins/markets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body[0].current_price).toBe(90_000);
  });
});
```

**Step 2: Run and iterate until all tests pass**

**Step 3: Commit**

```bash
git add tests/integration-live-data.test.ts
git commit -m "test: add integration tests for live CCXT data pipeline"
```

---

## Phase 2: Historical Data & Exchange Volumes

### Task 2.1: OHLCV backfill on every boot

**Files:**
- Modify: `src/services/initial-sync.ts`

**Step 1:** In `runInitialMarketSync()`, after snapshot sync:
- Check `SELECT COUNT(*) FROM ohlcv_candles WHERE interval = '1d'`
- If zero rows: backfill 365 days (first boot)
- If rows exist: backfill last 30 days (incremental update)
- Use `replaceExisting: true` to overwrite stale daily candles

**Step 2: Write a test** verifying the lookback is 365 on first boot and 30 on subsequent boots.

**Step 3: Commit.**

---

### Task 2.2: Rework exchange_volume_points

**Files:**
- Modify: `src/services/market-refresh.ts` (write exchange volume snapshots during each refresh)

**Step 1:** In `runMarketRefreshOnce()`, after processing all tickers:
- For each exchange, sum up all `quoteVolume` values from its tickers
- Write a single `exchange_volume_points` row: `{ exchangeId, timestamp: now, volumeBtc: totalQuoteVolume / btcPrice }`

**Step 2:** Update `exchanges.ts` volume_chart handler to downsample the snapshot data:
- For `days <= 1`: take hourly snapshots
- For `days > 1`: take daily snapshots (last value of each day)

**Step 3: Write tests. Commit.**

---

### Task 2.3: Remove chart_points table usage

**Files:**
- Modify: `src/modules/catalog.ts` — ensure `getChartSeries()` reads from `ohlcv_candles` not `chart_points`
- Modify: `src/db/client.ts` — remove `buildSeededChartPoints()` and `chartPoints` insert

**Step 1:** Verify that all chart endpoints (`/coins/:id/market_chart`, `/coins/:id/ohlc`) read from `ohlcv_candles`.

**Step 2:** Remove `chartPoints` from seed data and `seedReferenceData()`.

**Step 3:** Run all tests. Commit.

---

## Phase 3: Freshness Model & Cleanup

### Task 3.1: Two-dimensional freshness model

**Files:**
- Modify: `src/modules/market-freshness.ts`
- Create/Modify: `tests/market-freshness.test.ts`

**Step 1: Write the failing tests**

```typescript
it('allows stale live data when allowStaleLiveService is true', () => {
  const snapshot = {
    lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
    sourceProvidersJson: '["binance"]',
    sourceCount: 1,
  };

  const result = getUsableSnapshot(
    snapshot,
    300,
    { initialSyncCompleted: false, allowStaleLiveService: true },
    Date.parse('2026-03-20T00:10:00.000Z'),
  );

  expect(result).toEqual(snapshot);
});

it('rejects all seeded snapshots regardless of policy', () => {
  const snapshot = {
    lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
    sourceProvidersJson: '[]',
    sourceCount: 0,
  };

  expect(getUsableSnapshot(
    snapshot,
    300,
    { initialSyncCompleted: true, allowStaleLiveService: false },
    Date.parse('2026-03-20T00:01:00.000Z'),
  )).toBeNull();
});

it('returns null for stale live data when not allowed', () => {
  const snapshot = {
    lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
    sourceProvidersJson: '["binance"]',
    sourceCount: 1,
  };

  expect(getUsableSnapshot(
    snapshot,
    300,
    { initialSyncCompleted: true, allowStaleLiveService: false },
    Date.parse('2026-03-20T00:10:00.000Z'),
  )).toBeNull();
});
```

**Step 2: Refactor `market-freshness.ts`**

Replace `SnapshotAccessPolicy = { allowSeededFallback }` with:

```typescript
export type SnapshotAccessPolicy = {
  initialSyncCompleted: boolean;
  allowStaleLiveService: boolean;
};
```

Update `getSnapshotAccessPolicy()` to read from the new 2D state.

Update `getUsableSnapshot()` logic:
- If `sourceCount === 0` → always return null (no more seeded market data)
- If `sourceCount > 0` and fresh → return snapshot
- If `sourceCount > 0` and stale and `allowStaleLiveService` → return snapshot
- If `sourceCount > 0` and stale and `!allowStaleLiveService` → return null

**Step 3: Update all consumers**

Files that call `getSnapshotAccessPolicy()`:
- `src/modules/simple.ts`
- `src/modules/coins.ts`
- `src/modules/exchanges.ts`
- `src/modules/global.ts`
- `src/lib/conversion.ts`

Update each to pass the new `MarketDataRuntimeState` shape. The function signature change is internal — `getSnapshotAccessPolicy(runtimeState)` just reads different fields now.

**Step 4: Run all tests. Commit.**

---

### Task 3.2: Remove all seeded market data constants

**Files:**
- Modify: `src/db/client.ts` — delete `seededCoins`, `seededSnapshots`, `seededChartPointValues`, `buildSeededChartPoints()`, `buildSeededOhlcvCandles()`, `seededExchanges`, `seededCoinTickers`, `buildSeededExchangeVolumePoints()`, and all related constants (~1200 lines)
- Remove `seedReferenceData()` — keep only `seedStaticReferenceData()`

**Step 1:** After ensuring `seedStaticReferenceData()` is the only seed function called, remove all market data seed constants.

**Step 2:** Remove `chartPoints` import if no longer used.

**Step 3:** Run all tests. Fix any that depended on seeded market data by adapting to mock CCXT responses.

**Step 4: Commit.**

---

### Task 3.3: Update stale-data integration tests

**Files:**
- Modify: `tests/stale-data.test.ts`

**Step 1:** Rewrite the test to use mocked CCXT data instead of seeded data:
1. Mock CCXT to return specific tickers
2. Let initial-sync populate the DB
3. Manually age the snapshots in the DB
4. Verify endpoints return null/degraded responses

**Step 2:** Add test for the `allowStaleLiveService: true` fallback scenario:
1. Populate DB with live data
2. Age snapshots past threshold
3. Set `allowStaleLiveService: true` in runtime state
4. Verify endpoints return the stale data

**Step 3:** Remove the test "keeps seeded snapshots usable before live provider data exists" — no longer applicable.

**Step 4:** Run all tests. Commit.

---

### Task 3.4: Update all remaining tests

**Files:**
- All test files in `tests/`

**Step 1:** Run `bun run test` and identify all failing tests.

**Step 2:** For each failing test:
- If it relied on seeded market data → replace with mock CCXT data + initial-sync
- If it relied on `hasCompletedBootMarketRefresh` → migrate to `initialSyncCompleted`
- If it relied on `allowSeededFallback` → migrate to new 2D model

**Step 3:** Run all tests until green.

**Step 4:** Commit.

---

### Task 3.5: Final verification and documentation update

**Step 1:** Run full test suite:

```bash
bun run test
bun run typecheck
```

**Step 2:** Verify startup with real CCXT (if network available):

```bash
bun run dev
# Wait for boot, then:
curl http://localhost:3000/simple/price?ids=bitcoin&vs_currencies=usd
curl http://localhost:3000/coins/markets?vs_currency=usd
```

**Step 3:** Update documentation:
- Update `CLAUDE.md` if architecture constraints changed
- Update `docs/status/implementation-tracker.md` — mark WS-B Live market ingestion as `done`
- Update `docs/plans/2026-03-21-ccxt-dynamic-data-plan.md` — mark phases complete

**Step 4: Final commit.**

```bash
git add -A
git commit -m "feat: replace seeded market data with live CCXT pipeline

- Extract shared coin-id utilities
- Split seed data into static-only references
- Add boot-time initial sync from 3 CCXT exchanges
- Two-dimensional freshness model (initialSyncCompleted + allowStaleLiveService)
- Remove ~1200 lines of hardcoded market constants
- Integrate OHLCV backfill into startup flow
- All tests adapted to mock CCXT responses"
```

---

## Summary of Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `src/lib/coin-id.ts` | Create | Shared `buildCoinId()`, `buildCoinName()`, `COIN_ID_OVERRIDES` |
| `src/services/initial-sync.ts` | Create | Boot-time market sync orchestrator |
| `src/services/coin-catalog-sync.ts` | Modify | Generalize to multi-exchange `syncCoinCatalogFromExchanges()` |
| `src/services/market-runtime.ts` | Modify | Add `runInitialMarketSync` step before refresh loop |
| `src/services/market-runtime-state.ts` | Modify | 1D → 2D freshness state |
| `src/modules/market-freshness.ts` | Modify | 2D access policy, remove seeded branch |
| `src/services/market-refresh.ts` | Modify | Write exchange volume snapshots |
| `src/services/ohlcv-backfill.ts` | Modify | Extract reusable backfill function |
| `src/db/client.ts` | Modify | Remove ~1200 lines of seed constants, keep static-only |
| `src/app.ts` | Modify | Startup uses initial-sync before accepting requests |
| `tests/*.test.ts` | Modify | Adapt from seeded to mocked CCXT |
| `tests/coin-id.test.ts` | Create | Unit tests for coin-id utilities |
| `tests/initial-sync.test.ts` | Create | Unit tests for initial-sync service |
| `tests/integration-live-data.test.ts` | Create | Integration test for full live pipeline |
