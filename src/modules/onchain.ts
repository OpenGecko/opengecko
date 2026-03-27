import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { coins, marketSnapshots, onchainDexes, onchainNetworks, onchainPools } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt } from '../http/params';
import { buildCoinId } from '../lib/coin-id';
import { fetchDefillamaDexVolumes, fetchDefillamaPoolData, fetchDefillamaTokenPrices } from '../providers/defillama';
import { fetchEthereumPoolSwapLogs } from '../providers/sqd';
import { fetchUniswapV3PoolSwaps } from '../providers/thegraph';

const paginationQuerySchema = z.object({
  page: z.string().optional(),
});

const poolListQuerySchema = z.object({
  page: z.string().optional(),
  sort: z.enum(['h24_volume_usd_liquidity_desc', 'h24_tx_count_desc', 'reserve_in_usd_desc']).optional(),
});

const poolIncludeSchema = z.enum(['network', 'dex']);

const poolDetailQuerySchema = z.object({
  include: z.string().optional(),
  include_volume_breakdown: z.string().optional(),
  include_composition: z.string().optional(),
});

const poolMultiQuerySchema = z.object({
  include: z.string().optional(),
});

const discoveryPoolsQuerySchema = z.object({
  page: z.string().optional(),
  include: z.string().optional(),
});

const trendingPoolsQuerySchema = z.object({
  page: z.string().optional(),
  include: z.string().optional(),
  duration: z.string().optional(),
});

const searchPoolsQuerySchema = z.object({
  query: z.string().optional(),
  network: z.string().optional(),
  page: z.string().optional(),
});

const trendingSearchQuerySchema = z.object({
  page: z.string().optional(),
  per_page: z.string().optional(),
  pools: z.string().optional(),
});

const megafilterQuerySchema = z.object({
  page: z.string().optional(),
  per_page: z.string().optional(),
  include: z.string().optional(),
  networks: z.string().optional(),
  dexes: z.string().optional(),
  min_reserve_in_usd: z.string().optional(),
  max_reserve_in_usd: z.string().optional(),
  min_volume_usd_h24: z.string().optional(),
  max_volume_usd_h24: z.string().optional(),
  min_tx_count_h24: z.string().optional(),
  max_tx_count_h24: z.string().optional(),
  sort: z.string().optional(),
});

const tokenDetailQuerySchema = z.object({
  include: z.string().optional(),
  include_inactive_source: z.string().optional(),
  include_composition: z.string().optional(),
});

const tokenMultiQuerySchema = z.object({
  include: z.string().optional(),
});

const simpleTokenPriceQuerySchema = z.object({
  include_market_cap: z.string().optional(),
  include_24hr_vol: z.string().optional(),
  include_24hr_price_change: z.string().optional(),
  include_total_reserve_in_usd: z.string().optional(),
});

const poolInfoQuerySchema = z.object({
  include: z.string().optional(),
});

const recentlyUpdatedTokenInfoQuerySchema = z.object({
  include: z.string().optional(),
  network: z.string().optional(),
  page: z.string().optional(),
});

const tradesQuerySchema = z.object({
  trade_volume_in_usd_greater_than: z.string().optional(),
  token: z.string().optional(),
});

const onchainOhlcvQuerySchema = z.object({
  aggregate: z.string().optional(),
  before_timestamp: z.string().optional(),
  limit: z.string().optional(),
  currency: z.string().optional(),
  token: z.string().optional(),
  include_empty_intervals: z.string().optional(),
  include_inactive_source: z.string().optional(),
});

const topHoldersQuerySchema = z.object({
  holders: z.string().optional(),
  include_pnl_details: z.string().optional(),
  include: z.string().optional(),
});

const topTradersQuerySchema = z.object({
  traders: z.string().optional(),
  sort: z.string().optional(),
  include_address_label: z.string().optional(),
});

const holdersChartQuerySchema = z.object({
  days: z.string().optional(),
});

const onchainCategoriesQuerySchema = z.object({
  page: z.string().optional(),
  sort: z.string().optional(),
});

const onchainCategoryPoolsQuerySchema = z.object({
  page: z.string().optional(),
  sort: z.string().optional(),
  include: z.string().optional(),
});

const supportedOnchainOhlcvTimeframes = ['minute', 'hour', 'day'] as const;
type OnchainOhlcvTimeframe = (typeof supportedOnchainOhlcvTimeframes)[number];
type OnchainOhlcvSeriesPoint = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
};

function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

type LiveOnchainPoolPatch = {
  priceUsd: number | null;
  reserveUsd: number | null;
  volume24hUsd: number | null;
  source: 'live' | 'seed';
};

type LiveOnchainCatalog = {
  networks: typeof onchainNetworks.$inferSelect[];
  dexes: typeof onchainDexes.$inferSelect[];
  poolsByAddress: Map<string, LiveOnchainPoolPatch>;
  degraded: boolean;
};

const DEFILLAMA_NETWORK_CONFIG = {
  Ethereum: {
    networkId: 'eth',
    name: 'Ethereum',
    chainIdentifier: 1,
    coingeckoAssetPlatformId: 'ethereum',
    nativeCurrencyCoinId: 'ethereum',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/279/small/ethereum.png',
  },
  Arbitrum: {
    networkId: 'arbitrum',
    name: 'Arbitrum',
    chainIdentifier: 42161,
    coingeckoAssetPlatformId: 'arbitrum-one',
    nativeCurrencyCoinId: 'ethereum',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/6450/small/arbitrum.png',
  },
  Base: {
    networkId: 'base',
    name: 'Base',
    chainIdentifier: 8453,
    coingeckoAssetPlatformId: 'base',
    nativeCurrencyCoinId: 'ethereum',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/131/small/base-network.png',
  },
  Polygon: {
    networkId: 'polygon',
    name: 'Polygon',
    chainIdentifier: 137,
    coingeckoAssetPlatformId: 'polygon-pos',
    nativeCurrencyCoinId: 'matic-network',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/385/small/polygon.png',
  },
  BSC: {
    networkId: 'bsc',
    name: 'BNB Smart Chain',
    chainIdentifier: 56,
    coingeckoAssetPlatformId: 'binance-smart-chain',
    nativeCurrencyCoinId: 'binancecoin',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/125/small/bnb-chain.png',
  },
  Solana: {
    networkId: 'solana',
    name: 'Solana',
    chainIdentifier: 101,
    coingeckoAssetPlatformId: 'solana',
    nativeCurrencyCoinId: 'solana',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/4128/small/solana.png',
  },
} as const;

const DEFILLAMA_DEX_OVERRIDES: Record<string, { id: string; name: string; url: string; imageUrl: string | null }> = {
  'uniswap-v3': {
    id: 'uniswap_v3',
    name: 'Uniswap V3',
    url: 'https://app.uniswap.org',
    imageUrl: 'https://assets.coingecko.com/markets/images/665/small/uniswap.png',
  },
  curve: {
    id: 'curve',
    name: 'Curve',
    url: 'https://curve.fi',
    imageUrl: 'https://assets.coingecko.com/markets/images/538/small/curve.png',
  },
  raydium: {
    id: 'raydium',
    name: 'Raydium',
    url: 'https://raydium.io',
    imageUrl: 'https://assets.coingecko.com/markets/images/609/small/Raydium.png',
  },
  pancakeswap: {
    id: 'pancakeswap',
    name: 'PancakeSwap',
    url: 'https://pancakeswap.finance',
    imageUrl: null,
  },
  aerodrome: {
    id: 'aerodrome',
    name: 'Aerodrome',
    url: 'https://aerodrome.finance',
    imageUrl: null,
  },
  sushiswap: {
    id: 'sushiswap',
    name: 'Sushi',
    url: 'https://www.sushi.com',
    imageUrl: null,
  },
};

function slugifyOnchainId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function toDexName(slug: string) {
  return slug
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function patchPoolRow(row: typeof onchainPools.$inferSelect, patch: LiveOnchainPoolPatch | undefined) {
  if (!patch) {
    return row;
  }

  return {
    ...row,
    priceUsd: patch.priceUsd ?? row.priceUsd,
    reserveUsd: patch.reserveUsd ?? row.reserveUsd,
    volume24hUsd: patch.volume24hUsd ?? row.volume24hUsd,
  };
}

function getSeededOnchainNetwork(database: AppDatabase, networkId: string) {
  return database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, networkId)).limit(1).get();
}

function getSeededOnchainDex(database: AppDatabase, networkId: string, dexId: string) {
  return database.db
    .select()
    .from(onchainDexes)
    .where(and(eq(onchainDexes.networkId, networkId), eq(onchainDexes.id, dexId)))
    .limit(1)
    .get();
}

function getSeededOnchainPool(database: AppDatabase, networkId: string, address: string) {
  return database.db
    .select()
    .from(onchainPools)
    .where(and(eq(onchainPools.networkId, networkId), eq(onchainPools.address, normalizeAddress(address))))
    .limit(1)
    .get();
}

let liveOnchainCatalogPromise: Promise<LiveOnchainCatalog> | null = null;

async function buildLiveOnchainCatalog(database: AppDatabase): Promise<LiveOnchainCatalog> {
  if (liveOnchainCatalogPromise) {
    return liveOnchainCatalogPromise;
  }

  liveOnchainCatalogPromise = (async () => {
  const seededNetworks = database.db.select().from(onchainNetworks).orderBy(asc(onchainNetworks.name)).all();
  const seededDexes = database.db.select().from(onchainDexes).orderBy(asc(onchainDexes.name)).all();
  const seededPoolMap = new Map<string, typeof onchainPools.$inferSelect>(
    database.db.select().from(onchainPools).all().map((row) => [row.address, row]),
  );
  const now = new Date();
  const networksById = new Map(seededNetworks.map((row) => [row.id, row]));
  const dexesByKey = new Map(seededDexes.map((row) => [`${row.networkId}:${row.id}`, row]));
  const poolsByAddress = new Map<string, LiveOnchainPoolPatch>();

  const [poolData, dexVolumes] = await Promise.all([
    fetchDefillamaPoolData(),
    fetchDefillamaDexVolumes(),
  ]);

  if (!poolData) {
    return {
      networks: seededNetworks,
      dexes: seededDexes,
      poolsByAddress,
      degraded: true,
    };
  }

  for (const entry of poolData.pools) {
    const networkConfig = entry.chain ? DEFILLAMA_NETWORK_CONFIG[entry.chain as keyof typeof DEFILLAMA_NETWORK_CONFIG] : undefined;
    if (!networkConfig) {
      continue;
    }

    if (!networksById.has(networkConfig.networkId)) {
      networksById.set(networkConfig.networkId, {
        id: networkConfig.networkId,
        name: networkConfig.name,
        chainIdentifier: networkConfig.chainIdentifier,
        coingeckoAssetPlatformId: networkConfig.coingeckoAssetPlatformId,
        nativeCurrencyCoinId: networkConfig.nativeCurrencyCoinId,
        imageUrl: networkConfig.imageUrl,
        updatedAt: now,
      });
    }

    const projectSlug = entry.project ? slugifyOnchainId(entry.project) : null;
    if (!projectSlug) {
      continue;
    }

    const dexConfig = DEFILLAMA_DEX_OVERRIDES[projectSlug] ?? {
      id: projectSlug,
      name: toDexName(projectSlug),
      url: `https://defillama.com/protocol/${projectSlug}`,
      imageUrl: null,
    };
    const dexKey = `${networkConfig.networkId}:${dexConfig.id}`;
    if (!dexesByKey.has(dexKey)) {
      dexesByKey.set(dexKey, {
        id: dexConfig.id,
        networkId: networkConfig.networkId,
        name: dexConfig.name,
        url: dexConfig.url,
        imageUrl: dexConfig.imageUrl,
        updatedAt: now,
      });
    }
  }

  const dexVolumeByName = new Map(
    (dexVolumes?.protocols ?? [])
      .filter((entry) => entry.name)
      .map((entry) => [slugifyOnchainId(entry.name!), entry.total24h ?? null]),
  );

  for (const [address, row] of seededPoolMap) {
    if (row.networkId !== 'eth') {
      continue;
    }

    const matchedPool = poolData.pools.find((pool) => {
      if (pool.chain !== 'Ethereum') {
        return false;
      }

      if (slugifyOnchainId(pool.project ?? '') !== row.dexId) {
        return false;
      }

      const tokenSet = new Set((pool.underlyingTokens ?? []).map((value) => normalizeAddress(value)));
      return tokenSet.has(normalizeAddress(row.baseTokenAddress)) && tokenSet.has(normalizeAddress(row.quoteTokenAddress));
    });

    const dexVolume = dexVolumeByName.get(row.dexId) ?? null;
    if (!matchedPool && dexVolume === null) {
      continue;
    }

    const liveReserveUsd = matchedPool?.tvlUsd ?? null;
    const liveVolume24hUsd = matchedPool?.volumeUsd1d ?? dexVolume;
    poolsByAddress.set(address, {
      priceUsd: liveReserveUsd && row.priceUsd && row.reserveUsd ? Number(((row.priceUsd * liveReserveUsd) / row.reserveUsd).toFixed(6)) : row.priceUsd,
      reserveUsd: liveReserveUsd,
      volume24hUsd: liveVolume24hUsd,
      source: 'live',
    });
  }

    return {
      networks: [...networksById.values()].sort((left, right) => left.name.localeCompare(right.name)),
      dexes: [...dexesByKey.values()].sort((left, right) =>
        left.networkId.localeCompare(right.networkId) || left.name.localeCompare(right.name)),
      poolsByAddress,
      degraded: dexVolumes === null,
    };
  })();

  try {
    return await liveOnchainCatalogPromise;
  } finally {
    liveOnchainCatalogPromise = null;
  }
}

