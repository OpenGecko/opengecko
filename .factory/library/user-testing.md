# User Testing

Validation surface findings and runtime testing notes.

**What belongs here:** user-testing surfaces, tools, setup steps, known gotchas, and resource classification.

---

## Validation Surface

- Surface: HTTP API only
- Tools: `curl`, existing shell endpoint scripts under `scripts/modules/*`, milestone scrutiny and user-testing validators
- Startup command proven during dry run: `PORT=3107 bun run src/server.ts`
- Representative dry-run checks that succeeded:
  - `GET /ping`
  - `GET /simple/supported_vs_currencies`
  - `GET /simple/price?...`
- Focused automated validation path is executable; a pre-existing timestamp-sensitive test drift exists in `tests/app.test.ts` and should be treated as mission work.

## Validation Concurrency

- Machine profile observed during planning: 8 CPU cores, ~30 GB RAM
- Conservative max concurrent validators: `3`
- Rationale: server startup triggers bootstrap sync and SQLite/network activity; 3-way parallelism leaves enough headroom while avoiding avoidable contention.

## Validation Notes

- Prefer targeted route-family checks while implementing features.
- Use curated fixture chains for cross-area assertions instead of one-off spot checks.
- For onchain responses, inspect `relationships` and `included` explicitly where the contract expects them.
