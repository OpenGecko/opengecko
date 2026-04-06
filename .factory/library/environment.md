# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API endpoints, dependency quirks, and platform-specific notes.
**What does NOT belong here:** Service ports or commands (use `.factory/services.yaml`).

---

## Environment Variables

Primary runtime configuration lives in `src/config/env.ts`.

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | HTTP bind host |
| `PORT` | `3000` | HTTP bind port (mission services override this in `.factory/services.yaml`) |
| `LOG_LEVEL` | `info` | Runtime log level |
| `DATABASE_URL` | `./data/opengecko.db` | SQLite path |
| `CCXT_EXCHANGES` | `binance,bybit,coinbase,kraken,okx,gate,mexc,bitget` | Active exchange allowlist |
| `MARKET_FRESHNESS_THRESHOLD_SECONDS` | `300` | Fresh/stale cutoff for market reads |
| `MARKET_REFRESH_INTERVAL_SECONDS` | runtime-policy default | Hot market refresh cadence |
| `CURRENCY_REFRESH_INTERVAL_SECONDS` | runtime-policy default | Fiat/exchange-rate refresh cadence |
| `SEARCH_REBUILD_INTERVAL_SECONDS` | runtime-policy default | Search rebuild cadence |
| `PROVIDER_FANOUT_CONCURRENCY` | runtime-policy default | Upstream fanout concurrency limit |
| `REQUEST_TIMEOUT_MS` | `15000` | Upstream request timeout |
| `OHLCV_TARGET_HISTORY_DAYS` | runtime-policy default | Desired OHLCV history target |
| `OHLCV_RETENTION_DAYS` | runtime-policy default | OHLCV retention window |
| `DEFILLAMA_BASE_URL` | `https://api.llama.fi` | DeFiLlama protocol/token base URL |
| `DEFILLAMA_YIELDS_BASE_URL` | `https://yields.llama.fi` | DeFiLlama pool-discovery base URL |
| `RESPONSE_COMPRESSION_THRESHOLD_BYTES` | `1024` | Compression threshold |
| `STARTUP_PREWARM_BUDGET_MS` | `250` | Startup prewarm budget |
| `DISABLE_REMOTE_CURRENCY_REFRESH` | `false` | Disable remote fiat refresh |
| `OPEN_GECKO_DISABLE_REPO_DOTENV` | unset | Mission-only escape hatch to bypass repo `.env` loading for isolated validation runs |

## External Dependencies

- **CCXT**: approved source for exchange metadata, tickers, market pairs, and OHLCV inputs.
- **DeFiLlama**: approved source for onchain network / DEX / pool / token discovery and price enrichment.
- **Subsquid**: approved source for Ethereum Uniswap V3 trade and derived onchain OHLCV paths.
- **currency-api path already present in the repo**: approved for fiat/exchange-rate support.
- **SQLite**: only database used in this mission.

## Mission-Specific Notes

- Approved mission port range is `3100-3199`.
- Mission API service runs on `3103`; validation API service runs on `3102`.
- The repo default `CCXT_EXCHANGES` comes from `src/config/runtime-policy.ts`; `.factory/services.yaml` intentionally narrows mission startup exchanges for stable local validation.
- The validation API on `3102` must run with `OPEN_GECKO_DISABLE_REPO_DOTENV=1` and `DATABASE_URL=:memory:` so override-driven checks do not reuse shared repo runtime state.
- `data/opengecko.db` remains the default local runtime DB for mission API flows.
- Do not add new providers, credentials, hosted services, or background infrastructure without explicit mission scope expansion.
- Expect provider-backed startup on the mission API to be slower than isolated validation startup.
