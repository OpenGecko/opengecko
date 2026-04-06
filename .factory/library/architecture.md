# Architecture

## 1) System Overview

OpenGecko remains a modular monolith. The target architecture for this mission separates orchestration from domain logic and isolates database responsibilities so startup, runtime behavior, and quality controls are deterministic.
**Normative mission scope statement:** all architecture and implementation changes for this mission **MUST** stay within startup lifecycle determinism, module-boundary enforcement, API compatibility preservation, and quality-gate hardening; changes outside this scope are **NOT ALLOWED** unless explicitly approved.

Core component groups:
- **Application composition**: app construction, plugin wiring, route registration, lifecycle ownership.
- **Runtime services**: startup sync, refresh loops, diagnostics state, and logging.
- **Data layer**: SQLite access adapter, schema/migration bootstrap, and seed ingestion as distinct concerns.
- **API surfaces**: Fastify route modules that consume shared runtime/data services.
- **Quality gates**: lint, typecheck, tests, and build gates enforced consistently in local and CI flows.

## 2) Runtime & Data Flow

High-level flow:
`startup config -> app composition -> db adapter init -> migration/bootstrap -> runtime services start -> routes serve shared state`

Data flow boundaries:
- Route modules read from service-layer contracts, not raw DB primitives.
- Runtime services use DB adapter interfaces, not migration/seed internals.
- Seed/static datasets are loaded through dedicated seed modules and are not coupled to startup orchestration logic.
- Diagnostics and operational logging reflect the same runtime state transitions used by route behavior.

## 3) Startup Lifecycle Model

Startup is modeled as explicit phases with deterministic transitions:
1. **Configuration resolution** (including env parsing).
2. **App and dependency composition**.
3. **Database initialization** via adapter.
4. **Migration/bootstrap execution** via dedicated migration bootstrap path.
5. **Seed availability wiring** via separated seed modules.
6. **Runtime activation** (refresh/sync/background services).
7. **Ready/serve state** with stable logging and diagnostics.

Failure handling requirement: each phase emits consistent structured logging and produces predictable readiness/failure signals.

## 4) Module Boundaries (target architecture after refactor)

- `app.ts` acts as a **thin seam/composition boundary**, not a mixed orchestration + domain implementation file.
- Ownership map anchors (implementation seam mapping workers **MUST** follow):
  - **Composition seam owner**: `app.ts` (app wiring, plugin registration, lifecycle hookup only).
  - **Route/API seam owner**: `src/modules/**` (HTTP contracts and handlers; no migration/seed/bootstrap logic).
  - **Service/runtime seam owner**: `src/services/**` (runtime orchestration/state transitions and shared domain/runtime contracts).
  - **DB runtime seam owner**: `src/db/adapter/**` (query/runtime DB access contract only).
  - **Migration/bootstrap seam owner**: `src/db/migrations/**` (schema lifecycle and bootstrap execution only).
  - **Seed/static data seam owner**: `src/db/seeds/**` (seed payload definition/loading only).
  - If current paths differ, workers **MUST** preserve this ownership split using equivalent anchored modules and document exact file-level anchors in change notes.
- Database concerns are split into:
  - **DB adapter/runtime client** (query/runtime access),
  - **Migration/bootstrap executor** (schema lifecycle),
  - **Seed/static data modules** (seed payload ownership).
- Startup and logging concerns are centralized behind deterministic lifecycle APIs.
- Route modules depend on service contracts and runtime state abstractions, avoiding direct coupling to migration/seed/bootstrap internals.

## 5) Operational Invariants

Workers must preserve:
- One authoritative startup lifecycle state model.
- Deterministic, non-duplicated logging paths for startup/runtime errors.
- DB runtime access remains usable independently of migration and seed loading mechanics.
- Seed data ownership is explicit and isolated from app composition.
- API behavior remains compatible while internals are refactored, measured as:
  - unchanged status-code behavior per endpoint for success and expected failure classes,
  - response schema compatibility for each endpoint version in scope,
  - required response fields remain present and semantically equivalent.
  Any exception requires explicit prior approval recorded with the affected endpoint(s).
- Quality gates remain enforceable and stable as first-class architecture constraints.

### Readiness/Failure Contract

- Startup readiness is deterministic: service transitions to ready state **only after** successful completion of all lifecycle phases (config, composition, DB init, migration/bootstrap, seed wiring, runtime activation).
- Readiness signal is singular and stable: exactly one authoritative ready indicator is emitted and used by diagnostics/health reporting.
- Failure semantics are deterministic: any unrecovered failure in a lifecycle phase transitions startup to failed state, emits structured error context (phase, cause category, correlation id/timestamp), and prevents partial-ready signaling.
- Runtime fatal failures follow the same contract: emit one authoritative failure transition and deterministic structured logs; no alternate silent failure paths.
- Timeout behavior is explicit and deterministic per phase with consistent failure signaling.

## 6) Validation-Relevant Surfaces

Mission-relevant validation surfaces:
- App composition and startup seam behavior (`app.ts` boundary and lifecycle wiring).
- DB adapter vs migration/bootstrap separation behavior.
- Seed module loading paths and startup interactions.
- Startup timeout/env parsing/logging determinism.
- Quality-gate pipeline surfaces: lint, typecheck, test, build, and coverage-gated test enforcement.

Validation intent: architectural seams must be testable independently and produce deterministic pass/fail outcomes under CI gates.
Validation requirement: each listed surface **MUST** have deterministic automated coverage (unit/integration/contract as appropriate) with reproducible assertions and CI-executed pass/fail criteria.

## 7) Mission-Specific Change Constraints

- Keep changes aligned to architecture + quality-gates hardening only.
- Prefer extraction and boundary clarification over behavioral redesign.
- Do not re-couple app composition to DB migration/seed internals.
- Do not introduce alternate startup/logging paths that bypass shared lifecycle handling.
- Keep quality gate hardening ratchet-friendly with concrete required checks:
  - **MUST pass**: lint, typecheck, test, and build gates for mission-scoped changes.
  - **MUST enforce**: non-regressing, non-zero automated test coverage threshold (coverage percentage cannot decrease versus current enforced baseline and cannot be 0%).
  - Gate definitions must run deterministically in local and CI execution paths.

## 8) Out-of-Scope

- New product features or endpoint contract redesign.
- Infrastructure topology changes (no new external services).
- Broad data model redesign outside adapter/migration/seed separation.
- Unrelated performance/security initiatives not required by this mission.
- Deep implementation-level rewrites beyond boundary extraction and deterministic lifecycle/quality-gate hardening.