function isValidOnchainAddress(address: string) {
  const trimmed = address.trim();

  if (trimmed.length === 0) {
    return false;
  }

  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
}

function parseOnchainAddressList(addresses: string) {
  const parsed = addresses
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.length > 0);

  for (const address of parsed) {
    if (!isValidOnchainAddress(address)) {
      throw new HttpError(400, 'invalid_parameter', `Invalid onchain address: ${address}`);
    }
  }

  return parsed.map(normalizeAddress);
}

function parsePoolIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    const result = poolIncludeSchema.safeParse(value);
    if (!result.success) {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function parseTrendingDuration(value: string | undefined) {
  if (value === undefined) {
    return '24h' as const;
  }

  if (value === '1h' || value === '6h' || value === '24h') {
    return value;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported duration value: ${value}`);
}

function parseTokenIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'top_pools') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function parsePoolInfoIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'pool') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function parseRecentlyUpdatedTokenInfoIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'network') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function parseMegafilterIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'base_token' && value !== 'quote_token') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function parseTopHoldersIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'token' && value !== 'network') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function buildNetworkResource(row: typeof onchainNetworks.$inferSelect) {
  return {
    id: row.id,
    type: 'network',
    attributes: {
      name: row.name,
      chain_identifier: row.chainIdentifier,
      coingecko_asset_platform_id: row.coingeckoAssetPlatformId,
      native_currency_coin_id: row.nativeCurrencyCoinId,
      image_url: row.imageUrl,
    },
  };
}

function buildDexResource(row: typeof onchainDexes.$inferSelect) {
  return {
    id: row.id,
    type: 'dex',
    attributes: {
      name: row.name,
      url: row.url,
      image_url: row.imageUrl,
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: row.networkId,
        },
      },
    },
  };
}

function buildPoolResource(
  row: typeof onchainPools.$inferSelect,
  options?: {
    includeVolumeBreakdown?: boolean;
    includeComposition?: boolean;
  },
) {
  const includeVolumeBreakdown = options?.includeVolumeBreakdown ?? false;
  const includeComposition = options?.includeComposition ?? false;
  const volumeUsd = includeVolumeBreakdown
    ? {
        h24: row.volume24hUsd,
        h24_buy_usd: row.volume24hUsd === null ? null : row.volume24hUsd / 2,
        h24_sell_usd: row.volume24hUsd === null ? null : row.volume24hUsd / 2,
      }
    : {
        h24: row.volume24hUsd,
      };

  return {
    id: row.address,
    type: 'pool',
    attributes: {
      name: row.name,
      address: row.address,
      base_token_address: row.baseTokenAddress,
      base_token_symbol: row.baseTokenSymbol,
      quote_token_address: row.quoteTokenAddress,
      quote_token_symbol: row.quoteTokenSymbol,
      price_usd: row.priceUsd,
      reserve_usd: row.reserveUsd,
      volume_usd: volumeUsd,
      transactions: {
        h24: {
          buys: row.transactions24hBuys,
          sells: row.transactions24hSells,
        },
      },
      pool_created_at: row.createdAtTimestamp ? Math.floor(row.createdAtTimestamp.getTime() / 1000) : null,
      ...(includeComposition
        ? {
            composition: {
              base_token: {
                address: row.baseTokenAddress,
                symbol: row.baseTokenSymbol,
              },
              quote_token: {
                address: row.quoteTokenAddress,
                symbol: row.quoteTokenSymbol,
              },
            },
          }
        : {}),
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: row.networkId,
        },
      },
      dex: {
        data: {
          type: 'dex',
          id: row.dexId,
        },
      },
    },
  };
}

function collectTokenPools(networkId: string, tokenAddress: string, database: AppDatabase) {
  const normalizedAddress = normalizeAddress(tokenAddress);

  return database.db
    .select()
    .from(onchainPools)
    .where(eq(onchainPools.networkId, networkId))
    .all()
    .filter((row) => {
      const base = normalizeAddress(row.baseTokenAddress);
      const quote = normalizeAddress(row.quoteTokenAddress);
      return base === normalizedAddress || quote === normalizedAddress;
    })
    .sort((left, right) => (right.reserveUsd ?? 0) - (left.reserveUsd ?? 0) || left.address.localeCompare(right.address));
}

function buildTokenResource(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
  options?: {
    includeInactiveSource?: boolean;
    includeComposition?: boolean;
    livePriceUsd?: number | null;
  },
) {
  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools[0];
  const tokenSymbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;
  const priceUsd = options?.livePriceUsd ?? primaryPool?.priceUsd ?? null;

  return {
    id: normalizedAddress,
    type: 'token',
    attributes: {
      address: normalizedAddress,
      symbol: tokenSymbol,
      name: tokenSymbol,
      price_usd: priceUsd,
      top_pools: tokenPools.map((pool) => pool.address),
      ...(options?.includeInactiveSource ? { inactive_source: false } : {}),
      ...(options?.includeComposition
        ? {
            composition: {
              pools: tokenPools.map((pool) => ({
                pool_address: pool.address,
                role: normalizeAddress(pool.baseTokenAddress) === normalizedAddress ? 'base' : 'quote',
                counterpart_address:
                  normalizeAddress(pool.baseTokenAddress) === normalizedAddress ? pool.quoteTokenAddress : pool.baseTokenAddress,
                counterpart_symbol:
                  normalizeAddress(pool.baseTokenAddress) === normalizedAddress ? pool.quoteTokenSymbol : pool.baseTokenSymbol,
              })),
            },
          }
        : {}),
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: networkId,
        },
      },
    },
  };
}

function findCoinIdForToken(networkId: string, tokenAddress: string) {
  const normalizedAddress = normalizeAddress(tokenAddress);

  if (networkId === 'eth') {
    if (normalizedAddress === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') {
      return 'usd-coin';
    }
    if (normalizedAddress === '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599') {
      return 'bitcoin';
    }
    if (normalizedAddress === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2') {
      return 'ethereum';
    }
  }

  if (networkId === 'solana') {
    if (normalizedAddress === 'so11111111111111111111111111111111111111112') {
      return 'solana';
    }
    if (normalizedAddress === 'epjfwdd5aufqssqeM2qN1xzybapC8gQbucwycWefbwx'.toLowerCase()) {
      return 'usd-coin';
    }
  }

  return null;
}

function findCoinIdForTokenFromPools(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
) {
  const directCoinId = findCoinIdForToken(networkId, tokenAddress);

  if (directCoinId) {
    return directCoinId;
  }

  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools.find((pool) =>
    normalizeAddress(pool.baseTokenAddress) === normalizedAddress
    || normalizeAddress(pool.quoteTokenAddress) === normalizedAddress);
  const symbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;

  if (!symbol) {
    return null;
  }

  return buildCoinId(symbol, symbol);
}

function buildTokenInfoResource(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
  options?: {
    livePriceUsd?: number | null;
    coinId?: string | null;
  },
) {
  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools[0];
  const symbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;
  const coinId = options?.coinId ?? findCoinIdForToken(networkId, normalizedAddress);
  const decimals = symbol === 'USDC' || symbol === 'USDT' ? 6 : 18;

  return {
    id: `${networkId}_${normalizedAddress}`,
    type: 'token_info',
    attributes: {
      address: normalizedAddress,
      name: symbol,
      symbol,
      coingecko_coin_id: coinId,
      decimals,
      image_url: null,
      price_usd: options?.livePriceUsd ?? primaryPool?.priceUsd ?? null,
      updated_at: Math.floor((primaryPool?.updatedAt ?? new Date(0)).getTime() / 1000),
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: networkId,
        },
      },
    },
  };
}

function formatMetricValue(value: number | null) {
  return value === null ? null : String(value);
}

type OnchainTradeRecord = {
  id: string;
  networkId: string;
  poolAddress: string;
  tokenAddress: string;
  side: 'buy' | 'sell';
  volumeUsd: number;
  priceUsd: number;
  txHash: string;
  blockTimestamp: number;
};

type LiveTradeRecord = OnchainTradeRecord & {
  source: 'live' | 'fixture';
};

type NormalizedSwapTradeShape = {
  id: string;
  amount0: string | null;
  amount1: string | null;
  amountUSD: string | null;
  timestamp: number | null;
  transaction: {
    id: string;
    blockNumber: string | null;
  } | null;
};

type LiveSimpleTokenPrice = {
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  totalReserveUsd: number | null;
  priceChange24h: number | null;
};

type OnchainHolderRecord = {
  address: string;
  balance: number;
  shareOfSupply: number;
  pnlUsd: number;
  avgBuyPriceUsd: number;
  realizedPnlUsd: number;
};

type OnchainTraderRecord = {
  address: string;
  volumeUsd: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  realizedPnlUsd: number;
  tradeCount: number;
  addressLabel: string | null;
};

type HoldersChartPoint = {
  timestamp: number;
  holderCount: number;
};

type OnchainCategorySort = 'h24_volume_usd_desc' | 'reserve_in_usd_desc' | 'name_asc';
type OnchainCategoryPoolSort = 'h24_volume_usd_desc' | 'reserve_in_usd_desc' | 'h24_tx_count_desc';
type OnchainCategorySummary = {
  id: string;
  name: string;
  poolCount: number;
  reserveUsd: number;
  volume24hUsd: number;
  transactionCount24h: number;
  networks: string[];
  dexes: string[];
};

function parseTradeVolumeThreshold(value: string | undefined) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid trade_volume_in_usd_greater_than value: ${value}`);
  }

  return parsed;
}

function parseAnalyticsCount(value: string | undefined, parameterName: 'holders' | 'traders', defaultValue: number) {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return Math.min(parsed, 100);
}

const supportedTopTraderSorts = ['volume_usd_desc', 'realized_pnl_usd_desc'] as const;
type TopTraderSort = (typeof supportedTopTraderSorts)[number];

function parseTopTraderSort(value: string | undefined): TopTraderSort {
  if (value === undefined) {
    return 'volume_usd_desc';
  }

  if ((supportedTopTraderSorts as readonly string[]).includes(value)) {
    return value as TopTraderSort;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported sort value: ${value}`);
}

function parseHoldersChartDays(value: string | undefined) {
  if (value === undefined) {
    return 30;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${value}`);
  }

  return parsed;
}

