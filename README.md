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
- **Operator-visible data quality** — Provider liveness, stale/failing classification, cache behavior, market freshness, exchange live rows, ticker coverage, and chart/OHLC gaps are exposed through diagnostics instead of hidden behind fallback responses.
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
curl "http://localhost:3000/diagnostics/cache"
curl "http://localhost:3000/diagnostics/exchanges"
curl "http://localhost:3000/diagnostics/market_charts"
curl "http://localhost:3000/diagnostics/jobs"
```

**Developer commands:**

```bash
bun run dev                              # local dev server (hot reload)
bun run build                            # compile TypeScript
bun run lint                             # ESLint over src/
bun run typecheck                        # TypeScript type check
bun run test                             # run full test suite
bun run test:coverage                    # run full test suite with coverage
bun run test:data-quality                # run data-quality regression gate
bun run test:endpoint                    # smoke-test all endpoint families
bun run test:endpoint:simple
bun run test:endpoint:coins
bun run test:endpoint:exchanges
bun run test:endpoint:global
bun run test:endpoint:assets
bun run test:endpoint:search
bun run test:endpoint:onchain
bun run test:endpoint:treasury
bun run test:endpoint:mr-market-frontend
bun run db:generate                      # generate Drizzle migrations
bun run db:migrate                       # apply database migrations
bun run markets:refresh                  # refresh hot market snapshots
bun run ohlcv:worker                     # continuous OHLCV ingestion
bun run search:rebuild                   # rebuild SQLite FTS5 search index
bun run charts:backfill                  # backfill historical OHLCV data
bun run coin:history:sync                # optional dated coin history sync
bun run derivatives:sync                 # optional/source-backed derivatives sync
bun run exchange:volumes:sync            # optional exchange volume sync
bun run market:charts:sync               # optional chart/OHLC target sync
bun run onchain:analytics:sync           # optional holder/trader analytics sync
bun run onchain:trades:sync              # optional onchain pool trade sync
bun run supply:charts:sync               # optional supply chart sync
bun run benchmark:hot-routes             # benchmark hot API routes
bash scripts/operator-proof-smoke.sh     # end-to-end operator proof bundle
bun run coingecko:snapshots:capture      # capture CoinGecko snapshots
bun run coingecko:replay:offline         # replay captured CoinGecko snapshots offline
bun run coingecko:report:diff            # report snapshot diffs
bun run coingecko:report:improvement-gate # run the parity improvement report gate
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
| `GET /search/trending` | Trending coins, categories, and NFT-compatible groups |
| `GET /global` | Global market overview (total cap, volume, dominance) |
| `GET /global/decentralized_finance_defi` | DeFi market aggregate overview |
| `GET /global/market_cap_chart` | Global market cap history |
| `GET /token_lists/{asset_platform_id}/all.json` | Token-list payload for a supported asset platform |

### Coins & Markets

Coin listings, market data, historical charts, and contract resolution.

