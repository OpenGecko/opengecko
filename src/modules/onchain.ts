import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { marketSnapshots, onchainNetworks, onchainPools } from '../db/schema';
import { sendCacheableJson } from '../http/cache';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parsePositiveInt } from '../http/params';
import { fetchDefillamaTokens } from '../providers/defillama';
import { resolveAddressLabel } from '../providers/sqd';
import {
  readOnchainHoldersChart,
  readOnchainHoldersChartSourceKind,
  readOnchainTokenHolders,
  readOnchainTokenHolderSourceKind,
  readOnchainTokenTraders,
  readOnchainTokenTraderSourceKind,
} from '../services/onchain-analytics-ingestion';
import { readOnchainPoolOhlcvSeries } from '../services/onchain-ohlcv-ingestion';
import { readOnchainPoolTrades, readOnchainTokenTrades } from '../services/onchain-trade-ingestion';
import {
  buildPaginationMeta,
  formatMetricValue,
  isValidOnchainAddress,
  normalizeAddress,
  parseAnalyticsCount,
  parseHoldersChartDays,
  parseMegafilterIncludes,
  parseMegafilterSort,
  parseOnchainAddressList,
  parseOnchainCategoryPoolSort,
  parseOnchainCategorySort,
  parseOnchainOhlcvTimeframe,
  parseOptionalFiniteNumber,
  parseOptionalPositiveInteger,
  parseOptionalTimestamp,
  parsePoolIncludes,
  parsePoolInfoIncludes,
  parseRecentlyUpdatedTokenInfoIncludes,
  parseTokenIncludes,
  parseTopHoldersIncludes,
  parseTopTraderSort,
  parseTradeVolumeThreshold,
  parseTrendingDuration,
} from './onchain/helpers';
import {
  buildDexResource,
  buildIncludedResources,
  buildLiveOnchainCatalog,
  buildMegafilterIncludedResources,
  buildMegafilterRow,
  buildNetworkResource,
  buildOnchainCategoryResource,
  buildOnchainCategorySummaries,
  buildPoolDiscoveryRows,
  buildPoolResource,
  buildTopHoldersIncludedResources,
  collectTokenPools,
  getSeededOnchainDex,
  getSeededOnchainNetwork,
  getSeededOnchainPool,
  getPoolsForOnchainCategory,
  parseMegafilterDexes,
  parseMegafilterNetworks,
  parseTrendingSearchCandidates,
  patchPoolRow,
  resolvePoolOrder,
  searchPoolRows,
  sortMegafilterRows,
  sortOnchainCategoryPools,
  sortOnchainCategorySummaries,
} from './onchain/pools';
import {
  aggregatePoolSeriesForToken,
  buildSyntheticPoolOhlcvSeries,
  buildTokenInfoResource,
  buildTokenResource,
  fetchLiveSimpleTokenPrice,
  finalizeOnchainOhlcvSeries,
  findCoinIdForToken,
  resolveTokenCoinId,
} from './onchain/tokens';
import {
  buildHoldersChartFixtures,
  buildHoldersChartResource,
  buildOnchainTradeFixtures,
  buildTopHolderFixtures,
  buildTopHolderResource,
  buildTopTraderFixtures,
  buildTopTraderResource,
  buildTradeResource,
  derivePoolOhlcvFromTrades,
  fetchLivePoolTrades,
} from './onchain/trades';
import {
  categoryParamsSchema,
  discoveryPoolsQuerySchema,
  holdersChartQuerySchema,
  megafilterQuerySchema,
  networkAddressParamsSchema,
  networkAddressesParamsSchema,
  networkAddressTimeframeParamsSchema,
  networkDexParamsSchema,
  networkParamsSchema,
  onchainCategoriesQuerySchema,
  onchainCategoryPoolsQuerySchema,
  onchainOhlcvQuerySchema,
  paginationQuerySchema,
  poolDetailQuerySchema,
  poolInfoQuerySchema,
  poolListQuerySchema,
  poolMultiQuerySchema,
  recentlyUpdatedTokenInfoQuerySchema,
  searchPoolsQuerySchema,
  simpleTokenPriceQuerySchema,
  tokenDetailQuerySchema,
  tokenMultiQuerySchema,
  topHoldersQuerySchema,
  topTradersQuerySchema,
  tradesQuerySchema,
  trendingPoolsQuerySchema,
  trendingSearchQuerySchema,
} from './onchain/query-schemas';
import { getOnchainNetwork, requireOnchainNetwork } from './onchain/route-helpers';

