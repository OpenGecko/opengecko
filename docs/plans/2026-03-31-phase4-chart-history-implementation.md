# Phase 4 Chart History Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Increase real chart and OHLC coverage for more active coins by extending canonical `1d` OHLCV backfill beyond the current top-100-first behavior, without changing endpoint contracts.

**Architecture:** Keep `/coins/{id}/market_chart`, `/ohlc`, and `/ohlc/range` reading from canonical `ohlcv_candles` exactly as they do today. Improve fidelity by expanding target selection in the OHLCV worker/backfill pipeline so more active coins receive real `1d` candles, while preserving the top-100-first priority and existing retention model.

**Tech Stack:** Bun + TypeScript + Fastify + SQLite + Drizzle + CCXT + Vitest

---

### Task 1: Define and Test Expanded OHLCV Target Selection

**Files:**
- Modify: `src/services/ohlcv-targets.ts`
- Test: `tests/services/ohlcv-targets.test.ts`

**Step 1: Write the failing test**

Create tests that prove target selection distinguishes:
- top-100 coins
- recently active coins outside top-100
- unsupported long-tail coins

Example test cases:
- coin in top-100 with `BTC/USDT` or `BTC/USD` market -> selected as `top100`
- coin outside top-100 but marked recently active -> selected as `requested` or equivalent mid-tier
- coin with no supported USD quote market -> excluded

**Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/services/ohlcv-targets.test.ts
```

Expected: FAIL because the new active-coin tier behavior does not exist yet.

**Step 3: Write minimal implementation**

In `src/services/ohlcv-targets.ts`:
- keep `top100` behavior unchanged
- add a second tier for active non-top-100 coins seen recently
- continue falling back to `long_tail` exclusion rather than scheduling everything blindly
- keep quote preference `USDT` then `USD`

Implementation requirements:
- do not change endpoint response contracts
- do not remove top-100 priority
- use a deterministic rule for “recently active” based on existing DB state, not ad-hoc randomness

Recommended direction:
- derive recent activity from existing canonical candles or market snapshot/catalog recency already stored in SQLite
- map active non-top-100 targets to `priorityTier: 'requested'`

**Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/services/ohlcv-targets.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/services/ohlcv-targets.test.ts src/services/ohlcv-targets.ts
git commit -m "feat: expand OHLCV target selection for active coins"
```

---

### Task 2: Thread Expanded Targets Through Backfill Runtime

**Files:**
- Modify: `src/services/ohlcv-backfill.ts`
- Modify: `src/services/ohlcv-runtime.ts`
- Modify: `src/services/initial-sync.ts`
- Test: `tests/services/ohlcv-backfill.test.ts`

**Step 1: Write the failing test**

Add tests proving that the backfill/runtime path:
- requests targets from the expanded selector
- preserves top-100-first ordering
- still processes additional active coins after top-100 targets

**Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/services/ohlcv-backfill.test.ts
```

Expected: FAIL because runtime ordering only reflects the old selection model.

**Step 3: Write minimal implementation**

In the runtime/backfill path:
- preserve top-100-first ordering explicitly
- process the new active-coin tier after top-100
- keep long-tail behavior bounded
- do not widen startup scope beyond what the current runtime model can safely handle

Implementation constraints:
- startup should still focus on hot snapshots, not massive historical sync
- the worker remains responsible for durability and deeper history
- avoid introducing a new provider or new persistence table unless strictly necessary

**Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/services/ohlcv-backfill.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/services/ohlcv-backfill.test.ts src/services/ohlcv-backfill.ts src/services/ohlcv-runtime.ts src/services/initial-sync.ts
git commit -m "feat: backfill chart history for active non-top100 coins"
```

---

### Task 3: Add Endpoint-Level Evidence That Real Candles Are Used

**Files:**
- Modify: `src/modules/coins.ts`
- Modify: `src/modules/catalog.ts`
- Test: `tests/modules/coins-history-fidelity.test.ts`

**Step 1: Write the failing test**

Add tests proving that when canonical `1d` candles exist for a non-top-100 active coin:
- `/coins/:id/market_chart`
- `/coins/:id/market_chart/range`
- `/coins/:id/ohlc`
- `/coins/:id/ohlc/range`

return values derived from `ohlcv_candles`, not seeded synthetic chart rows.

**Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/modules/coins-history-fidelity.test.ts
```

Expected: FAIL until the test fixture and route path prove the behavior explicitly.

**Step 3: Write minimal implementation**

Only if needed after reading current code:
- keep `getChartSeries()` and OHLC readers pointed at canonical candles
- add the smallest missing glue or assertions needed to make the behavior explicit and testable
- do not change response shape

Preferred outcome:
- this task is mostly proof via tests, not behavior churn

**Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/modules/coins-history-fidelity.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add tests/modules/coins-history-fidelity.test.ts src/modules/coins.ts src/modules/catalog.ts
git commit -m "test: prove chart endpoints prefer canonical candles"
```

---

### Task 4: Update Canonical Docs and Tracker for Phase 4a

**Files:**
- Modify: `docs/status/implementation-tracker.md`
- Modify: `docs/plans/2026-03-29-data-fidelity-uplift-plan.md`

**Step 1: Write the failing check**

Create a short checklist of statements that must become true:
- Phase 4 status reflects expanded active-coin candle coverage
- tracker no longer implies only top-100 coins can realistically get real candles
- fallback behavior remains honest and documented

**Step 2: Verify current docs fail the checklist**

Read:
```bash
grep -n "top-100\|synthetic\|Phase 4" docs/status/implementation-tracker.md docs/plans/2026-03-29-data-fidelity-uplift-plan.md
```

Expected: docs still describe the older narrower policy.

**Step 3: Write minimal documentation update**

Update both docs to state:
- top-100-first priority still exists
- active non-top-100 coins seen recently now receive canonical `1d` backfill
- synthetic fallback still exists for coins with no real candles

**Step 4: Verify docs reflect new state**

Run the same grep/read check and confirm wording is aligned.

**Step 5: Commit**

```bash
git add docs/status/implementation-tracker.md docs/plans/2026-03-29-data-fidelity-uplift-plan.md
git commit -m "docs: update chart history coverage after phase 4a"
```

---

### Task 5: Final Verification

**Files:**
- No new files required

**Step 1: Run targeted tests**

Run:
```bash
bun test tests/services/ohlcv-targets.test.ts
bun test tests/services/ohlcv-backfill.test.ts
bun test tests/modules/coins-history-fidelity.test.ts
bun test tests/app.test.ts -t "market_chart|ohlc"
```

Expected: PASS

**Step 2: Run typecheck**

Run:
```bash
bun run typecheck
```

Expected: PASS

**Step 3: Commit final follow-up if verification required fixes**

```bash
git add .
git commit -m "test: verify phase 4 chart history rollout"
```

Only create this commit if verification exposed changes that needed fixing.

---

## Notes

- This plan intentionally scopes Phase 4 to **4.1 first**.
- It does **not** change endpoint response contracts.
- It does **not** remove synthetic fallback yet.
- It preserves the product rule that startup stays focused on hot snapshots while the worker owns durable OHLCV history.
- If execution shows the active-coin tier is too expensive, reduce scope before touching endpoint behavior.
