# CLAUDE.md

## Project Direction

OpenGecko aims to become a CoinGecko-compatible open-source API.

Canonical planning documents:

- `docs/plans/2026-03-20-opengecko-coingecko-compatible-api-prd.md`
- `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`
- `docs/plans/2026-03-20-opengecko-engineering-execution-plan.md`
- `docs/plans/2026-03-22-opengecko-compatibility-gap-closure-plan.md`
- `docs/plans/2026-03-29-data-fidelity-uplift-plan.md`
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
- Keep startup focused on exchange metadata, catalogs, and hot market snapshots; treat durable OHLCV ingestion as a continuous worker responsibility.
- Preserve the top-100-first OHLCV scheduling policy unless a planning document explicitly supersedes it.

## Versioning Rules

- Treat `package.json` version as the canonical release version and bump it in any change set intended to ship new behavior.
- Follow SemVer for version bumps: use `patch` for bug fixes and compatibility-preserving implementation/detail changes, `minor` for backward-compatible endpoint additions or response-field expansions, and `major` for intentional breaking changes.
- Do not bump the version for docs-only edits, test-only changes, or internal refactors with no externally observable behavior change.
- If a change mixes internal work with externally visible behavior, bump the version based on the highest user-visible impact in that change set.
- When bumping `package.json` version, update every user-facing startup/version surface in the same change set, including the startup banner string in `src/services/startup-progress.ts` and any tests that assert it.

## Documentation Rules

- Update the canonical PRD when scope, endpoint family rollout, or architecture assumptions change.
- Update the endpoint parity matrix when endpoint priority, rollout phase, or compatibility assumptions change.
- Update the engineering execution plan when milestone sequencing, hardening priorities, or near-term implementation order changes.
- Update the implementation tracker when execution status, active priorities, or current architecture decisions change.
- Keep this file aligned with current project direction and compatibility principles.

## Script Conventions

- Keep endpoint-family smoke tests under `scripts/modules/<module>/<module>.sh`.
- Put shared shell helpers for module scripts in `scripts/modules/lib/common.sh` so new module checks reuse the same curl/jq reporting pattern.
