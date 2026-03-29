# User Testing

Testing surface, required testing skills/tools, and resource cost classification.

---

## Validation Surface

- **Surface type**: REST API endpoints (no browser UI)
- **Testing tool**: curl against local server
- **Server startup**: `PORT=3102 HOST=127.0.0.1 DATABASE_URL=:memory: CCXT_EXCHANGES='' LOG_LEVEL=error bun run src/server.ts`
- **Startup time**: ~4-6 seconds (with CCXT_EXCHANGES='' for fast boot)
- **Database**: SQLite at `./data/opengecko.db` (or `:memory:` for tests)

### Snapshot-Parity Mission Surface

- **Primary acceptance flow**:
  1. bounded CoinGecko Pro capture writes artifacts under `data/coingecko-snapshots/`
  2. local validation API runs on `3102`
  3. offline replay compares local responses to stored upstream artifacts
  4. machine-readable diff reports provide pass/fail evidence
- **Primary tools**: local API + curl + targeted tests + offline replay/diff commands
- **Important constraint**: do not re-hit live CoinGecko during replay, reporting, or repeated validation runs
- **Evidence chain**: stored upstream artifact -> replay-captured OpenGecko artifact -> structured diff/report entry

### Endpoints to Test Per Milestone

**foundation-fixes**: `/global/market_cap_chart`, `/coins/bitcoin/market_chart`, `/coins/ethereum/contract/...`, `/token_lists/eth/all.json`, `/simple/token_price/eth`, `/ping`
**chain-id-resolution**: `/diagnostics/chain_coverage`, `/asset_platforms`, `/coins/ethereum/contract/...` with alias variants
**onchain-live-data**: `/onchain/networks`, `/onchain/networks/eth/pools`, `/onchain/networks/eth/pools/:address/ohlcv/hour`, `/onchain/networks/eth/pools/:address/trades`, `/onchain/simple/networks/eth/token_price/:addresses`
**historical-durability**: `/coins/bitcoin/market_chart`, `/coins/bitcoin/ohlc`, `/diagnostics/ohlcv_sync`
**exchange-live-fidelity**: `/exchanges`, `/exchanges/binance/tickers`, `/derivatives/exchanges`, `/exchanges/binance/volume_chart`
**compatibility-hardening**: All endpoints with invalid parameters, response shape validation
**snapshot-parity**: stored snapshot capture corpus, canonical `/simple/price`, `/simple/token_price/{id}`, `/coins/markets`, `/coins/{id}`, `/global`, `/exchange_rates`, `/exchanges`, `/exchanges/{id}`, `/exchanges/{id}/tickers`, plus offline replay/diff reports

## Validation Concurrency

- **Machine**: 8 cores, 30GB RAM, ~19GB available
- **API server footprint**: ~80-120MB RAM per instance
- **Max concurrent validators**: 5 (each uses ~120MB for server + ~50MB curl overhead = ~170MB; 5 * 170MB = 850MB, well within 19GB * 0.7 = 13.3GB budget)
- **Test suite**: Vitest runs parallel by default, uses ~500MB peak

## Known Limitations

- Solana onchain endpoints remain seeded (no live Raydium subgraph)
- Holder/trader analytics remain fixture-backed
- Ethereum trades/OHLCV recovery is shifting to SQD/Subsquid raw log queries; validation should prefer `DATABASE_URL=:memory:` and verify non-fixture responses from the SQD-backed path
- Server startup with CCXT exchanges enabled takes 30+ seconds (use CCXT_EXCHANGES='' for validation)
- The legacy `scripts/modules/simple/simple.sh` flow is not a hard gate for the snapshot-parity mission because it assumes live market snapshots instead of the stored-artifact replay workflow.


## Flow Validator Guidance: api

- Shared validation server on `http://127.0.0.1:3102` is allowed for concurrent curl-based checks.
- If the server is not running, start exactly one instance on port `3102`; prefer `DATABASE_URL=:memory:` to avoid lock conflicts with any dev server using `data/opengecko.db`.
- If port `3102` is occupied by a stale or incompatible mission-owned validation server (for example diagnostics show `shared_market_snapshot.available=false` for a flow that needs live snapshots), stop it with the manifest stop command and start a fresh validation instance on `3102` before continuing.
- For the bootstrap runtime-mode change, the validation API on `3102` should expose the same seeded-bootstrap semantics as the default/local bootstrap path when persisted rows are present. User-testing flows should verify `/diagnostics/runtime`, `/simple/price`, `/simple/token_price/*`, `/coins/markets`, and `/coins/{id}` against that seeded-bootstrap contract rather than the older stale/degraded-only behavior.
- Do not use ports outside `3100-3199`.
- Save response artifacts only under the assigned mission evidence directory.
- Do not modify repository source files while validating.
- For snapshot-parity validation, prefer stored artifacts under `data/coingecko-snapshots/` and verify replay/diff results offline rather than by making repeated upstream requests.

## Flow Validator Guidance: repo-validations

- Repository validators (`bun run test`, `bun run typecheck`, targeted `bun test`) may run concurrently with API curl checks, but avoid launching multiple full `bun run test` processes at once.
- Keep all artifacts in assigned evidence paths and `.factory/validation/<milestone>/user-testing/flows/`.
- Validation workers may inspect tests/source to map assertions to existing coverage, but must not edit source code.
