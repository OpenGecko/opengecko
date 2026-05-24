import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';

import type { AppDatabase } from '../../db/client';
import { marketSnapshots, onchainNetworks, onchainPools } from '../../db/schema';
import { sendCacheableJson } from '../../http/cache';
import { HttpError } from '../../http/errors';
import { parseBooleanQuery, parsePositiveInt } from '../../http/params';
import { fetchDefillamaTokens } from '../../providers/defillama';
import {
  formatMetricValue,
  normalizeAddress,
  parseOnchainAddressList,
  parsePoolInfoIncludes,
  parseRecentlyUpdatedTokenInfoIncludes,
  parseTokenIncludes,
} from './helpers';
import { buildOnchainSourceMeta, latestPoolUpdatedAt, ONCHAIN_HTTP_CACHE_POLICY } from './meta';
import {
  buildNetworkResource,
  buildPoolResource,
  collectTokenPools,
} from './pools';
import {
  networkAddressParamsSchema,
  networkAddressesParamsSchema,
  paginationQuerySchema,
  poolInfoQuerySchema,
  recentlyUpdatedTokenInfoQuerySchema,
  simpleTokenPriceQuerySchema,
  tokenDetailQuerySchema,
  tokenMultiQuerySchema,
} from './query-schemas';
import { getOnchainNetwork, requireOnchainNetwork } from './route-helpers';
import {
  buildTokenInfoResource,
  buildTokenResource,
  fetchLiveSimpleTokenPrice,
  findCoinIdForToken,
  resolveTokenCoinId,
} from './tokens';

export function registerOnchainTokenRoutes(app: FastifyInstance, database: AppDatabase) {
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

}
