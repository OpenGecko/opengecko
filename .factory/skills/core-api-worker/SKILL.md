---
name: core-api-worker
description: Implement non-onchain CoinGecko-compatible API endpoints and their targeted tests.
---

# Core API Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the work procedure.

## When to Use This Skill

Use for features involving: foundation fixes (chart timestamps, test failures), chain/ID resolution, historical durability (OHLCV gap repair, retention), exchange live-fidelity, compatibility hardening, and any non-onchain endpoint work.

## Required Skills

None.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, the assigned feature, and all assigned assertions in `validation-contract.md`.
2. Inspect the relevant source files before making changes. Understand existing patterns.
3. Write failing tests first for the exact behavior you are implementing. Cover both happy-path and error cases.
4. Implement the changes to make tests pass. Follow existing code patterns (Fastify routes, Drizzle queries, Zod validation).
5. Run the targeted tests until they pass.
6. If the manifest-wide baseline test command fails only on issues already listed in `AGENTS.md` as pre-existing, continue with scoped work; record that baseline failure in the handoff.
7. Start the local API (`PORT=3102 CCXT_EXCHANGES='' LOG_LEVEL=error bun run src/server.ts`) and manually verify at least one valid + one invalid request with curl. Kill the server after.
8. Run `bun run typecheck` before finishing. If your changes affect shared modules, run the broader test suite too.
9. In the handoff, record exact endpoints, parameters, and responses used in verification.

## Example Handoff

```json
{
  "salientSummary": "Fixed 4 pre-existing test failures caused by timestamp drift in seeded chart data. Made chartPoints population date-relative instead of absolute. Committed existing chain-normalization work. All 343 tests now pass.",
  "whatWasImplemented": "Updated seeded chart point generation to use relative date offsets from test execution time instead of hardcoded absolute timestamps. Bridged the chartPoints table to read from OHLCV candle store when available. Committed the existing platform-id alias resolution in src/lib/platform-id.ts and updated chain-catalog-sync, catalog, assets, and simple modules.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun run test",
        "exitCode": 0,
        "observation": "All 343 tests pass including the 4 previously failing chart/global tests."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "No type errors."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Started API on port 3102 and curled GET /global/market_cap_chart?vs_currency=usd&days=7",
        "observed": "Returns 200 with market_cap_chart array containing 7 [timestamp, value] tuples with positive values."
      },
      {
        "action": "Curled GET /token_lists/eth/all.json",
        "observed": "Returns 200 with name='OpenGecko Ethereum Token List' and tokens array containing USDC."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/app.test.ts",
        "cases": [
          {
            "name": "accepts canonical platform aliases for token-price, contract, and token-list routes",
            "verifies": "Platform alias eth resolves to ethereum across all contract-address-dependent routes."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature requires schema migrations that would break other in-progress features
- Test failures appear to be caused by changes from a different feature (not your own)
- Requirements are ambiguous or contradictory
- External provider integration is needed (use onchain-api-worker for DeFiLlama/TheGraph)