| Endpoint | Description |
|---|---|
| `GET /coins/list` | Full list of all supported coins with platform mappings |
| `GET /coins/list/new` | Newly discovered or activated coin listings |
| `GET /coins/markets` | Market data for coins (price, cap, volume, ATH/ATL, sparklines) |
| `GET /coins/top_gainers_losers` | Top gaining and losing coins over the requested duration |
| `GET /coins/{id}` | Detailed coin info — metadata, links, community data, market data |
| `GET /coins/{id}/history` | Point-in-time snapshot of a coin on a specific date |
| `GET /coins/{id}/market_chart` | Historical prices, market caps, and volumes |
| `GET /coins/{id}/market_chart/range` | Historical chart data for a specific time range |
| `GET /coins/{id}/ohlc` | OHLC candlestick data |
| `GET /coins/{id}/ohlc/range` | OHLC candlestick data over an explicit time range |
| `GET /coins/{id}/tickers` | Ticker data from exchanges and DEXs |
| `GET /coins/{id}/circulating_supply_chart` | Circulating supply series |
| `GET /coins/{id}/circulating_supply_chart/range` | Circulating supply series over an explicit time range |
| `GET /coins/{id}/total_supply_chart` | Total supply series |
| `GET /coins/{id}/total_supply_chart/range` | Total supply series over an explicit time range |
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
| `GET /exchanges/{id}/volume_chart/range` | Exchange volume history for an explicit time range |
| `GET /derivatives/exchanges/list` | List of derivatives exchanges |
| `GET /derivatives/exchanges` | Derivatives exchange data with OI and funding |
| `GET /derivatives/exchanges/{id}` | Detailed derivatives exchange data |
| `GET /derivatives/exchanges/{id}/tickers` | Derivatives exchange contract tickers |
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
| `GET /onchain/networks/{network}/dexes/{dex}/pools` | DEX-scoped pool listings |
| `GET /onchain/networks/{network}/new_pools` | Recently discovered pools for a network |
| `GET /onchain/networks/new_pools` | Recently discovered pools across networks |
| `GET /onchain/networks/{network}/trending_pools` | Trending pools for a network |
| `GET /onchain/networks/{network}/pools/{address}` | Pool detail with optional related resources |
| `GET /onchain/networks/{network}/pools/multi/{addresses}` | Multi-pool lookup on a network |
| `GET /onchain/networks/{network}/pools/{pool_address}/info` | Pool constituent token metadata |
| `GET /onchain/networks/{network}/tokens/{address}` | Token market/detail view on a network |
| `GET /onchain/networks/{network}/tokens/{token_address}/pools` | Pools for a token on a network |
| `GET /onchain/networks/{network}/tokens/multi/{addresses}` | Multi-token lookup on a network |
| `GET /onchain/networks/{network}/tokens/{token_address}/info` | Token metadata on a network |
| `GET /onchain/networks/{network}/tokens/{token_address}/top_holders` | Token holder leaderboard |
| `GET /onchain/networks/{network}/tokens/{token_address}/top_traders` | Token trader leaderboard |
| `GET /onchain/networks/{network}/tokens/{token_address}/holders_chart` | Token holder-count history |
| `GET /onchain/networks/{network}/tokens/{token_address}/ohlcv/{timeframe}` | Token OHLCV series aggregated from pools |
| `GET /onchain/networks/{network}/tokens/{token_address}/trades` | Token trade feed aggregated from pools |
| `GET /onchain/networks/{network}/pools/{pool_address}/trades` | Pool trade feed |
| `GET /onchain/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}` | Pool OHLCV series |
| `GET /onchain/simple/networks/{network}/token_price/{addresses}` | Simple token price lookup on a network |
| `GET /onchain/networks/trending_pools` | Global trending pool feed |
| `GET /onchain/search/pools` | Pool search |
| `GET /onchain/pools/megafilter` | Pool screener with filters |
| `GET /onchain/pools/trending_search` | Trending pool search feed |
| `GET /onchain/tokens/info_recently_updated` | Recently updated token metadata feed |
| `GET /onchain/categories` | Onchain category listings |
| `GET /onchain/categories/{category_id}/pools` | Category-scoped pool listings |

