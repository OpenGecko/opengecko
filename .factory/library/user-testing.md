# User Testing

Testing surface, validation tooling, and concurrency guidance for the approved data-fidelity uplift mission.

---

## Validation Surface

### Surface: live-api
- **Primary boundary**: REST API on `http://localhost:3000`
- **Primary tool**: `curl`
- **Primary service**: `PORT=3000 HOST=127.0.0.1 CCXT_EXCHANGES=binance,coinbase,okx LOG_LEVEL=error bun run src/server.ts`
- **Use for**: provider-backed readiness, catalog discovery, onchain discovery, enrichment, fixture-provenance, and chart-fidelity assertions that depend on real runtime behavior

### Surface: isolated-api
- **Boundary**: REST API on `http://localhost:3102`
- **Primary tool**: `curl`
- **Primary service**: `OPEN_GECKO_DISABLE_REPO_DOTENV=1 PORT=3102 HOST=127.0.0.1 DATABASE_URL=:memory: CCXT_EXCHANGES='' LOG_LEVEL=error bun run src/server.ts`
- **Use for**: validation-only override routes, structural contract checks, and negative-path checks that should not mutate shared SQLite state

### Surface: repo-validations
- **Primary tools**: `bun run typecheck`, targeted `bun test ...`, `bun run test`, endpoint smoke scripts
- **Use for**: regression protection, type safety, module smoke checks, and milestone scrutiny evidence

## Validation Concurrency

- **Machine profile**: 8 CPU cores, ~31 GB RAM
- **Observed live boot behavior**: provider-backed startup can take ~60-70s and is the main flakiness/resource risk
- **Observed isolated boot behavior**: much lighter than the live API because providers are disabled and the DB is in-memory

### Max concurrent validators by surface
- **live-api**: `1`
- **isolated-api**: `2`
- **repo-validations**: `1` full-suite job at a time; targeted tests may run alongside curl checks only if they do not start a second live API

Reasoning: the live provider path is the dominant source of boot cost, latency, and upstream flakiness, so real-fidelity validation should stay serialized.

## Milestone Validation Focus

### baseline-stability
- `/ping`
- any documented `/health` probe surface
- `/diagnostics/runtime`
- `/simple/price`
- `/simple/token_price`
- validation-only diagnostics override routes on `3102`
- endpoint smoke flow through `bun run test:endpoint`

### platform-catalog-discovery
- `/coins/list/new`
- `/coins/list`
- `/search`
- `/search/trending`
- `/global`
- `/global/market_cap_chart`
- `/asset_platforms`
- `/token_lists/{asset_platform_id}/all.json`
- `/coins/{id}` and downstream history/chart spot checks for discovered ids

### onchain-discovery-uplift
- `/onchain/networks`
- `/onchain/networks/{id}/dexes`
- `/onchain/networks/{id}/pools`
- `/onchain/networks/{id}/pools/{address}`
- `/onchain/networks/eth/tokens/{address}`
- downstream trades / OHLCV spot checks for discovered token/pool identities

### enrichment-uplift
- `/coins/{id}`
- `/onchain/networks/{network}/pools/{pool}/trades`
- `/onchain/networks/{network}/tokens/{token}/trades`
- version/banner surfaces when the release-sync feature runs

### fixture-honesty-hardening
- `/derivatives`
- `/derivatives/exchanges`
- `/public_treasury/{entity}`
- `/public_treasury/{entity}/{coin}/holding_chart`
- `/public_treasury/{entity}/transaction_history`
- `/onchain/.../top_holders`
- `/onchain/.../top_traders`
- `/onchain/.../holders_chart`
- `/coins/categories`
- `/coins/categories/list`
- `/coins/{id}/circulating_supply_chart*`
- `/coins/{id}/total_supply_chart*`

### chart-fidelity-uplift
- `/coins/{id}/market_chart`
- `/coins/{id}/market_chart/range`
- `/coins/{id}/ohlc`
- `/coins/{id}/ohlc/range`
- `/coins/{platform_id}/contract/{contract_address}/market_chart`
- `/coins/{platform_id}/contract/{contract_address}/market_chart/range`

## Known Mission Constraints

- Wait for `/ping` before declaring the live API unavailable.
- `bun run test:endpoint` and `bun run test:endpoint:*` assume the server is already running and default to `BASE_URL=http://localhost:3000`.
- Use only one mission-owned live API against the shared SQLite file at a time to avoid `database is locked` conflicts.
- Upstream CCXT and DeFiLlama calls can be slow or flaky; if a required provider is down, record the blocker instead of silently switching to mocks.
- Ethereum has the strongest onchain live coverage; non-Ethereum discovery paths must be validated against actual route behavior, not assumptions.
- Fixture-backed analytics and chart fallbacks need runtime-visible provenance evidence, not doc-only justification.

## Flow Validator Guidance

### live-api
- Start exactly one mission-owned live API on port `3000`.
- Wait up to `70s` for `/ping` before declaring startup failure.
- Prefer exact `curl` requests that map cleanly to `validation-contract.md` assertions.
- Capture response bodies and any provenance headers/metadata when validating live, hybrid, fixture, or fallback claims.

### isolated-api
- Use `3102` only for validation-only override routes or structural checks that should not share live state.
- Current baseline runtime override routes are `POST /diagnostics/runtime/degraded_state` and `POST /diagnostics/runtime/provider_failure` on `3102`; keep validator prompts aligned to those exact paths.
- For zero-live completed-boot reruns on `3102`, start from a fresh validation listener and temporarily move `data/opengecko.db` aside before boot so the isolated API cannot inherit persisted snapshot state.
- Stop any pre-existing listener on `3102` before launching a fresh isolated validation API instance; stale validation servers can otherwise cause `EADDRINUSE` and misleading setup failures.
- Confirm the same route is absent or gated on `3000` when the contract requires validation-only access.

### repo-validations
- Run the narrowest relevant test slice first, then `bun run typecheck`.
- Reserve `bun run test` for baseline repair, milestone scrutiny, or when a feature explicitly requires broader regression proof.
- If endpoint smoke scripts are used, ensure the correct API service is already running and record the exact `BASE_URL` used.
