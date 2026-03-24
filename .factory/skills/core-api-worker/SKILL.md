---
name: core-api-worker
description: Implement non-onchain CoinGecko-compatible API endpoints and their targeted tests.
---

# Core API Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the work procedure.

## When to Use This Skill

Use this skill for non-onchain endpoint work in the simple, global, coins, exchanges, derivatives, and treasury-adjacent core API families.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, the assigned feature, and the relevant assertions in `validation-contract.md`.
2. Inspect the existing route module, tests, and any related serializers or DB helpers before changing code.
3. Write failing tests first. Add or update the most focused endpoint contract tests needed for the assigned assertions before implementation.
4. Implement the route/handler/data-shaping changes needed to satisfy the failing tests while preserving existing family conventions.
5. Add explicit invalid-parameter coverage whenever the feature includes validation semantics.
6. Run the narrowest targeted test command that exercises the feature until it passes.
7. Start the local API if needed and manually verify the endpoint(s) with `curl`, including at least one happy-path and one negative-path request when the contract includes validation behavior. Prefer port `3102` if `3100` is already occupied so manual checks hit the worker's latest code.
8. Run `bun run typecheck` before finishing. If the change affects shared route behavior broadly, also run a broader relevant Bun/Vitest command.
9. Update your handoff with exact commands, exact observations, tests added, and any discovered gaps.

## Example Handoff

```json
{
  "salientSummary": "Implemented `/coins/list/new` with CoinGecko-style object envelope and stabilized ranking for `/coins/top_gainers_losers`; added explicit invalid-param handling for unsupported duration values.",
  "whatWasImplemented": "Added failing tests first for new-listings envelope shape and mover ranking polarity, then implemented both routes in the coins module using existing snapshot queries and a listing-timestamp field. Added explicit 400 handling for invalid duration/top_coins inputs and updated fixtures for the new response shape.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test tests/app.test.ts --runInBand",
        "exitCode": 0,
        "observation": "New mover and listing tests passed alongside existing coin endpoint tests."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "No TypeScript errors after route and schema updates."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Started API on port 3100 and curled `/coins/list/new` and `/coins/top_gainers_losers?vs_currency=usd`.",
        "observed": "`/coins/list/new` returned an object with `coins[]`; movers returned both `top_gainers` and `top_losers` arrays with expected ordering."
      },
      {
        "action": "Curled an invalid mover request with unsupported duration.",
        "observed": "Endpoint returned a stable 400 response instead of falling through to a 500 or silent default."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/app.test.ts",
        "cases": [
          {
            "name": "coins list new returns object envelope with coins array",
            "verifies": "New-listings top-level shape and row identity fields."
          },
          {
            "name": "top gainers losers rejects invalid duration",
            "verifies": "Explicit invalid-parameter behavior for mover ranking endpoint."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature requires a provider or dataset not already represented in mission guidance.
- CoinGecko contract behavior is ambiguous and cannot be resolved from existing tests, fixtures, or docs.
- Meeting the feature contract would require changing mission boundaries or introducing new infrastructure.
