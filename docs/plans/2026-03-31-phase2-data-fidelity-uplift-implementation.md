# Phase 2 Data Fidelity Uplift Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Phase 2 of the data fidelity uplift plan to increase live data coverage from ~30% to ~55% by extending DeFiLlama pool/token discovery, enriching coin descriptions, and adding Subsquid address labels.

**Architecture:** Extend existing provider integrations (DeFiLlama, CCXT, Subsquid) with dynamic discovery and enrichment capabilities while maintaining backward compatibility with CoinGecko API contracts.

**Tech Stack:** Bun + TypeScript + Fastify + Zod + SQLite + Drizzle + CCXT + DeFiLlama API + Subsquid API

---

## Task 2.1: Extend DeFiLlama Pool Discovery Beyond Seeded Pools

**Files:**
- Modify: `src/modules/onchain.ts:317-442` (buildLiveOnchainCatalog function)
- Modify: `src/providers/defillama.ts` (add new fetch functions)
- Modify: `src/db/schema.ts` (add discovered pools table if needed)
- Test: `tests/modules/onchain.test.ts`

**Step 1: Add DeFiLlama pool discovery function**

```typescript
// In src/providers/defillama.ts
export async function fetchDefillamaDiscoveredPools(
  chain?: string,
  options: DefillamaRequestOptions = {}
): Promise<DefillamaYieldPool[] | null> {
  try {
    const poolsUrl = `${resolveYieldsBaseUrl(options.yieldsBaseUrl, options.baseUrl)}/pools`;
    const response = await fetchJson<{ data?: unknown[] }>('/pools', options, poolsUrl);
    
    if (!Array.isArray(response?.data)) {
      return null;
    }
    
    return response.data
      .map(normalizeYieldPool)
      .filter((pool): pool is DefillamaYieldPool => 
        pool !== null && 
        (!chain || pool.chain === chain) &&
        pool.tvlUsd !== null && 
        pool.tvlUsd > 100_000 // Minimum TVL threshold
      );
  } catch (error) {
    console.error('Failed to fetch DeFiLlama discovered pools', error);
    return null;
  }
}
```

**Step 2: Update buildLiveOnchainCatalog to include discovered pools**

```typescript
// In src/modules/onchain.ts - buildLiveOnchainCatalog function
// Add discovered pools to the catalog
const discoveredPools = await fetchDefillamaDiscoveredPools('Ethereum');
if (discoveredPools) {
  for (const pool of discoveredPools) {
    const projectSlug = pool.project ? slugifyOnchainId(pool.project) : null;
    if (!projectSlug) continue;
    
    // Check if pool already exists in seeded pools
    const existingPool = [...seededPoolMap.values()].find(p => {
      const tokenSet = new Set([p.baseTokenAddress, p.quoteTokenAddress].map(normalizeAddress));
      const poolTokens = new Set((pool.underlyingTokens ?? []).map(normalizeAddress));
      return tokenSet.has([...poolTokens][0] ?? '') && tokenSet.has([...poolTokens][1] ?? '');
    });
    
    if (!existingPool && pool.underlyingTokens && pool.underlyingTokens.length >= 2) {
      // Create discovered pool entry
      const poolAddress = `0x${Math.random().toString(16).slice(2, 42)}`; // Generate placeholder address
      const baseToken = pool.underlyingTokens[0];
      const quoteToken = pool.underlyingTokens[1];
      
      poolsByAddress.set(poolAddress, {
        priceUsd: null,
        reserveUsd: pool.tvlUsd,
        volume24hUsd: pool.volumeUsd1d,
        source: 'live',
      });
    }
  }
}
```

**Step 3: Update pool discovery routes to use live data**

```typescript
// In src/modules/onchain.ts - /onchain/networks/:network/pools route
// Replace seeded-only query with discovered pools
const discoveredPools = await fetchDefillamaDiscoveredPools('Ethereum');
const allPools = [
  ...database.db.select().from(onchainPools).where(eq(onchainPools.networkId, params.network)).all(),
  ...(discoveredPools?.map(pool => ({
    // Map discovered pool to expected format
  })) ?? [])
];
```

**Step 4: Test pool discovery**

```bash
bun test tests/modules/onchain.test.ts -t "pool discovery"
```

**Step 5: Commit changes**

```bash
git add src/providers/defillama.ts src/modules/onchain.ts
git commit -m "feat: extend DeFiLlama pool discovery beyond seeded pools"
```

---

## Task 2.2: DeFiLlama-based Token Discovery for ETH

**Files:**
- Modify: `src/providers/defillama.ts` (add token discovery function)
- Modify: `src/modules/onchain.ts` (update token routes)
- Test: `tests/modules/onchain.test.ts`

