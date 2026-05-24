import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { AppDatabase } from '../../db/client';
import { onchainPools } from '../../db/schema';
import { sendCacheableJson } from '../../http/cache';
import { HttpError } from '../../http/errors';
import { parseBooleanQuery, parsePositiveInt } from '../../http/params';
import {
  buildPaginationMeta,
  normalizeAddress,
  parseMegafilterIncludes,
  parseMegafilterSort,
  parseOnchainCategoryPoolSort,
  parseOnchainCategorySort,
  parseOptionalFiniteNumber,
  parsePoolIncludes,
  parseTrendingDuration,
} from './helpers';
import { buildOnchainSourceMeta, latestPoolUpdatedAt, ONCHAIN_HTTP_CACHE_POLICY } from './meta';
import {
  buildIncludedResources,
  buildLiveOnchainCatalog,
  buildMegafilterIncludedResources,
  buildMegafilterRow,
  buildOnchainCategoryResource,
  buildOnchainCategorySummaries,
  buildPoolDiscoveryRows,
  buildPoolResource,
  getPoolsForOnchainCategory,
  getSeededOnchainDex,
  getSeededOnchainNetwork,
  getSeededOnchainPool,
  parseMegafilterDexes,
  parseMegafilterNetworks,
  parseTrendingSearchCandidates,
  patchPoolRow,
  resolvePoolOrder,
  searchPoolRows,
  sortMegafilterRows,
  sortOnchainCategoryPools,
  sortOnchainCategorySummaries,
} from './pools';
import {
  categoryParamsSchema,
  discoveryPoolsQuerySchema,
  megafilterQuerySchema,
  networkAddressParamsSchema,
  networkAddressesParamsSchema,
  networkDexParamsSchema,
  networkParamsSchema,
  onchainCategoriesQuerySchema,
  onchainCategoryPoolsQuerySchema,
  poolDetailQuerySchema,
  poolListQuerySchema,
  poolMultiQuerySchema,
  searchPoolsQuerySchema,
  trendingPoolsQuerySchema,
  trendingSearchQuerySchema,
} from './query-schemas';
import { requireOnchainNetwork } from './route-helpers';

