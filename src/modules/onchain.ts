import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { onchainDexes, onchainNetworks, onchainPools } from '../db/schema';
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
}
