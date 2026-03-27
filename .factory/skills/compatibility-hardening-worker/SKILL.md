---
name: compatibility-hardening-worker
description: Harden cross-endpoint consistency, characterization tests, and compatibility semantics across implemented surfaces.
---

# Compatibility Hardening Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the work procedure.

## When to Use This Skill

Use for compatibility audit features, invalid-parameter coverage expansion, serializer fixture creation, parity report generation, and any feature focused on cross-endpoint consistency rather than new functionality.

## Required Skills

None.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, the assigned feature, and all assigned assertions in `validation-contract.md`.
2. Read the endpoint parity matrix at `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md` to understand the full endpoint surface.
3. Read existing test coverage in `tests/invalid-params.test.ts` and `tests/compare-coingecko.test.ts`.
4. For audit features: systematically inventory every endpoint, cross-reference with tests and fixtures, produce a structured report.
5. For invalid-param features: write failing tests first for each untested parameter validation path, then verify the implementation handles them correctly. Add implementation fixes if needed.
6. For fixture features: create response shape fixtures in `tests/fixtures/` and add `toMatchObject` assertions.
7. For report features: generate markdown documents in `docs/status/` with per-endpoint compatibility analysis.
8. Run `bun run test` to verify no regressions. Run `bun run typecheck`.
9. Start the API on port 3102 and manually verify at least 3 representative endpoints with curl.
10. In the handoff, list every endpoint covered and the specific validation checks added.

## Example Handoff

```json
{
  "salientSummary": "Expanded invalid-parameter test coverage to all 6 endpoint families. Added 24 new test cases covering pagination, ordering, boolean, and precision parameter validation. Created per-family compatibility report in docs/status/.",
  "whatWasImplemented": "Added invalid-param tests for treasury family (3 new cases), expanded onchain family coverage (6 new cases), added pagination uniformity tests across all paginated endpoints. Created docs/status/compatibility-audit.md with per-endpoint status for all 76 matrix endpoints.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun run test",
        "exitCode": 0,
        "observation": "All tests pass including 24 new invalid-param tests."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "No type errors."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Curled GET /coins/markets?page=0 and GET /exchanges?page=-1",
        "observed": "Both return 400 with consistent {error: 'invalid_parameter'} envelope."
      },
      {
        "action": "Curled GET /coins/not-a-coin and GET /exchanges/not-an-exchange",
        "observed": "Both return 404 with consistent {error: 'not_found'} envelope."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/invalid-params.test.ts",
        "cases": [
          {
            "name": "rejects invalid pagination across all paginated endpoints uniformly",
            "verifies": "Uniform 400 response for page=0, page=-1, page=abc across coins, exchanges, onchain, derivatives."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- An endpoint has a structural incompatibility that requires architectural changes beyond test/fixture work
- The parity matrix contains endpoints not yet registered as routes (implementation gap, not hardening gap)
- Existing test infrastructure cannot express the required assertion pattern
