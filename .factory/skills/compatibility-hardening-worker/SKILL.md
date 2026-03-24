---
name: compatibility-hardening-worker
description: Harden cross-endpoint consistency, characterization tests, and compatibility semantics across implemented surfaces.
---

# Compatibility Hardening Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the work procedure.

## When to Use This Skill

Use this skill for cross-area consistency work: identity continuity, range-vs-lookback alignment, aggregate reconciliation, pagination stability, shared error-envelope behavior, null-vs-omitted rules, and freshness tolerance hardening.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, the assigned feature, and every assigned cross-area assertion.
2. Identify the endpoint families involved and build a small curated fixture chain before changing code. Do not rely on one-off spot checks for cross-area work.
3. Write characterization tests first that reproduce the current inconsistency or missing behavior across the affected endpoints.
4. Make the smallest changes needed to align behavior without breaking already-compatible surfaces.
5. Re-run the targeted characterization tests, then the most relevant broader suite touching the affected families.
6. Run `bun run typecheck` before finishing.
7. Manually verify the fixture chain with `curl`, capturing the ids, addresses, and timestamps used so later validators can reproduce the same comparisons.
8. If a cross-area issue is really a product or contract ambiguity rather than an implementation bug, stop and return to orchestrator instead of guessing.

## Example Handoff

```json
{
  "salientSummary": "Hardened range-vs-lookback chart semantics and unified 400-class error envelopes for invalid range requests across coin OHLC, supply charts, and exchange volume range routes.",
  "whatWasImplemented": "Added characterization tests first for aligned-window chart comparisons and invalid-range error shape mismatches, then updated shared request parsing/helpers so the affected route families use the same timestamp validation and error envelope rules. Also normalized range ordering behavior so range and lookback responses align on timestamp units and ordering.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test tests/app.test.ts --runInBand",
        "exitCode": 0,
        "observation": "Cross-area range and error-semantics tests passed for all touched route families."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "Typecheck remained clean after shared helper changes."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Curled aligned lookback/range requests across coin OHLC and exchange volume endpoints.",
        "observed": "Returned timestamps were aligned and invalid ranges now use the same 400-class error shape across families."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/app.test.ts",
        "cases": [
          {
            "name": "range and lookback chart routes align for equivalent windows",
            "verifies": "Cross-family timestamp and ordering consistency."
          },
          {
            "name": "invalid ranges share a common 400-class error contract",
            "verifies": "Cross-family error-envelope consistency for shared failure modes."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The inconsistency traces back to an unresolved product/contract decision instead of an implementation gap.
- Fixing the issue would require changing the mission validation contract or scope.
- The necessary fixture chain cannot be built from the available endpoint families or data sources.