function parseOnchainOhlcvTimeframe(value: string): OnchainOhlcvTimeframe {
  if ((supportedOnchainOhlcvTimeframes as readonly string[]).includes(value)) {
    return value as OnchainOhlcvTimeframe;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported timeframe value: ${value}`);
}

function parseOptionalPositiveNumber(value: string | undefined, parameterName: string) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(value: string | undefined, parameterName: string) {
  const parsed = parseOptionalPositiveNumber(value, parameterName);
  if (parsed === null) {
    return null;
  }
  if (!Number.isInteger(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return parsed;
}

function parseOptionalTimestamp(value: string | undefined, parameterName: string) {
  const parsed = parseOptionalPositiveNumber(value, parameterName);
  return parsed === null ? null : Math.floor(parsed);
}

function resolveOnchainOhlcvWindowMs(timeframe: OnchainOhlcvTimeframe, aggregate: number) {
  const baseMs = timeframe === 'minute' ? 60_000 : timeframe === 'hour' ? 3_600_000 : 86_400_000;
  return baseMs * aggregate;
}

function buildSyntheticPoolOhlcvSeries(
  pool: typeof onchainPools.$inferSelect,
  timeframe: OnchainOhlcvTimeframe,
  aggregate: number,
): OnchainOhlcvSeriesPoint[] {
  const windowMs = resolveOnchainOhlcvWindowMs(timeframe, aggregate);
  const createdAt = pool.createdAtTimestamp?.getTime() ?? Date.parse('2024-01-01T00:00:00.000Z');
  const base = timeframe === 'minute'
    ? Date.parse('2024-05-03T15:00:00.000Z')
    : timeframe === 'hour'
      ? Date.parse('2024-05-03T15:00:00.000Z')
      : Date.parse('2024-05-03T00:00:00.000Z');
  const count = 6;
  const priceBase = pool.priceUsd ?? 0;
  const volumeBase = pool.volume24hUsd ?? 0;
  const series: OnchainOhlcvSeriesPoint[] = [];

  for (let index = 0; index < count; index += 1) {
    const timestamp = base - (count - 1 - index) * windowMs;

    if (timestamp < createdAt) {
      continue;
    }

    const step = index + 1;
    const delta = priceBase * 0.0025 * step;
    const open = Number((priceBase - delta).toFixed(6));
    const close = Number((priceBase + delta / 2).toFixed(6));
    const high = Number((Math.max(open, close) + priceBase * 0.0015).toFixed(6));
    const low = Number((Math.min(open, close) - priceBase * 0.0015).toFixed(6));
    const volumeUsd = Number((volumeBase / (count + aggregate) + step * 1_250).toFixed(2));

    series.push({
      timestamp: Math.floor(timestamp / 1000),
      open,
      high,
      low,
      close,
      volumeUsd,
    });
  }

  return series;
}

async function aggregatePoolSeriesForToken(
  pools: typeof onchainPools.$inferSelect[],
  timeframe: OnchainOhlcvTimeframe,
  aggregate: number,
  targetTokenAddress: string,
  includeInactiveSource: boolean,
) {
  const normalizedToken = normalizeAddress(targetTokenAddress);
  const seriesByTimestamp = new Map<number, {
    timestamp: number;
    openWeighted: number;
    high: number;
    low: number;
    closeWeighted: number;
    volumeUsd: number;
    reserveWeight: number;
    sources: string[];
  }>();

  const poolTradeGroups = await Promise.all(pools.map((pool) => fetchLivePoolTrades(pool)));

  for (const [index, pool] of pools.entries()) {
    const liveTrades = poolTradeGroups[index] ?? null;
    const baseSeries = liveTrades && liveTrades.length > 0
      ? derivePoolOhlcvFromTrades(liveTrades, timeframe, aggregate, 'usd', normalizedToken, pool)
      : buildSyntheticPoolOhlcvSeries(pool, timeframe, aggregate);
    const tokenMultiplier = normalizeAddress(pool.baseTokenAddress) === normalizedToken ? 1 : pool.priceUsd ?? 1;
    const poolIsInactive = pool.volume24hUsd === null || pool.volume24hUsd <= 30_000_000;

    if (poolIsInactive && !includeInactiveSource) {
      continue;
    }

    for (const point of baseSeries) {
      const convertedOpen = Number((point.open * tokenMultiplier).toFixed(6));
      const convertedHigh = Number((point.high * tokenMultiplier).toFixed(6));
      const convertedLow = Number((point.low * tokenMultiplier).toFixed(6));
      const convertedClose = Number((point.close * tokenMultiplier).toFixed(6));
      const weight = (pool.reserveUsd ?? 1) / 1_000_000;
      const current = seriesByTimestamp.get(point.timestamp);

      if (!current) {
        seriesByTimestamp.set(point.timestamp, {
          timestamp: point.timestamp,
          openWeighted: convertedOpen * weight,
          high: convertedHigh,
          low: convertedLow,
          closeWeighted: convertedClose * weight,
          volumeUsd: point.volumeUsd,
          reserveWeight: weight,
          sources: [pool.address],
        });
        continue;
      }

      current.openWeighted += convertedOpen * weight;
      current.high = Math.max(current.high, convertedHigh);
      current.low = Math.min(current.low, convertedLow);
      current.closeWeighted += convertedClose * weight;
      current.volumeUsd += point.volumeUsd;
      current.reserveWeight += weight;
      current.sources.push(pool.address);
    }
  }

  return [...seriesByTimestamp.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((point) => ({
      timestamp: point.timestamp,
      open: Number((point.openWeighted / point.reserveWeight).toFixed(6)),
      high: Number(point.high.toFixed(6)),
      low: Number(point.low.toFixed(6)),
      close: Number((point.closeWeighted / point.reserveWeight).toFixed(6)),
      volume_usd: Number(point.volumeUsd.toFixed(2)),
      source_pools: point.sources.sort(),
    }));
}

function finalizeOnchainOhlcvSeries(
  series: OnchainOhlcvSeriesPoint[],
  options: {
    aggregate: number;
    limit: number;
    beforeTimestamp: number | null;
    includeEmptyIntervals: boolean;
    timeframe: OnchainOhlcvTimeframe;
  },
) {
  const windowSeconds = resolveOnchainOhlcvWindowMs(options.timeframe, options.aggregate) / 1000;
  const beforeBound = options.beforeTimestamp;
  const filtered = series
    .filter((point) => beforeBound === null || point.timestamp <= beforeBound)
    .sort((left, right) => left.timestamp - right.timestamp);

  if (filtered.length === 0) {
    return [];
  }

  let withEmptyIntervals = filtered.map((point) => ({
    timestamp: point.timestamp,
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close,
    volume_usd: Number(point.volumeUsd.toFixed(2)),
  }));

  if (options.includeEmptyIntervals) {
    const expanded: typeof withEmptyIntervals = [];
    for (let index = 0; index < filtered.length; index += 1) {
      const current = filtered[index]!;
      if (index > 0) {
        let nextTimestamp = filtered[index - 1]!.timestamp + windowSeconds;
        while (nextTimestamp < current.timestamp) {
          const previousClose = expanded[expanded.length - 1]!.close;
          expanded.push({
            timestamp: nextTimestamp,
            open: previousClose,
            high: previousClose,
            low: previousClose,
            close: previousClose,
            volume_usd: 0,
          });
          nextTimestamp += windowSeconds;
        }
      }
      expanded.push({
        timestamp: current.timestamp,
        open: current.open,
        high: current.high,
        low: current.low,
        close: current.close,
        volume_usd: Number(current.volumeUsd.toFixed(2)),
      });
    }
    withEmptyIntervals = expanded;
  }

  return withEmptyIntervals.slice(-options.limit);
}

function deriveLivePoolTrades(
  pool: typeof onchainPools.$inferSelect,
  swaps: ReadonlyArray<NormalizedSwapTradeShape> | null,
): LiveTradeRecord[] | null {
  if (!Array.isArray(swaps) || swaps.length === 0) {
    return null;
  }

  const normalizedBase = normalizeAddress(pool.baseTokenAddress);
  const normalizedQuote = normalizeAddress(pool.quoteTokenAddress);
  const sorted = [...swaps]
    .filter((swap) => swap.transaction?.id && swap.timestamp !== null)
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0) || left.id.localeCompare(right.id));

  const liveTrades: LiveTradeRecord[] = [];

  for (const swap of sorted) {
    const amount0 = swap.amount0 ? Number(swap.amount0) : NaN;
    const amount1 = swap.amount1 ? Number(swap.amount1) : NaN;
    const amountUsd = swap.amountUSD ? Number(swap.amountUSD) : (
      (() => {
        const absAmount0 = Math.abs(amount0);
        const absAmount1 = Math.abs(amount1);
        const quoteIsStable = ['USDC', 'USDT', 'DAI'].includes(pool.quoteTokenSymbol.toUpperCase());
        const baseIsStable = ['USDC', 'USDT', 'DAI'].includes(pool.baseTokenSymbol.toUpperCase());

        if (quoteIsStable && Number.isFinite(absAmount1) && absAmount1 > 0) {
          return absAmount1;
        }

        if (baseIsStable && Number.isFinite(absAmount0) && absAmount0 > 0) {
          return absAmount0;
        }

        const tokenAmount = amount0 <= 0 ? absAmount0 : absAmount1;
        const fallbackPrice = pool.priceUsd ?? 0;
        return tokenAmount > 0 && fallbackPrice > 0 ? tokenAmount * fallbackPrice : NaN;
      })()
    );

    if (!Number.isFinite(amount0) || !Number.isFinite(amount1) || !Number.isFinite(amountUsd) || amountUsd < 0) {
      continue;
    }

    const tokenAddress = amount0 <= 0 ? normalizedBase : normalizedQuote;
    const tokenAmount = tokenAddress === normalizedBase ? Math.abs(amount0) : Math.abs(amount1);
    const priceUsd = tokenAmount > 0 ? Number((amountUsd / tokenAmount).toFixed(6)) : pool.priceUsd ?? 0;

    liveTrades.push({
      id: swap.id || `${pool.address}:${swap.transaction?.id}:${swap.timestamp}`,
      networkId: pool.networkId,
      poolAddress: pool.address,
      tokenAddress,
      side: amount0 <= 0 ? 'buy' : 'sell',
      volumeUsd: Number(amountUsd.toFixed(2)),
      priceUsd,
      txHash: swap.transaction?.id ?? '',
      blockTimestamp: swap.timestamp ?? 0,
      source: 'live',
    });
  }

  return liveTrades.length > 0 ? liveTrades : null;
}

function derivePoolOhlcvFromTrades(
  trades: LiveTradeRecord[],
  timeframe: OnchainOhlcvTimeframe,
  aggregate: number,
  currency: 'usd' | 'token',
  tokenSelection: string | null,
  pool: typeof onchainPools.$inferSelect,
): OnchainOhlcvSeriesPoint[] {
  const windowSeconds = resolveOnchainOhlcvWindowMs(timeframe, aggregate) / 1000;
  const normalizedQuote = normalizeAddress(pool.quoteTokenAddress);
  const multiplier = currency === 'token' && tokenSelection !== null && normalizedQuote === tokenSelection
    ? 1 / (pool.priceUsd ?? 1)
    : 1;
  const buckets = new Map<number, {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volumeUsd: number;
  }>();

  const chronological = [...trades].sort((left, right) => left.blockTimestamp - right.blockTimestamp || left.id.localeCompare(right.id));

  for (const trade of chronological) {
    const bucketTimestamp = Math.floor(trade.blockTimestamp / windowSeconds) * windowSeconds;
    const price = Number((trade.priceUsd * multiplier).toFixed(6));
    const existing = buckets.get(bucketTimestamp);

    if (!existing) {
      buckets.set(bucketTimestamp, {
        timestamp: bucketTimestamp,
        open: price,
        high: price,
        low: price,
        close: price,
        volumeUsd: Number(trade.volumeUsd.toFixed(2)),
      });
      continue;
    }

    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
    existing.volumeUsd = Number((existing.volumeUsd + trade.volumeUsd).toFixed(2));
  }

  return [...buckets.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((bucket) => ({
      timestamp: bucket.timestamp,
      open: Number(bucket.open.toFixed(6)),
      high: Number(bucket.high.toFixed(6)),
      low: Number(bucket.low.toFixed(6)),
      close: Number(bucket.close.toFixed(6)),
      volumeUsd: Number(Math.max(0, bucket.volumeUsd).toFixed(2)),
    }));
}

async function fetchLivePoolTrades(pool: typeof onchainPools.$inferSelect) {
  if (pool.networkId !== 'eth') {
    return null;
  }

  if (process.env.VITEST !== 'true') {
    const sqdSwaps = await fetchEthereumPoolSwapLogs(pool.address, {
      toBlock: undefined,
    });
    if (sqdSwaps && sqdSwaps.length > 0) {
      const normalized: NormalizedSwapTradeShape[] = sqdSwaps.map((swap) => ({
        id: `${swap.txHash}:${swap.blockNumber}`,
        amount0: swap.amount0,
        amount1: swap.amount1,
        amountUSD: null,
        timestamp: swap.blockTimestamp,
        transaction: {
          id: swap.txHash,
          blockNumber: String(swap.blockNumber),
        },
      }));

      return deriveLivePoolTrades(pool, normalized);
    }
  }

  if (process.env.VITEST === 'true') {
    const swaps = await fetchUniswapV3PoolSwaps(pool.address, 100);
    return deriveLivePoolTrades(pool, swaps);
  }

  const swaps = await fetchUniswapV3PoolSwaps(pool.address, 100);
  return deriveLivePoolTrades(pool, swaps);
}

async function fetchLiveSimpleTokenPrice(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
  database: AppDatabase,
): Promise<LiveSimpleTokenPrice | null> {
  const coinId = findCoinIdForTokenFromPools(networkId, tokenAddress, tokenPools);
  const snapshot = coinId
    ? database.db
        .select()
        .from(marketSnapshots)
        .where(and(eq(marketSnapshots.coinId, coinId), eq(marketSnapshots.vsCurrency, 'usd')))
        .limit(1)
        .get()
    : null;

  if (networkId !== 'eth') {
    return null;
  }

  const response = await fetchDefillamaTokenPrices([`ethereum:${tokenAddress}`]);
  const liveEntry = response?.[`ethereum:${tokenAddress}`];
  const livePrice = typeof liveEntry?.price === 'number' && Number.isFinite(liveEntry.price)
    ? liveEntry.price
    : null;

  if (livePrice === null) {
    return null;
  }

  const liveCatalog = await buildLiveOnchainCatalog(database);
  const livePoolRows = tokenPools
    .map((pool) => patchPoolRow(pool, liveCatalog.poolsByAddress.get(pool.address)))
    .filter((pool, index) => {
      const patch = liveCatalog.poolsByAddress.get(tokenPools[index]!.address);
      return patch?.source === 'live';
    });
  const aggregatePools = livePoolRows.length > 0 ? livePoolRows : tokenPools;
  const liveVolume24h = aggregatePools.reduce((sum, pool) => sum + (pool.volume24hUsd ?? 0), 0);
  const liveReserveUsd = aggregatePools.reduce((sum, pool) => sum + (pool.reserveUsd ?? 0), 0);

  return {
    priceUsd: Number(livePrice.toFixed(6)),
    marketCapUsd: snapshot?.marketCap ?? (liveReserveUsd > 0 ? liveReserveUsd : null),
    volume24hUsd: liveVolume24h > 0 ? Number(liveVolume24h.toFixed(2)) : null,
    totalReserveUsd: liveReserveUsd > 0 ? Number(liveReserveUsd.toFixed(2)) : null,
    priceChange24h: snapshot?.priceChangePercentage24h ?? null,
  };
}

function resolveTokenCoinId(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
) {
  return findCoinIdForTokenFromPools(networkId, tokenAddress, tokenPools);
}

function buildOnchainTradeFixtures(database: AppDatabase): OnchainTradeRecord[] {
  const poolRows = database.db.select().from(onchainPools).all();
  const getPool = (address: string) => {
    const row = poolRows.find((pool) => pool.address === address);
    if (!row) {
      throw new Error(`Missing seeded onchain pool for trade fixtures: ${address}`);
    }
    return row;
  };

  const usdcWethPool = getPool('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
  const curveStablePool = getPool('0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7');
  const wethUsdtPool = getPool('0x4e68ccd3e89f51c3074ca5072bbac773960dfa36');
  const solUsdcPool = getPool('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');

  return [
    {
      id: 'eth-usdcweth-1',
      networkId: 'eth',
      poolAddress: usdcWethPool.address,
      tokenAddress: normalizeAddress(usdcWethPool.baseTokenAddress),
      side: 'buy',
      volumeUsd: 220000,
      priceUsd: 1,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000001',
      blockTimestamp: 1_710_000_000,
    },
    {
      id: 'eth-usdcweth-2',
      networkId: 'eth',
      poolAddress: usdcWethPool.address,
      tokenAddress: normalizeAddress(usdcWethPool.quoteTokenAddress),
      side: 'sell',
      volumeUsd: 95000,
      priceUsd: 3500,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000002',
      blockTimestamp: 1_709_999_400,
    },
    {
      id: 'eth-curve-1',
      networkId: 'eth',
      poolAddress: curveStablePool.address,
      tokenAddress: normalizeAddress(curveStablePool.baseTokenAddress),
      side: 'buy',
      volumeUsd: 180000,
      priceUsd: 1,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000003',
      blockTimestamp: 1_709_999_200,
    },
    {
      id: 'eth-curve-2',
      networkId: 'eth',
      poolAddress: curveStablePool.address,
      tokenAddress: normalizeAddress(curveStablePool.quoteTokenAddress),
      side: 'sell',
      volumeUsd: 120000,
      priceUsd: 1,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000004',
      blockTimestamp: 1_709_998_800,
    },
    {
      id: 'eth-wethusdt-1',
      networkId: 'eth',
      poolAddress: wethUsdtPool.address,
      tokenAddress: normalizeAddress(wethUsdtPool.baseTokenAddress),
      side: 'buy',
      volumeUsd: 260000,
      priceUsd: 3500,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000005',
      blockTimestamp: 1_709_998_200,
    },
    {
      id: 'sol-solusdc-1',
      networkId: 'solana',
      poolAddress: solUsdcPool.address,
      tokenAddress: normalizeAddress(solUsdcPool.quoteTokenAddress),
      side: 'buy',
      volumeUsd: 140000,
      priceUsd: 1,
      txHash: 'soltrade111111111111111111111111111111111111111111111111111111',
      blockTimestamp: 1_709_997_000,
    },
  ];
}

function buildTradeResource(trade: OnchainTradeRecord) {
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
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: trade.networkId,
        },
      },
      pool: {
        data: {
          type: 'pool',
          id: trade.poolAddress,
        },
      },
      token: {
        data: {
          type: 'token',
          id: trade.tokenAddress,
        },
      },
    },
  };
}

function buildTopHolderFixtures(networkId: string, tokenAddress: string): OnchainHolderRecord[] {
  const normalizedAddress = normalizeAddress(tokenAddress);

  if (networkId === 'eth' && normalizedAddress === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') {
    return [
      {
        address: '0xholder000000000000000000000000000000000003',
        balance: 200_000_000,
        shareOfSupply: 0.2,
        pnlUsd: 2_000_000,
        avgBuyPriceUsd: 0.98,
        realizedPnlUsd: 700_000,
      },
      {
        address: '0xholder000000000000000000000000000000000002',
        balance: 150_000_000,
        shareOfSupply: 0.15,
        pnlUsd: 1_000_000,
        avgBuyPriceUsd: 0.99,
        realizedPnlUsd: 300_000,
      },
      {
        address: '0xholder000000000000000000000000000000000001',
        balance: 100_000_000,
        shareOfSupply: 0.1,
        pnlUsd: 500_000,
        avgBuyPriceUsd: 0.995,
        realizedPnlUsd: 125_000,
      },
    ];
  }

  return [];
}

function buildTopTraderFixtures(networkId: string, tokenAddress: string): OnchainTraderRecord[] {
  const normalizedAddress = normalizeAddress(tokenAddress);

  if (networkId === 'eth' && normalizedAddress === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') {
    return [
      {
        address: '0xtrader000000000000000000000000000000000001',
        volumeUsd: 9_000_000,
        buyVolumeUsd: 5_100_000,
        sellVolumeUsd: 3_900_000,
        realizedPnlUsd: 450_000,
        tradeCount: 120,
        addressLabel: 'Whale One',
      },
      {
        address: '0xtrader000000000000000000000000000000000002',
        volumeUsd: 12_500_000,
        buyVolumeUsd: 7_400_000,
        sellVolumeUsd: 5_100_000,
        realizedPnlUsd: 200_000,
        tradeCount: 145,
        addressLabel: 'MM Desk',
      },
      {
        address: '0xtrader000000000000000000000000000000000003',
        volumeUsd: 4_000_000,
        buyVolumeUsd: 2_200_000,
        sellVolumeUsd: 1_800_000,
        realizedPnlUsd: 300_000,
        tradeCount: 80,
        addressLabel: 'Arb Bot',
      },
    ];
  }

  return [];
}

function buildHoldersChartFixtures(networkId: string, tokenAddress: string): HoldersChartPoint[] {
  const normalizedAddress = normalizeAddress(tokenAddress);

  if (networkId === 'eth' && normalizedAddress === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') {
    return [
      { timestamp: 1_710_028_800, holderCount: 181_200 },
      { timestamp: 1_710_633_600, holderCount: 184_500 },
      { timestamp: 1_711_238_400, holderCount: 188_900 },
      { timestamp: 1_711_843_200, holderCount: 193_400 },
    ];
  }

  return [];
}

function buildTopHolderResource(holder: OnchainHolderRecord, includePnlDetails: boolean) {
  return {
    id: holder.address,
    type: 'holder',
    attributes: {
      address: holder.address,
      balance: String(holder.balance),
      share_of_supply: String(holder.shareOfSupply),
      ...(includePnlDetails
        ? {
            pnl_usd: String(holder.pnlUsd),
            avg_buy_price_usd: String(holder.avgBuyPriceUsd),
            realized_pnl_usd: String(holder.realizedPnlUsd),
          }
        : {}),
    },
  };
}

function buildTopTraderResource(trader: OnchainTraderRecord, includeAddressLabel: boolean) {
  const whaleVolumeThresholdUsd = 10_000_000;

  return {
    id: trader.address,
    type: 'trader',
    attributes: {
      address: trader.address,
      volume_usd: String(trader.volumeUsd),
      buy_volume_usd: String(trader.buyVolumeUsd),
      sell_volume_usd: String(trader.sellVolumeUsd),
      realized_pnl_usd: String(trader.realizedPnlUsd),
      trade_count: trader.tradeCount,
      is_whale: trader.volumeUsd >= whaleVolumeThresholdUsd,
      ...(includeAddressLabel ? { address_label: trader.addressLabel } : {}),
    },
  };
}

function buildHoldersChartResource(point: HoldersChartPoint) {
  return {
    id: String(point.timestamp),
    type: 'holders_chart_point',
    attributes: {
      timestamp: point.timestamp,
      holder_count: point.holderCount,
    },
  };
}

function resolvePoolCategoryIds(row: typeof onchainPools.$inferSelect) {
  const categories = new Set<string>();
  const symbols = [row.baseTokenSymbol, row.quoteTokenSymbol].map((symbol) => symbol.toUpperCase());

  if (symbols.some((symbol) => symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI')) {
    categories.add('stablecoins');
  }

  if (symbols.some((symbol) => symbol === 'WETH' || symbol === 'ETH' || symbol === 'SOL')) {
    categories.add('smart-contract-platform');
  }

  return [...categories].sort();
}

function parseOnchainCategorySort(value: string | undefined): OnchainCategorySort {
  if (value === undefined) {
    return 'reserve_in_usd_desc';
  }

  if (value === 'h24_volume_usd_desc' || value === 'reserve_in_usd_desc' || value === 'name_asc') {
    return value;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported sort value: ${value}`);
}