The API coverage table is guarded by `tests/docs-drift.test.ts` against the registered CoinGecko-compatible GET route surface. For detailed compatibility status and known gaps, see `docs/status/implementation-tracker.md`, `docs/status/compatibility-audit.md`, and `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | HTTP bind host |
| `PORT` | `3000` | HTTP bind port |
| `LOG_LEVEL` | `info` | Pino log level |
| `LOG_PRETTY` | `true` | Enable pretty local logs |
| `LOG_HTTP_STYLE` | `emoji_compact_p` | HTTP access-log format style |
| `DATABASE_URL` | `./data/opengecko.db` | SQLite database path |
| `CCXT_EXCHANGES` | `binance,bybit,coinbase,kraken,okx,gate,mexc,bitget,bigone,kucoin,htx,bitmart,lbank,whitebit,coinex,ascendex` | Active CCXT spot exchange set |
| `DERIVATIVES_CCXT_EXCHANGES` | `binance_futures=binanceusdm,bybit,okx,bitget` | Active CCXT derivatives exchange set |
| `COIN_HISTORY_TARGETS` | empty | Optional `provider=coin:YYYY-MM-DD` source-backed dated coin history sync targets |
| `EXCHANGE_VOLUME_TARGETS` | empty | Optional `provider=exchange` source-backed exchange volume sync targets |
| `MARKET_CHART_TARGETS` | empty | Optional `provider=coin:interval:vs_currency` source-backed chart/OHLC sync targets; see `docs/reference/market-chart-targets.json` and `docs/reference/market-chart-provider-presets.json` |
| `MARKET_CHART_USE_COVERAGE_PLAN` | `false` | Run `market:charts:sync` from the coverage target manifest and history backfill planner instead of only `MARKET_CHART_TARGETS` |
| `ONCHAIN_ANALYTICS_TARGETS` | empty | Optional source-backed onchain holder/trader analytics sync targets |
| `ONCHAIN_TRADE_TARGETS` | empty | Optional source-backed onchain pool trade sync targets |
| `SUPPLY_CHART_TARGETS` | empty | Optional `provider=coin:supply_type` source-backed supply chart sync targets |
| `TREASURY_DISCLOSURE_REPLAY_PATH` | empty | Optional local replay file for treasury disclosure source ingestion |
| `OPTIONAL_PROVIDER_SYNC_ENABLED` | `false` | Enables interval scheduler hooks for optional source-backed sync jobs |
| `OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS` | `900` | Interval for optional provider sync scheduler when enabled |
| `MARKET_REFRESH_INTERVAL_SECONDS` | `60` | Hot snapshot refresh cadence |
| `MARKET_FRESHNESS_THRESHOLD_SECONDS` | `300` | Freshness threshold for live reads |
| `CURRENCY_REFRESH_INTERVAL_SECONDS` | `300` | Exchange-rate refresh cadence |
| `SEARCH_REBUILD_INTERVAL_SECONDS` | `900` | Search index rebuild cadence |
| `OHLCV_REFRESH_INTERVAL_SECONDS` | `60` | OHLCV worker tick cadence |
| `DEFILLAMA_POOL_SWEEP_INTERVAL_SECONDS` | `300` | DeFiLlama pool sweep cadence |
| `DEFILLAMA_TOKEN_SWEEP_INTERVAL_SECONDS` | `600` | DeFiLlama token sweep cadence |
| `SUBSQUID_TRADE_SWEEP_INTERVAL_SECONDS` | `60` | Subsquid/SQD trade sweep cadence |
| `COIN_CATALOG_RESCAN_INTERVAL_SECONDS` | `3600` | CCXT coin catalog rescan cadence |
| `EXCHANGE_METADATA_RESCAN_INTERVAL_SECONDS` | `21600` | CCXT exchange metadata rescan cadence |
| `GLOBAL_AGGREGATOR_INTERVAL_SECONDS` | `60` | Global market aggregate refresh cadence |
| `CATEGORY_AGGREGATOR_INTERVAL_SECONDS` | `900` | Category aggregate refresh cadence |
| `DERIVATIVES_REFRESH_INTERVAL_SECONDS` | `120` | Derivatives source refresh cadence |
| `SUPPLY_AGGREGATOR_INTERVAL_SECONDS` | `900` | Supply aggregate refresh cadence |
| `TREASURY_SWEEP_INTERVAL_SECONDS` | `86400` | Treasury disclosure sweep cadence |
| `SCHEDULER_DISABLED` | `false` | Disable all in-process scheduler jobs |
| `MARKET_REFRESH_DISABLED` | `false` | Disable hot market refresh job |
| `CURRENCY_RATES_DISABLED` | `false` | Disable exchange-rate refresh job |
| `SEARCH_REBUILD_DISABLED` | `false` | Disable search-index rebuild job |
| `OHLCV_TICK_DISABLED` | `false` | Disable OHLCV worker ticks |
| `CACHE_EVICTION_DISABLED` | `false` | Disable cache eviction job |
| `DEFILLAMA_POOL_SWEEP_DISABLED` | `false` | Disable DeFiLlama pool sweeps |
| `DEFILLAMA_TOKEN_SWEEP_DISABLED` | `false` | Disable DeFiLlama token sweeps |
| `SUBSQUID_TRADE_SWEEP_DISABLED` | `false` | Disable Subsquid/SQD trade sweeps |
| `COIN_CATALOG_RESCAN_DISABLED` | `false` | Disable CCXT coin catalog rescans |
| `EXCHANGE_METADATA_RESCAN_DISABLED` | `false` | Disable CCXT exchange metadata rescans |
| `GLOBAL_AGGREGATOR_DISABLED` | `false` | Disable global market aggregate job |
| `CATEGORY_AGGREGATOR_DISABLED` | `false` | Disable category aggregate job |
| `DERIVATIVES_REFRESH_DISABLED` | `false` | Disable derivatives refresh job |
| `SUPPLY_AGGREGATOR_DISABLED` | `false` | Disable supply aggregate job |
| `TREASURY_SWEEP_DISABLED` | `false` | Disable treasury disclosure sweeps |
| `PROVIDER_FANOUT_CONCURRENCY` | `2` | Maximum provider fanout concurrency |
| `REQUEST_TIMEOUT_MS` | `15000` | Upstream provider request timeout |
| `OHLCV_TARGET_HISTORY_DAYS` | `1825` | Default daily OHLCV history depth to backfill for generated chart/OHLC targets |
| `OHLCV_RETENTION_DAYS` | `1825` | Default canonical OHLCV retention window before old candles can be pruned |
| `DEFILLAMA_BASE_URL` | `https://api.llama.fi` | DeFiLlama pool/token API origin |
| `DEFILLAMA_YIELDS_BASE_URL` | `https://yields.llama.fi` | DeFiLlama yields API origin |
| `RESPONSE_COMPRESSION_THRESHOLD_BYTES` | `1024` | Response-size threshold before compression is applied |
| `STARTUP_PREWARM_BUDGET_MS` | `250` | Startup prewarm time budget |
| `DISABLE_REMOTE_CURRENCY_REFRESH` | `false` | Skip remote currency refresh during startup/runtime validation |
| `OPEN_GECKO_REBUILD_CANONICAL_DB_ON_START` | `false` | Rebuild canonical SQLite data on startup |
| `OPEN_GECKO_DISABLE_REPO_DOTENV` | unset | Disable automatic loading of a repository-local `.env` file when set to `1` |
| `COIN_HISTORY_BASE_URL` | unset | Base URL for the optional coin history provider adapter used by `bun run coin:history:sync` |
| `EXCHANGE_VOLUME_BASE_URL` | unset | Base URL for the optional exchange volume provider adapter used by `bun run exchange:volumes:sync` |
| `MARKET_CHART_BASE_URL` | unset | Base URL for the optional market chart provider adapter used by `bun run market:charts:sync` |
| `ONCHAIN_ANALYTICS_BASE_URL` | unset | Base URL for the optional onchain analytics provider adapter used by `bun run onchain:analytics:sync` |
| `ONCHAIN_TRADE_BASE_URL` | unset | Base URL for the optional onchain trade provider adapter used by `bun run onchain:trades:sync` |
| `SUPPLY_CHART_BASE_URL` | unset | Base URL for the optional supply chart provider adapter used by `bun run supply:charts:sync` |

