# Data Quality Parity

Mission-specific guidance for stored CoinGecko snapshot capture, offline replay, and parity-driven data-quality fixes.

**What belongs here:** snapshot storage rules, replay/reporting guardrails, priority endpoint set, and parity-specific evidence expectations.

---

## Snapshot Storage

- Store upstream artifacts only under `data/coingecko-snapshots/`.
- Preserve upstream payload bodies without mutation.
- Keep request-identifying metadata in a sidecar or index with manifest entry identity, timestamp, status, and artifact format version.
- Treat the checked-in capture manifest as the only allowed source of snapshot targets and extra variants.

## Replay and Reporting

- Replay must run from stored local artifacts plus the validation API on `3102`.
- Record corpus identity, manifest identity, normalization-rules identity, and divergence-registry identity when relevant.
- Machine-readable reports must remain deterministic enough for before/after regression comparison.
- Actionable findings need endpoint identity, ownership hint, and linked upstream/replay evidence paths.

## Priority Endpoint Set

The initial mission focus is the canonical non-onchain market surfaces most likely to show high-impact data-fidelity gaps:

- `/simple/price`
- `/simple/token_price/{id}`
- `/coins/markets`
- `/coins/{id}`
- `/global`
- `/exchange_rates`
- `/exchanges`
- `/exchanges/{id}`
- `/exchanges/{id}/tickers`

## Guardrails

- Do not repeatedly call live CoinGecko after the bounded capture run completes.
- Do not hide parity regressions by narrowing replay coverage, silently changing divergence classification, or changing public request contracts.
- Prefer targeted parity fixtures/tests over broad unrelated rewrites.
- For `/coins/markets` and `/coins/{id}` parity, prefer enriching the persisted corpus that bootstrap/default runtime imports from, rather than inventing broader fixture-only bootstrap data.
- Keep persisted-corpus parity tests separate from fixture-backed `test.db` app tests when their expectations intentionally differ.
