import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../../db/client';
import { coins, onchainDexes, onchainNetworks, onchainPools } from '../../db/schema';
import { HttpError } from '../../http/errors';
import { parseCsvQuery } from '../../http/params';
import { fetchDefillamaDexVolumes, fetchDefillamaPoolData } from '../../providers/defillama';
import {
  type LiveOnchainPoolPatch,
  type NetworkDexMaps,
  type OnchainCategoryPoolSort,
  type OnchainCategorySort,
  type OnchainCategorySummary,
  type MegafilterSort,
  generateDeterministicAddress,
  normalizeAddress,
  slugifyOnchainId,
  toDexName,
} from './helpers';
import { buildTokenResource } from './tokens';

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

export function patchPoolRow(row: typeof onchainPools.$inferSelect, patch: LiveOnchainPoolPatch | undefined) {
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

export function getSeededOnchainNetwork(database: AppDatabase, networkId: string) {
  return database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, networkId)).limit(1).get();
}

export function getSeededOnchainDex(database: AppDatabase, networkId: string, dexId: string) {
  return database.db
    .select()
    .from(onchainDexes)
    .where(and(eq(onchainDexes.networkId, networkId), eq(onchainDexes.id, dexId)))
    .limit(1)
    .get();
}

export function getSeededOnchainPool(database: AppDatabase, networkId: string, address: string) {
  return database.db
    .select()
    .from(onchainPools)
    .where(and(eq(onchainPools.networkId, networkId), eq(onchainPools.address, normalizeAddress(address))))
    .limit(1)
    .get();
}

let liveOnchainCatalogPromise: Promise<LiveOnchainCatalog> | null = null;

export function ensureNetworkAndDex(
  chainName: string,
  projectSlug: string,
  maps: NetworkDexMaps & { networksById: Map<string, typeof onchainNetworks.$inferSelect>; dexesByKey: Map<string, typeof onchainDexes.$inferSelect> },
): { networkConfig: (typeof DEFILLAMA_NETWORK_CONFIG)[keyof typeof DEFILLAMA_NETWORK_CONFIG]; dexConfig: { id: string; name: string; url: string; imageUrl: string | null } } | null {
  const networkConfig = DEFILLAMA_NETWORK_CONFIG[chainName as keyof typeof DEFILLAMA_NETWORK_CONFIG];
  if (!networkConfig) {
    return null;
  }

  if (!maps.networksById.has(networkConfig.networkId)) {
    maps.networksById.set(networkConfig.networkId, {
      id: networkConfig.networkId,
      name: networkConfig.name,
      chainIdentifier: networkConfig.chainIdentifier,
      coingeckoAssetPlatformId: networkConfig.coingeckoAssetPlatformId,
      nativeCurrencyCoinId: networkConfig.nativeCurrencyCoinId,
      imageUrl: networkConfig.imageUrl,
      updatedAt: maps.now,
    });
  }

  const dexConfig = DEFILLAMA_DEX_OVERRIDES[projectSlug] ?? {
    id: projectSlug,
    name: toDexName(projectSlug),
    url: `https://defillama.com/protocol/${projectSlug}`,
    imageUrl: null,
  };
  const dexKey = `${networkConfig.networkId}:${dexConfig.id}`;
  if (!maps.dexesByKey.has(dexKey)) {
    maps.dexesByKey.set(dexKey, {
      id: dexConfig.id,
      networkId: networkConfig.networkId,
      name: dexConfig.name,
      url: dexConfig.url,
      imageUrl: dexConfig.imageUrl,
      updatedAt: maps.now,
    });
  }

  return { networkConfig, dexConfig };
}