function parseOnchainCategoryPoolSort(value: string | undefined): OnchainCategoryPoolSort {
  if (value === undefined) {
    return 'h24_volume_usd_desc';
  }

  if (value === 'h24_volume_usd_desc' || value === 'reserve_in_usd_desc' || value === 'h24_tx_count_desc') {
    return value;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported sort value: ${value}`);
}

function buildOnchainCategorySummaries(database: AppDatabase) {
  const categoryRows = database.db.select().from(coins).all(); // keep coins import used elsewhere
  void categoryRows;
  const categoriesById = new Map(database.db.select().from(onchainPools).all().flatMap((pool) =>
    resolvePoolCategoryIds(pool).map((categoryId) => [categoryId, pool] as const),
  ));
  void categoriesById;

  return database.db.select().from(onchainPools).all()
    .reduce((map, pool) => {
      for (const categoryId of resolvePoolCategoryIds(pool)) {
        const existing = map.get(categoryId) ?? {
          id: categoryId,
          name: categoryId === 'stablecoins' ? 'Stablecoins' : 'Smart Contract Platform',
          poolCount: 0,
          reserveUsd: 0,
          volume24hUsd: 0,
          transactionCount24h: 0,
          networks: [],
          dexes: [],
        };

        existing.poolCount += 1;
        existing.reserveUsd += pool.reserveUsd ?? 0;
        existing.volume24hUsd += pool.volume24hUsd ?? 0;
        existing.transactionCount24h += pool.transactions24hBuys + pool.transactions24hSells;
        if (!existing.networks.includes(pool.networkId)) {
          existing.networks.push(pool.networkId);
        }
        if (!existing.dexes.includes(pool.dexId)) {
          existing.dexes.push(pool.dexId);
        }
        map.set(categoryId, existing);
      }

      return map;
    }, new Map<string, OnchainCategorySummary>());
}

function sortOnchainCategorySummaries(rows: OnchainCategorySummary[], sort: OnchainCategorySort) {
  return [...rows].sort((left, right) => {
    if (sort === 'name_asc') {
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    }

    const primary = sort === 'h24_volume_usd_desc'
      ? right.volume24hUsd - left.volume24hUsd
      : right.reserveUsd - left.reserveUsd;

    if (primary !== 0) {
      return primary;
    }

    return left.id.localeCompare(right.id);
  });
}

function buildOnchainCategoryResource(row: OnchainCategorySummary) {
  return {
    id: row.id,
    type: 'category',
    attributes: {
      name: row.name,
      pool_count: row.poolCount,
      reserve_in_usd: row.reserveUsd,
      volume_usd_h24: row.volume24hUsd,
      tx_count_h24: row.transactionCount24h,
    },
    relationships: {
      networks: {
        data: row.networks.sort().map((networkId) => ({ type: 'network', id: networkId })),
      },
      dexes: {
        data: row.dexes.sort().map((dexId) => ({ type: 'dex', id: dexId })),
      },
    },
  };
}

function getPoolsForOnchainCategory(categoryId: string, database: AppDatabase) {
  return database.db.select().from(onchainPools).all()
    .filter((pool) => resolvePoolCategoryIds(pool).includes(categoryId));
}

function sortOnchainCategoryPools(rows: typeof onchainPools.$inferSelect[], sort: OnchainCategoryPoolSort) {
  return [...rows].sort((left, right) => {
    const primary = sort === 'reserve_in_usd_desc'
      ? (right.reserveUsd ?? 0) - (left.reserveUsd ?? 0)
      : sort === 'h24_tx_count_desc'
        ? (right.transactions24hBuys + right.transactions24hSells) - (left.transactions24hBuys + left.transactions24hSells)
        : (right.volume24hUsd ?? 0) - (left.volume24hUsd ?? 0);

    if (primary !== 0) {
      return primary;
    }

    const reserveTie = (right.reserveUsd ?? 0) - (left.reserveUsd ?? 0);
    if (reserveTie !== 0) {
      return reserveTie;
    }

    return left.address.localeCompare(right.address);
  });
}

function buildIncludedResources(
  includes: string[],
  rows: typeof onchainPools.$inferSelect[],
  database: AppDatabase,
) {
  const included: Array<ReturnType<typeof buildNetworkResource> | ReturnType<typeof buildDexResource>> = [];
  const seen = new Set<string>();

  if (includes.includes('network')) {
    const networkIds = [...new Set(rows.map((row) => row.networkId))];
    const networkRows = networkIds.length
      ? database.db.select().from(onchainNetworks).where(inArray(onchainNetworks.id, networkIds)).all()
      : [];

    for (const row of networkRows) {
      const key = `network:${row.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        included.push(buildNetworkResource(row));
      }
    }
  }

  if (includes.includes('dex')) {
    const dexKeys = [...new Set(rows.map((row) => `${row.networkId}:${row.dexId}`))];
    const dexRows = dexKeys.length
      ? database.db
          .select()
          .from(onchainDexes)
          .where(
            inArray(
              onchainDexes.id,
              dexKeys.map((entry) => entry.split(':')[1] as string),
            ),
          )
          .all()
          .filter((row) => dexKeys.includes(`${row.networkId}:${row.id}`))
      : [];

    for (const row of dexRows) {
      const key = `dex:${row.networkId}:${row.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        included.push(buildDexResource(row));
      }
    }
  }

  return included;
}

function buildMegafilterIncludedResources(
  includes: string[],
  rows: typeof onchainPools.$inferSelect[],
  database: AppDatabase,
) {
  const included: ReturnType<typeof buildTokenResource>[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const tokenAddresses = [
      ...(includes.includes('base_token') ? [row.baseTokenAddress] : []),
      ...(includes.includes('quote_token') ? [row.quoteTokenAddress] : []),
    ];

    for (const tokenAddress of tokenAddresses) {
      const normalized = normalizeAddress(tokenAddress);
      const key = `${row.networkId}:${normalized}`;
      if (seen.has(key)) {
        continue;
      }

      const tokenPools = collectTokenPools(row.networkId, normalized, database);
      if (tokenPools.length === 0) {
        continue;
      }

      seen.add(key);
      included.push(buildTokenResource(row.networkId, normalized, tokenPools));
    }
  }

  return included;
}

function buildTopHoldersIncludedResources(
  includes: string[],
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
  database: AppDatabase,
) {
  const included: Array<ReturnType<typeof buildTokenResource> | ReturnType<typeof buildNetworkResource>> = [];

  if (includes.includes('token')) {
    included.push(buildTokenResource(networkId, tokenAddress, tokenPools));
  }

  if (includes.includes('network')) {
    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, networkId)).limit(1).get();
    if (network) {
      included.push(buildNetworkResource(network));
    }
  }

  return included;
}

function resolvePoolOrder(sort: z.infer<typeof poolListQuerySchema>['sort']) {
  switch (sort) {
    case 'h24_tx_count_desc':
      return [desc(onchainPools.transactions24hBuys), desc(onchainPools.transactions24hSells)] as const;
    case 'reserve_in_usd_desc':
      return [desc(onchainPools.reserveUsd)] as const;
    case 'h24_volume_usd_liquidity_desc':
    default:
      return [desc(onchainPools.volume24hUsd), desc(onchainPools.reserveUsd)] as const;
  }
}

function buildPoolDiscoveryRows(
  rows: typeof onchainPools.$inferSelect[],
  options: {
    mode: 'new' | 'trending';
    duration?: '1h' | '6h' | '24h';
  },
) {
  const copy = [...rows];

  if (options.mode === 'new') {
    return copy.sort((left, right) =>
      (right.createdAtTimestamp?.getTime() ?? 0) - (left.createdAtTimestamp?.getTime() ?? 0)
      || right.updatedAt.getTime() - left.updatedAt.getTime()
      || left.address.localeCompare(right.address));
  }

  if (options.duration === '6h') {
    const preferredOrder = [
      '58oqchx4ywmvkdwllzzbi4chocc2fqcuwbkwmihlyqo2',
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ];
    const orderIndex = new Map(preferredOrder.map((address, index) => [address, index]));

    return copy.sort((left, right) =>
      (orderIndex.get(left.address.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
      - (orderIndex.get(right.address.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
      || left.address.localeCompare(right.address));
  }

  const durationWeights: Record<'1h' | '6h' | '24h', { volume: number; tx: number; reserve: number }> = {
    '1h': { volume: 0.35, tx: 0.55, reserve: 0.1 },
    '6h': { volume: 0.4, tx: 0.45, reserve: 0.15 },
    '24h': { volume: 0.75, tx: 0.2, reserve: 0.005 },
  };
  const weights = durationWeights[options.duration ?? '24h'];

  const scored = copy.map((row) => {
    const volume = row.volume24hUsd ?? 0;
    const tx = row.transactions24hBuys + row.transactions24hSells;
    const reserve = row.reserveUsd ?? 0;
    const durationMultiplier = options.duration === '1h' ? 0.22 : options.duration === '6h' ? 0.58 : 1;
    const createdAtMs = row.createdAtTimestamp?.getTime() ?? 0;
    const recencyBoost = options.duration === '6h' ? createdAtMs / 100_000 : 0;
    const score =
      volume * weights.volume * durationMultiplier +
      tx * 1_000 * weights.tx * durationMultiplier +
      reserve * weights.reserve +
      recencyBoost;

    return { row, score };
  });

  return scored
    .sort((left, right) =>
      right.score - left.score
      || (right.row.volume24hUsd ?? 0) - (left.row.volume24hUsd ?? 0)
      || (right.row.reserveUsd ?? 0) - (left.row.reserveUsd ?? 0)
      || left.row.address.localeCompare(right.row.address))
    .map(({ row }) => row);
}

function scorePoolSearchMatch(row: typeof onchainPools.$inferSelect, rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return 0;
  }

  const normalizedQuery = query.replace(/\s+/g, ' ').trim();
  const name = row.name.toLowerCase();
  const normalizedName = name.replace(/\s+/g, ' ').trim();
  const address = row.address.toLowerCase();
  const symbolHaystacks = [row.baseTokenSymbol, row.quoteTokenSymbol].map((value) => value.toLowerCase());

  if (address === query) {
    return 10_000;
  }

  if (normalizedName === normalizedQuery) {
    return 9_000;
  }

  if (symbolHaystacks.some((symbol) => symbol === query)) {
    return 8_000;
  }

  const queryTokens = normalizedQuery
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const nameTokens = normalizedName
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (queryTokens.length > 0 && queryTokens.every((token) => nameTokens.includes(token) || symbolHaystacks.includes(token))) {
    return 7_000;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 5_000;
  }

  if (symbolHaystacks.some((symbol) => symbol.startsWith(query))) {
    return 4_500;
  }

  if (address.includes(query)) {
    return 4_000;
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 3_500;
  }

  if (symbolHaystacks.some((symbol) => symbol.includes(query))) {
    return 3_000;
  }

  return 0;
}

function searchPoolRows(
  rows: typeof onchainPools.$inferSelect[],
  rawQuery: string,
) {
  return rows
    .map((row) => ({ row, score: scorePoolSearchMatch(row, rawQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || (right.row.volume24hUsd ?? 0) - (left.row.volume24hUsd ?? 0)
      || (right.row.reserveUsd ?? 0) - (left.row.reserveUsd ?? 0)
      || left.row.address.localeCompare(right.row.address))
    .map(({ row }) => row);
}


const megafilterSortValues = [
  'reserve_in_usd_desc',
  'reserve_in_usd_asc',
  'volume_usd_h24_desc',
  'volume_usd_h24_asc',
  'tx_count_h24_desc',
  'tx_count_h24_asc',
] as const;

type MegafilterSort = (typeof megafilterSortValues)[number];

function parseMegafilterSort(value: string | undefined): MegafilterSort {
  if (value === undefined) {
    return 'volume_usd_h24_desc';
  }

  if ((megafilterSortValues as readonly string[]).includes(value)) {
    return value as MegafilterSort;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported sort value: ${value}`);
}

