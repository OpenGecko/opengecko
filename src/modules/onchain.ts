import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { onchainDexes, onchainNetworks } from '../db/schema';
import { HttpError } from '../http/errors';
import { parsePositiveInt } from '../http/params';

const paginationQuerySchema = z.object({
  page: z.string().optional(),
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
}