**Step 1: Add DeFiLlama token discovery function**

```typescript
// In src/providers/defillama.ts
export async function fetchDefillamaTokens(
  chain: string = 'Ethereum',
  options: DefillamaRequestOptions = {}
): Promise<Array<{
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  priceUsd: number | null;
}> | null> {
  try {
    const response = await fetchJson<Record<string, {
      coins?: Record<string, { price?: number; symbol?: string; decimals?: number }>;
    }>>(`/prices/current/coingecko:${chain}`, options);
    
    if (!response || typeof response !== 'object') {
      return null;
    }
    
    const tokens: Array<{
      address: string;
      name: string;
      symbol: string;
      decimals: number;
      priceUsd: number | null;
    }> = [];
    
    for (const [key, value] of Object.entries(response)) {
      if (key.startsWith(`${chain}:`) && value.coins) {
        for (const [coinKey, coinData] of Object.entries(value.coins)) {
          const address = coinKey.split(':').pop();
          if (address && address.startsWith('0x')) {
            tokens.push({
              address,
              name: coinData.symbol ?? 'Unknown',
              symbol: coinData.symbol ?? 'UNKNOWN',
              decimals: coinData.decimals ?? 18,
              priceUsd: coinData.price ?? null,
            });
          }
        }
      }
    }
    
    return tokens;
  } catch (error) {
    console.error('Failed to fetch DeFiLlama tokens', error);
    return null;
  }
}
```

**Step 2: Update token discovery to use live data**

```typescript
// In src/modules/onchain.ts - /onchain/networks/:network/tokens/:address route
// Enhance token discovery with DeFiLlama data
const liveTokens = await fetchDefillamaTokens('Ethereum');
if (liveTokens) {
  const tokenData = liveTokens.find(t => normalizeAddress(t.address) === normalizeAddress(params.address));
  if (tokenData) {
    // Enhance token resource with live data
    tokenResource.attributes.name = tokenData.name;
    tokenResource.attributes.symbol = tokenData.symbol;
    tokenResource.attributes.decimals = tokenData.decimals;
    tokenResource.attributes.price_usd = tokenData.priceUsd;
  }
}
```

**Step 3: Test token discovery**

```bash
bun test tests/modules/onchain.test.ts -t "token discovery"
```

**Step 4: Commit changes**

```bash
git add src/providers/defillama.ts src/modules/onchain.ts
git commit -m "feat: add DeFiLlama-based token discovery for ETH"
```

---

## Task 2.3: Multi-network DeFiLlama Discovery (Solana, etc.)

**Files:**
- Modify: `src/modules/onchain.ts` (update network config)
- Modify: `src/providers/defillama.ts` (add multi-chain support)
- Test: `tests/modules/onchain.test.ts`

**Step 1: Extend DEFILLAMA_NETWORK_CONFIG**

```typescript
// In src/modules/onchain.ts
const DEFILLAMA_NETWORK_CONFIG = {
  // ... existing config ...
  Avalanche: {
    networkId: 'avalanche',
    name: 'Avalanche',
    chainIdentifier: 43114,
    coingeckoAssetPlatformId: 'avalanche',
    nativeCurrencyCoinId: 'avalanche-2',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/127/small/avalanche.png',
  },
  Fantom: {
    networkId: 'fantom',
    name: 'Fantom',
    chainIdentifier: 250,
    coingeckoAssetPlatformId: 'fantom',
    nativeCurrencyCoinId: 'fantom',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/87/small/fantom.png',
  },
} as const;
```

**Step 2: Update buildLiveOnchainCatalog for multi-chain**

```typescript
// In src/modules/onchain.ts - buildLiveOnchainCatalog function
// Process pools from all supported chains
for (const entry of poolData.pools) {
  const networkConfig = entry.chain ? DEFILLAMA_NETWORK_CONFIG[entry.chain as keyof typeof DEFILLAMA_NETWORK_CONFIG] : undefined;
  if (!networkConfig) {
    continue; // Skip unsupported chains
  }
  
  // ... rest of processing logic ...
}
```

**Step 3: Test multi-network discovery**

```bash
bun test tests/modules/onchain.test.ts -t "multi-network discovery"
```

**Step 4: Commit changes**

```bash
git add src/modules/onchain.ts src/providers/defillama.ts
git commit -m "feat: add multi-network DeFiLlama discovery (Solana, Avalanche, Fantom)"
```

---

## Task 2.4: Coin Enrichment from CCXT

**Files:**
- Modify: `src/providers/ccxt.ts` (add coin metadata function)
- Modify: `src/modules/coins/detail.ts` (enrich coin details)
- Modify: `src/db/schema.ts` (add metadata fields if needed)
- Test: `tests/modules/coins.test.ts`

