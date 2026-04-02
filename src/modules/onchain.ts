import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { marketSnapshots, onchainDexes, onchainNetworks, onchainPools } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parsePositiveInt } from '../http/params';
import { fetchDefillamaTokens } from '../providers/defillama';
import { resolveAddressLabel } from '../providers/sqd';
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
  scorePoolSearchMatch,
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
  deriveLivePoolTrades,
  derivePoolOhlcvFromTrades,
  fetchLivePoolTrades,
} from './onchain/trades';

const paginationQuerySchema = z.object({
  page: z.string().optional(),
});

const poolListQuerySchema = z.object({
  page: z.string().optional(),
  sort: z.enum(['h24_volume_usd_liquidity_desc', 'h24_tx_count_desc', 'reserve_in_usd_desc']).optional(),
});

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
  limit: z.string().optional(),
  before_timestamp: z.string().optional(),
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

    return {
      data: allRows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
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

    return {
      data: allRows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
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

    return {
      data: tokenResource,
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
        fixture: true,
        network: params.network,
        token_address: tokenAddress,
        holders,
        include_pnl_details: includePnlDetails,
        scope: 'USDC only',
        note: 'Holder data is seeded fixture for USDC only; all other tokens return empty arrays',
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
        fixture: true,
        network: params.network,
        token_address: tokenAddress,
        traders,
        sort,
        include_address_label: includeAddressLabel,
        scope: 'USDC only',
        note: 'Trader data is seeded fixture for USDC only; all other tokens return empty arrays',
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
        fixture: true,
        network: params.network,
        token_address: tokenAddress,
        days,
        scope: 'USDC only',
        note: 'Holders chart data is seeded fixture for USDC only; all other tokens return empty arrays',
      },
    };
  });

  app.get('/onchain/networks/:network/pools/:address/trades', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = tradesQuerySchema.parse(request.query);
    const threshold = parseTradeVolumeThreshold(query.trade_volume_in_usd_greater_than);
    const limit = parseOptionalPositiveInteger(query.limit, 'limit') ?? 100;
    const beforeTimestamp = parseOptionalTimestamp(query.before_timestamp, 'before_timestamp');
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

    let liveTrades = null;
    try {
      liveTrades = await fetchLivePoolTrades(pool);
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
      liveTrades = null;
    }

    const trades = (liveTrades ?? buildOnchainTradeFixtures(database).map((trade) => ({ ...trade, source: 'fixture' as const })))
      .filter((trade) => trade.networkId === params.network && trade.poolAddress === params.address)
      .filter((trade) => threshold === null || trade.volumeUsd > threshold)
      .filter((trade) => filteredToken === null || trade.tokenAddress === filteredToken)
      .filter((trade) => beforeTimestamp === null || trade.blockTimestamp <= beforeTimestamp)
      .sort((left, right) => right.blockTimestamp - left.blockTimestamp || left.id.localeCompare(right.id))
      .slice(0, limit);

    request.log.info({
      network: params.network,
      pool_address: normalizedAddress,
      response_trade_count: trades.length,
      response_source: liveTrades ? 'live' : 'fixture',
    }, 'sending onchain pool trades response');

    return {
      data: trades.map((trade) => buildTradeResource(trade, resolveAddressLabel(trade.poolAddress))),
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
    const limit = parseOptionalPositiveInteger(query.limit, 'limit') ?? 100;
    const beforeTimestamp = parseOptionalTimestamp(query.before_timestamp, 'before_timestamp');

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
      .filter((trade) => beforeTimestamp === null || trade.blockTimestamp <= beforeTimestamp)
      .sort((left, right) => right.blockTimestamp - left.blockTimestamp || left.id.localeCompare(right.id))
      .slice(0, limit);

    return {
      data: trades.map((trade) => buildTradeResource(trade, resolveAddressLabel(trade.poolAddress))),
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

    request.log.info({
      network: params.network,
      pool_address: normalizedAddress,
      timeframe,
      response_point_count: baseSeries.length,
      response_source: liveTrades && liveTrades.length > 0 ? 'live' : 'fixture',
    }, 'sending onchain pool ohlcv response');

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
