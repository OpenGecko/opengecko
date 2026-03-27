# Onchain Data Sources Research: DeFiLlama + The Graph

> Researched 2026-03-27. Covers DeFiLlama Free/Pro API and The Graph decentralized subgraphs.

---

## 1. DeFiLlama API

### Overview
DeFiLlama provides free, open-source DeFi analytics covering 7,000+ protocols on 500+ chains.

### Base URLs & Authentication

| Tier | Base URL | Auth | Cost |
|------|----------|------|------|
| **Free** | `https://api.llama.fi` | None required | Free |
| **Pro** | `https://pro-api.llama.fi/{API_KEY}` | API key in URL path | $300/month |

- **Free tier**: 31 endpoints, standard rate limits, no API key needed.
- **Pro tier**: 38 exclusive endpoints + all 31 free endpoints with higher rate limits.
- Rate limits: not published as exact numbers; described as "standard" (free) vs "higher" (pro). In practice the free tier is generous for moderate use.

### Key Endpoints for OpenGecko Onchain Data

#### Token Prices (Free)
- `GET /prices/current/{coins}` — current prices by `{chain}:{address}` (e.g., `ethereum:0xdF57...`)
- `GET /prices/historical/{timestamp}/{coins}` — historical price at a timestamp
- `GET /chart/{coins}` — price time series at regular intervals (configurable `period`: `2d`, `1h`, etc.)
- `GET /percentage/{coins}` — percentage change over time
- `GET /batchHistorical` — batch historical prices for multiple tokens at multiple timestamps

#### DEX Volume Data (Free)
- `GET /overview/dexs` — all DEXes with volume summaries (total24h, total7d, total30d, totalAllTime)
- `GET /overview/dexs/{chain}` — DEX volumes filtered by chain
- `GET /summary/dexs/{protocol}` — per-protocol DEX volume with historical chart data
- Response includes: `total24h`, `total7d`, `total30d`, `totalAllTime`, `change_1d/7d/1m`, chain breakdowns
- **1,057 DEX protocols** currently indexed

#### TVL Data (Free)
- `GET /protocols` — all protocols with TVL, category, chains
- `GET /protocol/{protocol}` — historical TVL with token/chain breakdowns
- `GET /tvl/{protocol}` — current TVL (simple number)
- `GET /v2/chains` — current TVL per chain

#### Yield Pools (Free)
- `GET /pools` (served from `yields.llama.fi/pools`) — **18,559 pools** currently indexed
- Per-pool fields: `chain`, `project`, `symbol`, `tvlUsd`, `apy`, `apyBase`, `apyReward`, `rewardTokens`, `pool` (UUID), `underlyingTokens` (contract addresses), `volumeUsd1d`, `volumeUsd7d`, `stablecoin`, `ilRisk`, `exposure`, `predictions`
- `GET /chart/{pool}` — historical APY and TVL for a specific pool

#### Fees & Revenue (Free)
- `GET /overview/fees` — all protocols with fee/revenue summaries
- `GET /overview/fees/{chain}` — fees by chain
- `GET /summary/fees/{protocol}` — per-protocol fee/revenue history

#### Pro-Only Relevant Endpoints
- `GET /api/historicalLiquidity/{token}` — token liquidity depth over time
- Bridge data, token unlocks, ETF data, equities OHLCV (not relevant for onchain DEX)

### DeFiLlama Response Format Example (Yields /pools)
```json
{
  "status": "success",
  "data": [
    {
      "chain": "Ethereum",
      "project": "uniswap-v3",
      "symbol": "USDC-WETH",
      "tvlUsd": 184000000,
      "apyBase": 12.5,
      "apy": 12.5,
      "pool": "747c1d2a-c668-4682-b9f9-296708a3dd90",
      "underlyingTokens": ["0xa0b8...", "0xc02a..."],
      "volumeUsd1d": 50000000,
      "volumeUsd7d": 350000000,
      "stablecoin": false,
      "ilRisk": "yes"
    }
  ]
}
```

