# Architecture

Architectural decisions, patterns discovered, and module boundaries.

---

## Module Structure

```
src/
├── app.ts              # Fastify app builder, route registration
├── server.ts           # Entry point (listen)
├── config/env.ts       # Zod-validated environment config
├── db/
│   ├── schema.ts       # Drizzle schema (all tables)
│   ├── client.ts       # DB creation, migration, seeding
│   ├── search-index.ts # FTS5 search index
│   └── migrate.ts      # Migration runner
├── http/
│   ├── errors.ts       # HttpError class
│   └── params.ts       # Query parameter parsers
├── lib/
│   ├── coin-id.ts      # Coin ID derivation, overrides
│   ├── platform-id.ts  # Platform alias resolution (NEW)
│   ├── conversion.ts   # Currency conversion
│   └── async.ts        # Concurrency helpers
├── modules/
│   ├── catalog.ts      # Shared coin/market data queries
│   ├── coins.ts        # /coins/* routes
│   ├── coins/          # Coin detail helpers
│   ├── simple.ts       # /simple/* routes
│   ├── assets.ts       # /asset_platforms, /token_lists
│   ├── exchanges.ts    # /exchanges/*, /derivatives/*
│   ├── onchain.ts      # /onchain/* routes (2700+ lines)
│   ├── search.ts       # /search
│   ├── global.ts       # /global
│   └── diagnostics.ts  # /diagnostics/*
├── providers/
│   └── ccxt.ts         # CCXT exchange provider (tickers, markets, OHLCV, networks)
├── services/           # Business logic, sync jobs, runtime state
└── types/              # Shared type declarations
```

## Data Flow

1. **Boot**: createDatabase → migrateDatabase → runInitialMarketSync → seedStaticReferenceData → rebuildSearchIndex → startupPrewarm
2. **Live refresh**: 60s market snapshots → 900s search rebuild → continuous OHLCV worker
3. **HTTP request**: Fastify route → module handler → catalog/service query → SQLite → JSON response

## Snapshot Parity Flow

For the snapshot-parity mission, parity work should follow this artifact flow:

1. checked-in capture manifest selects canonical endpoint paths/variants
2. bounded CoinGecko Pro capture writes raw artifacts under `data/coingecko-snapshots/`
3. offline replay hits the local validation API on `3102`
4. diff/report tooling compares replay artifacts to stored upstream artifacts
5. targeted fixes improve endpoint data fidelity without changing public contracts

## Onchain Architecture

All 29 onchain routes exist but are fixture-backed. Key fixture functions:
- `buildOnchainTradeFixtures()` — 8 hardcoded trades
- `buildSyntheticPoolOhlcvSeries()` — synthetic candles from seed prices
- `buildTopHolderFixtures()` / `buildTopTraderFixtures()` — USDC-only fixtures
- `buildHoldersChartFixtures()` — 3-point USDC chart

Live data integration plan: DeFiLlama for pools/TVL/prices, SQD/Subsquid direct EVM log queries for Ethereum swap events/OHLCV when public Graph access is unavailable.