**Step 1: Add CCXT coin metadata extraction**

```typescript
// In src/providers/ccxt.ts
export function extractCoinMetadata(
  markets: ExchangeMarketSnapshot[],
  coinId: string
): {
  description: string | null;
  website: string | null;
  explorer: string | null;
  sourceCode: string | null;
  whitepaper: string | null;
} | null {
  const coinMarkets = markets.filter(m => 
    m.base.toLowerCase() === coinId.toLowerCase() ||
    m.baseName?.toLowerCase() === coinId.toLowerCase()
  );
  
  if (coinMarkets.length === 0) {
    return null;
  }
  
  // Extract metadata from market info
  const firstMarket = coinMarkets[0];
  const rawInfo = firstMarket.raw as Record<string, unknown>;
  
  return {
    description: (rawInfo?.description as string) ?? null,
    website: (rawInfo?.info?.website as string) ?? null,
    explorer: (rawInfo?.info?.explorer as string) ?? null,
    sourceCode: (rawInfo?.info?.sourceCode as string) ?? null,
    whitepaper: (rawInfo?.info?.whitepaper as string) ?? null,
  };
}
```

**Step 2: Update coin detail enrichment**

```typescript
// In src/modules/coins/detail.ts - buildCoinDetail function
// Enrich description and links from CCXT
const ccxtMetadata = extractCoinMetadata(markets, coin.id);
if (ccxtMetadata) {
  if (ccxtMetadata.description && !description.en) {
    description.en = ccxtMetadata.description;
  }
  
  if (ccxtMetadata.website) {
    links.homepage = [ccxtMetadata.website];
  }
  
  if (ccxtMetadata.explorer) {
    links.blockchain_site = [ccxtMetadata.explorer];
  }
  
  if (ccxtMetadata.sourceCode) {
    links.repos_url = { github: [ccxtMetadata.sourceCode] };
  }
}
```

**Step 3: Test coin enrichment**

```bash
bun test tests/modules/coins.test.ts -t "coin enrichment"
```

**Step 4: Commit changes**

```bash
git add src/providers/ccxt.ts src/modules/coins/detail.ts
git commit -m "feat: enrich coin details with CCXT metadata"
```

---

## Task 2.5: Subsquid Address-label Enrichment for Swap Trades

**Files:**
- Modify: `src/providers/sqd.ts` (add label enrichment)
- Modify: `src/modules/onchain.ts` (update trades response)
- Test: `tests/modules/onchain.test.ts`

**Step 1: Add address label mapping**

```typescript
// In src/providers/sqd.ts
const KNOWN_LABELS: Record<string, string> = {
  // Major DEX routers
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap Universal Router',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router 2',
  // Add more known addresses as needed
};

export function resolveAddressLabel(address: string): string | null {
  return KNOWN_LABELS[address.toLowerCase()] ?? null;
}
```

**Step 2: Update trades response with labels**

```typescript
// In src/modules/onchain.ts - buildTradeResource function
function buildTradeResource(trade: OnchainTradeRecord, label?: string | null) {
  return {
    id: trade.id,
    type: 'trade',
    attributes: {
      tx_hash: trade.txHash,
      side: trade.side,
      token_address: trade.tokenAddress,
      volume_in_usd: String(trade.volumeUsd),
      price_in_usd: String(trade.priceUsd),
      block_timestamp: trade.blockTimestamp,
      ...(label ? { address_label: label } : {}),
    },
    // ... rest of resource
  };
}

// Update trades route to include labels
const tradesWithLabels = trades.map(trade => ({
  ...trade,
  label: resolveAddressLabel(trade.poolAddress),
}));
```

**Step 3: Test address label enrichment**

```bash
bun test tests/modules/onchain.test.ts -t "address labels"
```

**Step 4: Commit changes**

```bash
git add src/providers/sqd.ts src/modules/onchain.ts
git commit -m "feat: add Subsquid address-label enrichment for swap trades"
```

---

## Verification Checklist

- [ ] All Phase 2 tasks completed
- [ ] Tests passing: `bun test`
- [ ] Linting passing: `bun run lint`
- [ ] Type checking passing: `bun run typecheck`
- [ ] Documentation updated: `docs/status/implementation-tracker.md`
- [ ] API compatibility maintained with CoinGecko endpoints
- [ ] Live data coverage increased from ~30% to ~55%

## Next Steps

After completing Phase 2:
1. Update implementation tracker with new status
2. Run full test suite to ensure no regressions
3. Consider Phase 3 tasks (fixture documentation and hardening)
4. Monitor live data performance and error rates
