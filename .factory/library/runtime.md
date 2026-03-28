# Runtime Hardening

Runtime-specific facts and guidance for the runtime hardening mission.

**What belongs here:** startup lifecycle facts, provider/runtime seams, cache/fallback rules, and runtime-specific validation gotchas.
**What does NOT belong here:** service commands/ports (use `.factory/services.yaml`) or mission status.

---

- The committed mission baseline already includes CCXT exchange pooling in `src/providers/ccxt.ts` plus shutdown cleanup from `src/app.ts`.
- Provider fanout sites to inspect first include:
  - `src/services/market-refresh.ts`
  - `src/services/initial-sync.ts`
  - catalog sync paths that still fan out across exchanges
- Startup currently performs heavy initial sync before the listener becomes reachable; readiness must be reasoned about separately from process existence.
- Fastify transport hooks cannot reliably infer JSON response size from `reply.getHeader('content-length')` inside `onSend`; many JSON replies have no `Content-Length` yet at that stage, so compression thresholds must inspect the payload bytes directly if they need size-based gating.
- The shared HTTP app test fixture auto-completes bootstrap before `inject`, so route-level tests cannot model a true pre-ready startup listener state; use runtime-state/diagnostics-focused tests for pre-ready assertions instead of expecting `app.inject()` to observe the pre-bind phase.
- Operational-controls follow-up validation confirmed a live server started via `src/server.ts` exposes `/metrics` and `/diagnostics/runtime` after readiness; validators should still verify live-server route availability explicitly instead of assuming parity with `app.inject()` coverage.
- Startup prewarm evidence now lives on both surfaces: `/diagnostics/runtime` exposes `startup_prewarm` fields for configured targets/status/budget observations, and Prometheus metrics expose `opengecko_startup_prewarm_*` series plus first-request warm-observation counters. Validators should use those surfaces together when proving warm-start benefit or diagnosing mismatched prewarm attribution.
- Existing runtime state already tracks:
  - `initialSyncCompleted`
  - `allowStaleLiveService`
  - `syncFailureReason`
- Fresh-boot zero-live behavior is now intentionally explicit: when initial sync completes with no usable live snapshots on that boot, runtime state preserves `initialSyncCompletedWithoutUsableLiveSnapshots`, `/diagnostics/runtime` exposes the zero-live state, and only `/simple/price` plus `/simple/token_price/*` convert that condition into a `503 { error, message }` envelope instead of returning `{}`.
- Mission decision for local/default bootstrap: when `buildApp({ startBackgroundJobs: false })` is used and persisted snapshot rows are available, shared bootstrap/runtime code should import those persisted snapshot rows rather than seeding only a tiny canonical fixture subset. Keep this centralized in bootstrap/runtime helpers, not route-local logic.
- For `/coins/markets` and `/coins/{id}` parity, prefer enriching the persisted corpus that runtime imports from instead of fabricating broader fixture-only bootstrap rows. Keep persisted-corpus parity tests separate from fixture-backed `test.db` app tests when their expectations differ.
- Imported persisted rows existing in the bootstrap-only in-memory runtime is not sufficient by itself: if `initialSyncCompleted` is true and `allowStaleLiveService` is false, `getUsableSnapshot` can still hide those imported rows from `/coins/markets`, `/coins/{id}`, `/simple/price`, and `/simple/token_price`. Default/local bootstrap parity work must align access-policy state with the intended seeded-runtime source.
- Hot-endpoint cache coherence now also depends on `hotDataRevision` in `src/services/market-runtime-state.ts`; any runtime-state transition that changes hot-endpoint freshness/visibility must advance this shared revision so `/simple/price` and `/coins/markets` caches invalidate together.
- Successful recovery transitions must also clear stale/failure flags consistently across both the background-runtime path (`src/services/market-runtime.ts`) and the bootstrap-only startup path (`src/app.ts`), especially `allowStaleLiveService` and `syncFailureReason`, so diagnostics and hot-endpoint source-class state do not drift from the data actually being served.
- `src/modules/market-freshness.ts` already encodes important degraded/stale behavior; new fallback work should extend that policy rather than re-inventing it elsewhere.
- Keep provider failure control centralized near runtime/provider services. Route handlers should consume established state, not create their own provider retry or breaker logic.
- Query-shape and cache work must stay aligned: stabilize miss-path selectors first, then add indexes, then add route-facing caches.
- Final refactors for `src/modules/coins.ts` and `src/services/market-refresh.ts` must be characterization-first and should not redesign the runtime model.
- Planning-time validation found unrelated baseline validator instability; workers should document unrelated failures instead of broadening scope unless the touched feature actually depends on them.