export function registerOnchainPoolRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/onchain/networks/:network/pools', async (request, reply) => {
    const params = networkParamsSchema.parse(request.params);
    const query = poolListQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const liveCatalog = await buildLiveOnchainCatalog(database);
    const seededNetwork = getSeededOnchainNetwork(database, params.network)
      ?? liveCatalog.networks.find((row) => row.id === params.network);

    if (!seededNetwork) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const orderBy = resolvePoolOrder(query.sort);

    const seededRows = database.db
      .select()
      .from(onchainPools)
      .where(eq(onchainPools.networkId, params.network))
      .orderBy(...orderBy)
      .all()
      .map((row) => patchPoolRow(row, liveCatalog.poolsByAddress.get(row.address)));

    const seededAddresses = new Set(seededRows.map((row) => row.address));
    const now = new Date();
    const discoveredRows = [...liveCatalog.poolsByAddress.entries()]
      .filter(([address, patch]) =>
        !seededAddresses.has(address)
        && patch.source === 'live'
        && patch.networkId === params.network
        && patch.baseTokenAddress
        && patch.quoteTokenAddress,
      )
      .map(([address, patch]) => ({
        networkId: params.network,
        address,
        dexId: patch.dexId ?? 'unknown',
        name: patch.name ?? address.slice(0, 8),
        baseTokenAddress: patch.baseTokenAddress!,
        baseTokenSymbol: patch.baseTokenSymbol ?? patch.baseTokenAddress!.slice(0, 8),
        quoteTokenAddress: patch.quoteTokenAddress!,
        quoteTokenSymbol: patch.quoteTokenSymbol ?? patch.quoteTokenAddress!.slice(0, 8),
        priceUsd: patch.priceUsd,
        reserveUsd: patch.reserveUsd,
        volume24hUsd: patch.volume24hUsd,
        transactions24hBuys: 0,
        transactions24hSells: 0,
        createdAtTimestamp: null,
        updatedAt: now,
      }));

    const allRows = [...seededRows, ...discoveredRows];

    const start = (page - 1) * perPage;

    return sendCacheableJson(request, reply, {
      data: allRows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: buildOnchainSourceMeta({
        source: liveCatalog.poolsByAddress.size === 0 || params.network !== 'eth' ? 'seeded' : 'live',
        updatedAt: latestPoolUpdatedAt(seededRows),
        extra: {
        page,
        data_source: liveCatalog.poolsByAddress.size === 0 || params.network !== 'eth' ? 'seeded' : 'live',
        },
      }),
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/dexes/:dex/pools', async (request, reply) => {
    const params = networkDexParamsSchema.parse(request.params);
    const query = poolListQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    const network = getSeededOnchainNetwork(database, params.network);

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const liveCatalog = await buildLiveOnchainCatalog(database);

    const dex = getSeededOnchainDex(database, params.network, params.dex)
      ?? liveCatalog.dexes.find((entry) => entry.networkId === params.network && entry.id === params.dex);

    if (!dex) {
      throw new HttpError(404, 'not_found', `Onchain dex not found: ${params.dex}`);
    }

    const orderBy = resolvePoolOrder(query.sort);

    const seededRows = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.dexId, params.dex)))
      .orderBy(...orderBy)
      .all()
      .map((row) => patchPoolRow(row, liveCatalog.poolsByAddress.get(row.address)));

    const seededAddresses = new Set(seededRows.map((row) => row.address));
    const now = new Date();
    const discoveredRows = [...liveCatalog.poolsByAddress.entries()]
      .filter(([address, patch]) =>
        !seededAddresses.has(address)
        && patch.source === 'live'
        && patch.networkId === params.network
        && patch.dexId === params.dex
        && patch.baseTokenAddress
        && patch.quoteTokenAddress,
      )
      .map(([address, patch]) => ({
        networkId: params.network,
        address,
        dexId: patch.dexId ?? params.dex,
        name: patch.name ?? address.slice(0, 8),
        baseTokenAddress: patch.baseTokenAddress!,
        baseTokenSymbol: patch.baseTokenSymbol ?? patch.baseTokenAddress!.slice(0, 8),
        quoteTokenAddress: patch.quoteTokenAddress!,
        quoteTokenSymbol: patch.quoteTokenSymbol ?? patch.quoteTokenAddress!.slice(0, 8),
        priceUsd: patch.priceUsd,
        reserveUsd: patch.reserveUsd,
        volume24hUsd: patch.volume24hUsd,
        transactions24hBuys: 0,
        transactions24hSells: 0,
        createdAtTimestamp: null,
        updatedAt: now,
      }));

    const allRows = [...seededRows, ...discoveredRows];

    const start = (page - 1) * perPage;

    return sendCacheableJson(request, reply, {
      data: allRows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: buildOnchainSourceMeta({
        source: liveCatalog.poolsByAddress.size === 0 || params.network !== 'eth' ? 'seeded' : 'live',
        updatedAt: latestPoolUpdatedAt(seededRows),
        extra: {
        page,
        dex: dex.id,
        data_source: liveCatalog.poolsByAddress.size === 0 || params.network !== 'eth' ? 'seeded' : 'live',
        },
      }),
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/new_pools', async (request, reply) => {
    const params = networkParamsSchema.parse(request.params);
    const query = discoveryPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);

    requireOnchainNetwork(database, params.network);

    const rows = buildPoolDiscoveryRows(database.db
      .select()
      .from(onchainPools)
      .where(eq(onchainPools.networkId, params.network))
      .all(), { mode: 'new' });

    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return sendCacheableJson(request, reply, {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/new_pools', async (request, reply) => {
    const query = discoveryPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);
    const rows = buildPoolDiscoveryRows(database.db.select().from(onchainPools).all(), { mode: 'new' });
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return sendCacheableJson(request, reply, {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/trending_pools', async (request, reply) => {
    const query = trendingPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);
    const duration = parseTrendingDuration(query.duration);
    const rows = buildPoolDiscoveryRows(database.db.select().from(onchainPools).all(), { mode: 'trending', duration });
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return sendCacheableJson(request, reply, {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
        duration,
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/trending_pools', async (request, reply) => {
    const params = networkParamsSchema.parse(request.params);
    const query = trendingPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);
    const duration = parseTrendingDuration(query.duration);

    const network = requireOnchainNetwork(database, params.network);

    const rows = buildPoolDiscoveryRows(
      database.db.select().from(onchainPools).where(eq(onchainPools.networkId, params.network)).all(),
      { mode: 'trending', duration },
    );
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return sendCacheableJson(request, reply, {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
        duration,
        network: network.id,
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/search/pools', async (request, reply) => {
    const query = searchPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const rawQuery = query.query?.trim() ?? '';

    let rows = database.db.select().from(onchainPools).all();

    if (query.network !== undefined) {
      requireOnchainNetwork(database, query.network, {
        statusCode: 400,
        code: 'invalid_parameter',
        message: `Unknown onchain network: ${query.network}`,
      });
      rows = rows.filter((row) => row.networkId === query.network);
    }

    const matchedRows = rawQuery.length === 0 ? [] : searchPoolRows(rows, rawQuery);
    const start = (page - 1) * perPage;

    return sendCacheableJson(request, reply, {
      data: matchedRows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        query: rawQuery,
        ...(query.network !== undefined ? { network: query.network } : {}),
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });


  app.get('/onchain/pools/megafilter', async (request, reply) => {
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

    return sendCacheableJson(request, reply, {
      data: pagedRows.map((row) => buildMegafilterRow(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        ...buildPaginationMeta(page, perPage, sortedRows.length),
        fixture: true,
        degraded: true,
        out_of_scope: true,
        scope: 'out-of-scope analytics approximation; not promoted as live-complete',
        source: 'seeded',
        note: 'Megafilter is an out-of-scope analytics surface backed by seeded pool rows and must not be treated as live-complete.',
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
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/pools/trending_search', async (request, reply) => {
    const query = trendingSearchQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = parsePositiveInt(query.per_page, 100);
    const rankedRows = buildPoolDiscoveryRows(database.db.select().from(onchainPools).all(), {
      mode: 'trending',
      duration: '24h',
    });
    const subset = parseTrendingSearchCandidates(query.pools, rankedRows);
    const start = (page - 1) * perPage;

    return sendCacheableJson(request, reply, {
      data: subset.rows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        per_page: perPage,
        candidate_count: subset.candidateCount,
        ...(subset.ignoredCandidates.length > 0 ? { ignored_candidates: subset.ignoredCandidates } : {}),
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/categories', async (request, reply) => {
    const query = onchainCategoriesQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 1;
    const sort = parseOnchainCategorySort(query.sort);
    const rows = sortOnchainCategorySummaries(
      [...buildOnchainCategorySummaries(database).values()],
      sort,
    );
    const start = (page - 1) * perPage;

    return sendCacheableJson(request, reply, {
      data: rows.slice(start, start + perPage).map(buildOnchainCategoryResource),
      meta: {
        ...buildPaginationMeta(page, perPage, rows.length),
        sort,
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/categories/:categoryId/pools', async (request, reply) => {
    const params = categoryParamsSchema.parse(request.params);
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

    return sendCacheableJson(request, reply, {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        ...buildPaginationMeta(page, perPage, rows.length),
        sort,
        category_id: params.categoryId,
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/pools/multi/:addresses', async (request, reply) => {
    const params = networkAddressesParamsSchema.parse(request.params);
    const query = poolMultiQuerySchema.parse(request.query);
    const includes = parsePoolIncludes(query.include);
    const requestedAddresses = [...new Set(params.addresses
      .split(',')
      .map((address) => normalizeAddress(address))
      .filter((address) => address.length > 0))];

    if (requestedAddresses.length === 0) {
      return sendCacheableJson(request, reply, {
        data: [],
        ...(includes.length > 0 ? { included: [] } : {}),
      }, ONCHAIN_HTTP_CACHE_POLICY);
    }

    requireOnchainNetwork(database, params.network);

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

    return sendCacheableJson(request, reply, {
      data: orderedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/pools/:address', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = poolDetailQuerySchema.parse(request.query);
    const includes = parsePoolIncludes(query.include);
    const includeVolumeBreakdown = parseBooleanQuery(query.include_volume_breakdown, false);
    const includeComposition = parseBooleanQuery(query.include_composition, false);
    const normalizedAddress = normalizeAddress(params.address);
    const liveCatalog = await buildLiveOnchainCatalog(database);
    const seededNetwork = getSeededOnchainNetwork(database, params.network)
      ?? liveCatalog.networks.find((row) => row.id === params.network);

    if (!seededNetwork) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const row = getSeededOnchainPool(database, params.network, normalizedAddress);

    if (!row) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${normalizedAddress}`);
    }

    const patchedRow = patchPoolRow(row, liveCatalog.poolsByAddress.get(row.address));
    const included = buildIncludedResources(includes, [patchedRow], database);

    return sendCacheableJson(request, reply, {
      data: buildPoolResource(patchedRow, {
        includeVolumeBreakdown,
        includeComposition,
      }),
      meta: buildOnchainSourceMeta({
        source: liveCatalog.degraded || params.network !== 'eth' ? 'seeded' : 'live',
        updatedAt: patchedRow.updatedAt,
        extra: {
        data_source: liveCatalog.degraded || params.network !== 'eth' ? 'seeded' : 'live',
        },
      }),
      ...(included.length > 0 ? { included } : {}),
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

}
