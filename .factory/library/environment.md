# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Environment Variables

All defined in `src/config/env.ts` with defaults. No `.env` file required.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind host |
| `DATABASE_URL` | `./data/opengecko.db` | SQLite path |
| `CCXT_EXCHANGES` | `binance,bigone,mexc,gate,okx` | Exchange set |
| `MARKET_FRESHNESS_THRESHOLD_SECONDS` | `300` | Stale data threshold |
| `THEGRAPH_API_KEY` | (none) | The Graph API key for onchain subgraph queries |

## External Dependencies

- **CCXT**: Live exchange APIs (binance, coinbase, kraken, okx). No auth needed.
- **DeFiLlama**: `https://api.llama.fi/` — free, no auth, rate-limited
- **The Graph**: `https://gateway.thegraph.com/api/` — requires API key, 100K free/month
- **SQLite**: File-based at `DATABASE_URL`. No external database service.
