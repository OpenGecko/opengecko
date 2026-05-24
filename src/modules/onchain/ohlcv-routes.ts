import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';

import type { AppDatabase } from '../../db/client';
import { onchainPools } from '../../db/schema';
import { sendCacheableJson } from '../../http/cache';
import { HttpError } from '../../http/errors';
import { parseBooleanQuery } from '../../http/params';
import { readOnchainPoolOhlcvSeries } from '../../services/onchain-ohlcv-ingestion';
import {
  isValidOnchainAddress,
  normalizeAddress,
  parseOnchainOhlcvTimeframe,
  parseOptionalPositiveInteger,
  parseOptionalTimestamp,
} from './helpers';
import {
  buildOnchainOhlcvFieldProvenance,
  buildOnchainSourceMeta,
  latestPoolUpdatedAt,
  ONCHAIN_FIXTURE_VERSION,
  ONCHAIN_LIVE_HTTP_CACHE_POLICY,
} from './meta';
import { collectTokenPools } from './pools';
import { networkAddressTimeframeParamsSchema, onchainOhlcvQuerySchema } from './query-schemas';
import { requireOnchainNetwork } from './route-helpers';
import { derivePoolOhlcvFromTrades, fetchLivePoolTrades } from './trades';
import {
  aggregatePoolSeriesForToken,
  buildSyntheticPoolOhlcvSeries,
  finalizeOnchainOhlcvSeries,
} from './tokens';

