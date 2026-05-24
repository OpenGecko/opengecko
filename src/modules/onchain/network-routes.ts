import type { FastifyInstance } from 'fastify';

import type { AppDatabase } from '../../db/client';
import { sendCacheableJson } from '../../http/cache';
import { HttpError } from '../../http/errors';
import { parsePositiveInt } from '../../http/params';
import { buildPaginationMeta } from './helpers';
import { ONCHAIN_HTTP_CACHE_POLICY } from './meta';
import {
  buildDexResource,
  buildLiveOnchainCatalog,
  buildNetworkResource,
  getSeededOnchainNetwork,
} from './pools';
import { networkParamsSchema, paginationQuerySchema } from './query-schemas';

export function registerOnchainNetworkRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/onchain/networks', async (request, reply) => {
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const liveCatalog = await buildLiveOnchainCatalog(database);
    const rows = liveCatalog.networks;
    const start = (page - 1) * perPage;
    const totalCount = rows.length;

    return sendCacheableJson(request, reply, {
      data: rows.slice(start, start + perPage).map(buildNetworkResource),
      meta: buildPaginationMeta(page, perPage, totalCount),
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/dexes', async (request, reply) => {
    const params = networkParamsSchema.parse(request.params);
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

    return sendCacheableJson(request, reply, {
      data: rows.slice(start, start + perPage).map(buildDexResource),
      meta: {
        ...buildPaginationMeta(page, perPage, totalCount),
        network: seededNetwork.id,
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

}
