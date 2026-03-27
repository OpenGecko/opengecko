---
name: safe-refactor-worker
description: Perform characterization-first structural refactors while preserving OpenGecko runtime behavior and contracts.
---

# Safe Refactor Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for final-phase structural cleanup that should not change public behavior, especially:
- splitting oversized modules
- extracting cohesive helpers
- reducing long functions into smaller responsibilities
- preserving runtime and route behavior while improving maintainability

## Required Skills

None.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, the assigned feature, and the relevant validation assertions that the refactor must preserve indirectly.
2. Before changing production code, write or tighten characterization tests that pin the exact behavior the refactor touches. The tests must fail if behavior drifts.
   - If you extract or centralize parser/normalization helpers, include malformed-input characterization explicitly (for example invalid CSV/query token handling), not just happy-path coverage.
3. Identify natural extraction seams. Favor small, reversible moves over sweeping rewrites.
4. Do not redesign public behavior during a refactor feature. If you discover a real behavior bug, record it and return to the orchestrator unless the feature explicitly includes that bug fix.
5. Keep the diff mechanically understandable:
   - extract helpers
   - move logic behind stable call sites
   - keep names descriptive and consistent with existing code
6. After each structural move, rerun the narrowest characterization tests that cover the touched seam.
7. Before finishing, run the broader route/runtime regression tests affected by the refactor and `bun run typecheck`.
8. Manually spot-check at least one representative route or runtime flow from the touched module after the refactor.

## Example Handoff

```json
{
  "salientSummary": "Split the oversized coins module into smaller route and helper units without changing public behavior. Characterization tests were added first and remained green through the refactor.",
  "whatWasImplemented": "Added characterization coverage for /coins/markets ordering, stale-field nulling, and representative detail-route behavior, then extracted shared parsing and response-shaping helpers out of src/modules/coins.ts. The refactor preserved the existing route registration surface and did not change externally observed payloads.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test tests/app.test.ts tests/compare-coingecko.test.ts tests/stale-data.test.ts",
        "exitCode": 0,
        "observation": "Characterization and broader route regressions stayed green after the extraction."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "Typecheck remained clean after moving helpers and module boundaries."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Curled representative /coins/markets and /coins/{id} routes after the refactor.",
        "observed": "Responses matched the pre-refactor contract and stale-field behavior remained unchanged."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/app.test.ts",
        "cases": [
          {
            "name": "coins routes preserve ordering and optional field behavior after module extraction",
            "verifies": "Refactor keeps route-facing contract stable."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The safest refactor requires changing public behavior or the validation contract.
- Characterization tests reveal a real behavior bug that should be handled as a separate feature.
- The module is too entangled to refactor safely within one worker session and needs decomposition changes from the orchestrator.