### DeFiLlama Limitations
- **No per-pool reserve breakdown** (token0 amount / token1 amount) — only aggregate `tvlUsd`
- **No individual swap/trade events** — only aggregate volume
- **No transaction-level data** (tx hashes, sender/receiver, individual trade amounts)
- **No OHLCV candlestick data** for token pairs (only price time series via `/chart/{coins}`)
- **No token holder data**
- Volume data is **daily granularity** at best (total24h), not real-time trade-by-trade
- Pool UUIDs are DeFiLlama-internal, not on-chain pool addresses

---

## 2. The Graph (Decentralized Subgraphs)

### Overview
The Graph is a decentralized indexing protocol for querying blockchain data via GraphQL. It indexes smart contract events into queryable subgraphs.

### Authentication & Pricing

| Plan | Queries/Month | Cost |
|------|--------------|------|
| **Free** | 100,000 | Free |
| **Growth** | Unlimited | $2 per 100,000 queries (credit card or GRT token) |

- **API key required**: Yes — create at [The Graph Studio](https://thegraph.com/studio/apikeys/)
- Endpoint format: `https://gateway.thegraph.com/api/{API_KEY}/subgraphs/id/{SUBGRAPH_ID}`
- Payment: Credit card or GRT (The Graph token) on Arbitrum
- Rate limits: Not explicitly documented beyond the billing model; queries are metered, not rate-limited per se.

### Uniswap V3 Subgraph (Ethereum Mainnet)

**Subgraph ID**: `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`

**Endpoint**:
```
https://gateway.thegraph.com/api/{API_KEY}/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV
```

**Multi-chain Uniswap V3 Subgraph IDs**:
| Chain | Subgraph ID |
|-------|------------|
| Ethereum | `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV` |
| Arbitrum | `FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM` |
| Base | `43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG` |
| Optimism | `Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj` |
| Polygon | `3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm` |
| BSC | `F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2` |
| Avalanche | `GVH9h9KZ9CqheUEL93qMbq7QwgoBu32QXQDPR6bev4Eo` |

**Uniswap V4 (Mainnet)**: `DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G`

### GraphQL Query Examples

#### Query Pool Data
```graphql
{
  pool(id: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8") {
    tick
    token0 { symbol, id, decimals }
    token1 { symbol, id, decimals }
    feeTier
    sqrtPrice
    liquidity
  }
}
```

#### Query Top Pools by Liquidity
```graphql
{
  pools(first: 1000, orderBy: liquidity, orderDirection: desc) {
    id
    token0 { id, symbol }
    token1 { id, symbol }
    feeTier
    liquidity
    sqrtPrice
  }
}
```

#### Query Recent Swaps in a Pool
```graphql
{
  swaps(
    orderBy: timestamp, orderDirection: desc,
    where: { pool: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8" }
  ) {
    sender
    recipient
    amount0
    amount1
    timestamp
    transaction { id, blockNumber, gasUsed, gasPrice }
    token0 { id, symbol }
    token1 { id, symbol }
  }
}
```

#### Query Pool Daily Aggregated Data
```graphql
{
  poolDayDatas(
    first: 30, orderBy: date,
    where: { pool: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", date_gt: 1700000000 }
  ) {
    date
    liquidity
    sqrtPrice
    token0Price
    token1Price
    volumeToken0
    volumeToken1
  }
}
```

#### Query Token Data
```graphql
{
  token(id: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") {
    symbol
    name
    decimals
    volumeUSD
    poolCount
  }
}
```

#### Query Token Daily Data (for OHLCV derivation)
```graphql
{
  tokenDayDatas(
    first: 30,
    where: { token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
    orderBy: date, orderDirection: asc
  ) {
    date
    token { id, symbol }
    volumeUSD
    open
    high
    low
    close
    priceUSD
  }
}
```

### Available Data from Uniswap V3 Subgraph
- **Pool registry**: pool address, token0/token1, feeTier, liquidity, sqrtPrice, tick
- **Swap events**: individual trades with amounts, sender, recipient, timestamp, tx hash
- **Daily aggregates**: `poolDayData` with volume per token, liquidity, prices
- **Token data**: symbol, name, decimals, total volume, pool count
- **Token daily data**: `tokenDayData` with daily volume and price
- **Position data**: NFT positions with fees collected, liquidity
- **Pagination**: max 1000 items per query, use `skip` for pagination

### Solana / Raydium Support on The Graph

- **The Graph supports Solana** via Substreams-powered subgraphs (announced 2023, expanded 2025).
- Solana is listed as a supported network at `thegraph.com/networks/solana/`.
- **No official Raydium subgraph** exists on The Graph's decentralized network as of March 2026.
- Solana DEX data (Raydium, Orca, Jupiter) would need:
  - A custom Substreams-powered subgraph (community-built), OR
  - Alternative indexing via Helius, Shyft, or direct RPC + Geyser plugins
- DeFiLlama already covers Raydium volume/TVL at the aggregate level.

---

## 3. Coverage Assessment: DeFiLlama + The Graph Combined

### What CAN be provided

| Data Need | Source | Coverage |
|-----------|--------|----------|
| **Pool registry** (networks, DEXes, pools) | DeFiLlama `/pools` + The Graph subgraphs | ✅ DeFiLlama: 18,559 yield pools with chain/project/TVL. The Graph: all on-chain pools with token pair, fee tier, liquidity |
| **Pool reserves/liquidity** | The Graph subgraphs | ✅ `liquidity`, `sqrtPrice` per pool (derive reserve amounts from concentrated liquidity math) |
| **Pool volume (aggregate)** | DeFiLlama `/overview/dexs`, `/pools` | ✅ Daily aggregate volume per DEX, per chain. Per-pool `volumeUsd1d`/`volumeUsd7d` in yields endpoint |
| **Recent swap/trade events** | The Graph subgraphs | ✅ Individual swap events with amounts, sender, recipient, timestamp, tx hash (EVM chains only) |
| **Token prices** | DeFiLlama `/prices/current`, `/chart` | ✅ Current and historical prices by `{chain}:{address}`. Time series with configurable period |
| **Token metadata** | The Graph subgraphs | ✅ Symbol, name, decimals, pool count, total volume |
| **Daily OHLCV-style data** | The Graph `poolDayData`/`tokenDayData` + DeFiLlama `/chart` | ⚠️ Partial: daily granularity from subgraph day data. DeFiLlama `/chart` gives price series. No native minute/hour OHLCV candles |
| **DEX fees & revenue** | DeFiLlama `/overview/fees` | ✅ Per-protocol and per-chain fee/revenue data |
| **TVL** | DeFiLlama `/tvl`, `/protocols` | ✅ Protocol-level and chain-level TVL |
| **Multi-chain coverage** | Both | ✅ DeFiLlama: 500+ chains. The Graph: Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, Avalanche, Celo, Blast, Solana (via Substreams) |

### What CANNOT be provided (Gaps)

| Data Need | Gap | Potential Workaround |
|-----------|-----|---------------------|
| **Intraday OHLCV candles** (1m, 5m, 15m, 1h) | Neither source provides pre-built sub-daily candles | Build from swap events via The Graph: query swaps in time windows, compute O/H/L/C from individual trade prices |
| **Token holder data** (number of holders, top holders, holder distribution) | Neither source provides this | Use Etherscan/Blockscout APIs, or Moralis/Alchemy token holder endpoints |
| **Per-pool reserve amounts** (exact token0/token1 balances) | DeFiLlama only has aggregate USD TVL; The Graph V3 uses concentrated liquidity (not simple reserves) | For V2-style pools: query `reserve0`/`reserve1` from V2 subgraph. For V3: derive from `liquidity` + `sqrtPrice` + tick range |
| **Solana DEX trade-level data** (Raydium, Orca, Jupiter swaps) | No Raydium/Orca subgraph on The Graph | Use Helius DAS API, Shyft, or Birdeye API for Solana trade data. DeFiLlama covers aggregate volume |
| **Order book data** | Neither source (DEXes are AMM-based) | Not applicable for AMM DEXes; use CCXT for CEX order books |
| **Real-time streaming** (WebSocket trades) | The Graph is query-based, not streaming | Poll The Graph at intervals; or use direct RPC/WebSocket subscriptions for real-time |
| **Transaction count per pool** | Not directly in DeFiLlama pools; available in The Graph (`txCount` on factory/pool) | Use The Graph `pool.txCount` |

---

## 4. Authentication Summary

| Source | API Key Required? | Free Tier | Cost Beyond Free |
|--------|------------------|-----------|------------------|
| **DeFiLlama Free API** | ❌ No | Unlimited (standard rate) | N/A |
| **DeFiLlama Pro API** | ✅ Yes (in URL path) | N/A | $300/month |
| **The Graph** | ✅ Yes (in URL path) | 100,000 queries/month | $2 per 100,000 queries |

---

## 5. Recommended Integration Strategy for OpenGecko

### Primary Layer: DeFiLlama (Free API)
- Token prices (`/prices/current`, `/chart`)
- DEX volume aggregates (`/overview/dexs`, `/summary/dexs/{protocol}`)
- Pool discovery and TVL (`/pools` via yields endpoint)
- Fee/revenue data (`/overview/fees`)
- Protocol and chain TVL (`/protocols`, `/v2/chains`)

### Detail Layer: The Graph Subgraphs
- Individual pool data (reserves, liquidity, fee tier)
- Swap/trade events (for recent trades feed and OHLCV construction)
- Pool daily aggregates (`poolDayData` for daily candles)
- Token metadata enrichment

### Gap-Fill Layer (Future)
- Solana trade data: Helius DAS API or Birdeye
- Token holder data: Etherscan/Moralis/Alchemy
- Sub-daily OHLCV: derive from swap events polled from The Graph

### Cost Estimate
- DeFiLlama Free API: **$0/month** (sufficient for most needs)
- The Graph: **~$20-50/month** for moderate query volume (1M-2.5M queries/month)
- Total: **$20-50/month** for comprehensive onchain data coverage

---

## 6. SDK / Client Libraries

- **DeFiLlama JS SDK**: `npm install @defillama/api` ([GitHub](https://github.com/DefiLlama/api-sdk))
- **DeFiLlama Python SDK**: `pip install defillama-sdk`
- **The Graph**: Use any GraphQL client (e.g., `graphql-request` for Node.js). No official SDK — just POST GraphQL queries to the endpoint.

---

## 7. Key Implementation Notes

1. **DeFiLlama pools endpoint** (`yields.llama.fi/pools`) returns yield-farming pools, not all AMM pools. It's curated and enriched but not exhaustive for pool discovery.
2. **The Graph pagination** is capped at 1000 items per query. Use `skip` parameter or `id_gt` cursor for larger datasets.
3. **DeFiLlama coin identifiers** use `{chain}:{address}` format (e.g., `ethereum:0xdF57...`). Map these to CoinGecko-style IDs in OpenGecko.
4. **The Graph subgraph IDs may change** when subgraphs are upgraded. Pin to known IDs and monitor for migrations.
5. **Uniswap V3 concentrated liquidity** means reserves aren't simple — must compute from `liquidity`, `sqrtPrice`, and tick ranges.
6. **DeFiLlama volume data** at the DEX overview level is protocol-aggregate, not per-pool. Per-pool volume is only available in the yields endpoint (`volumeUsd1d`) and only for yield-tracked pools.