Full central schema in `src/config/env.ts`. The optional `*_BASE_URL` adapter settings are read directly by standalone sync jobs and are intentionally allowlisted by `tests/docs-drift.test.ts` until they move into the central config loader.

## Diagnostics & Operations

| Route | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `GET /diagnostics/runtime` | Startup state, stale fallback, provider and cache status, including per-provider `alert_status` (`healthy` / `degraded` / `failing`) derived from the runtime constants in `src/services/runtime-diagnostics.ts` |
| `GET /diagnostics/cache` | Market snapshot revision, route cache TTL/header policy, hit/miss counters, invalidation reasons, and operator evidence for `/coins/markets` and `/simple/price` |
| `GET /diagnostics/ohlcv_sync` | OHLCV worker progress, sync health, estimated remaining history backfill chunks, and capped most-behind target samples |
| `GET /diagnostics/chain_coverage` | Chain/network normalization coverage |
| `GET /diagnostics/coverage_matrix` | Endpoint-family data ownership and live/hybrid/seeded/fixture coverage matrix |
| `GET /diagnostics/data_quality` | Endpoint-family 0-10 quality scores, dimensions, source/fallback state, coverage consistency evidence, global recomputation comparison against `/global`, and regression-gate status |
| `GET /diagnostics/exchanges` | Exchange catalog/ticker diagnostics, including live row counts, configured exchange coverage, ticker freshness, and degraded/fallback evidence |
| `GET /diagnostics/exchange_volumes` | Source-backed exchange volume target coverage, row counts, freshness/depth status, and configured-target gaps |
| `GET /diagnostics/market_charts` | Configured market chart targets, live/replay row counts, freshness/depth status, continuity/fallback pressure, daily/intraday target suggestions, and fallback-only gaps |
| `GET /diagnostics/jobs` | Unified scheduler and optional provider sync job target counts, run state, sanitized failures, retention/sweep outcomes, and last persisted or in-process run outcome |
| `GET /metrics` | Prometheus-compatible metrics |

