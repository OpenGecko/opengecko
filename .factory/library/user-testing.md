# User Testing

Testing surface, validation tooling, and concurrency guidance for the architecture + quality-gate hardening mission.

---

## Validation Surface

### Surface: mission-api
- **Primary boundary**: REST API on `http://127.0.0.1:3103`
- **Primary tool**: `curl`
- **Primary service**: `.factory/services.yaml -> services.api`
- **Use for**: black-box assertions for `/ping`, `/health`, `/diagnostics/runtime`, `/simple/*`, `/coins/*`, `/exchanges*`, `/public_treasury*`, `/onchain*`

### Surface: validation-api
- **Boundary**: REST API on `http://127.0.0.1:3102`
- **Primary tool**: `curl`
- **Primary service**: `.factory/services.yaml -> services.validation-api`
- **Use for**: validation-mode-only diagnostics override assertions (`POST /diagnostics/runtime/degraded_state`, `POST /diagnostics/runtime/provider_failure`) and cross-flow state mutation checks

### Surface: repo-quality-gates
- **Primary tool**: shell commands from `.factory/services.yaml -> commands.*`
- **Use for**: quality-gate assertions (`VAL-QA-*`) over workflow/config and command behavior (`lint`, `typecheck`, `test`, `build`, coverage mode)

## Validation Concurrency

- **Machine profile**: 8 CPU cores, ~31 GB RAM total, ~15 GB available during planning
- **Dry-run observation**: one API run on `3103` increased memory by ~200 MB and process count by ~4
- **Headroom rule**: use <= 70% of available headroom for validator parallelism

### Max concurrent validators by surface
- **mission-api**: `4`
- **validation-api**: `3`
- **repo-quality-gates**: `1` full gate run at a time

Rationale: mission-api and validation-api share network/provider and runtime pressure; keep repo-quality-gate runs serialized to avoid noisy failures and resource contention.

## Flow Validator Guidance

### mission-api checks
- Start `services.api` and wait for `/ping` before running assertions.
- Run exact curl flows mapped to `validation-contract.md` IDs.
- Capture for each assertion: command, HTTP status, key JSON fields, and any relevant headers.

### validation-api checks
- Use `services.validation-api` only when assertion explicitly requires validation-mode mutators.
- Always restore neutral override state (`mode=off`, `active=false`) before ending flow.
- Treat mutator endpoints returning `404` on mission-api (`3103`) as expected contract behavior.

### repo-quality-gates checks
- Validate workflow/config assertions with file evidence plus command execution evidence.
- Required command evidence set: `lint`, `typecheck`, `test` (or coverage mode per contract), and `build`.
- Endpoint shell scripts are non-mandatory for core quality-gate assertions unless a feature explicitly adds them to mandatory workflow.

## Flow Validator Guidance: mission-api
- Isolation boundary: use only the shared mission API at `http://127.0.0.1:3103`; do not restart or reconfigure it from subagents.
- Allowed actions: `curl` GET requests against the assigned endpoints and negative-path query variations needed by the assertion.
- Shared-state caution: do not call validation-only mutator routes here; mission-api assertions must remain read-only.

## Flow Validator Guidance: validation-api
- Isolation boundary: use only the validation API at `http://127.0.0.1:3102`.
- Allowed actions: `curl` GET/POST requests required by assigned diagnostics override assertions.
- Shared-state caution: each assertion batch must restore neutral state before exit using `POST /diagnostics/runtime/degraded_state {"mode":"off"}` and `POST /diagnostics/runtime/provider_failure {"active":false}`.

## Flow Validator Guidance: repo-quality-gates
- Isolation boundary: inspect repo files and run repo validation commands only; do not modify workflow/config files.
- Serialize expensive validators inside the subagent and record exact command outputs relevant to lint, typecheck, tests, coverage, and build.
- Shared-state caution: do not start API services from this surface; quality-gate evidence is file/command based only.
