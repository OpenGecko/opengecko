import { sendCacheableJson } from '../../http/cache';
import { HttpError } from '../../http/errors';
import { parseBooleanQuery, parsePrecision } from '../../http/params';
import { getCoinByContract, getMarketRows } from '../catalog';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, getUsableSnapshot } from '../market-freshness';
import {
  buildChartPayload,
  getChartRowsForDays,
  getChartRowsForRange,
  parseChartRange,
} from './charts';
import { buildCoinDetail } from './detail';
import { parseDexPairFormat } from './helpers';
import { COIN_AUXILIARY_HTTP_CACHE_POLICY, HISTORICAL_CHART_HTTP_CACHE_POLICY } from './http-policies';
import {
  coinChartQuerySchema,
  coinChartRangeQuerySchema,
  coinContractParamsSchema,
  coinDetailQuerySchema,
} from './query-schemas';
import type { CoinsRouteContext } from './route-context';

export function registerCoinContractRoutes({
  app,
  database,
  marketFreshnessThresholdSeconds,
  runtimeState,
}: CoinsRouteContext) {
  app.get('/coins/:platform_id/contract/:contract_address', async (request, reply) => {
    const params = coinContractParamsSchema.parse(request.params);
    const query = coinDetailQuerySchema.parse(request.query);
    parseDexPairFormat(query.dex_pair_format);
    const coin = getCoinByContract(database, params.platform_id, params.contract_address);

    if (!coin) {
      throw new HttpError(404, 'not_found', `Contract not found: ${params.contract_address}`);
    }

    const marketRow = getMarketRows(database, 'usd', { ids: [coin.id] })[0] ?? { coin, snapshot: null };
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);

    return sendCacheableJson(request, reply, buildCoinDetail(database, marketRow.coin, getUsableSnapshot(getEffectiveSnapshot(marketRow.snapshot, runtimeState), marketFreshnessThresholdSeconds, snapshotAccessPolicy), marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
      includeLocalization: parseBooleanQuery(query.localization, true),
      includeMarketData: parseBooleanQuery(query.market_data, true),
      includeTickers: parseBooleanQuery(query.tickers, true),
      includeCommunityData: parseBooleanQuery(query.community_data, true),
      includeDeveloperData: parseBooleanQuery(query.developer_data, true),
      includeSparkline: parseBooleanQuery(query.sparkline, false),
      includeCategoriesDetails: parseBooleanQuery(query.include_categories_details, false),
    }), COIN_AUXILIARY_HTTP_CACHE_POLICY);
  });

  app.get('/coins/:platform_id/contract/:contract_address/market_chart', async (request, reply) => {
    const params = coinContractParamsSchema.parse(request.params);
    const query = coinChartQuerySchema.parse(request.query);
    const coin = getCoinByContract(database, params.platform_id, params.contract_address);

    if (!coin) {
      throw new HttpError(404, 'not_found', `Contract not found: ${params.contract_address}`);
    }

    const vsCurrency = query.vs_currency.toLowerCase();
    const rows = getChartRowsForDays(database, coin.id, query.days, query.interval);

    return sendCacheableJson(
      request,
      reply,
      buildChartPayload(database, coin.id, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision)),
      HISTORICAL_CHART_HTTP_CACHE_POLICY,
    );
  });

  app.get('/coins/:platform_id/contract/:contract_address/market_chart/range', async (request, reply) => {
    const params = coinContractParamsSchema.parse(request.params);
    const query = coinChartRangeQuerySchema.parse(request.query);
    const coin = getCoinByContract(database, params.platform_id, params.contract_address);

    if (!coin) {
      throw new HttpError(404, 'not_found', `Contract not found: ${params.contract_address}`);
    }

    const vsCurrency = query.vs_currency.toLowerCase();
    const rows = getChartRowsForRange(database, coin.id, parseChartRange(query), query.interval);

    return sendCacheableJson(
      request,
      reply,
      buildChartPayload(database, coin.id, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision)),
      HISTORICAL_CHART_HTTP_CACHE_POLICY,
    );
  });
}
