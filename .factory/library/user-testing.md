# User Testing

Testing surface, validation tooling, and concurrency guidance for the approved trust-slice hardening mission.

---

## Validation Surface

### Surface: mission-api
- **Primary boundary**: REST API on `http://localhost:3001`
- **Primary tool**: `curl`
- **Primary service**: `.factory/services.yaml -> services.api`
- **Use for**: normal contract checks for `/simple/price`, `/coins/markets`, `/coins/{id}`, and `GET /diagnostics/runtime`

### Surface: validation-api
- **Boundary**: REST API on `http://localhost:3102`
- **Primary tool**: `curl`
- **Primary service**: `.factory/services.yaml -> services.validation-api`
- **Use for**: validation-only diagnostics override routes, isolated bootstrap/degraded-state checks, and negative-path checks that must not mutate the shared SQLite database

### Surface: repo-validations
- **Primary tools**: `.factory/services.yaml -> commands.test`, `commands.full_test`, `commands.typecheck`, `commands.build`, `commands.lint`, and endpoint smoke commands
- **Use for**: milestone scrutiny evidence, trust-slice regression protection, harness repair, and end-of-mission repository confidence

## Validation Concurrency

- **Machine profile**: 8 CPU cores, ~31 GB RAM total, dry-run recommendation capped at 2 validation lanes
- **Observed startup behavior**: the mission API on `3001` is the heaviest surface because it can touch persisted SQLite state and provider-backed startup paths; the validation API on `3102` is lighter because it runs in-memory with validation-mode controls

### Max concurrent validators by surface
- **mission-api**: `1`
- **validation-api**: `2`
- **repo-validations**: `1` full-suite job at a time; targeted test jobs may run in parallel with `curl` checks only if they do not require a second mission API process

Reasoning: use at most 70% of observed headroom and avoid SQLite/process contention on the shared trust slice.

## Milestone Validation Focus

### trust-slice-semantics
- `commands.test` is the milestone scrutiny gate
- validate `/simple/price`, `/coins/markets`, `/coins/{id}`, and `GET /diagnostics/runtime`
- use `POST /diagnostics/runtime/degraded_state` and `POST /diagnostics/runtime/provider_failure` on `3102` only when an assertion explicitly requires an override-controlled state

### regression-gate-restoration
- promote back to `commands.full_test` plus `commands.build`, `commands.typecheck`, and `commands.lint`
- run `commands.endpoint_smoke` plus the trust-slice smoke commands on `3001`
- confirm `tests/frontend-contract-script.test.ts` and any harness fixes work in the mission environment, not only under `app.inject()`

## Known Mission Constraints

- Port `3000` is off-limits and belongs to another project.
- Port `5173` is off-limits and belongs to another project.
- Use only one mission-owned API against the shared SQLite file at a time to avoid `database is locked` errors.
- Wait up to `70s` for `/ping` on `3001` before declaring mission API startup failure.
- Port `3102` is the only runtime that should expose validation-mode diagnostics overrides.
- The `spawn bash ENOENT` failure in `tests/frontend-contract-script.test.ts` is an in-scope regression-gate blocker; do not paper over it by silently skipping that test.

## Flow Validator Guidance

### mission-api
- Start exactly one mission-owned API on port `3001`.
- Prefer exact `curl` requests that map directly to `validation-contract.md` assertions.
- Use this surface for normal trust-slice behavior, not override-only routes.

### validation-api
- Use `3102` only for validation-only override routes or isolated runtime-state checks.
- Keep validator prompts aligned to the current POST routes: `POST /diagnostics/runtime/degraded_state` and `POST /diagnostics/runtime/provider_failure`.
- Clear degraded-state overrides with `mode=off`, never `mode=none`.
- Confirm the same routes are absent or gated on `3001` when the contract requires validation-only access.
- Restart the `3102` service from a clean state when changing override assumptions or zero-live bootstrap setup.
- For cache transition assertions, record both `POST /diagnostics/runtime/degraded_state -> data.cache_revision` and `GET /diagnostics/runtime -> hot_paths.cache_revision`; do not look for a top-level `cache_revision` field.

### repo-validations
- Start with the narrowest relevant targeted suite.
- During the trust-slice-semantics milestone, treat `commands.test` as the required scrutiny gate.
- During the regression-gate-restoration milestone, use `commands.full_test` as the required repository gate before declaring the mission complete.
- If endpoint smoke scripts are used, ensure the `3001` API service is already healthy and record the exact `BASE_URL`.

## Flow Validator Guidance: api-curl
- Use the shared mission API at `http://localhost:3001` for normal route checks and the shared validation API at `http://localhost:3102` only for override setup or validation-only route checks.
- Do not start or stop services from subagents; the parent validator owns service lifecycle.
- Avoid mutating global override state unless your assigned assertions explicitly require it, and restore neutral state when your flow finishes.
- Restore neutral degraded-state override with `mode=off`.
- For cache/timestamp assertions, preserve before/after diagnostics payloads and cite `hot_paths.cache_revision` plus `hot_paths.shared_market_snapshot.last_successful_live_refresh_at`.
- Save exact curl commands, HTTP statuses, and key JSON evidence in your flow report.