export function registerOnchainRoutes(app: FastifyInstance, database: AppDatabase) {
  const ONCHAIN_HTTP_CACHE_POLICY = {
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 60,
  };
  const ONCHAIN_LIVE_HTTP_CACHE_POLICY = {
    maxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 30,
  };
  const latestPoolUpdatedAt = (rows: Array<{ updatedAt: Date }>) =>
    rows.reduce<Date | null>((latest, row) =>
      latest === null || row.updatedAt.getTime() > latest.getTime() ? row.updatedAt : latest, null);
  const buildOnchainSourceMeta = (options: {
    source: 'live' | 'seeded' | 'fixture' | 'replay';
    updatedAt?: Date | null;
    extra?: Record<string, unknown>;
  }) => ({
    fixture: options.source === 'seeded' || options.source === 'fixture',
    source: options.source,
    updated_at: options.updatedAt?.toISOString() ?? null,
    ...options.extra,
  });
  const latestTradeUpdatedAt = (trades: Array<{ id: string; sourceFetchedAt?: Date | null }>) =>
    trades.reduce<Date | null>((latest, trade) =>
      trade.sourceFetchedAt && (latest === null || trade.sourceFetchedAt.getTime() > latest.getTime())
        ? trade.sourceFetchedAt
        : latest, null);

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

  app.get('/onchain/networks/:network/tokens/multi/:addresses', async (request, reply) => {
    const params = networkAddressesParamsSchema.parse(request.params);
    const query = tokenMultiQuerySchema.parse(request.query);
    const includes = parseTokenIncludes(query.include);
    const requestedAddresses = [...new Set(params.addresses
      .split(',')
      .map((address) => normalizeAddress(address))
      .filter((address) => address.length > 0))];

    requireOnchainNetwork(database, params.network);

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

    return sendCacheableJson(request, reply, {
      data: tokenRows,
      ...(included.length > 0 ? { included } : {}),
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address/pools', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, params.address, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${normalizeAddress(params.address)}`);
    }

    const start = (page - 1) * perPage;

    return sendCacheableJson(request, reply, {
      data: tokenPools.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        token_address: normalizeAddress(params.address),
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = tokenDetailQuerySchema.parse(request.query);
    const includes = parseTokenIncludes(query.include);
    const includeInactiveSource = parseBooleanQuery(query.include_inactive_source, false);
    const includeComposition = parseBooleanQuery(query.include_composition, false);

    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, params.address, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${normalizeAddress(params.address)}`);
    }

    const livePrice = await fetchLiveSimpleTokenPrice(params.network, normalizeAddress(params.address), tokenPools, database);
    const tokenResource = buildTokenResource(params.network, params.address, tokenPools, {
      includeInactiveSource,
      includeComposition,
      livePriceUsd: livePrice?.priceUsd ?? null,
    });

    if (params.network === 'eth') {
      const liveTokens = await fetchDefillamaTokens('Ethereum');
      if (liveTokens) {
        const tokenData = liveTokens.find((t) => normalizeAddress(t.address) === normalizeAddress(params.address));
        if (tokenData) {
          tokenResource.attributes.decimals = tokenData.decimals;
          tokenResource.attributes.price_usd = tokenData.priceUsd;
        }
      }
    }

    return sendCacheableJson(request, reply, {
      data: tokenResource,
      meta: buildOnchainSourceMeta({
        source: livePrice ? 'live' : 'seeded',
        updatedAt: latestPoolUpdatedAt(tokenPools),
        extra: {
          network: params.network,
          token_address: normalizeAddress(params.address),
        },
      }),
      ...(includes.includes('top_pools')
        ? { included: tokenPools.map((row) => buildPoolResource(row)) }
        : {}),
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/simple/networks/:network/token_price/:addresses', async (request, reply) => {
    const params = networkAddressesParamsSchema.parse(request.params);
    const query = simpleTokenPriceQuerySchema.parse(request.query);
    const network = requireOnchainNetwork(database, params.network);

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

    return sendCacheableJson(request, reply, {
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
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address/info', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, params.address, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${normalizeAddress(params.address)}`);
    }

    const livePrice = await fetchLiveSimpleTokenPrice(params.network, normalizeAddress(params.address), tokenPools, database);
    const coinId = resolveTokenCoinId(params.network, normalizeAddress(params.address), tokenPools);

    return sendCacheableJson(request, reply, {
      data: buildTokenInfoResource(params.network, params.address, tokenPools, {
        livePriceUsd: livePrice?.priceUsd ?? null,
        coinId,
      }),
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/pools/:address/info', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
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

    return sendCacheableJson(request, reply, {
      data: tokenInfos,
      ...(includes.includes('pool') ? { included: [buildPoolResource(row)] } : {}),
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/tokens/info_recently_updated', async (request, reply) => {
    const query = recentlyUpdatedTokenInfoQuerySchema.parse(request.query);
    const includes = parseRecentlyUpdatedTokenInfoIncludes(query.include);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    if (query.network) {
      requireOnchainNetwork(database, query.network, {
        statusCode: 400,
        code: 'invalid_parameter',
        message: `Unknown onchain network: ${query.network}`,
      });
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
          .map((networkId) => getOnchainNetwork(database, networkId))
          .filter((row): row is typeof onchainNetworks.$inferSelect => row !== undefined)
          .map((row) => buildNetworkResource(row))
      : [];

    return sendCacheableJson(request, reply, {
      data: paged,
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address/top_holders', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = topHoldersQuerySchema.parse(request.query);
    const includePnlDetails = parseBooleanQuery(query.include_pnl_details, false);
    const includes = parseTopHoldersIncludes(query.include);
    const holders = parseAnalyticsCount(query.holders, 'holders', 3);
    const tokenAddress = normalizeAddress(params.address);

    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const sourceHolders = readOnchainTokenHolders(database, params.network, tokenAddress);
    const holdersSource = readOnchainTokenHolderSourceKind(database, params.network, tokenAddress) ?? 'fixture';
    const holdersRows = (sourceHolders.length > 0 ? sourceHolders : buildTopHolderFixtures(params.network, tokenAddress))
      .sort((left, right) => right.balance - left.balance || right.shareOfSupply - left.shareOfSupply || left.address.localeCompare(right.address))
      .slice(0, holders);
    const included = buildTopHoldersIncludedResources(includes, params.network, tokenAddress, tokenPools, database);

    return sendCacheableJson(request, reply, {
      data: holdersRows.map((holder) => buildTopHolderResource(holder, includePnlDetails)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        fixture: holdersSource !== 'live',
        degraded: true,
        out_of_scope: true,
        network: params.network,
        token_address: tokenAddress,
        holders,
        include_pnl_details: includePnlDetails,
        scope: holdersSource === 'fixture'
          ? 'out-of-scope analytics fixture for USDC only'
          : 'out-of-scope source-attributed token analytics, not live-complete',
        source: holdersSource,
        note: holdersSource === 'live'
          ? 'Holder data is source-attributed live provider data for a narrow analytics slice; the surface remains out-of-scope for live-complete coverage'
          : holdersSource === 'replay'
            ? 'Holder data is source-attributed replay, not live; the surface remains out-of-scope for live-complete coverage'
            : 'Holder data is seeded fixture for USDC only; all other tokens return empty arrays and the surface remains out-of-scope',
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address/top_traders', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = topTradersQuerySchema.parse(request.query);
    const includeAddressLabel = parseBooleanQuery(query.include_address_label, false);
    const traders = parseAnalyticsCount(query.traders, 'traders', 3);
    const sort = parseTopTraderSort(query.sort);
    const tokenAddress = normalizeAddress(params.address);

    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const sourceTraders = readOnchainTokenTraders(database, params.network, tokenAddress);
    const tradersSource = readOnchainTokenTraderSourceKind(database, params.network, tokenAddress) ?? 'fixture';
    const tradersRows = (sourceTraders.length > 0 ? sourceTraders : buildTopTraderFixtures(params.network, tokenAddress))
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

    return sendCacheableJson(request, reply, {
      data: tradersRows.map((trader) => buildTopTraderResource(trader, includeAddressLabel)),
      meta: {
        fixture: tradersSource !== 'live',
        degraded: true,
        out_of_scope: true,
        network: params.network,
        token_address: tokenAddress,
        traders,
        sort,
        include_address_label: includeAddressLabel,
        scope: tradersSource === 'fixture'
          ? 'out-of-scope analytics fixture for USDC only'
          : 'out-of-scope source-attributed token analytics, not live-complete',
        source: tradersSource,
        note: tradersSource === 'live'
          ? 'Trader data is source-attributed live provider data for a narrow analytics slice; the surface remains out-of-scope for live-complete coverage'
          : tradersSource === 'replay'
            ? 'Trader data is source-attributed replay, not live; the surface remains out-of-scope for live-complete coverage'
            : 'Trader data is seeded fixture for USDC only; all other tokens return empty arrays and the surface remains out-of-scope',
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address/holders_chart', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = holdersChartQuerySchema.parse(request.query);
    const days = parseHoldersChartDays(query.days);
    const tokenAddress = normalizeAddress(params.address);

    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const sourceSeries = readOnchainHoldersChart(database, params.network, tokenAddress);
    const chartSource = readOnchainHoldersChartSourceKind(database, params.network, tokenAddress) ?? 'fixture';
    const fullSeries = (sourceSeries.length > 0 ? sourceSeries : buildHoldersChartFixtures(params.network, tokenAddress))
      .sort((left, right) => left.timestamp - right.timestamp);
    const data = days <= 7 ? fullSeries.slice(-2) : fullSeries;

    return sendCacheableJson(request, reply, {
      data: data.map(buildHoldersChartResource),
      meta: {
        fixture: chartSource !== 'live',
        degraded: true,
        out_of_scope: true,
        network: params.network,
        token_address: tokenAddress,
        days,
        scope: chartSource === 'fixture'
          ? 'out-of-scope analytics fixture for USDC only'
          : 'out-of-scope source-attributed token analytics, not live-complete',
        source: chartSource,
        note: chartSource === 'live'
          ? 'Holders chart data is source-attributed live provider data for a narrow analytics slice; the surface remains out-of-scope for live-complete coverage'
          : chartSource === 'replay'
            ? 'Holders chart data is source-attributed replay, not live; the surface remains out-of-scope for live-complete coverage'
            : 'Holders chart data is seeded fixture for USDC only; all other tokens return empty arrays and the surface remains out-of-scope',
      },
    }, ONCHAIN_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/pools/:address/trades', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = tradesQuerySchema.parse(request.query);
    const threshold = parseTradeVolumeThreshold(query.trade_volume_in_usd_greater_than);
    const limit = parseOptionalPositiveInteger(query.limit, 'limit') ?? 100;
    const beforeTimestamp = parseOptionalTimestamp(query.before_timestamp, 'before_timestamp');
    const normalizedAddress = normalizeAddress(params.address);

    const liveCatalog = await buildLiveOnchainCatalog(database);
    const seededNetwork = getSeededOnchainNetwork(database, params.network)
      ?? liveCatalog.networks.find((row) => row.id === params.network);

    if (!seededNetwork) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const pool = getSeededOnchainPool(database, params.network, normalizedAddress);
    const discoveredPoolPatch = liveCatalog.poolsByAddress.get(normalizedAddress);

    if (!pool && !discoveredPoolPatch) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${normalizedAddress}`);
    }

    const resolvedPool = pool
      ? patchPoolRow(pool, liveCatalog.poolsByAddress.get(pool.address))
      : {
          networkId: params.network,
          address: normalizedAddress,
          dexId: discoveredPoolPatch?.dexId ?? 'unknown',
          name: discoveredPoolPatch?.name ?? normalizedAddress,
          baseTokenAddress: discoveredPoolPatch?.baseTokenAddress ?? normalizedAddress,
          baseTokenSymbol: discoveredPoolPatch?.baseTokenSymbol ?? normalizedAddress.slice(0, 8),
          quoteTokenAddress: discoveredPoolPatch?.quoteTokenAddress ?? normalizedAddress,
          quoteTokenSymbol: discoveredPoolPatch?.quoteTokenSymbol ?? normalizedAddress.slice(0, 8),
          priceUsd: discoveredPoolPatch?.priceUsd ?? null,
          reserveUsd: discoveredPoolPatch?.reserveUsd ?? null,
          volume24hUsd: discoveredPoolPatch?.volume24hUsd ?? null,
          transactions24hBuys: 0,
          transactions24hSells: 0,
          createdAtTimestamp: new Date(0),
          updatedAt: new Date(0),
        };

    let filteredToken: string | null = null;
    if (query.token !== undefined) {
      if (!isValidOnchainAddress(query.token)) {
        throw new HttpError(400, 'invalid_parameter', `Invalid onchain address: ${query.token}`);
      }

      filteredToken = normalizeAddress(query.token);
      const poolTokens = [normalizeAddress(resolvedPool.baseTokenAddress), normalizeAddress(resolvedPool.quoteTokenAddress)];
      if (!poolTokens.includes(filteredToken)) {
        throw new HttpError(400, 'invalid_parameter', `Token is not a constituent of pool: ${filteredToken}`);
      }
    }

    const persistedTrades = readOnchainPoolTrades(database, params.network, normalizedAddress);
    const liveFetchedAt = new Date();
    let liveTrades = null;
    if (persistedTrades.length === 0) {
      try {
        liveTrades = (await fetchLivePoolTrades(resolvedPool))?.map((trade) => ({
          ...trade,
          sourceFetchedAt: liveFetchedAt,
        })) ?? null;
        request.log.info({
          network: params.network,
          pool_address: normalizedAddress,
          live_trade_count: liveTrades?.length ?? 0,
          live_source: liveTrades ? 'live' : 'fixture',
        }, 'resolved onchain pool trades source');
      } catch (error) {
        request.log.error({
          err: error,
          network: params.network,
          pool_address: normalizedAddress,
        }, 'failed to fetch live onchain pool trades');
      }
    }

    const sourceTrades = persistedTrades.length > 0 ? persistedTrades : liveTrades ?? [];
    const tradeSource = liveTrades
      ? 'live'
      : sourceTrades.length > 0
        ? sourceTrades[0]?.source ?? 'replay'
        : 'fixture';
    const trades = (sourceTrades.length > 0 ? sourceTrades : buildOnchainTradeFixtures(database).map((trade) => ({ ...trade, source: 'fixture' as const })))
      .filter((trade) => trade.networkId === params.network && normalizeAddress(trade.poolAddress) === normalizedAddress)
      .filter((trade) => threshold === null || trade.volumeUsd > threshold)
      .filter((trade) => filteredToken === null || trade.tokenAddress === filteredToken)
      .filter((trade) => beforeTimestamp === null || trade.blockTimestamp <= beforeTimestamp)
      .sort((left, right) => right.blockTimestamp - left.blockTimestamp || left.id.localeCompare(right.id))
      .slice(0, limit);

    request.log.info({
      network: params.network,
      pool_address: normalizedAddress,
      response_trade_count: trades.length,
      response_source: tradeSource,
    }, 'sending onchain pool trades response');

    return sendCacheableJson(request, reply, {
      data: trades.map((trade) => buildTradeResource(trade, resolveAddressLabel(trade.poolAddress))),
      meta: buildOnchainSourceMeta({
        source: tradeSource,
        updatedAt: latestTradeUpdatedAt(trades),
        extra: {
          network: params.network,
          pool_address: params.address,
        },
      }),
    }, ONCHAIN_LIVE_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address/trades', async (request, reply) => {
    const params = networkAddressParamsSchema.parse(request.params);
    const query = tradesQuerySchema.parse(request.query);
    const threshold = parseTradeVolumeThreshold(query.trade_volume_in_usd_greater_than);
    const limit = parseOptionalPositiveInteger(query.limit, 'limit') ?? 100;
    const beforeTimestamp = parseOptionalTimestamp(query.before_timestamp, 'before_timestamp');

    requireOnchainNetwork(database, params.network);

    const tokenAddress = normalizeAddress(params.address);
    const tokenPools = collectTokenPools(params.network, tokenAddress, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const poolAddresses = new Set(tokenPools.map((pool) => pool.address));
    const sourceTrades = readOnchainTokenTrades(database, params.network, tokenAddress);
    const tradeSource = sourceTrades.length > 0
      ? sourceTrades[0]?.source ?? 'replay'
      : 'fixture';
    const trades = (sourceTrades.length > 0 ? sourceTrades : buildOnchainTradeFixtures(database).map((trade) => ({ ...trade, source: 'fixture' as const })))
      .filter((trade) => trade.networkId === params.network && trade.tokenAddress === tokenAddress && poolAddresses.has(trade.poolAddress))
      .filter((trade) => threshold === null || trade.volumeUsd > threshold)
      .filter((trade) => beforeTimestamp === null || trade.blockTimestamp <= beforeTimestamp)
      .sort((left, right) => right.blockTimestamp - left.blockTimestamp || left.id.localeCompare(right.id))
      .slice(0, limit);

    return sendCacheableJson(request, reply, {
      data: trades.map((trade) => buildTradeResource(trade, resolveAddressLabel(trade.poolAddress))),
      meta: buildOnchainSourceMeta({
        source: tradeSource,
        updatedAt: latestTradeUpdatedAt(trades),
        extra: {
          network: params.network,
          token_address: tokenAddress,
        },
      }),
    }, ONCHAIN_LIVE_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/pools/:address/ohlcv/:timeframe', async (request, reply) => {
    const params = networkAddressTimeframeParamsSchema.parse(request.params);
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

    let liveTrades = null;
    try {
      liveTrades = await fetchLivePoolTrades(pool);
      request.log.info({
        network: params.network,
        pool_address: normalizedAddress,
        timeframe,
        live_trade_count: liveTrades?.length ?? 0,
        live_source: liveTrades && liveTrades.length > 0 ? 'live' : 'fixture',
      }, 'resolved onchain pool ohlcv trade source');
    } catch (error) {
      request.log.error({
        err: error,
        network: params.network,
        pool_address: normalizedAddress,
        timeframe,
      }, 'failed to fetch live onchain pool trades for ohlcv');
    }
    const sourceSeries = readOnchainPoolOhlcvSeries(
      database,
      pool,
      timeframe,
      aggregate,
      currency as 'usd' | 'token',
      tokenSelection,
    );
    const responseSource = liveTrades && liveTrades.length > 0
      ? 'live'
      : sourceSeries?.source ?? 'fixture';
    const baseSeries = liveTrades && liveTrades.length > 0
      ? derivePoolOhlcvFromTrades(
          liveTrades,
          timeframe,
          aggregate,
          currency as 'usd' | 'token',
          tokenSelection,
          pool,
        )
      : sourceSeries?.series
        ? sourceSeries.series
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

    request.log.info({
      network: params.network,
      pool_address: normalizedAddress,
      timeframe,
      response_point_count: baseSeries.length,
      response_source: responseSource,
    }, 'sending onchain pool ohlcv response');

    return sendCacheableJson(request, reply, {
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
          source: responseSource,
        },
      },
    }, ONCHAIN_LIVE_HTTP_CACHE_POLICY);
  });

  app.get('/onchain/networks/:network/tokens/:address/ohlcv/:timeframe', async (request, reply) => {
    const params = networkAddressTimeframeParamsSchema.parse(request.params);
    const query = onchainOhlcvQuerySchema.parse(request.query);
    const timeframe = parseOnchainOhlcvTimeframe(params.timeframe);
    const aggregate = parseOptionalPositiveInteger(query.aggregate, 'aggregate') ?? 1;
    const limit = parseOptionalPositiveInteger(query.limit, 'limit') ?? 100;
    const beforeTimestamp = parseOptionalTimestamp(query.before_timestamp, 'before_timestamp');
    const includeEmptyIntervals = parseBooleanQuery(query.include_empty_intervals, false);
    const includeInactiveSource = parseBooleanQuery(query.include_inactive_source, false);
    const tokenAddress = normalizeAddress(params.address);

    requireOnchainNetwork(database, params.network);

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const aggregatedSeries = await aggregatePoolSeriesForToken(
      database,
      tokenPools,
      timeframe,
      aggregate,
      tokenAddress,
      includeInactiveSource,
    );

    return sendCacheableJson(request, reply, {
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
    }, ONCHAIN_LIVE_HTTP_CACHE_POLICY);
  });
}
