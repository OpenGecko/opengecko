import type { FastifyInstance } from 'fastify';

import type { AppDatabase } from '../../db/client';
import { sendCacheableJson } from '../../http/cache';
import { HttpError } from '../../http/errors';
import { resolveAddressLabel } from '../../providers/sqd';
import { readOnchainPoolTrades, readOnchainTokenTrades } from '../../services/onchain-trade-ingestion';
import {
  isValidOnchainAddress,
  normalizeAddress,
  parseOptionalPositiveInteger,
  parseOptionalTimestamp,
  parseTradeVolumeThreshold,
} from './helpers';
import { buildOnchainSourceMeta, latestTradeUpdatedAt, ONCHAIN_LIVE_HTTP_CACHE_POLICY } from './meta';
import {
  buildLiveOnchainCatalog,
  collectTokenPools,
  getSeededOnchainNetwork,
  getSeededOnchainPool,
  patchPoolRow,
} from './pools';
import { networkAddressParamsSchema, tradesQuerySchema } from './query-schemas';
import { requireOnchainNetwork } from './route-helpers';
import { buildOnchainTradeFixtures, buildTradeResource, fetchLivePoolTrades } from './trades';

export function registerOnchainTradeRoutes(app: FastifyInstance, database: AppDatabase) {
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

}
