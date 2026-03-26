# User Testing

Validation surface findings and runtime testing notes.

**What belongs here:** user-testing surfaces, tools, setup steps, known gotchas, and resource classification.

---

## Validation Surface

- Surface: HTTP API only
- Tools: `curl`, existing shell endpoint scripts under `scripts/modules/*`, milestone scrutiny and user-testing validators
- Startup command proven during dry run: `PORT=3100 LOG_LEVEL=error bun run src/server.ts`
- Dry-run finding: the app can start, but heavy initial sync delays listener bind; validators must poll for readiness instead of assuming the port is immediately reachable.
- Representative validation probes for this mission:
  - `GET /ping`
  - `GET /simple/price?...`
  - `GET /coins/markets?...`
  - targeted shell scripts such as `scripts/modules/simple/simple.sh` and `scripts/modules/coins/coins.sh`
- Implementation workers may manually validate against the main mission API on `3100`; validators should prefer the dedicated validation API on `3102`.

## Validation Concurrency

- Machine profile observed during planning: 8 CPU cores, ~30 GB RAM
- Mission max concurrent API validators: `1`
- Rationale: startup and validation both depend on heavy initial sync and delayed listener readiness; the user approved sequential endpoint validation for this mission to avoid startup contention and ambiguous failures.

## Flow Validator Guidance: HTTP API

### Isolation Rules
- Validators must run sequentially for this mission’s API surface
- HTTP GET requests are read-only, but startup cost and delayed listener readiness make concurrent validator flows undesirable here
- Reuse the same validation API instance rather than spawning concurrent flows against multiple startup sequences
- Use the same base URL with controlled test data/fixtures for sequential runs

### Boundary Constraints
- Validators should use port `3102` (validation-api) unless the orchestrator explicitly directs otherwise.
- Main mission API on `3100` is acceptable for worker manual checks but should not be shared with validator flows.
- Off-limits ports: `80`, `6379`, `8317`, `11434`, `33331`

### Testing Approach
- Use `curl` for HTTP API assertions
- Base URL: `http://127.0.0.1:3102`
- Prefer `curl -s` for clean JSON output, `curl -i` when headers needed
- Use `jq` for JSON parsing and validation
- Save evidence (response excerpts) for each assertion tested
- Poll `/ping` or the declared runtime-status surface until readiness before running endpoint scripts
- For degraded or fallback assertions, capture the matching diagnostics/runtime-status payload from the same time window

### Evidence Requirements
Each assertion should capture:
1. HTTP status code (via `curl -i` or `-w "%{http_code}"`)
2. Response body excerpt (first/last items, relevant fields)
3. For array responses: sample items from beginning, middle, and end
4. For validation errors: status code and error body structure

## Validation Notes

- Prefer targeted route-family checks while implementing features.
- Use curated fixture chains for cross-area assertions instead of one-off spot checks.
- Sequential validation is required for this mission’s API surface.
- When validating compression, compare negotiated and non-negotiated responses and preserve body semantics.
- When validating timeouts, record the timeout budget source plus measured elapsed time.

## Runtime Validation Gotchas

- The dedicated validation API on port `3102` is already declared in `.factory/services.yaml`; use it consistently for manual verification instead of ad hoc ports.
- Prefer the validation API on port `3102` for manual curl checks if port `3100` is occupied by a stale server.
- Treat port `3102` as disposable validation infrastructure: before starting a new validation API instance, stop any existing listener on `3102` so validator evidence never comes from stale pre-fix code.
- Bun/Vitest fake-timer-heavy tests may need explicit microtask flushing between timer advances to avoid apparent hangs.
- The service may not bind until initial sync finishes; connection-refused before readiness is expected and must not be treated as immediate mission failure without a readiness wait.
- Hot-endpoint-cache validation recorded a false-negative for `VAL-SIMPLE-001`: the synthesis says `/simple/price?vs_currencies=usd` failed because it used `{error,message}`, but the captured `expectedBody` and `actualBody` are identical and that exact envelope is the intended contract.
- Treat the source of truth for `VAL-SIMPLE-001` as: HTTP `400` plus exact JSON `{ "error": "invalid_parameter", "message": "One of ids, names, or symbols must be provided." }`.
- Characterization coverage for that contract now exists in both `tests/invalid-params.test.ts` and `tests/app.test.ts`; if a future validator still flags the assertion while those tests and manual curl evidence pass, the ambiguity is validator-side rather than product-side.
