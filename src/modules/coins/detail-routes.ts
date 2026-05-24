import { sendCacheableJson } from '../../http/cache';
import { HttpError } from '../../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt } from '../../http/params';
import { getCoinById, getMarketRows } from '../catalog';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, getUsableSnapshot } from '../market-freshness';
import {
  buildCoinDetail,
  getCoinTickers,
  getHistorySnapshot,
  getRequiredCoin,
} from './detail';
import { parseDexPairFormat, parseHistoryDate } from './helpers';
import { COIN_AUXILIARY_HTTP_CACHE_POLICY, COIN_DETAIL_HTTP_CACHE_POLICY } from './http-policies';
import {
  coinDetailQuerySchema,
  coinHistoryQuerySchema,
  coinIdParamsSchema,
  coinTickersQuerySchema,
} from './query-schemas';
import type { CoinsRouteContext } from './route-context';

export function registerCoinDetailRoutes({
  app,
  database,
  marketFreshnessThresholdSeconds,
  runtimeState,
}: CoinsRouteContext) {
  app.get('/coins/:id', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = coinDetailQuerySchema.parse(request.query);
    parseDexPairFormat(query.dex_pair_format);
    const row = getMarketRows(database, 'usd', { ids: [params.id], status: 'all' })[0];
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);

    if (!row) {
      throw new HttpError(404, 'not_found', `Coin not found: ${params.id}`);
    }

    const payload = buildCoinDetail(database, row.coin, getUsableSnapshot(getEffectiveSnapshot(row.snapshot, runtimeState), marketFreshnessThresholdSeconds, snapshotAccessPolicy), marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
      includeLocalization: parseBooleanQuery(query.localization, true),
      includeMarketData: parseBooleanQuery(query.market_data, true),
      includeTickers: parseBooleanQuery(query.tickers, true),
      includeCommunityData: parseBooleanQuery(query.community_data, true),
      includeDeveloperData: parseBooleanQuery(query.developer_data, true),
      includeSparkline: parseBooleanQuery(query.sparkline, false),
      includeCategoriesDetails: parseBooleanQuery(query.include_categories_details, false),
    });

    return sendCacheableJson(request, reply, payload, COIN_DETAIL_HTTP_CACHE_POLICY);
  });

  app.get('/coins/:id/history', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = coinHistoryQuerySchema.parse(request.query);
    const coin = getCoinById(database, params.id);

    if (!coin) {
      throw new HttpError(404, 'not_found', `Coin not found: ${params.id}`);
    }

    const historicalSnapshot = getHistorySnapshot(database, coin.id, parseHistoryDate(query.date));

    return sendCacheableJson(request, reply, buildCoinDetail(database, coin, historicalSnapshot, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), {
      includeLocalization: parseBooleanQuery(query.localization, true),
      includeMarketData: true,
      includeTickers: false,
      includeCommunityData: false,
      includeDeveloperData: false,
      includeSparkline: false,
      includeCategoriesDetails: false,
    }), COIN_AUXILIARY_HTTP_CACHE_POLICY);
  });

  app.get('/coins/:id/tickers', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = coinTickersQuerySchema.parse(request.query);
    const coin = getRequiredCoin(database, params.id);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 100);
    const tickerPayload = getCoinTickers(database, params.id, {
      exchangeIds: parseCsvQuery(query.exchange_ids),
      includeExchangeLogo: parseBooleanQuery(query.include_exchange_logo, false),
      includeDepth: parseBooleanQuery(query.depth, false),
      dexPairFormat: parseDexPairFormat(query.dex_pair_format),
      page,
      perPage,
      order: query.order,
      marketFreshnessThresholdSeconds,
      snapshotAccessPolicy: getSnapshotAccessPolicy(runtimeState),
    });

    return sendCacheableJson(request, reply, {
      name: coin.name,
      tickers: tickerPayload.tickers,
    }, COIN_AUXILIARY_HTTP_CACHE_POLICY);
  });
}