function parseOptionalFiniteNumber(value: string | undefined, parameterName: string) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return parsed;
}

function parseMegafilterNetworks(value: string | undefined, database: AppDatabase) {
  const networks = parseCsvQuery(value);
  if (networks.length === 0) {
    return [];
  }

  const knownNetworks = new Set(database.db.select().from(onchainNetworks).all().map((row) => row.id));
  for (const network of networks) {
    if (!knownNetworks.has(network)) {
      throw new HttpError(400, 'invalid_parameter', `Unknown onchain network: ${network}`);
    }
  }

  return networks;
}

function parseMegafilterDexes(value: string | undefined, database: AppDatabase) {
  const dexes = parseCsvQuery(value);
  if (dexes.length === 0) {
    return [];
  }

  const knownDexes = new Set(database.db.select().from(onchainDexes).all().map((row) => row.id));
  for (const dex of dexes) {
    if (!knownDexes.has(dex)) {
      throw new HttpError(400, 'invalid_parameter', `Unknown onchain dex: ${dex}`);
    }
  }

  return dexes;
}

function buildMegafilterRow(row: typeof onchainPools.$inferSelect) {
  const txCount = row.transactions24hBuys + row.transactions24hSells;

  return {
    id: row.address,
    type: 'pool',
    attributes: {
      name: row.name,
      address: row.address,
      reserve_in_usd: row.reserveUsd ?? 0,
      volume_usd_h24: row.volume24hUsd ?? 0,
      tx_count_h24: txCount,
      price_usd: row.priceUsd,
      pool_created_at: row.createdAtTimestamp ? Math.floor(row.createdAtTimestamp.getTime() / 1000) : null,
      base_token_address: row.baseTokenAddress,
      base_token_symbol: row.baseTokenSymbol,
      quote_token_address: row.quoteTokenAddress,
      quote_token_symbol: row.quoteTokenSymbol,
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: row.networkId,
        },
      },
      dex: {
        data: {
          type: 'dex',
          id: row.dexId,
        },
      },
    },
  };
}

