import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { onchainDexes, onchainNetworks, onchainPools } from '../db/schema';
import { HttpError } from '../http/errors';
import { parsePositiveInt } from '../http/params';

const paginationQuerySchema = z.object({
  page: z.string().optional(),
});

const poolListQuerySchema = z.object({
  page: z.string().optional(),
  sort: z.enum(['h24_volume_usd_liquidity_desc', 'h24_tx_count_desc', 'reserve_in_usd_desc']).optional(),
});

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

function buildPoolResource(row: typeof onchainPools.$inferSelect) {
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
      volume_usd: {
        h24: row.volume24hUsd,
      },
      transactions: {
        h24: {
          buys: row.transactions24hBuys,
          sells: row.transactions24hSells,
        },
      },
      pool_created_at: row.createdAtTimestamp ? Math.floor(row.createdAtTimestamp.getTime() / 1000) : null,
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

export function registerOnchainRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/onchain/networks', async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const rows = database.db.select().from(onchainNetworks).orderBy(asc(onchainNetworks.name)).all();
    const start = (page - 1) * perPage;

    return {
      data: rows.slice(start, start + perPage).map(buildNetworkResource),
      meta: {
        page,
      },
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

    return {
      data: rows.slice(start, start + perPage).map(buildDexResource),
      meta: {
        page,
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
      data: rows.slice(start, start + perPage).map(buildPoolResource),
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
      data: rows.slice(start, start + perPage).map(buildPoolResource),
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
      data: rows.slice(start, start + perPage).map(buildPoolResource),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/:network/pools/multi/:addresses', async (request) => {
    const params = z.object({ network: z.string(), addresses: z.string() }).parse(request.params);
    const requestedAddresses = params.addresses
      .split(',')
      .map((address) => address.trim())
      .filter((address) => address.length > 0);

    if (requestedAddresses.length === 0) {
      return {
        data: [],
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
      .all();

    return {
      data: rows.map(buildPoolResource),
    };
  });

  app.get('/onchain/networks/:network/pools/:address', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);

    const row = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, params.address)))
      .limit(1)
      .get();

    if (!row) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${params.address}`);
    }

    return {
      data: buildPoolResource(row),
    };
  });
}
