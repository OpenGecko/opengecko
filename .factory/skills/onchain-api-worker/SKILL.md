---
name: onchain-api-worker
description: Implement GeckoTerminal-style onchain endpoints, JSON:API resources, and onchain-specific contract tests.
---

# Onchain API Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the work procedure.

## When to Use This Skill

Use this skill for `/onchain/*` endpoints, including network/dex catalogs, pool/token resources, onchain prices, trades, OHLCV, search, trending, categories, and analytics.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, the assigned feature, and all assigned onchain assertions in `validation-contract.md`.
2. Inspect `src/modules/onchain.ts`, related schema/data helpers, and any existing onchain tests before making changes.
3. Write failing tests first for the exact route family you are touching. Cover both happy-path and negative-path behavior when the assertions mention invalid params or unsupported includes.
4. Implement the route and response-shaping changes while preserving JSON:API-style `data`, `included`, `relationships`, and `meta` semantics where the contract expects them.
5. Verify network, dex, pool, and token relationship integrity explicitly; do not assume identity continuity without checking returned ids/relationships.
6. Run targeted onchain tests until they pass.
7. Start the local API if needed and manually verify at least one valid request plus one invalid request with `curl`. Prefer port `3102` if `3100` is already occupied so manual checks hit the worker's latest code.
8. Run `bun run typecheck` before finishing. If your changes affect shared onchain routing or schemas, run the most relevant broader onchain test slice too.
9. In the handoff, record exact ids/addresses/networks used in verification so follow-up workers and validators can reproduce the checks.

## Example Handoff

```json
{
  "salientSummary": "Implemented token detail and token-multi routes plus token-pools listing for the onchain surface, including explicit 400 handling for malformed addresses and unsupported include flags.",
  "whatWasImplemented": "Added failing tests first for token detail, token multi batching, token-pools scoping, and malformed-address validation. Implemented the missing handlers in `src/modules/onchain.ts`, reused existing pool/token records for relationship wiring, and kept JSON:API-style `data` resource shapes consistent with the existing network/dex catalog endpoints.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test tests/app.test.ts --runInBand",
        "exitCode": 0,
        "observation": "Onchain token route tests passed, including negative cases for malformed addresses."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "No type regressions after adding token handlers and response helpers."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Started API and curled token detail, token-multi, and token-pools endpoints for a known network/token fixture.",
        "observed": "All three endpoints returned JSON:API resources with matching token identities and token-to-pool relationships."
      },
      {
        "action": "Curled token detail with a malformed address and token-pools with an invalid page.",
        "observed": "Both requests returned stable 400-class validation responses."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/app.test.ts",
        "cases": [
          {
            "name": "onchain token detail and token multi preserve canonical address identity",
            "verifies": "Token resource continuity across single and batch routes."
          },
          {
            "name": "onchain token detail rejects malformed address",
            "verifies": "Explicit invalid-input behavior for address-bearing token routes."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The endpoint requires an onchain dataset/provider not yet selected in mission state.
- JSON:API response-shape expectations are ambiguous and cannot be resolved from existing planning docs or fixtures.
- The route cannot be completed without widening infrastructure boundaries or introducing unapproved external dependencies.
