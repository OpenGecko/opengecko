---
name: runtime-refactor-worker
description: Refactor OpenGecko runtime/app/database architecture seams while preserving API behavior and startup determinism.
---

# Runtime Refactor Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that change:
- `src/app.ts` composition/lifecycle seams
- startup/runtime determinism and logging behavior
- `src/db` adapter/migration/seed separation
- mission-scoped API compatibility preservation work

## Required Skills

None.

## Work Procedure

1. Read mission artifacts first (`mission.md`, `validation-contract.md`, `AGENTS.md`, `.factory/library/architecture.md`).
2. Identify the smallest seam-preserving extraction plan and list files to touch before edits.
3. Write/extend targeted tests first (red) for changed behavior (startup lifecycle, diagnostics/runtime behavior, API contract invariants).
4. Implement the minimal change that satisfies the feature scope. For regression-guard features, test-only changes are acceptable when production code already satisfies the scoped assertions; otherwise extract/refactor code while keeping dependency direction one-way.
5. If the repo is dirty and an isolated commit is not immediately possible, keep your diff narrowly scoped, record exact touched files in the handoff, and return to orchestrator rather than bundling unrelated changes.
6. Run focused validation during iteration (targeted tests + `typecheck` on touched modules).
7. Run required validators before handoff: `lint`, `typecheck`, and the strongest test command the session can support. If the full manifest `test` command exceeds worker timeout in this repo, run the relevant targeted suites plus manual assertion curls, and explicitly record that the full suite must be re-run by milestone scrutiny/orchestrator.
7. Perform manual API verification for touched surfaces (`/ping`, `/health`, `/diagnostics/runtime`, plus any changed endpoint families).
8. Before citing a `commitId` in the handoff, verify that the commit actually contains the claimed feature scope. If the repo is dirty and you cannot produce an isolated commit, say so explicitly and do not cite an unrelated commit.
9. Document exactly what changed, what was verified, whether the feature landed as code changes or regression guards, and any unresolved debt in the handoff.

## Example Handoff

```json
{
  "salientSummary": "Extracted app composition into dedicated lifecycle modules and split db runtime adapter from migration/seed paths while preserving endpoint behavior. Startup diagnostics now use one deterministic readiness path.",
  "whatWasImplemented": "Created new composition/runtime boundary modules, rewired app bootstrap to call them, and moved seed/migration responsibilities behind dedicated db bootstrapping interfaces. Added regression tests for startup readiness and validation-mode diagnostics overrides plus API compatibility checks for simple/coins runtime surfaces.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun run lint",
        "exitCode": 0,
        "observation": "No lint violations."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "Type checks passed after seam extraction."
      },
      {
        "command": "bun run test",
        "exitCode": 0,
        "observation": "All tests passed, including new startup/runtime regressions."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Started API on mission port and called /ping, /health, /diagnostics/runtime",
        "observed": "Endpoints returned expected status and runtime readiness/degraded fields remained contract-compatible."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/app-lifecycle-refactor.test.ts",
        "cases": [
          {
            "name": "startup readiness transitions deterministically to ready",
            "verifies": "Lifecycle state machine and listener-bound semantics."
          },
          {
            "name": "validation-mode override routes remain gated to validation profile",
            "verifies": "Non-validation runtime returns 404 and validation runtime mutates state."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Refactor requires changing mission boundaries (ports/services/infrastructure).
- Assertions in `validation-contract.md` cannot be satisfied without scope change.
- Existing unrelated failures block verification and cannot be resolved within feature scope.
