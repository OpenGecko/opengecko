---
name: compatibility-hardening-worker
description: Harden cross-endpoint consistency, characterization tests, and compatibility semantics across implemented surfaces.
---

# Compatibility Hardening Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the work procedure.

## When to Use This Skill

Use for compatibility audit features, snapshot capture/replay infrastructure, normalization rules, divergence registries, serializer fixture creation, parity report generation, and any feature focused on cross-endpoint consistency rather than new functionality.

## Required Skills

None.

## Work Procedure

1. Read `mission.md`, `AGENTS.md`, the assigned feature, and all assigned assertions in `validation-contract.md`.
2. Read the endpoint parity matrix at `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md` to understand the full endpoint surface.
3. Read existing comparison coverage in `tests/invalid-params.test.ts`, `tests/compare-coingecko.test.ts`, and any mission-specific snapshot/replay tests or rules files already present.
4. If the feature touches snapshot parity infrastructure, read `.factory/library/data-quality-parity.md` plus any checked-in capture manifest, normalization ruleset, or divergence registry before editing.
5. Write failing tests first for the exact behavior you are adding: capture manifest accounting, offline replay, classification, report schema, divergence labeling, or regression gate behavior.
6. For snapshot/replay features: prove the workflow can run from stored local artifacts without repeated upstream calls; preserve raw payloads and request-identifying metadata/evidence links.
7. For report features: emit machine-readable artifacts with stable ordering and enough ownership/evidence context to route fixes. Do not generate docs in `docs/status/` unless the assigned feature explicitly asks for it.
8. Run `bun run test` and `bun run typecheck`. If the baseline test suite fails only on issues already listed in mission `AGENTS.md` as pre-existing, continue with scoped work and record the baseline failure exactly in the handoff.
9. If the feature changes replay/report behavior, start the validation API on port 3102 and manually verify at least one canonical replay/report flow against stored artifacts. If the feature is purely internal test/rules wiring, explain why curl verification was not needed.
10. In the handoff, list every manifest entry, endpoint family, or report artifact covered and the specific validation checks added.

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
