import type { FastifyInstance } from 'fastify';
import { asc } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { exchanges } from '../db/schema';
import { sendCacheableJson } from '../http/cache';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt } from '../http/params';
import { parseDexPairFormat } from '../lib/shared';
import {
  getSourceBackedExchangeVolumeChart,
  getSourceBackedExchangeVolumeChartRange,
} from '../services/exchange-volume-ingestion';
import { getEndpointFreshnessBudget } from '../services/freshness-budgets';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import { buildExchangeDetail, buildExchangeSummary, getExchangeOrThrow } from './exchange-detail';
import { getExchangeTickers, getRawExchangeTickerRows } from './exchange-tickers';
import { getExchangeVolumeChart, getExchangeVolumeChartRange } from './exchange-volume';

const exchangesListQuerySchema = z.object({
  status: z.enum(['active', 'inactive', 'all']).optional(),
});

const exchangesQuerySchema = z.object({
  per_page: z.string().optional(),
  page: z.string().optional(),
});

const exchangeDetailQuerySchema = z.object({
  dex_pair_format: z.string().optional(),
});

const exchangeVolumeChartQuerySchema = z.object({
  days: z.string(),
});

const exchangeVolumeRangeQuerySchema = z.object({
  from: z.string(),
  to: z.string(),
});

const exchangeTickersQuerySchema = z.object({
  coin_ids: z.string().optional(),
  include_exchange_logo: z.enum(['true', 'false']).optional(),
  depth: z.enum(['true', 'false']).optional(),
  page: z.string().optional(),
  order: z.string().optional(),
  dex_pair_format: z.string().optional(),
});

const EXCHANGE_FRESHNESS_BUDGET = getEndpointFreshnessBudget('exchanges');
const EXCHANGE_HTTP_CACHE_MAX_AGE_SECONDS = Math.min(
  60,
  EXCHANGE_FRESHNESS_BUDGET?.target_freshness_seconds ?? 60,
);
const EXCHANGE_HTTP_CACHE_POLICY = {
  maxAgeSeconds: EXCHANGE_HTTP_CACHE_MAX_AGE_SECONDS,
  staleWhileRevalidateSeconds: EXCHANGE_HTTP_CACHE_MAX_AGE_SECONDS,
};
const EXCHANGE_VOLUME_CHART_HTTP_CACHE_POLICY = {
  maxAgeSeconds: EXCHANGE_HTTP_CACHE_MAX_AGE_SECONDS,
  staleWhileRevalidateSeconds: EXCHANGE_HTTP_CACHE_MAX_AGE_SECONDS,
};

export function registerExchangeRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
) {
  app.get('/exchanges/list', async (request, reply) => {
    const query = exchangesListQuerySchema.parse(request.query);

    if (query.status === 'inactive') {
      return sendCacheableJson(request, reply, [], {
        maxAgeSeconds: 3_600,
        staleWhileRevalidateSeconds: 3_600,
      });
    }

    const rows = database.db.select().from(exchanges).orderBy(asc(exchanges.id)).all();

    return sendCacheableJson(request, reply, rows.map((row) => ({
      id: row.id,
      name: row.name,
    })), {
      maxAgeSeconds: 3_600,
      staleWhileRevalidateSeconds: 3_600,
    });
  });

  app.get('/exchanges', async (request, reply) => {
    const query = exchangesQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const rows = database.db.select().from(exchanges).orderBy(asc(exchanges.trustScoreRank), asc(exchanges.id)).all();
    const start = (page - 1) * perPage;

    return sendCacheableJson(
      request,
      reply,
      rows.slice(start, start + perPage).map(buildExchangeSummary),
      EXCHANGE_HTTP_CACHE_POLICY,
    );
  });

  app.get('/exchanges/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = exchangeDetailQuerySchema.parse(request.query);
    const dexPairFormat = parseDexPairFormat(query.dex_pair_format);
    const exchange = getExchangeOrThrow(database, params.id);

    const tickers = getExchangeTickers(database, exchange.id, {
      includeExchangeLogo: false,
      includeDepth: false,
      page: 1,
      dexPairFormat,
      marketFreshnessThresholdSeconds,
      runtimeState,
    });

    return sendCacheableJson(request, reply, {
      ...buildExchangeDetail(exchange),
      coins: new Set(getRawExchangeTickerRows(database, exchange.id).map((row) => row.coin_tickers.coinId)).size,
      pairs: getRawExchangeTickerRows(database, exchange.id).length,
      tickers,
    }, EXCHANGE_HTTP_CACHE_POLICY);
  });

  app.get('/exchanges/:id/volume_chart', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = exchangeVolumeChartQuerySchema.parse(request.query);

    const exchange = getExchangeOrThrow(database, params.id);
    const sourceBackedRows = getSourceBackedExchangeVolumeChart(database, exchange.id, query.days);

    return sendCacheableJson(
      request,
      reply,
      sourceBackedRows.length > 0
        ? sourceBackedRows
        : getExchangeVolumeChart(database, exchange.id, query.days),
      EXCHANGE_VOLUME_CHART_HTTP_CACHE_POLICY,
    );
  });

  app.get('/exchanges/:id/volume_chart/range', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = exchangeVolumeRangeQuerySchema.parse(request.query);

    const exchange = getExchangeOrThrow(database, params.id);
    const sourceBackedRows = getSourceBackedExchangeVolumeChartRange(database, exchange.id, query.from, query.to);

    return sendCacheableJson(
      request,
      reply,
      sourceBackedRows.length > 0
        ? sourceBackedRows
        : getExchangeVolumeChartRange(database, exchange.id, query.from, query.to),
      EXCHANGE_VOLUME_CHART_HTTP_CACHE_POLICY,
    );
  });

  app.get('/exchanges/:id/tickers', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = exchangeTickersQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const dexPairFormat = parseDexPairFormat(query.dex_pair_format);
    const exchange = getExchangeOrThrow(database, params.id);

    return sendCacheableJson(request, reply, {
      name: exchange.name,
      tickers: getExchangeTickers(database, exchange.id, {
        coinIds: parseCsvQuery(query.coin_ids),
        includeExchangeLogo: parseBooleanQuery(query.include_exchange_logo, false),
        includeDepth: parseBooleanQuery(query.depth, false),
        page,
        order: query.order,
        dexPairFormat,
        marketFreshnessThresholdSeconds,
        runtimeState,
      }),
    }, EXCHANGE_HTTP_CACHE_POLICY);
  });

}
