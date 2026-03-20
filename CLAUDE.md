# CLAUDE.md

## Project Direction

OpenGecko aims to become a CoinGecko-compatible open-source API.

Canonical planning documents:

- `docs/plans/2026-03-20-opengecko-coingecko-compatible-api-prd.md`
- `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`
- `docs/plans/2026-03-20-opengecko-engineering-execution-plan.md`
- `docs/status/implementation-tracker.md`

## Product Principles

- Contract compatibility first: preserve endpoint paths, query semantics, and response field names wherever possible.
- Treat HTTP compatibility and data fidelity as separate concerns.
- Deliver by endpoint family in phases instead of trying to reach full parity at once.
- Keep provider adapters modular and replaceable.
- Document every intentional incompatibility explicitly.

## Engineering Constraints

- Use Bun as the default package manager for this repository.
- Prefer the smallest practical dependency set; add packages only when clearly justified.
- Use CCXT from the beginning for exchange and market data integrations whenever it can provide the required data.
- Prefer normalized data exposed by CCXT before implementing exchange-specific adapters.
- Only add custom exchange support when important required data is materially missing from CCXT.

## Documentation Rules

- Update the canonical PRD when scope, endpoint family rollout, or architecture assumptions change.
- Update the endpoint parity matrix when endpoint priority, rollout phase, or compatibility assumptions change.
- Update the engineering execution plan when milestone sequencing, hardening priorities, or near-term implementation order changes.
- Update the implementation tracker when execution status, active priorities, or current architecture decisions change.
- Keep this file aligned with current project direction and compatibility principles.
