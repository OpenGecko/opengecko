---
name: api-runtime-worker
description: Implement query-path, caching, transport, metrics, and prewarm hardening for OpenGecko API routes.
---

# API Runtime Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for features that primarily affect public API route behavior or the route-facing runtime layer, including:
- hot query-path shaping and targeted DB indexes
- in-process response caching for `/simple/price` and `/coins/markets`
- cache-safe handling of pagination, ordering, filters, precision, and optional expansions
- timeout, compression, and metrics surfaces
- startup prewarming of declared hot targets

## Required Skills

None.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, `validation-contract.md`, the assigned feature, and the relevant `.factory/library/` notes.
2. Inventory the exact request parameters, field sets, and degraded semantics that must remain stable for the touched route family. Do not assume route behavior from memory—read the current handler and nearby tests first.
3. Write failing characterization tests first for the concrete behaviors claimed by the feature when the feature changes user-visible behavior or fills a missing behavior gap. For behavior-preserving query-shaping, index-only, or migration-only fixes, an existing failing repro, query-plan failure, or validator-discovered regression may serve as the initial red signal, but you must still add or tighten automated coverage before finishing:
   - invalid-parameter contract
   - ordered ids / pagination behavior
   - optional field presence and absence
   - precision behavior
   - degraded/null/omission behavior where relevant
4. For DB/query-path work, stabilize the miss path before adding indexes. Add indexes only after you know the query shape you are protecting.
5. For cache work:
   - normalize only what the contract allows
   - isolate every shape-altering parameter in the cache key
   - test the negative case, not just the positive case
6. For transport work:
   - keep operational surfaces explicit
   - do not change unrelated endpoint bodies while adding compression, timeout, or metrics behavior
7. Re-run the required targeted route tests and any adjacent regression tests touched by shared helpers. Do not report success if the feature's own documented targeted suite is still failing; either fix the remaining failures, narrow scope only when AGENTS.md explicitly treats the failures as unrelated pre-existing issues, or return to the orchestrator.
8. Run `bun run typecheck` before finishing.
9. Manually verify with `curl` on the declared API port:
   - a baseline request
   - a parameter-varied request that should differ
   - a semantically equivalent request that should match
   - one unrelated endpoint if transport behavior changed
10. If the assigned reconciliation or validation cleanup is already satisfied by the current branch state and the documented target suite passes, do not manufacture an empty code change just to create a commit. Return to the orchestrator with the evidence so the feature can be marked completed or cancelled appropriately.
    - If you inherited pre-existing dirty working-tree changes, be explicit about which exact files/commit(s) constitute the feature-attributable implementation. Do not cite an unrelated existing commit as the feature evidence; either isolate the attributable diff into a clean commit or return to the orchestrator explaining why the feature must be finalized separately.
11. If you discover a broader cross-endpoint inconsistency rather than a single-route problem, record it and return to the orchestrator if it exceeds the assigned feature.

## Example Handoff

```json
{
  "salientSummary": "Implemented cache-safe /coins/markets response caching plus targeted query-path cleanup and verified that pagination, ordering, sparkline, and precision behavior remain stable across repeated requests.",
  "whatWasImplemented": "Added characterization tests first for repeated /coins/markets requests, page boundaries, optional expansions, and precision-sensitive values. Then introduced an in-process cache with explicit key isolation for page/order/filter/expansion parameters, tightened the shared query path to reduce unnecessary in-memory work, and kept degraded row/null semantics unchanged.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test tests/app.test.ts tests/stale-data.test.ts tests/compare-coingecko.test.ts",
        "exitCode": 0,
        "observation": "Hot-endpoint regression coverage passed, including repeated-request and degraded behavior checks."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "Typecheck stayed clean after cache and query-path changes."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Curled /coins/markets with repeated identical requests, then changed page/order/sparkline/price_change_percentage parameters.",
        "observed": "Repeated identical requests returned the same ordered ids, while parameter-varied requests changed only the intended rows/fields with no cache leakage."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/app.test.ts",
        "cases": [
          {
            "name": "coins markets cache key isolates page order filter and expansions",
            "verifies": "Optional fields and ordered ids do not leak across repeated requests."
          },
          {
            "name": "simple price optional fields remain absent unless requested",
            "verifies": "Cache-safe include_* and precision behavior."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature requires broad contract changes for a route family that are not covered by the validation contract.
- Query/index work reveals an architectural bottleneck that cannot be solved within the assigned slice without re-scoping the mission.
- A cache or transport change would require new infrastructure or a dependency trade-off that needs human judgment.
- The assigned task is already satisfied in the current branch state and there is no legitimate diff to commit.
