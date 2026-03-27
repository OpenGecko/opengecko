```
░█▀█░█▀█░█▀▀░█▀█░█▀▀░█▀▀░█▀▀░█░█░█▀█
░█░█░█▀▀░█▀▀░█░█░█░█░█▀▀░█░░░█▀▄░█░█
░▀▀▀░▀░░░▀▀▀░▀░▀░▀▀▀░▀▀▀░▀▀▀░▀░▀░▀▀▀
```

## Why This Exists

The crypto ecosystem preaches decentralization — but the moment you need basic market data, you're paying CoinGecko for a closed, rate-limited API you don't control. That's not what this space is supposed to be.

OpenGecko is an open-source, self-hostable API that does what CoinGecko does — using entirely public data. No proprietary aggregation locked behind a paywall. No vendor dependency. No rate limits imposed by someone else's business model.

We believe market data should be a public good, built from open sources:

- **Exchange feeds** via [CCXT](https://github.com/ccxt/ccxt) — Binance, Coinbase, Kraken, OKX, and every exchange CCXT supports
- **Token metadata** from [TrustWallet Assets](https://github.com/trustwallet/assets) — logos, contract addresses, chain mappings
- **On-chain data** via DEX aggregators and indexers
- **Treasury disclosures** from public filings

The result: a decentralized, open market data layer that anyone can deploy, audit, and extend.

> [!IMPORTANT]
> OpenGecko ships **HTTP contract compatibility** and **live-data fidelity** on separate tracks. Routes, params, and field names follow CoinGecko conventions from day one. Live-data breadth and long-tail fidelity improve per release. See `docs/status/implementation-tracker.md` for current coverage.

## What You Get

| | |
|---|---|
| **CoinGecko-compatible surface** | Same routes, params, response shapes. Switch the base URL and go. |
| **Zero vendor lock-in** | No API keys. No rate limits. No subscription. Own your infrastructure. |
| **Deploy in one command** | `bun install && bun run dev`. SQLite under the hood. No external services required. |
| **60-second fresh data** | Hot market snapshots refresh continuously. No stale cache surprises. |
| **Fully auditable** | Every intentional divergence from CoinGecko is documented. No black-box surprises. |
| **Built on open data** | CCXT, TrustWallet, public on-chain sources. No proprietary data lock-in. |

## Quick Start

```bash
git clone https://github.com/zed-wong/OpenGecko
cd OpenGecko
bun install
bun run dev
```

Server starts at `http://localhost:3000`.

**Smoke check:**

```bash
curl "http://localhost:3000/ping"
curl "http://localhost:3000/simple/price?ids=bitcoin,ethereum&vs_currencies=usd"
curl "http://localhost:3000/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=5&page=1"
curl "http://localhost:3000/diagnostics/runtime"
```

**Developer commands:**

```bash
bun run dev                  # local dev server (hot reload)
bun run typecheck            # TypeScript type check
bun run test                 # run full test suite
bun run test:endpoint        # smoke-test all endpoint families
bun run test:endpoint:simple
bun run test:endpoint:coins
bun run test:endpoint:exchanges
bun run test:endpoint:global
bun run test:endpoint:assets
bun run test:endpoint:search
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Compatibility API                      │
│           CoinGecko-compatible REST surface               │
│           (same routes, params, field names)               │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│                    Domain Services                        │
│         validation · freshness policy · shaping           │
└──────────────────────────┬───────────────────────────────┘
                           │
         ┌─────────────────┴─────────────────┐
         │                                    │
┌────────▼────────┐              ┌────────────▼────────────┐
│     SQLite      │              │          CCXT             │
│  hot snapshot  │              │   Binance · Coinbase    │
│  60s refresh    │              │   Kraken · OKX · ...    │
└─────────────────┘              └──────────────────────────┘
```

Three layers:

- **Compatibility API** — Fastify-powered REST surface matching CoinGecko contracts.
- **Domain Services** — Business logic, freshness enforcement, response shaping.
- **Storage / Provider** — SQLite hot snapshot (60s refresh) backed by CCXT live feeds.

A background OHLCV worker runs continuously, prioritizing top-100 coins for recent data before deepening historical range. Search uses SQLite FTS5.

## API Coverage

Rolled out by endpoint family (R0 → R4):

| Family | Phase | Representative Endpoints | Status |
|---|---|---|---|
| Simple + General | R0 | `/ping`, `/simple/*`, `/asset_platforms`, `/search`, `/global`, `/exchange_rates` | Stable |
| Coins + Contracts | R1 | `/coins/*`, `/coins/{platform}/contract/{address}/*` | Stable |
| Exchanges + Derivatives | R2 | `/exchanges/*`, `/derivatives/*` | Stable |
| Public Treasury | R3 | `/entities/*`, `/public_treasury/*` | Stable |
| Onchain DEX | R4 | `/onchain/networks`, `/onchain/{network}/dexes` | Expanding |

For detailed endpoint-level compatibility status and known gaps, see `docs/status/implementation-tracker.md` and `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | HTTP bind host |
| `PORT` | `3000` | HTTP bind port |
| `DATABASE_URL` | `./data/opengecko.db` | SQLite database path |
| `CCXT_EXCHANGES` | `binance,coinbase,kraken,okx` | Active exchange set |
| `MARKET_REFRESH_INTERVAL_SECONDS` | `60` | Hot snapshot refresh cadence |
| `MARKET_FRESHNESS_THRESHOLD_SECONDS` | `300` | Freshness threshold for live reads |
| `SEARCH_REBUILD_INTERVAL_SECONDS` | `900` | Search index rebuild cadence |
| `REQUEST_TIMEOUT_MS` | `15000` | Upstream exchange request timeout |

Full schema in `src/config/env.ts`.

## Diagnostics & Operations

| Route | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `GET /diagnostics/runtime` | Startup state, stale fallback, provider and cache status |
| `GET /diagnostics/ohlcv_sync` | OHLCV worker progress and sync health |
| `GET /diagnostics/chain_coverage` | Chain/network normalization coverage |
| `GET /metrics` | Prometheus-compatible metrics |

> [!TIP]
> For production, monitor `/diagnostics/runtime` and `/metrics` together to capture both contract uptime and data freshness state.

**Background jobs:**

```bash
bun run markets:refresh   # refresh hot market snapshots
bun run ohlcv:worker      # continuous OHLCV ingestion (top-100 first)
bun run search:rebuild    # rebuild SQLite FTS5 search index
bun run charts:backfill   # backfill historical OHLCV data
```

## Migrating from CoinGecko

1. Switch your API base URL to your OpenGecko host.
2. Re-run your existing contract tests against OpenGecko.
3. Check `GET /diagnostics/runtime` for initial sync state and any stale fallback conditions.
4. Validate the endpoints in your critical path first — `/simple`, `/coins`, `/exchanges`.
5. Track any intentional incompatibilities in your integration docs.

OpenGecko documents every intentional divergence from CoinGecko in `docs/plans/2026-03-22-opengecko-compatibility-gap-closure-plan.md`.

## Built With

`Bun · TypeScript · Fastify · SQLite · Drizzle ORM · CCXT`

## Status & Planning

- Active delivery target: **R4** — onchain DEX expansion and data-fidelity hardening.
- R0–R3 contract surfaces are implemented and validated.
- Current priorities: expanding chain coverage, onchain DEX breadth, OHLCV retention hardening, and replacing seeded slices with canonical live/backfilled paths.

Primary references:

- `docs/status/implementation-tracker.md`
- `docs/plans/2026-03-20-opengecko-coingecko-compatible-api-prd.md`
- `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`
- `docs/plans/2026-03-20-opengecko-engineering-execution-plan.md`
- `docs/plans/2026-03-22-opengecko-compatibility-gap-closure-plan.md`