> [!TIP]
> For production, monitor `/diagnostics/runtime`, `/diagnostics/jobs`, and `/metrics` together to capture contract uptime, scheduler health, data freshness, and fallback/degraded states.

**Final data-quality regression gates:**

Run these gates against an isolated OpenGecko API (for example `HOST=127.0.0.1 PORT=3103 DATABASE_URL=/tmp/opengecko-quality-3103.db bun run dev`) after `/diagnostics/runtime` reports `initial_sync_completed=true`:

```bash
bun run lint
bun run typecheck
TMPDIR=/home/whoami/dev/opengecko/data bun run test -- --maxWorkers=4
bun run build
BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/test-endpoints.sh
BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/modules/simple/simple.sh
BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/modules/coins/coins.sh
BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/modules/exchanges/exchanges.sh
BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/modules/global/global.sh
BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/modules/search/search.sh
BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/modules/assets/assets.sh
BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/modules/treasury/treasury.sh
BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/modules/onchain/onchain.sh
OPENGECKO_QUALITY_EVIDENCE_DIR=/tmp/opengecko-quality-evidence \
  BASE_URL=http://127.0.0.1:3103 ENDPOINT_CURL_MAX_TIME=30 bash scripts/data-quality-gate.sh
```

Interpret `/diagnostics/data_quality` by checking `data.gate.threshold == 9`, every required family in `data.families[]` has `score >= 9`, and `data.gate.below_target_families` is empty. The gate also records stable evidence fields for CI (`base_url`, `run_timestamp`, `request_url`, HTTP status/content type, raw diagnostics, parsed metrics, assertion table, and mismatch report) when `OPENGECKO_QUALITY_EVIDENCE_DIR` is set. Treat `source.state`, dimension `reason_codes`, and `/diagnostics/coverage_matrix` as authoritative for whether a high score reflects live fidelity or contract-compatible fixture/hybrid transparency; fixture, seeded, unavailable, and degraded surfaces must remain labeled rather than counted as full live parity. The `global` family includes `global_quality.public_route_comparison`, which compares recomputed market rows to public `/global` USD totals and dominance values.

No paid secrets are required for these gates. Do not print or commit optional provider credentials; `COINGECKO_API_KEY` is only for separate snapshot capture workflows. Asset image validation uses deterministic URL-format and diagnostics evidence as the baseline. Bounded image `HEAD` checks are optional and should only be enabled when `ASSET_IMAGE_BASE_URL` is configured to a reachable host.

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
        "target_depth_days": 1825,
        "targets_at_target_depth": 58,
        "coverage_ratio": 0.70411,
        "slo_status": "blocked",
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