export function registerOnchainOhlcvRoutes(app: FastifyInstance, database: AppDatabase) {
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

    const liveFetchedAt = new Date();
    let liveTrades = null;
    try {
      liveTrades = (await fetchLivePoolTrades(pool))?.map((trade) => ({
        ...trade,
        sourceFetchedAt: liveFetchedAt,
      })) ?? null;
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
    const finalizedOhlcvList = finalizeOnchainOhlcvSeries(baseSeries, {
      aggregate,
      limit,
      beforeTimestamp,
      includeEmptyIntervals,
      timeframe,
    });

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
          ohlcv_list: finalizedOhlcvList,
          source: responseSource,
          source_mode: responseSource,
        },
      },
      meta: buildOnchainSourceMeta({
        source: responseSource,
        updatedAt: pool.updatedAt,
        latestSourceFetchedAt: responseSource === 'live'
          ? liveFetchedAt
          : sourceSeries?.metadata.latestSourceFetchedAt ?? null,
        sourceIdentifiers: responseSource === 'live'
          ? ['sqd.pool_trades']
          : sourceSeries?.metadata.sourceProviders.length
            ? sourceSeries.metadata.sourceProviders
            : ['opengecko.seed.onchain_ohlcv_fixture'],
        fixtureVersion: responseSource === 'fixture' ? ONCHAIN_FIXTURE_VERSION : null,
        reasonCodes: responseSource === 'live'
          ? []
          : responseSource === 'replay'
            ? ['replay_source', 'paid_indexer_style_ohlcv_not_live_complete']
            : ['synthetic_fixture_fallback', 'paid_indexer_style_ohlcv_unavailable'],
        degradedReason: responseSource === 'live' ? null : 'paid_indexer_style_pool_ohlcv_not_live_complete',
        fallbackReason: responseSource === 'fixture' ? 'synthetic_pool_ohlcv_fallback' : null,
        unavailableReason: responseSource === 'fixture' ? 'no_public_complete_pool_ohlcv_indexer_configured' : null,
        fieldProvenance: buildOnchainOhlcvFieldProvenance(responseSource, {
          nullVolumeCount: sourceSeries?.metadata.nullVolumeCount ?? 0,
          includeEmptyIntervals,
        }),
        extra: {
          network: params.network,
          pool_address: normalizedAddress,
          timeframe,
          aggregate,
          response_point_count: finalizedOhlcvList.length,
          source_point_count: baseSeries.length,
          no_silent_zero_fill: {
            numeric_fields: ['open', 'high', 'low', 'close', 'volume_usd'],
            policy: 'volume zeros only appear for explicit empty intervals or marked synthetic/fixture fallback',
            empty_interval_zero_fill_count: includeEmptyIntervals
              ? finalizedOhlcvList.filter((point) => point.volume_usd === 0).length
              : 0,
            null_source_volume_count: sourceSeries?.metadata.nullVolumeCount ?? 0,
          },
        },
      }),
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
    const sourcePoolProvenance = [...new Map(
      aggregatedSeries
        .flatMap((point) => point.source_pool_provenance)
        .map((entry) => [entry.pool_address, entry]),
    ).values()].sort((left, right) => left.pool_address.localeCompare(right.pool_address));
    const tokenSourceMode = sourcePoolProvenance.some((entry) => entry.source_mode === 'live')
      ? 'live'
      : sourcePoolProvenance.some((entry) => entry.source_mode === 'replay')
        ? 'replay'
        : 'fixture';
    const latestTokenSourceFetchedAt = sourcePoolProvenance.reduce<Date | null>((latest, entry) => {
      const timestamp = entry.latest_source_fetched_at ? new Date(entry.latest_source_fetched_at) : null;
      return timestamp && Number.isFinite(timestamp.getTime()) && (latest === null || timestamp.getTime() > latest.getTime())
        ? timestamp
        : latest;
    }, null);
    const finalizedTokenOhlcvList = finalizeOnchainOhlcvSeries(
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
          ohlcv_list: finalizedTokenOhlcvList,
          source_pools: [...new Set(aggregatedSeries.flatMap((point) => point.source_pools))].sort(),
          source: tokenSourceMode,
          source_mode: tokenSourceMode,
        },
      },
      meta: buildOnchainSourceMeta({
        source: tokenSourceMode,
        updatedAt: latestPoolUpdatedAt(tokenPools),
        latestSourceFetchedAt: latestTokenSourceFetchedAt,
        sourceIdentifiers: [...new Set(sourcePoolProvenance.flatMap((entry) => entry.source_identifiers))].sort(),
        fixtureVersion: tokenSourceMode === 'fixture' ? ONCHAIN_FIXTURE_VERSION : null,
        reasonCodes: tokenSourceMode === 'live'
          ? []
          : tokenSourceMode === 'replay'
            ? ['replay_source', 'paid_indexer_style_token_ohlcv_not_live_complete']
            : ['synthetic_fixture_fallback', 'paid_indexer_style_token_ohlcv_unavailable'],
        degradedReason: tokenSourceMode === 'live' ? null : 'paid_indexer_style_token_ohlcv_not_live_complete',
        fallbackReason: tokenSourceMode === 'fixture' ? 'synthetic_pool_ohlcv_fallback' : null,
        unavailableReason: sourcePoolProvenance.length === 0 ? 'no_source_pools_available' : null,
        fieldProvenance: buildOnchainOhlcvFieldProvenance(tokenSourceMode, {
          nullVolumeCount: sourcePoolProvenance.reduce((sum, entry) => sum + entry.null_volume_count, 0),
          includeEmptyIntervals,
        }),
        extra: {
          network: params.network,
          token_address: tokenAddress,
          timeframe,
          aggregate,
          source_pools_provenance: sourcePoolProvenance,
          response_point_count: finalizedTokenOhlcvList.length,
          no_silent_zero_fill: {
            numeric_fields: ['open', 'high', 'low', 'close', 'volume_usd'],
            policy: 'volume zeros only appear for explicit empty intervals or marked synthetic/fixture fallback',
            empty_interval_zero_fill_count: includeEmptyIntervals
              ? finalizedTokenOhlcvList.filter((point) => point.volume_usd === 0).length
              : 0,
          },
        },
      }),
    }, ONCHAIN_LIVE_HTTP_CACHE_POLICY);
  });
}
