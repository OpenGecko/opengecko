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
- Existing runtime state already tracks:
  - `initialSyncCompleted`
  - `allowStaleLiveService`
  - `syncFailureReason`
- Hot-endpoint cache coherence now also depends on `hotDataRevision` in `src/services/market-runtime-state.ts`; any runtime-state transition that changes hot-endpoint freshness/visibility must advance this shared revision so `/simple/price` and `/coins/markets` caches invalidate together.
- Successful recovery transitions must also clear stale/failure flags consistently across both the background-runtime path (`src/services/market-runtime.ts`) and the bootstrap-only startup path (`src/app.ts`), especially `allowStaleLiveService` and `syncFailureReason`, so diagnostics and hot-endpoint source-class state do not drift from the data actually being served.
- `src/modules/market-freshness.ts` already encodes important degraded/stale behavior; new fallback work should extend that policy rather than re-inventing it elsewhere.
- Keep provider failure control centralized near runtime/provider services. Route handlers should consume established state, not create their own provider retry or breaker logic.
- Query-shape and cache work must stay aligned: stabilize miss-path selectors first, then add indexes, then add route-facing caches.
- Final refactors for `src/modules/coins.ts` and `src/services/market-refresh.ts` must be characterization-first and should not redesign the runtime model.
- Planning-time validation found unrelated baseline validator instability; workers should document unrelated failures instead of broadening scope unless the touched feature actually depends on them.
