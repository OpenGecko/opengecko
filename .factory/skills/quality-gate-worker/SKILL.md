---
name: quality-gate-worker
description: Harden CI, lint/typecheck/test/build gates, and coverage enforcement for OpenGecko mission milestones.
---

# Quality Gate Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that modify:
- `.github/workflows/*`
- lint/typecheck/test/build command wiring
- coverage thresholds and coverage-enforced CI behavior
- mission quality-gate assertions (`VAL-QA-*`)

## Required Skills

None.

## Work Procedure

1. Read `validation-contract.md` Quality Gates area and map each `VAL-QA-*` assertion to concrete workflow/config changes.
2. Add tests/checks first where needed to validate CI behavior deterministically (red), then implement workflow/config updates (green).
3. Keep mandatory workflow deterministic: `lint`, `typecheck`, `test`, `build`; keep endpoint scripts outside mandatory gate unless feature explicitly changes policy.
4. Enforce non-zero coverage threshold and ensure CI executes coverage mode.
5. Validate locally using the same command sequence CI runs.
6. Confirm workflow YAML syntax and command references are correct.
7. Return a handoff with exact command outputs and any follow-up debt.

## Example Handoff

```json
{
  "salientSummary": "Added lint + coverage-enforced test gates to CI and aligned workflow order with mission quality requirements.",
  "whatWasImplemented": "Updated GitHub Actions workflow to run lint, typecheck, coverage-mode tests, and build as mandatory checks. Raised Vitest thresholds above zero and kept endpoint shell scripts outside the required workflow. Added a workflow-focused regression check to prevent accidental removal of mandatory gates.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "bun run lint",
        "exitCode": 0,
        "observation": "Lint gate passes locally."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "TypeScript gate passes locally."
      },
      {
        "command": "bun run test -- --coverage",
        "exitCode": 0,
        "observation": "Coverage run passes and thresholds are enforced."
      },
      {
        "command": "bun run build",
        "exitCode": 0,
        "observation": "Build gate passes."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Inspected workflow file for gate order and endpoint-script exclusion",
        "observed": "Mandatory workflow contains lint->typecheck->test(coverage)->build and no test:endpoint invocation."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/ci-quality-gate-config.test.ts",
        "cases": [
          {
            "name": "mandatory workflow includes lint/typecheck/test/build",
            "verifies": "Core CI gate contract remains intact."
          },
          {
            "name": "coverage thresholds remain non-zero",
            "verifies": "Quality gate cannot regress to zero-coverage policy."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Required CI policy conflicts with user-approved mission gate strategy.
- Coverage enforcement causes widespread unrelated failures requiring scope decision.
- Workflow changes depend on external org/repo settings not configurable in code.
