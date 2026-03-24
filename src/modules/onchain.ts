import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { coins, marketSnapshots, onchainDexes, onchainNetworks, onchainPools } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt } from '../http/params';

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

function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
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
  },
) {
  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools[0];
  const tokenSymbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;
  const priceUsd = primaryPool?.priceUsd ?? null;

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

function buildTokenInfoResource(networkId: string, tokenAddress: string, tokenPools: typeof onchainPools.$inferSelect[]) {
  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools[0];
  const symbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;
  const coinId = findCoinIdForToken(networkId, normalizedAddress);
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
    const rows = database.db.select().from(onchainNetworks).orderBy(asc(onchainNetworks.name)).all();
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
    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const rows = database.db
      .select()
      .from(onchainDexes)
      .where(eq(onchainDexes.networkId, params.network))
      .orderBy(asc(onchainDexes.name))
      .all();
    const start = (page - 1) * perPage;
    const totalCount = rows.length;

    return {
      data: rows.slice(start, start + perPage).map(buildDexResource),
      meta: {
        ...buildPaginationMeta(page, perPage, totalCount),
        network: network.id,
      },
    };
  });

  app.get('/onchain/networks/:network/pools', async (request) => {
    const params = z.object({ network: z.string() }).parse(request.params);
    const query = poolListQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const orderBy = resolvePoolOrder(query.sort);

    const rows = database.db
      .select()
      .from(onchainPools)
      .where(eq(onchainPools.networkId, params.network))
      .orderBy(...orderBy)
      .all();

    const start = (page - 1) * perPage;

    return {
      data: rows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/:network/dexes/:dex/pools', async (request) => {
    const params = z.object({ network: z.string(), dex: z.string() }).parse(request.params);
    const query = poolListQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const dex = database.db
      .select()
      .from(onchainDexes)
      .where(and(eq(onchainDexes.networkId, params.network), eq(onchainDexes.id, params.dex)))
      .limit(1)
      .get();

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
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const rows = database.db
      .select()
      .from(onchainPools)
      .where(eq(onchainPools.networkId, params.network))
      .orderBy(desc(onchainPools.createdAtTimestamp), desc(onchainPools.updatedAt))
      .all();

    const start = (page - 1) * perPage;

    return {
      data: rows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/:network/pools/multi/:addresses', async (request) => {
    const params = z.object({ network: z.string(), addresses: z.string() }).parse(request.params);
    const query = poolMultiQuerySchema.parse(request.query);
    const includes = parsePoolIncludes(query.include);
    const requestedAddresses = [...new Set(params.addresses
      .split(',')
      .map((address) => address.trim())
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

    const row = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, params.address)))
      .limit(1)
      .get();

    if (!row) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${params.address}`);
    }

    const included = buildIncludedResources(includes, [row], database);

    return {
      data: buildPoolResource(row, {
        includeVolumeBreakdown,
        includeComposition,
      }),
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

    return {
      data: buildTokenResource(params.network, params.address, tokenPools, {
        includeInactiveSource,
        includeComposition,
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

      tokenPrices[address] = formatMetricValue(tokenResource.attributes.price_usd);

      if (includeMarketCap) {
        marketCaps[address] = formatMetricValue(snapshot?.marketCap ?? tokenPools[0]?.reserveUsd ?? null);
      }

      if (include24hrVol) {
        volumes24h[address] = formatMetricValue(tokenPools.reduce((sum, pool) => sum + (pool.volume24hUsd ?? 0), 0));
      }

      if (include24hrPriceChange) {
        priceChanges24h[address] = formatMetricValue(snapshot?.priceChangePercentage24h ?? 0);
      }

      if (includeTotalReserveInUsd) {
        totalReserveInUsd[address] = formatMetricValue(tokenPools.reduce((sum, pool) => sum + (pool.reserveUsd ?? 0), 0));
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

    return {
      data: buildTokenInfoResource(params.network, params.address, tokenPools),
    };
  });

  app.get('/onchain/networks/:network/pools/:address/info', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = poolInfoQuerySchema.parse(request.query);
    const includes = parsePoolInfoIncludes(query.include);
    const row = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, params.address)))
      .limit(1)
      .get();

    if (!row) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${params.address}`);
    }

    const tokenInfos = [
      buildTokenInfoResource(params.network, row.baseTokenAddress, collectTokenPools(params.network, row.baseTokenAddress, database)),
      buildTokenInfoResource(params.network, row.quoteTokenAddress, collectTokenPools(params.network, row.quoteTokenAddress, database)),
    ];

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

    const tokenInfos = [...byNetworkAndAddress.entries()]
      .filter(([key]) => !query.network || key.startsWith(`${query.network}:`))
      .map(([key, pools]) => {
        const [networkId, address] = key.split(':');
        return buildTokenInfoResource(networkId!, address!, pools);
      })
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

}
