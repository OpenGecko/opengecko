```
░█▀█░█▀█░█▀▀░█▀█░█▀▀░█▀▀░█▀▀░█░█░█▀█
░█░█░█▀▀░█▀▀░█░█░█░█░█▀▀░█░░░█▀▄░█░█
░▀▀▀░▀░░░▀▀▀░▀░▀░▀▀▀░▀▀▀░▀▀▀░▀░▀░▀▀▀
```

[![Bun](https://img.shields.io/badge/Bun-1.3.9-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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

- **CoinGecko-compatible surface** — Same routes, params, response shapes. Switch the base URL and go.
- **Zero vendor lock-in** — No API keys. No rate limits. No subscription. Own your infrastructure.
- **Deploy in one command** — `bun install && bun run dev`. SQLite under the hood. No external services required.
- **60-second fresh data** — Hot market snapshots refresh continuously. No stale cache surprises.
- **Fully auditable** — Every intentional divergence from CoinGecko is documented. No black-box surprises.
- **Built on open data** — CCXT, TrustWallet, public on-chain sources. No proprietary data lock-in.

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
│                    Compatibility API                     │
│           CoinGecko-compatible REST surface              │
│           (same routes, params, field names)             │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│                    Domain Services                       │
│         validation · freshness policy · shaping          │
└──────────────────────────┬───────────────────────────────┘
                           │
         ┌─────────────────┴──────────────────┐
         │                                    │
┌────────▼────────┐              ┌────────────▼────────────┐
│     SQLite      │              │          CCXT           │
│  hot snapshot   │              │   Binance · Coinbase    │
│  60s refresh    │              │   Kraken · OKX · ...    │
└─────────────────┘              └─────────────────────────┘
```

Three layers:

- **Compatibility API** — Fastify-powered REST surface matching CoinGecko contracts.
- **Domain Services** — Business logic, freshness enforcement, response shaping.
- **Storage / Provider** — SQLite hot snapshot (60s refresh) backed by CCXT live feeds.

A background OHLCV worker runs continuously, prioritizing top-100 coins for recent data before deepening historical range. Search uses SQLite FTS5.

## API Coverage

### Simple & General

Fast price lookups and foundational endpoints.

| Endpoint | Description |
|---|---|
| `GET /ping` | API liveness check |
| `GET /simple/price` | Price for one or more coins vs one or more currencies |
| `GET /simple/token_price/{id}` | Token prices by contract address on a specific chain |
| `GET /simple/supported_vs_currencies` | List of supported quote currencies |
| `GET /asset_platforms` | List of all supported asset platforms (chains) |
| `GET /exchange_rates` | BTC-to-fiat and BTC-to-crypto conversion rates |
| `GET /search` | Full-text search across coins, exchanges, and categories |
| `GET /global` | Global market overview (total cap, volume, dominance) |

### Coins & Markets

Coin listings, market data, historical charts, and contract resolution.

| Endpoint | Description |
|---|---|
| `GET /coins/list` | Full list of all supported coins with platform mappings |
| `GET /coins/markets` | Market data for coins (price, cap, volume, ATH/ATL, sparklines) |
| `GET /coins/{id}` | Detailed coin info — metadata, links, community data, market data |
| `GET /coins/{id}/history` | Point-in-time snapshot of a coin on a specific date |
| `GET /coins/{id}/market_chart` | Historical prices, market caps, and volumes |
| `GET /coins/{id}/market_chart/range` | Historical chart data for a specific time range |
| `GET /coins/{id}/ohlc` | OHLC candlestick data |
| `GET /coins/{id}/tickers` | Ticker data from exchanges and DEXs |
| `GET /coins/categories` | Coin categories ranked by market cap |
| `GET /coins/categories/list` | List of all coin categories |
| `GET /coins/{platform_id}/contract/{contract_address}` | Coin detail resolved by chain and contract address |
| `GET /coins/{platform_id}/contract/{contract_address}/market_chart` | Token chart by contract address |
| `GET /coins/{platform_id}/contract/{contract_address}/market_chart/range` | Token chart by contract address and time range |

### Exchanges & Derivatives

Exchange listings, volumes, and derivatives venues.

| Endpoint | Description |
|---|---|
| `GET /exchanges/list` | List of all exchanges |
| `GET /exchanges` | Exchange data with trust scores and volumes |
| `GET /exchanges/{id}` | Detailed exchange info with top tickers |
| `GET /exchanges/{id}/tickers` | All tickers for a specific exchange |
| `GET /exchanges/{id}/volume_chart` | Exchange 24h volume history in BTC |
| `GET /derivatives/exchanges/list` | List of derivatives exchanges |
| `GET /derivatives/exchanges` | Derivatives exchange data with OI and funding |
| `GET /derivatives` | All derivatives contracts with funding, spread, and expiry |

### Public Treasury

On-chain treasury data from public disclosures.

| Endpoint | Description |
|---|---|
| `GET /entities/list` | List of tracked entities (companies, governments) |
| `GET /{entity}/public_treasury/{coin_id}` | Treasury holdings for a specific entity and coin |
| `GET /public_treasury/{entity_id}` | Full treasury profile for an entity |
| `GET /public_treasury/{entity_id}/{coin_id}/holding_chart` | Historical holding value and amount over time |
| `GET /public_treasury/{entity_id}/transaction_history` | Treasury transaction ledger |

### Onchain DEX

DEX pools, tokens, trades, and OHLCV on supported networks. **Expanding.**

| Endpoint | Description |
|---|---|
| `GET /onchain/networks` | List of supported networks |
| `GET /onchain/networks/{network}/dexes` | List of DEXs on a specific network |

For detailed compatibility status and known gaps, see `docs/status/implementation-tracker.md` and `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`.

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

![Fastify](https://img.shields.io/badge/Fastify-5.2-black?logo=fastify)
![SQLite](https://img.shields.io/badge/SQLite-3-blue?logo=sqlite)
![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-0.44-blueviolet?logo=data)
![CCXT](https://img.shields.io/badge/CCXT-4.4-orange?logo=bitcoin)