export async function buildLiveOnchainCatalog(database: AppDatabase): Promise<LiveOnchainCatalog> {
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

  const maps = { networksById, dexesByKey, now } as NetworkDexMaps & { networksById: Map<string, typeof onchainNetworks.$inferSelect>; dexesByKey: Map<string, typeof onchainDexes.$inferSelect> };

  for (const entry of poolData.pools) {
    if (!entry.chain) continue;

    const projectSlug = entry.project ? slugifyOnchainId(entry.project) : null;
    if (!projectSlug) {
      continue;
    }

    ensureNetworkAndDex(entry.chain, projectSlug, maps);
  }

  const networkConfigByNetworkId = new Map<string, { chainName: string; networkId: string }>();
  for (const [chainName, config] of Object.entries(DEFILLAMA_NETWORK_CONFIG)) {
    networkConfigByNetworkId.set(config.networkId, { chainName, networkId: config.networkId });
  }

  const dexVolumeByName = new Map(
    (dexVolumes?.protocols ?? [])
      .filter((entry) => entry.name)
      .map((entry) => [slugifyOnchainId(entry.name!), entry.total24h ?? null]),
  );

  for (const [address, row] of seededPoolMap) {
    const chainInfo = networkConfigByNetworkId.get(row.networkId);
    if (!chainInfo) {
      continue;
    }

    const matchedPool = poolData.pools.find((pool) => {
      if (pool.chain !== chainInfo.chainName) {
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

  for (const [chainName, networkConfig] of Object.entries(DEFILLAMA_NETWORK_CONFIG)) {
    const discoveredPools = poolData.pools
      .filter((pool) =>
        pool.chain === chainName
        && typeof pool.tvlUsd === 'number'
        && pool.tvlUsd > 100_000,
      );

    for (const pool of discoveredPools) {
      const projectSlug = pool.project ? slugifyOnchainId(pool.project) : null;
      if (!projectSlug) continue;

      if (!pool.underlyingTokens || pool.underlyingTokens.length < 2) continue;

      const poolTokens = new Set(pool.underlyingTokens.map(normalizeAddress));

      const alreadyMatched = [...seededPoolMap.values()].some((seeded) => {
        if (seeded.networkId !== networkConfig.networkId) return false;
        const baseNorm = normalizeAddress(seeded.baseTokenAddress);
        const quoteNorm = normalizeAddress(seeded.quoteTokenAddress);
        return poolTokens.has(baseNorm) && poolTokens.has(quoteNorm);
      });

      if (alreadyMatched) continue;

      const result = ensureNetworkAndDex(chainName, projectSlug, maps);
      if (!result) continue;
      const { networkConfig: resolvedNetworkConfig, dexConfig } = result;

      const poolIdentifier = pool.pool ?? `${pool.chain ?? ''}-${pool.project ?? ''}-${pool.symbol ?? ''}-${(pool.underlyingTokens ?? []).join(',')}`;
      const poolAddress = generateDeterministicAddress(poolIdentifier);
      const baseToken = pool.underlyingTokens[0];
      const quoteToken = pool.underlyingTokens[1];

      if (!poolsByAddress.has(poolAddress)) {
        poolsByAddress.set(poolAddress, {
          priceUsd: null,
          reserveUsd: pool.tvlUsd ?? null,
          volume24hUsd: pool.volumeUsd1d ?? null,
          source: 'live',
          dexId: dexConfig.id,
          name: pool.symbol ?? `${poolAddress.slice(0, 8)}...`,
          baseTokenAddress: baseToken,
          baseTokenSymbol: baseToken.slice(0, 8),
          quoteTokenAddress: quoteToken,
          quoteTokenSymbol: quoteToken.slice(0, 8),
          networkId: resolvedNetworkConfig.networkId,
        });
      }
    }
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

export function buildNetworkResource(row: typeof onchainNetworks.$inferSelect) {
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

export function buildDexResource(row: typeof onchainDexes.$inferSelect) {
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

export function buildPoolResource(
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

export function collectTokenPools(networkId: string, tokenAddress: string, database: AppDatabase) {
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

export function resolvePoolCategoryIds(row: typeof onchainPools.$inferSelect) {
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

export function buildOnchainCategorySummaries(database: AppDatabase) {
  const categoryRows = database.db.select().from(coins).all();
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

export function sortOnchainCategorySummaries(rows: OnchainCategorySummary[], sort: OnchainCategorySort) {
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

export function buildOnchainCategoryResource(row: OnchainCategorySummary) {
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

export function getPoolsForOnchainCategory(categoryId: string, database: AppDatabase) {
  return database.db.select().from(onchainPools).all()
    .filter((pool) => resolvePoolCategoryIds(pool).includes(categoryId));
}

export function sortOnchainCategoryPools(rows: typeof onchainPools.$inferSelect[], sort: OnchainCategoryPoolSort) {
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

export function buildIncludedResources(
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

export function buildMegafilterIncludedResources(
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

export function buildTopHoldersIncludedResources(
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

export function resolvePoolOrder(sort: 'h24_volume_usd_liquidity_desc' | 'h24_tx_count_desc' | 'reserve_in_usd_desc' | undefined) {
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

export function buildPoolDiscoveryRows(
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

export function scorePoolSearchMatch(row: typeof onchainPools.$inferSelect, rawQuery: string) {
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

export function searchPoolRows(
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

export function buildMegafilterRow(row: typeof onchainPools.$inferSelect) {
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

export function sortMegafilterRows(rows: typeof onchainPools.$inferSelect[], sort: MegafilterSort) {
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

export function parseMegafilterNetworks(value: string | undefined, database: AppDatabase) {
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

export function parseMegafilterDexes(value: string | undefined, database: AppDatabase) {
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

export function parseTrendingSearchCandidates(
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