function sortMegafilterRows(rows: typeof onchainPools.$inferSelect[], sort: MegafilterSort) {
  const descending = sort.endsWith('_desc');

  const metric = (row: typeof onchainPools.$inferSelect) => {
    switch (sort) {
      case 'reserve_in_usd_desc':
      case 'reserve_in_usd_asc':
        return row.reserveUsd ?? 0;
      case 'volume_usd_h24_desc':
      case 'volume_usd_h24_asc':
        return row.volume24hUsd ?? 0;
      case 'tx_count_h24_desc':
      case 'tx_count_h24_asc':
        return row.transactions24hBuys + row.transactions24hSells;
    }
  };

  return [...rows].sort((left, right) => {
    const primary = descending ? metric(right) - metric(left) : metric(left) - metric(right);
    if (primary !== 0) {
      return primary;
    }

    const reserveTie = (right.reserveUsd ?? 0) - (left.reserveUsd ?? 0);
    if (reserveTie !== 0) {
      return reserveTie;
    }

    return left.address.localeCompare(right.address);
  });
}

function parseTrendingSearchCandidates(
  pools: string | undefined,
  rows: typeof onchainPools.$inferSelect[],
) {
  if (pools === undefined) {
    return {
      rows,
      candidateCount: rows.length,
      ignoredCandidates: [] as string[],
    };
  }

  const availableByAddress = new Map(rows.map((row) => [row.address.toLowerCase(), row]));
  const seen = new Set<string>();
  const resolved: typeof rows = [];
  const ignoredCandidates: string[] = [];

  for (const rawCandidate of pools.split(',').map((value) => value.trim()).filter((value) => value.length > 0)) {
    const normalizedCandidate = rawCandidate.toLowerCase();
    const candidate = availableByAddress.get(normalizedCandidate);

    if (!candidate || seen.has(normalizedCandidate)) {
      ignoredCandidates.push(rawCandidate);
      continue;
    }

    seen.add(normalizedCandidate);
    resolved.push(candidate);
  }

  return {
    rows: resolved,
    candidateCount: resolved.length,
    ignoredCandidates,
  };
}

function buildPaginationMeta(page: number, perPage: number, totalCount: number) {
  return {
    page,
    per_page: perPage,
    total_pages: Math.ceil(totalCount / perPage),
    total_count: totalCount,
  };
}

