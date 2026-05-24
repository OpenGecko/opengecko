import { sendCacheableJson } from '../../http/cache';
import {
  readSupplyChartRowsForDays,
  readSupplyChartRowsForRange,
  type SupplyType,
} from '../../services/supply-chart-ingestion';
import { parseExplicitRange } from './charts';
import { getRequiredCoin } from './detail';
import { parseChartInterval } from './helpers';
import { COIN_AUXILIARY_HTTP_CACHE_POLICY } from './http-policies';
import { coinIdParamsSchema, supplyChartQuerySchema, supplyChartRangeQuerySchema } from './query-schemas';
import type { CoinsRouteContext } from './route-context';

function buildSupplyChartResponse(
  coinId: string,
  supplyType: SupplyType,
  rows: ReturnType<typeof readSupplyChartRowsForDays>,
  fallbackNote: string,
) {
  const latestSourceFetchedAt = rows.reduce<Date | null>((latest, row) => {
    if (!row.sourceFetchedAt) {
      return latest;
    }

    return latest === null || row.sourceFetchedAt.getTime() > latest.getTime() ? row.sourceFetchedAt : latest;
  }, null);

  if (rows.length === 0) {
    return {
      data: [],
      meta: {
        fixture: true,
        coin_id: coinId,
        supply_type: supplyType,
        source: 'empty',
        source_mode: 'empty',
        point_count: 0,
        latest_source_fetched_at: null,
        note: fallbackNote,
      },
    };
  }

  const sourceProviders = [...new Set(rows.map((row) => row.sourceProvider).filter(Boolean))].sort();

  return {
    data: rows.map((row) => [row.timestamp.getTime(), row.value]),
    meta: {
      fixture: false,
      coin_id: coinId,
      supply_type: supplyType,
      source: rows.some((row) => row.sourceKind === 'live') ? 'live' : 'replay',
      source_mode: rows.some((row) => row.sourceKind === 'live') ? 'live' : 'replay',
      source_providers: sourceProviders,
      point_count: rows.length,
      latest_source_fetched_at: latestSourceFetchedAt?.toISOString() ?? null,
    },
  };
}

export function registerCoinSupplyRoutes({ app, database }: CoinsRouteContext) {
  app.get('/coins/:id/circulating_supply_chart', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = supplyChartQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    parseChartInterval(query.interval);
    const rows = readSupplyChartRowsForDays(database, params.id, 'circulating', query.days, query.interval);

    return sendCacheableJson(
      request,
      reply,
      buildSupplyChartResponse(params.id, 'circulating', rows, 'Circulating supply chart data is not available'),
      COIN_AUXILIARY_HTTP_CACHE_POLICY,
    );
  });

  app.get('/coins/:id/circulating_supply_chart/range', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = supplyChartRangeQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const range = parseExplicitRange(query);
    const rows = readSupplyChartRowsForRange(database, params.id, 'circulating', range);

    return sendCacheableJson(
      request,
      reply,
      buildSupplyChartResponse(params.id, 'circulating', rows, 'Circulating supply chart data is not available'),
      COIN_AUXILIARY_HTTP_CACHE_POLICY,
    );
  });

  app.get('/coins/:id/total_supply_chart', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = supplyChartQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    parseChartInterval(query.interval);
    const rows = readSupplyChartRowsForDays(database, params.id, 'total', query.days, query.interval);

    return sendCacheableJson(
      request,
      reply,
      buildSupplyChartResponse(params.id, 'total', rows, 'Total supply chart data is not available'),
      COIN_AUXILIARY_HTTP_CACHE_POLICY,
    );
  });

  app.get('/coins/:id/total_supply_chart/range', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = supplyChartRangeQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const range = parseExplicitRange(query);
    const rows = readSupplyChartRowsForRange(database, params.id, 'total', range);

    return sendCacheableJson(
      request,
      reply,
      buildSupplyChartResponse(params.id, 'total', rows, 'Total supply chart data is not available'),
      COIN_AUXILIARY_HTTP_CACHE_POLICY,
    );
  });
}