Use `/diagnostics/ohlcv_sync` and `history.completion_estimate` for the whole-worker backlog, then `history.by_tier` to see whether top100, requested, or long-tail targets are lagging. Each tier reports `target_depth_days`, `coverage_ratio`, and `slo_status` so operators can compare coverage across tiers without scanning every target. `depth_status_counts.complete` means a target has zero remaining depth, `catching_up` means it still has remaining depth and is not failed, and `blocked` means it still has remaining depth while the worker target is failed. `retry_recovery_counts.due` means failed targets have no future `next_retry_at` cursor and are eligible for the worker to lease again, while `backoff` means failed targets are still waiting for their retry cursor. `retry_starvation_counts.starved` means a failed target has been retry-due for at least `retry_starvation_thresholds.due_age_seconds` and may need operator intervention if it does not fall on the next worker ticks. `queue_priority_summary` gives coarse totals and per-tier buckets for `eligible_for_lease`, `retry_due_failed`, `retry_backoff_failed`, `incomplete_depth`, `complete_depth`, `running`, and `starved_retry_due`; use it to understand the next likely retry/backfill classes without treating it as an exact provider-call schedule. Remaining chunks are estimates from the current oldest coverage, `OHLCV_TARGET_HISTORY_DAYS`, and the worker's 180-day historical chunk size with a two-day overlap; they are planning numbers, not exact provider-call promises. `most_behind_samples` is capped per tier and sorted by highest `remaining_depth_days`, so it shows which target rows are currently blocking five-year coverage. `blocked_target_samples` is also capped per tier, sorted by retry cursor then remaining depth, and includes sanitized `last_error`, `failure_count`, `next_retry_at`, and `retry_in_seconds` metadata for failed incomplete targets without changing public chart or OHLC response shapes.

**OHLCV worker lease order:**

When several OHLCV targets are eligible, the worker leases by priority tier first (`top100`, then `requested`, then `long_tail`). Within the same tier it prefers retry-due failed targets, then targets with the largest `remaining_depth_days`, then the oldest `last_success_at`, and finally coin ID for deterministic tie-breaking. This means a complete long-tail target can wait behind top100 history deepening and retry recovery; it does not mean every high-priority target will receive an upstream provider call on every tick.

Daily `/coins/{id}/ohlc/range` requests use source-backed rows first, then canonical OHLCV storage, and can fall back to the configured ticker provider when the requested range is empty. Daily `/coins/{id}/market_chart` and `/coins/{id}/market_chart/range` requests use the same fallback path and expose provider OHLCV close prices as chart prices with stable market-cap and volume arrays. Successful fallback candles are persisted into canonical OHLCV storage so the same day window or range can be served locally on later requests; hourly ranges remain storage-backed only.

**Chart/OHLC continuity and intraday hardening:**

Market chart diagnostics now separate daily and intraday target pressure, report continuity gaps without changing public response shapes, and provide batch-ready `MARKET_CHART_TARGETS` templates for operator remediation. Use `/diagnostics/market_charts` after public chart or OHLC traffic to distinguish source-backed, canonical, provider-filled, and empty responses, then expand daily or intraday targets before enabling scheduled optional sync.

**Operator proof smoke:**

```bash
bash scripts/operator-proof-smoke.sh
```

The proof script starts isolated temp-SQLite runtimes, runs serial endpoint and diagnostics checks, captures provider liveness/failure-control evidence, verifies BTC/ETH market/ticker/chart/OHLC overlap readiness, records command exit codes, and writes a proof bundle under `${OPENGECKO_OPERATOR_PROOF_DIR}` or a temporary `/tmp/opengecko-operator-proof.*` directory.

**Snapshot retention contract:**

