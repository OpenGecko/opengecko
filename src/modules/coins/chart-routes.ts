import { sendCacheableJson } from '../../http/cache';
import { parsePrecision } from '../../http/params';
import { getConversionRate } from '../../lib/conversion';
import { getSnapshotAccessPolicy } from '../market-freshness';
import {
  buildChartPayload,
  getCanonicalChartRowsForDays,
  getCanonicalChartRowsForRange,
  getCanonicalOhlcRowsForDays,
  getCanonicalOhlcRowsForRange,
  getSourceBackedChartRowsForDays,
  getSourceBackedChartRowsForRange,
  getSourceBackedOhlcRowsForDays,
  getSourceBackedOhlcRowsForRange,
  parseChartRange,
  parseExplicitRange,
} from './charts';
import { getRequiredCoin } from './detail';
import { toNumberOrNull } from './helpers';
import { HISTORICAL_CHART_HTTP_CACHE_POLICY } from './http-policies';
import { coinChartQuerySchema, coinChartRangeQuerySchema, coinIdParamsSchema } from './query-schemas';
import type { CoinsRouteContext } from './route-context';

export function registerCoinChartRoutes({
  app,
  database,
  marketFreshnessThresholdSeconds,
  runtimeState,
  chartResponseSources,
}: CoinsRouteContext) {
  app.get('/coins/:id/market_chart', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = coinChartQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const vsCurrency = query.vs_currency.toLowerCase();
    const sourceRows = getSourceBackedChartRowsForDays(database, params.id, query.days, query.interval);
    const canonicalRows = sourceRows.length > 0
      ? []
      : getCanonicalChartRowsForDays(database, params.id, query.days, query.interval);
    const rows = sourceRows.length > 0
      ? sourceRows
      : canonicalRows.length > 0
        ? canonicalRows
        : [];
    const responseSource = sourceRows.length > 0
      ? 'source_backed'
      : canonicalRows.length > 0
        ? 'canonical'
        : 'empty';
    chartResponseSources.record('market_chart_days', responseSource, {
      coinId: params.id,
      vsCurrency,
      interval: query.interval ?? null,
      request: { kind: 'days', days: query.days },
    });

    return sendCacheableJson(
      request,
      reply,
      buildChartPayload(database, params.id, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision)),
      HISTORICAL_CHART_HTTP_CACHE_POLICY,
    );
  });

  app.get('/coins/:id/market_chart/range', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = coinChartRangeQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const vsCurrency = query.vs_currency.toLowerCase();
    const range = parseExplicitRange(query);
    const sourceRows = getSourceBackedChartRowsForRange(database, params.id, range, query.interval);
    const canonicalRows = sourceRows.length > 0
      ? []
      : getCanonicalChartRowsForRange(database, params.id, range, query.interval);
    const rows = sourceRows.length > 0
      ? sourceRows
      : canonicalRows.length > 0
        ? canonicalRows
        : [];
    const responseSource = sourceRows.length > 0
      ? 'source_backed'
      : canonicalRows.length > 0
        ? 'canonical'
        : 'empty';
    chartResponseSources.record('market_chart_range', responseSource, {
      coinId: params.id,
      vsCurrency,
      interval: query.interval ?? null,
      request: { kind: 'range', from: range.from, to: range.to },
    });

    return sendCacheableJson(
      request,
      reply,
      buildChartPayload(database, params.id, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision)),
      HISTORICAL_CHART_HTTP_CACHE_POLICY,
    );
  });

  app.get('/coins/:id/ohlc', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = coinChartQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const precision = parsePrecision(query.precision);
    const vsCurrency = query.vs_currency.toLowerCase();
    const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState));
    const sourceRows = getSourceBackedOhlcRowsForDays(database, params.id, query.days, query.interval);
    const canonicalRows = sourceRows.length > 0
      ? []
      : getCanonicalOhlcRowsForDays(database, params.id, query.days, query.interval);
    const rows = sourceRows.length > 0
      ? sourceRows
      : canonicalRows;
    const responseSource = sourceRows.length > 0
      ? 'source_backed'
      : canonicalRows.length > 0
        ? 'canonical'
        : 'empty';
    chartResponseSources.record('ohlc_days', responseSource, {
      coinId: params.id,
      vsCurrency,
      interval: query.interval ?? null,
      request: { kind: 'days', days: query.days },
    });

    const payload = rows.map((row) => {
      const open = toNumberOrNull(row.open * rate, precision);
      const high = toNumberOrNull(row.high * rate, precision);
      const low = toNumberOrNull(row.low * rate, precision);
      const close = toNumberOrNull(row.close * rate, precision);

      return [row.timestamp.getTime(), open, high, low, close];
    });

    return sendCacheableJson(request, reply, payload, HISTORICAL_CHART_HTTP_CACHE_POLICY);
  });

  app.get('/coins/:id/ohlc/range', async (request, reply) => {
    const params = coinIdParamsSchema.parse(request.params);
    const query = coinChartRangeQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const precision = parsePrecision(query.precision);
    const vsCurrency = query.vs_currency.toLowerCase();
    const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState));
    const range = parseChartRange(query);
    const sourceRows = getSourceBackedOhlcRowsForRange(database, params.id, range, query.interval);
    const canonicalRows = sourceRows.length > 0
      ? []
      : getCanonicalOhlcRowsForRange(database, params.id, range, query.interval);
    const rows = sourceRows.length > 0
      ? sourceRows
      : canonicalRows.length > 0
        ? canonicalRows
        : [];
    const responseSource = sourceRows.length > 0
      ? 'source_backed'
      : canonicalRows.length > 0
        ? 'canonical'
        : 'empty';
    chartResponseSources.record('ohlc_range', responseSource, {
      coinId: params.id,
      vsCurrency,
      interval: query.interval ?? null,
      request: { kind: 'range', from: range.from, to: range.to },
    });

    const payload = rows.map((row) => {
      const open = toNumberOrNull(row.open * rate, precision);
      const high = toNumberOrNull(row.high * rate, precision);
      const low = toNumberOrNull(row.low * rate, precision);
      const close = toNumberOrNull(row.close * rate, precision);

      return [row.timestamp.getTime(), open, high, low, close];
    });

    return sendCacheableJson(request, reply, payload, HISTORICAL_CHART_HTTP_CACHE_POLICY);
  });
}
