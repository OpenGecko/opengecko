# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Environment Variables

All defined in `src/config/env.ts` with defaults. The current onchain-live-data recovery plan prefers public DeFiLlama and SQD gateways, so no secret should be required for the remaining milestone work.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind host |
| `DATABASE_URL` | `./data/opengecko.db` | SQLite path |
| `CCXT_EXCHANGES` | `binance,bigone,mexc,gate,okx` | Exchange set |
| `MARKET_FRESHNESS_THRESHOLD_SECONDS` | `300` | Stale data threshold |
| `DEFILLAMA_BASE_URL` | `https://api.llama.fi` | Base URL for DeFiLlama protocol, overview, and price requests |
| `THEGRAPH_API_KEY` | (none) | Legacy The Graph API key path still exists in code, but the active recovery plan is moving live Ethereum trades/OHLCV to SQD public queries |

## External Dependencies

- **CCXT**: Live exchange APIs (binance, coinbase, kraken, okx). No auth needed.
- **DeFiLlama**: host split matters for live onchain work. Use `https://api.llama.fi/` for protocol/overview/price surfaces, and `https://yields.llama.fi/` for free yield-pool discovery. `https://api.llama.fi/yields/pools` currently 404s in practice.
- **SQD/Subsquid**: `https://v2.archive.subsquid.io/network/ethereum-mainnet` — public raw EVM log API for historical swap-event queries; rate-limited, historical-focused
- **The Graph**: `https://gateway.thegraph.com/api/` — legacy fallback path that currently requires a working API key and is not the preferred recovery plan
- **SQLite**: File-based at `DATABASE_URL`. No external database service.