OpenGecko keeps retained history, not infinite history. The generated daily history targets use `OHLCV_TARGET_HISTORY_DAYS=1825` and canonical OHLCV candles follow `OHLCV_RETENTION_DAYS=1825`; both defaults come from `src/config/runtime-policy.ts` through the central environment schema in `src/config/env.ts`. Append-style source table pruning is handled by `enforceSnapshotRetention()` in `src/services/snapshot-retention.ts`, whose default snapshot retention horizon is 365 days when a caller does not pass an override.

The snapshot-retention sweep deletes rows older than the retention cutoff based on each source row's `sourceFetchedAt` timestamp, then reports retention/sweep outcomes through `/diagnostics/jobs` when run by scheduler or sync jobs. The contract covers these append-style source table surfaces:

| Table | Pruned timestamp | Runtime result field | Contract |
|---|---|---|---|
| `market_chart_source_points` | `sourceFetchedAt` | `marketChartSourcePoints` | Source-backed `/coins/{id}/market_chart*` and `/coins/{id}/ohlc*` replay rows are bounded by snapshot retention. |
| `exchange_volume_source_points` | `sourceFetchedAt` | `exchangeVolumeSourcePoints` | Exchange volume replay rows are bounded by snapshot retention. |
| `onchain_pool_trades` | `sourceFetchedAt` | `onchainPoolTrades` | Source-attributed pool trade rows are bounded by snapshot retention. |
| `supply_chart_points` | `sourceFetchedAt` | `supplyChartPoints` | Supply chart source rows are bounded by snapshot retention. |
| `coin_history_snapshots` | `sourceFetchedAt` | `coinHistorySnapshots` | Dated coin history source snapshots are bounded by snapshot retention. |

Retention removes storage rows only; it must not add fields to public CoinGecko-compatible response shapes. When a requested chart, OHLC, volume, supply, trade, or history range falls outside retained data, the route keeps its existing compatibility shape and uses the documented fallback/degraded behavior for that surface.

**Optional provider scheduler playbook:**

1. Keep `OPTIONAL_PROVIDER_SYNC_ENABLED=false` until target envs and provider base URLs are configured and verified with the standalone commands above.
2. Start with a bounded target set, such as the starter `MARKET_CHART_TARGETS` in `docs/reference/market-chart-targets.json`. It covers every seeded chart coin daily and intraday; `docs/reference/market-chart-provider-presets.json` shows chart adapter IDs and request paths, while `docs/reference/provider-target-presets.json` groups the broader source-backed presets. Start with `market-charts.coverage-plan.default`, then expand through `exchange-volumes.major-cex.daily`, `derivatives.ccxt-major-futures`, and `onchain-trades.ethereum-bluechip-pools` as diagnostics gaps shrink. Expand further by the gaps shown in `/diagnostics/market_charts`, `/diagnostics/coin_history`, `/diagnostics/exchange_volumes`, `/diagnostics/onchain_analytics`, `/diagnostics/onchain_trades`, and `/diagnostics/supply_charts`.
3. Run `GET /diagnostics/jobs` after each standalone command. The route reports target counts, last start/finish timestamps, rows written, failure reasons, partial-failure reasons, bounded sanitized partial-failure target samples, retry-only target templates from persisted job state, and the market chart `production_freshness_cadence` advisory.
4. Enable `OPTIONAL_PROVIDER_SYNC_ENABLED=true` only after diagnostics show the configured standalone jobs can succeed. Leave `OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS=900` unless the provider and database can safely handle a tighter interval.
5. Roll back by setting `OPTIONAL_PROVIDER_SYNC_ENABLED=false` and running the same standalone sync commands from cron or an external scheduler. Public API response shapes are unchanged either way.

**Market chart preset example:**

For the detailed chart/OHLC fallback remediation workflow, see [`docs/reference/market-chart-diagnostics-workflow.md`](docs/reference/market-chart-diagnostics-workflow.md). For the end-to-end sync, backfill, diagnostics, and before/after coverage validation playbook, see [`docs/reference/operator-validation-workflow.md`](docs/reference/operator-validation-workflow.md). The README keeps a representative payload and command path here; the reference pages are the source for operator triage steps.

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
