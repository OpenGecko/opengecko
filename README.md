```
░█▀█░█▀█░█▀▀░█▀█░█▀▀░█▀▀░█▀▀░█░█░█▀█
░█░█░█▀▀░█▀▀░█░█░█░█░█▀▀░█░░░█▀▄░█░█
░▀▀▀░▀░░░▀▀▀░▀░▀░▀▀▀░▀▀▀░▀▀▀░▀░▀░▀▀▀
```

[![Bun](https://img.shields.io/badge/Bun-1.3.9-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The open-source, self-hostable CoinGecko-compatible crypto API. No API keys. No rate limits. No vendor lock-in.

## Why This Exists

The crypto ecosystem preaches decentralization — but the moment you need basic market data, you're paying CoinGecko for a closed, rate-limited API you don't control. That's not what this space is supposed to be.

OpenGecko is an open-source, self-hostable API that does what CoinGecko does — using entirely public data. No proprietary aggregation locked behind a paywall. No vendor dependency. No rate limits imposed by someone else's business model.

We believe market data should be a public good, built from open sources:

- **Exchange feeds** via [CCXT](https://github.com/ccxt/ccxt) — Binance, Coinbase, Kraken, OKX, and every exchange CCXT supports
- **Token metadata** from [TrustWallet Assets](https://github.com/trustwallet/assets) — logos, contract addresses, chain mappings
- **Image assets** from [OpenGecko Assets](https://github.com/opengecko/assets) — canonical, CDN-ready chain and token logos aggregated from multiple public sources
- **On-chain data** via DEX aggregators and indexers
- **Treasury disclosures** from public filings

The result: a decentralized, open market data layer that anyone can deploy, audit, and extend.

> [!IMPORTANT]
> OpenGecko ships **HTTP contract compatibility** and **live-data fidelity** on separate tracks. Routes, params, and field names follow CoinGecko conventions from day one. Live-data breadth and long-tail fidelity improve per release. See `docs/status/implementation-tracker.md` for current coverage.

> [!WARNING]
> Broad route coverage does **not** mean full data parity. The active non-NFT CoinGecko-compatible surface is largely implemented and the current validation gate is green, but live-data fidelity remains tiered: most endpoints are live or automated source-backed, while paid-indexer-style onchain analytics and deep long-tail historical coverage remain fixture/degraded or out of scope.

## What You Get

- **CoinGecko-compatible surface** — Same routes, params, response shapes. Switch the base URL and go.
- **Zero vendor lock-in** — No API keys. No rate limits. No subscription. Own your infrastructure.
- **Deploy in one command** — `bun install && bun run dev`. SQLite under the hood. No external services required.
- **60-second fresh data** — Hot market snapshots refresh continuously. No stale cache surprises.
- **Unified automation loop** — In-memory scheduling owns refresh, sweep, retention, and optional source-sync jobs with `/diagnostics/jobs` visibility.
- **Fully auditable** — Every intentional divergence from CoinGecko is documented. No black-box surprises.
- **Built on open data** — CCXT, TrustWallet, [OpenGecko Assets](https://github.com/opengecko/assets), public on-chain sources. No proprietary data lock-in.

## Quick Start

```bash
git clone https://github.com/zed-wong/OpenGecko
cd OpenGecko
bun install
bun run dev
```

Server starts at `http://localhost:3000`.

## Deploying to Railway

1. Push this repo to GitHub.
2. In Railway, create a new project and select this repo.
3. Railway will use the included `Dockerfile` to build and run the app.
4. Add a persistent Volume and mount it to `/data`.
5. Set `DATABASE_URL=/data/opengecko.db`.
6. Deploy the service.
7. Verify the deployment with `/health` and `/diagnostics/runtime`.

Notes:

- The app listens on port `3000`.
- The SQLite database must live on the mounted volume, or data will be lost after restart or redeploy.

**Smoke check:**

```bash
curl "http://localhost:3000/ping"
curl "http://localhost:3000/simple/price?ids=bitcoin,ethereum&vs_currencies=usd"
curl "http://localhost:3000/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=5&page=1"
curl "http://localhost:3000/diagnostics/runtime"
curl "http://localhost:3000/diagnostics/jobs"
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
bun run test:endpoint:onchain
bun run test:endpoint:treasury
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

Three layers plus an in-process automation scheduler:

- **Compatibility API** — Fastify-powered REST surface matching CoinGecko contracts.
- **Domain Services** — Business logic, freshness enforcement, response shaping.
- **Storage / Provider** — SQLite hot snapshot (60s refresh) backed by CCXT live feeds.
- **Scheduler / Jobs** — Serialized in-memory jobs for market refresh, Tier 1 through Tier 3 sweeps, retention pruning, and optional source-backed syncs exposed through `/diagnostics/jobs`.

A background OHLCV worker runs continuously, prioritizing top-100 coins for recent data before deepening historical range. Search uses SQLite FTS5. Live automation now covers the primary market, exchange, derivatives, category, supply, movers, treasury, trending, and onchain replay paths where public or configured sources are available; fixture/fallback states remain explicit in diagnostics instead of being presented as paid-indexer parity.

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
| `GET /onchain/networks/{network}/pools` | Pool listings for a specific network |
| `GET /onchain/networks/{network}/pools/{address}` | Pool detail with optional related resources |
| `GET /onchain/networks/{network}/tokens/{address}` | Token market/detail view on a network |
| `GET /onchain/networks/{network}/pools/{pool_address}/trades` | Pool trade feed |
| `GET /onchain/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}` | Pool OHLCV series |
| `GET /onchain/networks/trending_pools` | Global trending pool feed |
| `GET /onchain/search/pools` | Pool search |
| `GET /onchain/categories` | Onchain category listings |

This README intentionally lists representative onchain routes rather than the full family. For detailed compatibility status and known gaps, see `docs/status/implementation-tracker.md`, `docs/status/compatibility-audit.md`, and `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`.

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
| `OHLCV_TARGET_HISTORY_DAYS` | `1825` | Default daily OHLCV history depth to backfill for generated chart/OHLC targets |
| `OHLCV_RETENTION_DAYS` | `1825` | Default canonical OHLCV retention window before old candles can be pruned |
| `COIN_HISTORY_TARGETS` | empty | Optional `provider=coin:YYYY-MM-DD` source-backed dated coin history sync targets |
| `COIN_HISTORY_BASE_URL` | unset | Base URL for the optional coin history provider adapter used by `bun run coin:history:sync` |
| `EXCHANGE_VOLUME_TARGETS` | empty | Optional `provider=exchange` source-backed exchange volume sync targets |
| `EXCHANGE_VOLUME_BASE_URL` | unset | Base URL for the optional exchange volume provider adapter used by `bun run exchange:volumes:sync` |
| `MARKET_CHART_TARGETS` | empty | Optional `provider=coin:interval:vs_currency` source-backed chart/OHLC sync targets; see `docs/reference/market-chart-targets.json` and `docs/reference/market-chart-provider-presets.json` |
| `MARKET_CHART_BASE_URL` | unset | Base URL for the optional market chart provider adapter used by `bun run market:charts:sync` |
| `ONCHAIN_ANALYTICS_TARGETS` | empty | Optional source-backed onchain holder/trader analytics sync targets |
| `ONCHAIN_ANALYTICS_BASE_URL` | unset | Base URL for the optional onchain analytics provider adapter used by `bun run onchain:analytics:sync` |
| `ONCHAIN_TRADE_TARGETS` | empty | Optional source-backed onchain pool trade sync targets |
| `ONCHAIN_TRADE_BASE_URL` | unset | Base URL for the optional onchain trade provider adapter used by `bun run onchain:trades:sync` |
| `SUPPLY_CHART_TARGETS` | empty | Optional `provider=coin:supply_type` source-backed supply chart sync targets |
| `SUPPLY_CHART_BASE_URL` | unset | Base URL for the optional supply chart provider adapter used by `bun run supply:charts:sync` |
| `OPTIONAL_PROVIDER_SYNC_ENABLED` | `false` | Enables interval scheduler hooks for optional source-backed sync jobs |
| `OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS` | `900` | Interval for optional provider sync scheduler when enabled |

Full schema in `src/config/env.ts`.

## Diagnostics & Operations

| Route | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `GET /diagnostics/runtime` | Startup state, stale fallback, provider and cache status |
| `GET /diagnostics/ohlcv_sync` | OHLCV worker progress, sync health, estimated remaining history backfill chunks, and capped most-behind target samples |
| `GET /diagnostics/chain_coverage` | Chain/network normalization coverage |
| `GET /diagnostics/market_charts` | Configured market chart targets, live/replay row counts, freshness/depth status, and fallback-only gaps |
| `GET /diagnostics/jobs` | Unified scheduler and optional provider sync job target counts, run state, sanitized failures, retention/sweep outcomes, and last persisted or in-process run outcome |
| `GET /metrics` | Prometheus-compatible metrics |

> [!TIP]
> For production, monitor `/diagnostics/runtime`, `/diagnostics/jobs`, and `/metrics` together to capture contract uptime, scheduler health, data freshness, and fallback/degraded states.

**Background jobs:**

```bash
bun run markets:refresh   # refresh hot market snapshots
bun run ohlcv:worker      # continuous OHLCV ingestion (top-100 first)
bun run search:rebuild    # rebuild SQLite FTS5 search index
bun run charts:backfill   # backfill historical OHLCV data
bun run coin:history:sync # optional source-backed dated coin history sync
bun run derivatives:sync  # optional/source-backed derivatives venue sync
bun run exchange:volumes:sync # optional source-backed exchange volume sync
bun run market:charts:sync # optional source-backed market chart/OHLC target sync
bun run onchain:analytics:sync # optional source-backed onchain holder/trader analytics sync
bun run onchain:trades:sync # optional source-backed onchain pool trade sync
bun run supply:charts:sync # optional source-backed supply chart sync
```

**OHLCV completion interpretation:**

```json
{
  "history": {
    "target_history_days": 1825,
    "completion_estimate": {
      "chunk_days": 180,
      "overlap_days": 2,
      "targets_incomplete": 42,
      "remaining_depth_days": 12800,
      "estimated_remaining_chunks": 76,
      "max_remaining_depth_days": 1825
    },
    "by_tier": {
      "top100": {
        "targets_at_target_depth": 58,
        "remaining_depth_days": 5400,
        "estimated_remaining_chunks": 31,
        "depth_status_counts": {
          "complete": 58,
          "catching_up": 37,
          "blocked": 5
        },
        "retry_recovery_counts": {
          "due": 2,
          "backoff": 3
        },
        "retry_starvation_counts": {
          "starved": 1
        }
      }
    },
    "retry_recovery_counts": {
      "due": 4,
      "backoff": 8
    },
    "retry_starvation_counts": {
      "starved": 2
    },
    "retry_starvation_thresholds": {
      "due_age_seconds": 120
    },
    "queue_priority_summary": {
      "totals": {
        "eligible_for_lease": 80,
        "retry_due_failed": 4,
        "retry_backoff_failed": 8,
        "incomplete_depth": 42,
        "complete_depth": 58,
        "running": 1,
        "starved_retry_due": 2
      },
      "by_tier": {
        "top100": {
          "eligible_for_lease": 60,
          "retry_due_failed": 2,
          "retry_backoff_failed": 3,
          "incomplete_depth": 42,
          "complete_depth": 58,
          "running": 1,
          "starved_retry_due": 1
        }
      }
    },
    "depth_alert_thresholds": {
      "complete_remaining_depth_days": 0,
      "catching_up_min_remaining_depth_days": 1,
      "blocked_statuses": ["failed"]
    },
    "most_behind_samples": {
      "top100": [
        {
          "coin_id": "bitcoin",
          "exchange_id": "binance",
          "symbol": "BTC/USDT",
          "vs_currency": "usd",
          "interval": "1d",
          "status": "active",
          "target_history_days": 1825,
          "oldest_synced_at": "2023-05-06T00:00:00.000Z",
          "latest_synced_at": "2026-05-06T00:00:00.000Z",
          "remaining_depth_days": 730,
          "estimated_remaining_chunks": 5
        }
      ]
    },
    "blocked_target_samples": {
      "top100": [
        {
          "coin_id": "ethereum",
          "exchange_id": "binance",
          "symbol": "ETH/USDT",
          "vs_currency": "usd",
          "interval": "1d",
          "status": "failed",
          "target_history_days": 1825,
          "remaining_depth_days": 730,
          "estimated_remaining_chunks": 5,
          "failure_count": 2,
          "next_retry_at": "2026-05-06T00:10:00.000Z",
          "retry_in_seconds": 600,
          "last_attempt_at": "2026-05-06T00:00:00.000Z",
          "last_success_at": "2026-05-05T23:50:00.000Z",
          "last_error": "rate limit"
        }
      ]
    }
  }
}
```

Use `/diagnostics/ohlcv_sync` and `history.completion_estimate` for the whole-worker backlog, then `history.by_tier` to see whether top100, requested, or long-tail targets are lagging. `depth_status_counts.complete` means a target has zero remaining depth, `catching_up` means it still has remaining depth and is not failed, and `blocked` means it still has remaining depth while the worker target is failed. `retry_recovery_counts.due` means failed targets have no future `next_retry_at` cursor and are eligible for the worker to lease again, while `backoff` means failed targets are still waiting for their retry cursor. `retry_starvation_counts.starved` means a failed target has been retry-due for at least `retry_starvation_thresholds.due_age_seconds` and may need operator intervention if it does not fall on the next worker ticks. `queue_priority_summary` gives coarse totals and per-tier buckets for `eligible_for_lease`, `retry_due_failed`, `retry_backoff_failed`, `incomplete_depth`, `complete_depth`, `running`, and `starved_retry_due`; use it to understand the next likely retry/backfill classes without treating it as an exact provider-call schedule. Remaining chunks are estimates from the current oldest coverage, `OHLCV_TARGET_HISTORY_DAYS`, and the worker's 180-day historical chunk size with a two-day overlap; they are planning numbers, not exact provider-call promises. `most_behind_samples` is capped per tier and sorted by highest `remaining_depth_days`, so it shows which target rows are currently blocking five-year coverage. `blocked_target_samples` is also capped per tier, sorted by retry cursor then remaining depth, and includes sanitized `last_error`, `failure_count`, `next_retry_at`, and `retry_in_seconds` metadata for failed incomplete targets without changing public chart or OHLC response shapes.

**OHLCV worker lease order:**

When several OHLCV targets are eligible, the worker leases by priority tier first (`top100`, then `requested`, then `long_tail`). Within the same tier it prefers retry-due failed targets, then targets with the largest `remaining_depth_days`, then the oldest `last_success_at`, and finally coin ID for deterministic tie-breaking. This means a complete long-tail target can wait behind top100 history deepening and retry recovery; it does not mean every high-priority target will receive an upstream provider call on every tick.

Daily `/coins/{id}/ohlc/range` requests use source-backed rows first, then canonical OHLCV storage, and can fall back to the configured ticker provider when the requested range is empty. Daily `/coins/{id}/market_chart` and `/coins/{id}/market_chart/range` requests use the same fallback path and expose provider OHLCV close prices as chart prices with stable market-cap and volume arrays. Successful fallback candles are persisted into canonical OHLCV storage so the same day window or range can be served locally on later requests; hourly ranges remain storage-backed only.

**Optional provider scheduler playbook:**

1. Keep `OPTIONAL_PROVIDER_SYNC_ENABLED=false` until target envs and provider base URLs are configured and verified with the standalone commands above.
2. Start with a bounded target set, such as the starter `MARKET_CHART_TARGETS` in `docs/reference/market-chart-targets.json`. It covers every seeded chart coin daily and intraday; `docs/reference/market-chart-provider-presets.json` shows provider-specific adapter IDs and request paths. Expand further by the gaps shown in `/diagnostics/market_charts`, `/diagnostics/coin_history`, `/diagnostics/exchange_volumes`, `/diagnostics/onchain_analytics`, `/diagnostics/onchain_trades`, and `/diagnostics/supply_charts`.
3. Run `GET /diagnostics/jobs` after each standalone command. The route reports target counts, last start/finish timestamps, rows written, failure reasons, partial-failure reasons, bounded sanitized partial-failure target samples, retry-only target templates from persisted job state, and the market chart `production_freshness_cadence` advisory.
4. Enable `OPTIONAL_PROVIDER_SYNC_ENABLED=true` only after diagnostics show the configured standalone jobs can succeed. Leave `OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS=900` unless the provider and database can safely handle a tighter interval.
5. Roll back by setting `OPTIONAL_PROVIDER_SYNC_ENABLED=false` and running the same standalone sync commands from cron or an external scheduler. Public API response shapes are unchanged either way.

**Market chart preset example:**

For the detailed chart/OHLC fallback remediation workflow, see [`docs/reference/market-chart-diagnostics-workflow.md`](docs/reference/market-chart-diagnostics-workflow.md). The README keeps a representative payload and command path here; the reference page is the source for operator triage steps.

```bash
export MARKET_CHART_BASE_URL="https://charts-adapter.example"
export MARKET_CHART_TARGETS="ccxt.binance=bitcoin:1d:usd,ccxt.binance=ethereum:1d:usd,ccxt.binance=solana:1d:usd"

bun run market:charts:sync
curl "http://localhost:3000/diagnostics/market_charts"

export OPTIONAL_PROVIDER_SYNC_ENABLED=true
export OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS=900
```

Use the provider IDs and request paths in `docs/reference/market-chart-provider-presets.json` as adapter contracts. Keep credentials in the adapter service behind `MARKET_CHART_BASE_URL`, not in `MARKET_CHART_TARGETS`.

**Market chart diagnostics interpretation:**

```json
{
  "summary": {
    "configured_targets": 2,
    "source_backed_configured_targets": 1,
    "status_counts": { "configured_pending": 1, "live_backed": 1 },
    "freshness_counts": { "fresh": 1, "stale": 1, "unknown": 0 },
    "production_freshness_counts": { "fresh": 0, "stale": 2, "unknown": 0 },
    "depth_counts": { "deep": 1, "shallow": 1, "empty": 0 }
  },
  "coins": [
    {
      "coin_id": "bitcoin",
      "interval": "1d",
      "status": "configured_pending",
      "coverage": { "freshness": "unknown", "depth": "empty" }
    },
    {
      "coin_id": "ethereum",
      "interval": "1m",
      "status": "live_backed",
      "coverage": { "freshness": "fresh", "depth": "deep" }
    }
  ],
  "gaps": {
    "stale_source_targets": ["bitcoin:usd:1d"],
    "production_stale_source_targets": ["ethereum:usd:1m"],
    "shallow_source_targets": ["solana:usd:1m"]
  },
  "response_source_counts": {
    "market_chart_days": {
      "source_backed": 12,
      "canonical": 42,
      "provider_filled": 3,
      "empty": 0
    },
    "ohlc_range": {
      "source_backed": 4,
      "canonical": 18,
      "provider_filled": 2,
      "empty": 1
    }
  },
  "response_source_recent_events": [
    {
      "route": "market_chart_range",
      "source": "empty",
      "coin_id": "bitcoin",
      "vs_currency": "usd",
      "interval": "daily",
      "request": {
        "kind": "range",
        "days": null,
        "from": "2026-04-02T00:00:00.000Z",
        "to": "2026-04-02T00:00:00.000Z"
      },
      "observed_at": "2026-05-06T03:00:00.000Z"
    }
  ],
  "response_source_recent_event_rollups": {
    "total_events": 2,
    "by_route": {
      "market_chart_range": { "provider_filled": 0, "empty": 1 },
      "ohlc_range": { "provider_filled": 1, "empty": 0 }
    },
    "by_coin": [
      {
        "coin_id": "bitcoin",
        "vs_currency": "usd",
        "total": 2,
        "provider_filled": 1,
        "empty": 1
      }
    ]
  },
  "response_source_target_suggestion_window": {
    "window_seconds": 604800,
    "cutoff_observed_at": "2026-04-29T00:00:00.000Z",
    "ignored_stale_events": 0
  },
  "response_source_target_suggestion_summary": {
    "recent_events_total": 2,
    "stale_events_ignored": 0,
    "events_inside_window": 2,
    "source_backed_events_suppressed": 0,
    "events_eligible_for_suggestion": 2,
    "unique_eligible_targets": 1,
    "suggestions_returned": 1,
    "suggestions_limit": 20
  },
  "response_source_fallback_alert": {
    "status": "action_needed",
    "reason": "unresolved_recent_fallback_pressure",
    "recent_events_total": 2,
    "events_eligible_for_suggestion": 2,
    "suggestions_returned": 1,
    "stale_events_ignored": 0,
    "source_backed_events_suppressed": 0
  },
  "response_source_target_suggestion_operator_summary": {
    "total_suggestions": 1,
    "target_history_counts": {
      "daily_history": 1,
      "intraday_history": 0
    },
    "suggested_action_counts": {
      "expand_daily_history": 1,
      "expand_intraday_history": 0
    },
    "request_pattern_counts": {
      "days": 0,
      "range": 1,
      "none": 0
    },
    "range_window_counts": {
      "intraday": 0,
      "single_day": 1,
      "multi_day": 0,
      "none": 0
    }
  },
  "response_source_target_suggestion_overflow": {
    "basis": "eligible_unique_targets_after_stale_and_source_backed_filtering",
    "suggestions_limit": 20,
    "eligible_targets": 1,
    "returned_suggestions": 1,
    "omitted_by_suggestion_cap": 0,
    "target_history_counts": {
      "daily_history": {
        "eligible_targets": 1,
        "returned_suggestions": 1,
        "omitted_by_suggestion_cap": 0
      },
      "intraday_history": {
        "eligible_targets": 0,
        "returned_suggestions": 0,
        "omitted_by_suggestion_cap": 0
      }
    }
  },
  "response_source_target_suggestion_batch_previews": {
    "provider_placeholder": "<provider>",
    "total_suggestions": 1,
    "cap": {
      "preview_source": "response_source_target_suggestions",
      "suggestions_returned": 1,
      "suggestions_limit": 20
    },
    "groups": {
      "daily_history": {
        "target_history": "daily_history",
        "suggested_action": "expand_daily_history",
        "target_count": 1,
        "target_templates": [
          "<provider>=bitcoin:1d:usd"
        ],
        "market_chart_targets_template": "<provider>=bitcoin:1d:usd"
      },
      "intraday_history": {
        "target_history": "intraday_history",
        "suggested_action": "expand_intraday_history",
        "target_count": 0,
        "target_templates": [],
        "market_chart_targets_template": null
      }
    }
  },
  "response_source_target_suggestion_exclusions": {
    "sample_limit": 5,
    "stale_events": [],
    "source_backed_events": [
      {
        "coin_id": "ethereum",
        "vs_currency": "usd",
        "interval": "1m",
        "target_template": "<provider>=ethereum:1m:usd",
        "route": "market_chart_range",
        "source": "empty",
        "observed_at": "2026-05-06T03:00:00.000Z",
        "request": {
          "kind": "range",
          "days": null,
          "from": "2026-05-06T02:00:00.000Z",
          "to": "2026-05-06T03:00:00.000Z"
        }
      }
    ]
  },
  "response_source_target_suggestions": [
    {
      "coin_id": "bitcoin",
      "vs_currency": "usd",
      "interval": "1d",
      "target_template": "<provider>=bitcoin:1d:usd",
      "reason": "recent provider-filled or empty public chart/OHLC fallback events",
      "event_counts": {
        "total": 2,
        "provider_filled": 1,
        "empty": 1
      },
      "priority": {
        "rank": 1,
        "pressure_score": 2,
        "latest_observed_at": "2026-05-06T03:00:00.000Z"
      },
      "route_pressure": {
        "dominant_route": "ohlc_range",
        "totals": {
          "market_chart_days": 0,
          "market_chart_range": 1,
          "ohlc_days": 0,
          "ohlc_range": 1
        }
      },
      "request_kind_pressure": {
        "dominant_kind": "range",
        "totals": {
          "days": 0,
          "range": 2
        }
      },
      "range_span_pressure": {
        "dominant_bucket": "single_day",
        "range_requests": 2,
        "buckets": {
          "intraday": 0,
          "single_day": 2,
          "multi_day": 0
        },
        "min_span_seconds": 0,
        "max_span_seconds": 0
      },
      "coverage_target_hint": {
        "target_history": "daily_history",
        "suggested_action": "expand_daily_history",
        "request_pattern": "range",
        "range_window": "single_day"
      },
      "sample_requests": [
        {
          "route": "ohlc_range",
          "source": "provider_filled",
          "observed_at": "2026-05-06T03:00:00.000Z",
          "request": {
            "kind": "range",
            "days": null,
            "from": "2026-04-02T00:00:00.000Z",
            "to": "2026-04-02T00:00:00.000Z"
          }
        }
      ]
    }
  ]
}
```

Use `summary` for the rollout view and `coins` for per-target detail. The `response_source_*` diagnostics show recent chart/OHLC fallback pressure, ranked target suggestions, daily/intraday batch previews, and suggestion-cap overflow counters. These fields are operator hints only: they do not change public chart/OHLC response shapes, choose providers, write config, or prove CoinGecko freshness. Use [`docs/reference/market-chart-diagnostics-workflow.md`](docs/reference/market-chart-diagnostics-workflow.md) for the full alert, batching, overflow, sync, and verification workflow.

## Migrating from CoinGecko

1. Switch your API base URL to your OpenGecko host.
2. Re-run your existing contract tests against OpenGecko.
3. Check `GET /diagnostics/runtime` and `GET /diagnostics/jobs` for initial sync state, scheduler progress, source-backed job outcomes, and any stale/degraded fallback conditions.
4. Validate the endpoints in your critical path first — `/simple`, `/coins`, `/exchanges` — before assuming broader parity.
5. Read `docs/status/implementation-tracker.md` and `docs/status/compatibility-audit.md` together so you separate route availability from data/runtime confidence.
6. Track any intentional incompatibilities in your integration docs.

OpenGecko documents every intentional divergence from CoinGecko in `docs/status/compatibility-audit.md` and `docs/status/implementation-tracker.md`.

## Built With

![Fastify](https://img.shields.io/badge/Fastify-5.2-black?logo=fastify)
![SQLite](https://img.shields.io/badge/SQLite-3-blue?logo=sqlite)
![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-0.44-blueviolet?logo=data)
![CCXT](https://img.shields.io/badge/CCXT-4.4-orange?logo=bitcoin)