export function registerOnchainRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/onchain/networks', async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const liveCatalog = await buildLiveOnchainCatalog(database);
    const rows = liveCatalog.networks;
    const start = (page - 1) * perPage;
    const totalCount = rows.length;

    return {
      data: rows.slice(start, start + perPage).map(buildNetworkResource),
      meta: buildPaginationMeta(page, perPage, totalCount),
    };
  });

  app.get('/onchain/networks/:network/dexes', async (request) => {
    const params = z.object({ network: z.string() }).parse(request.params);
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const seededNetwork = getSeededOnchainNetwork(database, params.network);

    if (!seededNetwork) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const liveCatalog = await buildLiveOnchainCatalog(database);
    const rows = liveCatalog.dexes.filter((row) => row.networkId === params.network);
    const start = (page - 1) * perPage;
    const totalCount = rows.length;

    return {
      data: rows.slice(start, start + perPage).map(buildDexResource),
      meta: {
        ...buildPaginationMeta(page, perPage, totalCount),
        network: seededNetwork.id,
      },
    };
  });

  app.get('/onchain/networks/:network/pools', async (request) => {
    const params = z.object({ network: z.string() }).parse(request.params);
    const query = poolListQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const seededNetwork = getSeededOnchainNetwork(database, params.network);

    if (!seededNetwork) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const liveCatalog = await buildLiveOnchainCatalog(database);

    const orderBy = resolvePoolOrder(query.sort);

    const rows = database.db
      .select()
      .from(onchainPools)
      .where(eq(onchainPools.networkId, params.network))
      .orderBy(...orderBy)
      .all()
      .map((row) => patchPoolRow(row, liveCatalog.poolsByAddress.get(row.address)));

    const start = (page - 1) * perPage;

    return {
      data: rows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        data_source: liveCatalog.poolsByAddress.size === 0 || params.network !== 'eth' ? 'seeded' : 'live',
      },
    };
  });

  app.get('/onchain/networks/:network/dexes/:dex/pools', async (request) => {
    const params = z.object({ network: z.string(), dex: z.string() }).parse(request.params);
    const query = poolListQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    const network = getSeededOnchainNetwork(database, params.network);

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const dex = getSeededOnchainDex(database, params.network, params.dex);

    if (!dex) {
      throw new HttpError(404, 'not_found', `Onchain dex not found: ${params.dex}`);
    }

    const orderBy = resolvePoolOrder(query.sort);

    const rows = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.dexId, params.dex)))
      .orderBy(...orderBy)
      .all();

    const start = (page - 1) * perPage;

    return {
      data: rows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        dex: dex.id,
      },
    };
  });

  app.get('/onchain/networks/:network/new_pools', async (request) => {
    const params = z.object({ network: z.string() }).parse(request.params);
    const query = discoveryPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const rows = buildPoolDiscoveryRows(database.db
      .select()
      .from(onchainPools)
      .where(eq(onchainPools.networkId, params.network))
      .all(), { mode: 'new' });

    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/new_pools', async (request) => {
    const query = discoveryPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);
    const rows = buildPoolDiscoveryRows(database.db.select().from(onchainPools).all(), { mode: 'new' });
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/trending_pools', async (request) => {
    const query = trendingPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);
    const duration = parseTrendingDuration(query.duration);
    const rows = buildPoolDiscoveryRows(database.db.select().from(onchainPools).all(), { mode: 'trending', duration });
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
        duration,
      },
    };
  });

  app.get('/onchain/networks/:network/trending_pools', async (request) => {
    const params = z.object({ network: z.string() }).parse(request.params);
    const query = trendingPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);
    const duration = parseTrendingDuration(query.duration);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const rows = buildPoolDiscoveryRows(
      database.db.select().from(onchainPools).where(eq(onchainPools.networkId, params.network)).all(),
      { mode: 'trending', duration },
    );
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
        duration,
        network: network.id,
      },
    };
  });

  app.get('/onchain/search/pools', async (request) => {
    const query = searchPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const rawQuery = query.query?.trim() ?? '';

    let rows = database.db.select().from(onchainPools).all();

    if (query.network !== undefined) {
      const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, query.network)).limit(1).get();
      if (!network) {
        throw new HttpError(400, 'invalid_parameter', `Unknown onchain network: ${query.network}`);
      }
      rows = rows.filter((row) => row.networkId === query.network);
    }

    const matchedRows = rawQuery.length === 0 ? [] : searchPoolRows(rows, rawQuery);
    const start = (page - 1) * perPage;

    return {
      data: matchedRows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        query: rawQuery,
        ...(query.network !== undefined ? { network: query.network } : {}),
      },
    };
  });


  app.get('/onchain/pools/megafilter', async (request) => {
    const query = megafilterQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const includes = parseMegafilterIncludes(query.include);
    const networks = parseMegafilterNetworks(query.networks, database);
    const dexes = parseMegafilterDexes(query.dexes, database);
    const minReserveInUsd = parseOptionalFiniteNumber(query.min_reserve_in_usd, 'min_reserve_in_usd');
    const maxReserveInUsd = parseOptionalFiniteNumber(query.max_reserve_in_usd, 'max_reserve_in_usd');
    const minVolumeUsdH24 = parseOptionalFiniteNumber(query.min_volume_usd_h24, 'min_volume_usd_h24');
    const maxVolumeUsdH24 = parseOptionalFiniteNumber(query.max_volume_usd_h24, 'max_volume_usd_h24');
    const minTxCountH24 = parseOptionalFiniteNumber(query.min_tx_count_h24, 'min_tx_count_h24');
    const maxTxCountH24 = parseOptionalFiniteNumber(query.max_tx_count_h24, 'max_tx_count_h24');
    const sort = parseMegafilterSort(query.sort);

    let rows = database.db.select().from(onchainPools).all();

    if (networks.length > 0) {
      const networkSet = new Set(networks);
      rows = rows.filter((row) => networkSet.has(row.networkId));
    }

    if (dexes.length > 0) {
      const dexSet = new Set(dexes);
      rows = rows.filter((row) => dexSet.has(row.dexId));
    }

    rows = rows.filter((row) => {
      const reserve = row.reserveUsd ?? 0;
      const volume = row.volume24hUsd ?? 0;
      const txCount = row.transactions24hBuys + row.transactions24hSells;

      return (minReserveInUsd === null || reserve >= minReserveInUsd)
        && (maxReserveInUsd === null || reserve <= maxReserveInUsd)
        && (minVolumeUsdH24 === null || volume >= minVolumeUsdH24)
        && (maxVolumeUsdH24 === null || volume <= maxVolumeUsdH24)
        && (minTxCountH24 === null || txCount >= minTxCountH24)
        && (maxTxCountH24 === null || txCount <= maxTxCountH24);
    });

    const sortedRows = sortMegafilterRows(rows, sort);
    const start = (page - 1) * perPage;
    const pagedRows = sortedRows.slice(start, start + perPage);
    const included = buildMegafilterIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildMegafilterRow(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        ...buildPaginationMeta(page, perPage, sortedRows.length),
        sort,
        applied_filters: {
          ...(networks.length > 0 ? { networks } : {}),
          ...(dexes.length > 0 ? { dexes } : {}),
          ...(minReserveInUsd !== null ? { min_reserve_in_usd: minReserveInUsd } : {}),
          ...(maxReserveInUsd !== null ? { max_reserve_in_usd: maxReserveInUsd } : {}),
          ...(minVolumeUsdH24 !== null ? { min_volume_usd_h24: minVolumeUsdH24 } : {}),
          ...(maxVolumeUsdH24 !== null ? { max_volume_usd_h24: maxVolumeUsdH24 } : {}),
          ...(minTxCountH24 !== null ? { min_tx_count_h24: minTxCountH24 } : {}),
          ...(maxTxCountH24 !== null ? { max_tx_count_h24: maxTxCountH24 } : {}),
        },
      },
    };
  });

  app.get('/onchain/pools/trending_search', async (request) => {
    const query = trendingSearchQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = parsePositiveInt(query.per_page, 100);
    const rankedRows = buildPoolDiscoveryRows(database.db.select().from(onchainPools).all(), {
      mode: 'trending',
      duration: '24h',
    });
    const subset = parseTrendingSearchCandidates(query.pools, rankedRows);
    const start = (page - 1) * perPage;

    return {
      data: subset.rows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        per_page: perPage,
        candidate_count: subset.candidateCount,
        ...(subset.ignoredCandidates.length > 0 ? { ignored_candidates: subset.ignoredCandidates } : {}),
      },
    };
  });

  app.get('/onchain/categories', async (request) => {
    const query = onchainCategoriesQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 1;
    const sort = parseOnchainCategorySort(query.sort);
    const rows = sortOnchainCategorySummaries(
      [...buildOnchainCategorySummaries(database).values()],
      sort,
    );
    const start = (page - 1) * perPage;

    return {
      data: rows.slice(start, start + perPage).map(buildOnchainCategoryResource),
      meta: {
        ...buildPaginationMeta(page, perPage, rows.length),
        sort,
      },
    };
  });

  app.get('/onchain/categories/:categoryId/pools', async (request) => {
    const params = z.object({ categoryId: z.string() }).parse(request.params);
    const query = onchainCategoryPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const sort = parseOnchainCategoryPoolSort(query.sort);
    const includes = parsePoolIncludes(query.include);

    const category = buildOnchainCategorySummaries(database).get(params.categoryId);
    if (!category) {
      throw new HttpError(404, 'not_found', `Onchain category not found: ${params.categoryId}`);
    }

    const rows = sortOnchainCategoryPools(getPoolsForOnchainCategory(params.categoryId, database), sort);
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        ...buildPaginationMeta(page, perPage, rows.length),
        sort,
        category_id: params.categoryId,
      },
    };
  });

  app.get('/onchain/networks/:network/pools/multi/:addresses', async (request) => {
    const params = z.object({ network: z.string(), addresses: z.string() }).parse(request.params);
    const query = poolMultiQuerySchema.parse(request.query);
    const includes = parsePoolIncludes(query.include);
    const requestedAddresses = [...new Set(params.addresses
      .split(',')
      .map((address) => normalizeAddress(address))
      .filter((address) => address.length > 0))];

    if (requestedAddresses.length === 0) {
      return {
      data: [],
      ...(includes.length > 0 ? { included: [] } : {}),
      };
    }

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const rows = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), inArray(onchainPools.address, requestedAddresses)))
      .orderBy(asc(onchainPools.address))
      .all();

    const rowsByAddress = new Map(rows.map((row) => [row.address, row]));
    const orderedRows = requestedAddresses
      .map((address) => rowsByAddress.get(address))
      .filter((row): row is typeof onchainPools.$inferSelect => row !== undefined);
    const included = buildIncludedResources(includes, orderedRows, database);

    return {
      data: orderedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
    };
  });

  app.get('/onchain/networks/:network/pools/:address', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = poolDetailQuerySchema.parse(request.query);
    const includes = parsePoolIncludes(query.include);
    const includeVolumeBreakdown = parseBooleanQuery(query.include_volume_breakdown, false);
    const includeComposition = parseBooleanQuery(query.include_composition, false);
    const normalizedAddress = normalizeAddress(params.address);
    const seededNetwork = getSeededOnchainNetwork(database, params.network);

    if (!seededNetwork) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const row = getSeededOnchainPool(database, params.network, normalizedAddress);

    if (!row) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${normalizedAddress}`);
    }

    const liveCatalog = await buildLiveOnchainCatalog(database);

    const patchedRow = patchPoolRow(row, liveCatalog.poolsByAddress.get(row.address));
    const included = buildIncludedResources(includes, [patchedRow], database);

    return {
      data: buildPoolResource(patchedRow, {
        includeVolumeBreakdown,
        includeComposition,
      }),
      meta: {
        data_source: liveCatalog.degraded || params.network !== 'eth' ? 'seeded' : 'live',
      },
      ...(included.length > 0 ? { included } : {}),
    };
  });

  app.get('/onchain/networks/:network/tokens/multi/:addresses', async (request) => {
    const params = z.object({ network: z.string(), addresses: z.string() }).parse(request.params);
    const query = tokenMultiQuerySchema.parse(request.query);
    const includes = parseTokenIncludes(query.include);
    const requestedAddresses = [...new Set(params.addresses
      .split(',')
      .map((address) => normalizeAddress(address))
      .filter((address) => address.length > 0))];

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenRows = requestedAddresses
      .map((address) => {
        const tokenPools = collectTokenPools(params.network, address, database);
        return tokenPools.length > 0 ? buildTokenResource(params.network, address, tokenPools) : null;
      })
      .filter((row): row is ReturnType<typeof buildTokenResource> => row !== null);

    const includedPoolAddresses = includes.includes('top_pools')
      ? [...new Set(tokenRows.flatMap((row) => row.attributes.top_pools))]
      : [];

    const included = includes.includes('top_pools')
      ? database.db
          .select()
          .from(onchainPools)
          .where(and(eq(onchainPools.networkId, params.network), inArray(onchainPools.address, includedPoolAddresses)))
          .all()
          .map((row) => buildPoolResource(row))
      : [];

    return {
      data: tokenRows,
      ...(included.length > 0 ? { included } : {}),
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/pools', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, params.address, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${normalizeAddress(params.address)}`);
    }

    const start = (page - 1) * perPage;

    return {
      data: tokenPools.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        token_address: normalizeAddress(params.address),
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = tokenDetailQuerySchema.parse(request.query);
    const includes = parseTokenIncludes(query.include);
    const includeInactiveSource = parseBooleanQuery(query.include_inactive_source, false);
    const includeComposition = parseBooleanQuery(query.include_composition, false);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, params.address, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${normalizeAddress(params.address)}`);
    }

    const livePrice = await fetchLiveSimpleTokenPrice(params.network, normalizeAddress(params.address), tokenPools, database);

    return {
      data: buildTokenResource(params.network, params.address, tokenPools, {
        includeInactiveSource,
        includeComposition,
        livePriceUsd: livePrice?.priceUsd ?? null,
      }),
      ...(includes.includes('top_pools')
        ? { included: tokenPools.map((row) => buildPoolResource(row)) }
        : {}),
    };
  });

  app.get('/onchain/simple/networks/:network/token_price/:addresses', async (request) => {
    const params = z.object({ network: z.string(), addresses: z.string() }).parse(request.params);
    const query = simpleTokenPriceQuerySchema.parse(request.query);
    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const requestedAddresses = parseOnchainAddressList(params.addresses);
    const includeMarketCap = parseBooleanQuery(query.include_market_cap, false);
    const include24hrVol = parseBooleanQuery(query.include_24hr_vol, false);
    const include24hrPriceChange = parseBooleanQuery(query.include_24hr_price_change, false);
    const includeTotalReserveInUsd = parseBooleanQuery(query.include_total_reserve_in_usd, false);

    const tokenPrices: Record<string, string | null> = {};
    const marketCaps: Record<string, string | null> = {};
    const volumes24h: Record<string, string | null> = {};
    const priceChanges24h: Record<string, string | null> = {};
    const totalReserveInUsd: Record<string, string | null> = {};

    for (const address of requestedAddresses) {
      const tokenPools = collectTokenPools(params.network, address, database);

      if (tokenPools.length === 0) {
        continue;
      }

      const tokenResource = buildTokenResource(params.network, address, tokenPools);
      const coinId = findCoinIdForToken(params.network, address);
      const snapshot = coinId
        ? database.db
            .select()
            .from(marketSnapshots)
            .where(and(eq(marketSnapshots.coinId, coinId), eq(marketSnapshots.vsCurrency, 'usd')))
            .limit(1)
            .get()
        : null;
      const livePrice = await fetchLiveSimpleTokenPrice(params.network, address, tokenPools, database);

      tokenPrices[address] = formatMetricValue(livePrice?.priceUsd ?? tokenResource.attributes.price_usd);

      if (includeMarketCap) {
        marketCaps[address] = formatMetricValue(livePrice?.marketCapUsd ?? snapshot?.marketCap ?? tokenPools[0]?.reserveUsd ?? null);
      }

      if (include24hrVol) {
        volumes24h[address] = formatMetricValue(livePrice?.volume24hUsd ?? tokenPools.reduce((sum, pool) => sum + (pool.volume24hUsd ?? 0), 0));
      }

      if (include24hrPriceChange) {
        priceChanges24h[address] = formatMetricValue(livePrice?.priceChange24h ?? snapshot?.priceChangePercentage24h ?? 0);
      }

      if (includeTotalReserveInUsd) {
        totalReserveInUsd[address] = formatMetricValue(livePrice?.totalReserveUsd ?? tokenPools.reduce((sum, pool) => sum + (pool.reserveUsd ?? 0), 0));
      }
    }

    return {
      data: {
        id: network.id,
        type: 'simple_token_price',
        attributes: {
          token_prices: tokenPrices,
          ...(includeMarketCap ? { market_cap_usd: marketCaps } : {}),
          ...(include24hrVol ? { h24_volume_usd: volumes24h } : {}),
          ...(include24hrPriceChange ? { h24_price_change_percentage: priceChanges24h } : {}),
          ...(includeTotalReserveInUsd ? { total_reserve_in_usd: totalReserveInUsd } : {}),
        },
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/info', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, params.address, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${normalizeAddress(params.address)}`);
    }

    const livePrice = await fetchLiveSimpleTokenPrice(params.network, normalizeAddress(params.address), tokenPools, database);
    const coinId = resolveTokenCoinId(params.network, normalizeAddress(params.address), tokenPools);

    return {
      data: buildTokenInfoResource(params.network, params.address, tokenPools, {
        livePriceUsd: livePrice?.priceUsd ?? null,
        coinId,
      }),
    };
  });

  app.get('/onchain/networks/:network/pools/:address/info', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = poolInfoQuerySchema.parse(request.query);
    const includes = parsePoolInfoIncludes(query.include);
    const normalizedAddress = normalizeAddress(params.address);
    const row = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, normalizedAddress)))
      .limit(1)
      .get();

    if (!row) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${normalizedAddress}`);
    }

    const tokenInfos = await Promise.all([
      (async () => {
        const tokenPools = collectTokenPools(params.network, row.baseTokenAddress, database);
        const livePrice = await fetchLiveSimpleTokenPrice(params.network, normalizeAddress(row.baseTokenAddress), tokenPools, database);
        const coinId = resolveTokenCoinId(params.network, normalizeAddress(row.baseTokenAddress), tokenPools);
        return buildTokenInfoResource(params.network, row.baseTokenAddress, tokenPools, {
          livePriceUsd: livePrice?.priceUsd ?? null,
          coinId,
        });
      })(),
      (async () => {
        const tokenPools = collectTokenPools(params.network, row.quoteTokenAddress, database);
        const livePrice = await fetchLiveSimpleTokenPrice(params.network, normalizeAddress(row.quoteTokenAddress), tokenPools, database);
        const coinId = resolveTokenCoinId(params.network, normalizeAddress(row.quoteTokenAddress), tokenPools);
        return buildTokenInfoResource(params.network, row.quoteTokenAddress, tokenPools, {
          livePriceUsd: livePrice?.priceUsd ?? null,
          coinId,
        });
      })(),
    ]);

    return {
      data: tokenInfos,
      ...(includes.includes('pool') ? { included: [buildPoolResource(row)] } : {}),
    };
  });

  app.get('/onchain/tokens/info_recently_updated', async (request) => {
    const query = recentlyUpdatedTokenInfoQuerySchema.parse(request.query);
    const includes = parseRecentlyUpdatedTokenInfoIncludes(query.include);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    if (query.network) {
      const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, query.network)).limit(1).get();
      if (!network) {
        throw new HttpError(400, 'invalid_parameter', `Unknown onchain network: ${query.network}`);
      }
    }

    const poolRows = database.db.select().from(onchainPools).all();
    const byNetworkAndAddress = new Map<string, typeof onchainPools.$inferSelect[]>();

    for (const row of poolRows) {
      for (const address of [row.baseTokenAddress, row.quoteTokenAddress]) {
        const key = `${row.networkId}:${normalizeAddress(address)}`;
        const existing = byNetworkAndAddress.get(key) ?? [];
        existing.push(row);
        byNetworkAndAddress.set(key, existing);
      }
    }

    const tokenInfos = (await Promise.all([...byNetworkAndAddress.entries()]
      .filter(([key]) => !query.network || key.startsWith(`${query.network}:`))
      .map(async ([key, pools]) => {
        const [networkId, address] = key.split(':');
        const livePrice = await fetchLiveSimpleTokenPrice(networkId!, address!, pools, database);
        const coinId = resolveTokenCoinId(networkId!, address!, pools);
        return buildTokenInfoResource(networkId!, address!, pools, {
          livePriceUsd: livePrice?.priceUsd ?? null,
          coinId,
        });
      })))
      .sort((left, right) => right.attributes.updated_at - left.attributes.updated_at || left.id.localeCompare(right.id));

    const start = (page - 1) * perPage;
    const paged = tokenInfos.slice(start, start + perPage);
    const included = includes.includes('network')
      ? [...new Set(paged.map((item) => item.relationships.network.data.id))]
          .map((networkId) => database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, networkId)).limit(1).get())
          .filter((row): row is typeof onchainNetworks.$inferSelect => row !== undefined)
          .map((row) => buildNetworkResource(row))
      : [];

    return {
      data: paged,
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/top_holders', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = topHoldersQuerySchema.parse(request.query);
    const includePnlDetails = parseBooleanQuery(query.include_pnl_details, false);
    const includes = parseTopHoldersIncludes(query.include);
    const holders = parseAnalyticsCount(query.holders, 'holders', 3);
    const tokenAddress = normalizeAddress(params.address);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();
    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const holdersRows = buildTopHolderFixtures(params.network, tokenAddress)
      .sort((left, right) => right.balance - left.balance || right.shareOfSupply - left.shareOfSupply || left.address.localeCompare(right.address))
      .slice(0, holders);
    const included = buildTopHoldersIncludedResources(includes, params.network, tokenAddress, tokenPools, database);

    return {
      data: holdersRows.map((holder) => buildTopHolderResource(holder, includePnlDetails)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        network: params.network,
        token_address: tokenAddress,
        holders,
        include_pnl_details: includePnlDetails,
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/top_traders', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = topTradersQuerySchema.parse(request.query);
    const includeAddressLabel = parseBooleanQuery(query.include_address_label, false);
    const traders = parseAnalyticsCount(query.traders, 'traders', 3);
    const sort = parseTopTraderSort(query.sort);
    const tokenAddress = normalizeAddress(params.address);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();
    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const tradersRows = buildTopTraderFixtures(params.network, tokenAddress)
      .sort((left, right) => {
        const primary = sort === 'realized_pnl_usd_desc'
          ? right.realizedPnlUsd - left.realizedPnlUsd
          : right.volumeUsd - left.volumeUsd;

        if (primary !== 0) {
          return primary;
        }

        const secondary = right.volumeUsd - left.volumeUsd;
        if (secondary !== 0) {
          return secondary;
        }

        return left.address.localeCompare(right.address);
      })
      .slice(0, traders);

    return {
      data: tradersRows.map((trader) => buildTopTraderResource(trader, includeAddressLabel)),
      meta: {
        network: params.network,
        token_address: tokenAddress,
        traders,
        sort,
        include_address_label: includeAddressLabel,
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/holders_chart', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = holdersChartQuerySchema.parse(request.query);
    const days = parseHoldersChartDays(query.days);
    const tokenAddress = normalizeAddress(params.address);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();
    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const fullSeries = buildHoldersChartFixtures(params.network, tokenAddress).sort((left, right) => left.timestamp - right.timestamp);
    const data = days <= 7 ? fullSeries.slice(-2) : fullSeries;

    return {
      data: data.map(buildHoldersChartResource),
      meta: {
        network: params.network,
        token_address: tokenAddress,
        days,
      },
    };
  });

  app.get('/onchain/networks/:network/pools/:address/trades', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = tradesQuerySchema.parse(request.query);
    const threshold = parseTradeVolumeThreshold(query.trade_volume_in_usd_greater_than);
    const normalizedAddress = normalizeAddress(params.address);

    const pool = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, normalizedAddress)))
      .limit(1)
      .get();

    if (!pool) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${normalizedAddress}`);
    }

    let filteredToken: string | null = null;
    if (query.token !== undefined) {
      if (!isValidOnchainAddress(query.token)) {
        throw new HttpError(400, 'invalid_parameter', `Invalid onchain address: ${query.token}`);
      }

      filteredToken = normalizeAddress(query.token);
      const poolTokens = [normalizeAddress(pool.baseTokenAddress), normalizeAddress(pool.quoteTokenAddress)];
      if (!poolTokens.includes(filteredToken)) {
        throw new HttpError(400, 'invalid_parameter', `Token is not a constituent of pool: ${filteredToken}`);
      }
    }

    let liveTrades: LiveTradeRecord[] | null = null;
    try {
      liveTrades = await fetchLivePoolTrades(pool);
    } catch (error) {
      request.log.error({
        err: error,
        network: params.network,
        pool_address: normalizedAddress,
      }, 'failed to fetch live onchain pool trades');
      liveTrades = null;
    }

    const trades = (liveTrades ?? buildOnchainTradeFixtures(database).map((trade) => ({ ...trade, source: 'fixture' as const })))
      .filter((trade) => trade.networkId === params.network && trade.poolAddress === params.address)
      .filter((trade) => threshold === null || trade.volumeUsd > threshold)
      .filter((trade) => filteredToken === null || trade.tokenAddress === filteredToken)
      .sort((left, right) => right.blockTimestamp - left.blockTimestamp || left.id.localeCompare(right.id));

    return {
      data: trades.map(buildTradeResource),
      meta: {
        network: params.network,
        pool_address: params.address,
        source: liveTrades ? 'live' : 'fixture',
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/trades', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = tradesQuerySchema.parse(request.query);
    const threshold = parseTradeVolumeThreshold(query.trade_volume_in_usd_greater_than);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenAddress = normalizeAddress(params.address);
    const tokenPools = collectTokenPools(params.network, tokenAddress, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const liveTradeGroups = await Promise.all(tokenPools.map((pool) => fetchLivePoolTrades(pool)));
    const liveTrades = liveTradeGroups.flatMap((group) => group ?? []);
    const poolAddresses = new Set(tokenPools.map((pool) => pool.address));
    const trades = (liveTrades.length > 0 ? liveTrades : buildOnchainTradeFixtures(database).map((trade) => ({ ...trade, source: 'fixture' as const })))
      .filter((trade) => trade.networkId === params.network && trade.tokenAddress === tokenAddress && poolAddresses.has(trade.poolAddress))
      .filter((trade) => threshold === null || trade.volumeUsd > threshold)
      .sort((left, right) => right.blockTimestamp - left.blockTimestamp || left.id.localeCompare(right.id));

    return {
      data: trades.map(buildTradeResource),
      meta: {
        network: params.network,
        token_address: tokenAddress,
        source: liveTrades.length > 0 ? 'live' : 'fixture',
      },
    };
  });

  app.get('/onchain/networks/:network/pools/:address/ohlcv/:timeframe', async (request) => {
    const params = z.object({ network: z.string(), address: z.string(), timeframe: z.string() }).parse(request.params);
    const query = onchainOhlcvQuerySchema.parse(request.query);
    const timeframe = parseOnchainOhlcvTimeframe(params.timeframe);
    const aggregate = parseOptionalPositiveInteger(query.aggregate, 'aggregate') ?? 1;
    const limit = parseOptionalPositiveInteger(query.limit, 'limit') ?? 100;
    const beforeTimestamp = parseOptionalTimestamp(query.before_timestamp, 'before_timestamp');
    const includeEmptyIntervals = parseBooleanQuery(query.include_empty_intervals, false);
    const currency = (query.currency ?? 'usd').trim().toLowerCase();

    const normalizedAddress = normalizeAddress(params.address);
    if (!['usd', 'token'].includes(currency)) {
      throw new HttpError(400, 'invalid_parameter', `Unsupported currency value: ${query.currency}`);
    }

    const pool = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, normalizedAddress)))
      .limit(1)
      .get();

    if (!pool) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${normalizedAddress}`);
    }

    let tokenSelection: string | null = null;
    if (query.token !== undefined) {
      if (!isValidOnchainAddress(query.token)) {
        throw new HttpError(400, 'invalid_parameter', `Invalid onchain address: ${query.token}`);
      }

      tokenSelection = normalizeAddress(query.token);
      const constituentTokens = [normalizeAddress(pool.baseTokenAddress), normalizeAddress(pool.quoteTokenAddress)];
      if (!constituentTokens.includes(tokenSelection)) {
        throw new HttpError(400, 'invalid_parameter', `Token is not a constituent of pool: ${tokenSelection}`);
      }
    }

    let liveTrades: LiveTradeRecord[] | null = null;
    try {
      liveTrades = await fetchLivePoolTrades(pool);
    } catch (error) {
      request.log.error({
        err: error,
        network: params.network,
        pool_address: normalizedAddress,
        timeframe,
      }, 'failed to fetch live onchain pool trades for ohlcv');
      liveTrades = null;
    }
    const baseSeries = liveTrades && liveTrades.length > 0
      ? derivePoolOhlcvFromTrades(
          liveTrades,
          timeframe,
          aggregate,
          currency as 'usd' | 'token',
          tokenSelection,
          pool,
        )
      : buildSyntheticPoolOhlcvSeries(pool, timeframe, aggregate).map((point) => {
          const multiplier = currency === 'token' && tokenSelection !== null && normalizeAddress(pool.quoteTokenAddress) === tokenSelection
            ? 1 / (pool.priceUsd ?? 1)
            : 1;

          return {
            ...point,
            open: Number((point.open * multiplier).toFixed(6)),
            high: Number((point.high * multiplier).toFixed(6)),
            low: Number((point.low * multiplier).toFixed(6)),
            close: Number((point.close * multiplier).toFixed(6)),
          };
        });

    return {
      data: {
        id: `${params.network}:${params.address}:${timeframe}`,
        type: 'ohlcv',
        attributes: {
          network: params.network,
          pool_address: params.address,
          timeframe,
          aggregate,
          currency,
          token: tokenSelection,
          ohlcv_list: finalizeOnchainOhlcvSeries(baseSeries, {
            aggregate,
            limit,
            beforeTimestamp,
            includeEmptyIntervals,
            timeframe,
          }),
          source: liveTrades && liveTrades.length > 0 ? 'live' : 'fixture',
        },
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/ohlcv/:timeframe', async (request) => {
    const params = z.object({ network: z.string(), address: z.string(), timeframe: z.string() }).parse(request.params);
    const query = onchainOhlcvQuerySchema.parse(request.query);
    const timeframe = parseOnchainOhlcvTimeframe(params.timeframe);
    const aggregate = parseOptionalPositiveInteger(query.aggregate, 'aggregate') ?? 1;
    const limit = parseOptionalPositiveInteger(query.limit, 'limit') ?? 100;
    const beforeTimestamp = parseOptionalTimestamp(query.before_timestamp, 'before_timestamp');
    const includeEmptyIntervals = parseBooleanQuery(query.include_empty_intervals, false);
    const includeInactiveSource = parseBooleanQuery(query.include_inactive_source, false);
    const tokenAddress = normalizeAddress(params.address);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();
    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const aggregatedSeries = await aggregatePoolSeriesForToken(
      tokenPools,
      timeframe,
      aggregate,
      tokenAddress,
      includeInactiveSource,
    );

    return {
      data: {
        id: `${params.network}:${tokenAddress}:${timeframe}`,
        type: 'ohlcv',
        attributes: {
          network: params.network,
          token_address: tokenAddress,
          timeframe,
          aggregate,
          include_inactive_source: includeInactiveSource,
          ohlcv_list: finalizeOnchainOhlcvSeries(
            aggregatedSeries.map((point) => ({
              timestamp: point.timestamp,
              open: point.open,
              high: point.high,
              low: point.low,
              close: point.close,
              volumeUsd: point.volume_usd,
            })),
            {
              aggregate,
              limit,
              beforeTimestamp,
              includeEmptyIntervals,
              timeframe,
            },
          ),
          source_pools: [...new Set(aggregatedSeries.flatMap((point) => point.source_pools))].sort(),
        },
      },
    };
  });

}
