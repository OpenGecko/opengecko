---
name: runtime-provider-worker
description: Harden provider access, startup lifecycle, degraded boot, and runtime health surfaces for the OpenGecko mission.
---

# Runtime Provider Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for features that change provider/runtime coordination or runtime-state visibility, including:
- startup, bind, shutdown, and restart lifecycle hardening
- provider pooling follow-through and bounded concurrency
- circuit-breaker or fail-fast provider protection
- degraded boot and stale-live fallback coordination
- health, readiness, and diagnostics surfaces tied to runtime state

## Required Skills

None.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, `validation-contract.md`, the assigned feature, and the relevant `.factory/library/` notes before changing anything.
2. Identify the exact externally observable behaviors the feature owns from `fulfills`. Write failing characterization or regression tests first for those behaviors and any closely coupled runtime lifecycle paths.
3. Trace the runtime path end to end before editing:
   - `src/app.ts`
   - `src/server.ts`
   - `src/services/market-runtime.ts`
   - `src/services/market-runtime-state.ts`
   - `src/providers/ccxt.ts`
   - any touched diagnostics/health modules
4. Prefer service-layer fixes over route-local patches. Keep provider failure control, concurrency, and fallback policy centralized.
5. Preserve CoinGecko contracts. Runtime hardening may add health/diagnostic surfaces, but it must not silently change `/ping`, `/simple/price`, or `/coins/markets` payload semantics.
6. If the feature exposes runtime state externally, ensure the state is machine-readable and aligned with actual hot-endpoint behavior; do not expose vague booleans without cause/source context.
7. Run targeted tests covering startup/shutdown, provider coordination, stale/degraded behavior, and the touched health/diagnostics surfaces.
8. Run `bun run typecheck` before finishing.
9. Manually verify with live probes:
   - startup or restart sequence on the declared mission port
   - `/ping`
   - the affected hot endpoint(s)
   - health/diagnostics endpoints if touched
10. If validation finds a pre-existing unrelated repo failure, record it exactly and continue with scoped verification. If you need a new contract decision, return to the orchestrator instead of guessing.

## Example Handoff

```json
{
  "salientSummary": "Added readiness/degraded diagnostics and bounded provider failure handling without changing the public ping contract. Verified startup now reports machine-readable runtime status and hot endpoints remain safe during simulated upstream failure and recovery.",
  "whatWasImplemented": "Wrote failing runtime and diagnostics tests first, then added centralized provider failure state plus runtime-status reporting wired to market-runtime state. Updated startup/shutdown flow so restart no longer leaks prior degraded flags, and aligned diagnostics fields with the actual stale-live fallback behavior seen by /simple/price and /coins/markets.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test tests/market-runtime.test.ts tests/initial-sync.test.ts tests/stale-data.test.ts tests/app.test.ts",
        "exitCode": 0,
        "observation": "Runtime lifecycle, degraded fallback, and diagnostics regression tests all passed."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "TypeScript stayed clean after runtime-state and provider-surface changes."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Started the API on port 3100, probed /ping until ready, then hit /simple/price and the new diagnostics route during a forced provider-failure scenario.",
        "observed": "/ping stayed stable, diagnostics reported degraded provider state with source/freshness context, and /simple/price served the declared fallback contract instead of hanging."
      },
      {
        "action": "Stopped and restarted the service on the same port and repeated readiness probes.",
        "observed": "The listener withdrew cleanly on shutdown and restart did not retain the prior degraded flag."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/market-runtime.test.ts",
        "cases": [
          {
            "name": "runtime status distinguishes not-ready, degraded, and recovered states",
            "verifies": "Machine-readable runtime status aligns with startup and recovery transitions."
          }
        ]
      },
      {
        "file": "tests/stale-data.test.ts",
        "cases": [
          {
            "name": "hot endpoints and diagnostics agree during degraded fallback",
            "verifies": "Client-visible fallback behavior matches exposed runtime-status evidence."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature needs a new public runtime-status contract that is not covered by the mission validation contract.
- A provider-control change would require external infrastructure or credentials not already approved.
- You cannot make runtime-state evidence align with endpoint behavior without changing the mission scope.
