import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { sendCacheableJson } from '../http/cache';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt, parsePrecision } from '../http/params';
import { getConversionRate } from '../lib/conversion';
import type { ChartResponseSourceDiagnostics } from '../services/chart-response-source-diagnostics';
import { getEndpointFreshnessBudget } from '../services/freshness-budgets';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import {
  readSupplyChartRowsForDays,
  readSupplyChartRowsForRange,
  type SupplyType,
} from '../services/supply-chart-ingestion';
import { getCategories, getCoinByContract, getCoinById, getCoins, getMarketRows, parseJsonArray } from './catalog';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, getUsableSnapshot } from './market-freshness';
import {
  buildChartPayload,
  fetchProviderChartRowsForDays,
  fetchProviderChartRowsForRange,
  fetchProviderOhlcRowsForDays,
  fetchProviderOhlcRowsForRange,
  getChartRowsForDays,
  getChartRowsForRange,
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
} from './coins/charts';
import {
  buildCoinDetail,
  getCoinTickers,
  getHistorySnapshot,
  getRequiredCoin,
} from './coins/detail';
import {
  buildMarketRow,
  buildMoverRow,
  cloneCoinMarketsResponse,
  COINS_MARKETS_CACHE_TTL_MS,
  createCoinMarketsCacheKey,
  getSeriesChangePercentageForWindow,
  parseMarketRowsRequest,
  type CoinMarketsCacheEntry,
} from './coins/market-data';
import { getSnapshotOwnership } from '../services/market-snapshots';
import {
  buildNewListingRow,
  parseChartInterval,
  parseDexPairFormat,
  parseHistoryDate,
  parseMoverDuration,
  parseMoverPriceChangePercentage,
  parsePlatforms,
  parseTopCoinsLimit,
  sortNumber,
  toNumberOrNull,
} from './coins/helpers';

const coinsListQuerySchema = z.object({
  include_platform: z.enum(['true', 'false']).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
});

const COINS_MARKETS_FRESHNESS_BUDGET = getEndpointFreshnessBudget('coins_markets');
const COINS_MARKETS_HTTP_CACHE_MAX_AGE_SECONDS = Math.min(
  COINS_MARKETS_CACHE_TTL_MS / 1_000,
  COINS_MARKETS_FRESHNESS_BUDGET?.target_freshness_seconds ?? COINS_MARKETS_CACHE_TTL_MS / 1_000,
);
const COINS_MARKETS_HTTP_CACHE_POLICY = {
  maxAgeSeconds: COINS_MARKETS_HTTP_CACHE_MAX_AGE_SECONDS,
  staleWhileRevalidateSeconds: COINS_MARKETS_HTTP_CACHE_MAX_AGE_SECONDS,
};
const COIN_DETAIL_FRESHNESS_BUDGET = getEndpointFreshnessBudget('coin_detail');
const COIN_DETAIL_HTTP_CACHE_MAX_AGE_SECONDS = Math.min(
  60,
  COIN_DETAIL_FRESHNESS_BUDGET?.target_freshness_seconds ?? 60,
);
const COIN_DETAIL_HTTP_CACHE_POLICY = {
  maxAgeSeconds: COIN_DETAIL_HTTP_CACHE_MAX_AGE_SECONDS,
  staleWhileRevalidateSeconds: COIN_DETAIL_HTTP_CACHE_MAX_AGE_SECONDS,
};
const HISTORICAL_CHART_HTTP_CACHE_POLICY = {
  maxAgeSeconds: 60,
  staleWhileRevalidateSeconds: 60,
};
const COIN_AUXILIARY_HTTP_CACHE_POLICY = {
  maxAgeSeconds: 60,
  staleWhileRevalidateSeconds: 60,
};

const coinMarketsQuerySchema = z.object({
  vs_currency: z.string(),
  ids: z.string().optional(),
  names: z.string().optional(),
  symbols: z.string().optional(),
  category: z.string().optional(),
  order: z.string().optional(),
  per_page: z.string().optional(),
  page: z.string().optional(),
  price_change_percentage: z.string().optional(),
  sparkline: z.enum(['true', 'false']).optional(),
  precision: z.string().optional(),
});

const coinDetailQuerySchema = z.object({
  localization: z.enum(['true', 'false']).optional(),
  tickers: z.enum(['true', 'false']).optional(),
  market_data: z.enum(['true', 'false']).optional(),
  community_data: z.enum(['true', 'false']).optional(),
  developer_data: z.enum(['true', 'false']).optional(),
  sparkline: z.enum(['true', 'false']).optional(),
  include_categories_details: z.enum(['true', 'false']).optional(),
  dex_pair_format: z.string().optional(),
});

const coinHistoryQuerySchema = z.object({
  date: z.string(),
  localization: z.enum(['true', 'false']).optional(),
});

const coinChartQuerySchema = z.object({
  vs_currency: z.string(),
  days: z.string(),
  interval: z.string().optional(),
  precision: z.string().optional(),
});

const coinChartRangeQuerySchema = z.object({
  vs_currency: z.string(),
  from: z.string(),
  to: z.string(),
  interval: z.string().optional(),
  precision: z.string().optional(),
});

const supplyChartQuerySchema = z.object({
  days: z.string(),
  interval: z.string().optional(),
});

const supplyChartRangeQuerySchema = z.object({
  from: z.string(),
  to: z.string(),
});

const categoriesQuerySchema = z.object({
  order: z.string().optional(),
});

const coinTickersQuerySchema = z.object({
  exchange_ids: z.string().optional(),
  include_exchange_logo: z.enum(['true', 'false']).optional(),
  per_page: z.string().optional(),
  page: z.string().optional(),
  order: z.string().optional(),
});

const topGainersLosersQuerySchema = z.object({
  vs_currency: z.string(),
  duration: z.string().optional(),
  top_coins: z.string().optional(),
  price_change_percentage: z.string().optional(),
});

function sortCategories(
  rows: ReturnType<typeof getCategories>,
  order: string | undefined,
) {
  const normalizedOrder = (order ?? 'market_cap_desc').toLowerCase();
  const sortableRows = [...rows];

  switch (normalizedOrder) {
    case 'market_cap_desc':
      return sortableRows.sort((left, right) => sortNumber(right.marketCap, -1) - sortNumber(left.marketCap, -1));
    case 'market_cap_asc':
      return sortableRows.sort((left, right) => sortNumber(left.marketCap, Number.MAX_SAFE_INTEGER) - sortNumber(right.marketCap, Number.MAX_SAFE_INTEGER));
    case 'volume_desc':
      return sortableRows.sort((left, right) => sortNumber(right.volume24h, -1) - sortNumber(left.volume24h, -1));
    case 'volume_asc':
      return sortableRows.sort((left, right) => sortNumber(left.volume24h, Number.MAX_SAFE_INTEGER) - sortNumber(right.volume24h, Number.MAX_SAFE_INTEGER));
    case 'name_asc':
      return sortableRows.sort((left, right) => left.name.localeCompare(right.name));
    case 'name_desc':
      return sortableRows.sort((left, right) => right.name.localeCompare(left.name));
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported order value: ${order}`);
  }
}

const SEEDED_CATEGORY_TIMESTAMP_MS = Date.parse('2026-03-20T00:00:00.000Z');

function categoriesAreLiveAggregated(rows: ReturnType<typeof getCategories>) {
  return rows.some((category) => category.updatedAt.getTime() > SEEDED_CATEGORY_TIMESTAMP_MS);
}

function buildFixtureAwareMeta(options: {
  fixture: boolean;
  countKey: string;
  count: number;
  updatedAt: Date | null;
  fixtureNote: string;
  liveNote: string;
}) {
  return {
    fixture: options.fixture,
    [options.countKey]: options.count,
    source: options.fixture ? 'fixture' : 'live',
    updated_at: options.updatedAt?.toISOString() ?? null,
    note: options.fixture ? options.fixtureNote : options.liveNote,
  };
}

function buildMoverMeta(options: {
  rankedUniverse: Array<{ snapshot: ReturnType<typeof getUsableSnapshot> }>;
  durationDays: number;
  requestedWindows: string[];
  topCoinsLimit: number;
  moverCount: number;
}) {
  const snapshots = options.rankedUniverse
    .map((entry) => entry.snapshot)
    .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
  const liveSnapshotCount = snapshots.filter((snapshot) => getSnapshotOwnership(snapshot) === 'live').length;
  const fallbackSnapshotCount = options.rankedUniverse.length - liveSnapshotCount;
  const missingSnapshotCount = options.rankedUniverse.length - snapshots.length;
  const updatedAt = snapshots.reduce<Date | null>((latest, snapshot) =>
    latest === null || snapshot.lastUpdated.getTime() > latest.getTime() ? snapshot.lastUpdated : latest, null);
  const snapshotSource = options.rankedUniverse.length === 0
    ? 'empty'
    : liveSnapshotCount === options.rankedUniverse.length
      ? 'live'
      : liveSnapshotCount > 0
        ? 'mixed'
        : 'fixture';
  const fixture = snapshotSource !== 'live';

  return {
    fixture,
    source: 'market_snapshots',
    snapshot_source: snapshotSource,
    fallback: fixture,
    live_snapshot_count: liveSnapshotCount,
    fallback_snapshot_count: fallbackSnapshotCount,
    missing_snapshot_count: missingSnapshotCount,
    candidate_count: options.rankedUniverse.length,
    mover_count: options.moverCount,
    top_coins: options.topCoinsLimit,
    duration: options.durationDays === 1 ? '24h' : `${options.durationDays}d`,
    price_change_percentage: options.requestedWindows,
    updated_at: updatedAt?.toISOString() ?? null,
    note: fixture
      ? 'Top gainers/losers are computed from current market snapshots with fixture or fallback snapshot rows explicitly marked.'
      : 'Top gainers/losers are computed from current live market snapshots.',
  };
}

function buildCategoryTopCoinFields(database: AppDatabase, topCoinIds: string[]) {
  const coinById = new Map(getCoins(database, { status: 'all' }).map((coin) => [coin.id, coin]));
  const topCoinImages = topCoinIds.map((coinId) => {
    const coin = coinById.get(coinId);

    return coin?.imageSmallUrl ?? coin?.imageThumbUrl ?? coin?.imageLargeUrl ?? coinId;
  });

  return {
    top_3_coins: topCoinImages,
    top_3_coins_id: topCoinIds,
  };
}

function buildSupplyChartResponse(
  coinId: string,
  supplyType: SupplyType,
  rows: ReturnType<typeof readSupplyChartRowsForDays>,
  fallbackNote: string,
) {
  if (rows.length === 0) {
    return {
      data: [],
      meta: {
        fixture: true,
        coin_id: coinId,
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
      source_providers: sourceProviders,
    },
  };
}

export function registerCoinRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
  chartResponseSources: ChartResponseSourceDiagnostics,
) {
  const coinMarketsCache = new Map<string, CoinMarketsCacheEntry>();

  app.get('/coins/list', async (request, reply) => {
    const query = coinsListQuerySchema.parse(request.query);
    const includePlatforms = parseBooleanQuery(query.include_platform, false);
    const rows = getCoins(database, { status: query.status ?? 'active' });

    const payload = rows.map((row) => {
      const payload = {
        id: row.id,
        symbol: row.symbol,
        name: row.name,
      };

      if (!includePlatforms) {
        return payload;
      }

      return {
        ...payload,
        platforms: parsePlatforms(row.platformsJson),
      };
    });

    return sendCacheableJson(request, reply, payload, {
      maxAgeSeconds: 3_600,
      staleWhileRevalidateSeconds: 3_600,
    });
  });

  app.get('/coins/markets', async (request, reply) => {
    const query = coinMarketsQuerySchema.parse(request.query);
    const cacheKey = createCoinMarketsCacheKey(query);
    const cached = coinMarketsCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.revision === runtimeState.hotDataRevision && cached.expiresAt > now) {
      app.metrics.recordCacheHit('coins_markets');
      return sendCacheableJson(
        request,
        reply,
        cloneCoinMarketsResponse(cached.value),
        COINS_MARKETS_HTTP_CACHE_POLICY,
      );
    }

    app.metrics.recordCacheMiss('coins_markets');

    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const precision = parsePrecision(query.precision);
    const sparkline = parseBooleanQuery(query.sparkline, false);
    const vsCurrency = query.vs_currency.toLowerCase();
    const priceChangePercentages = parseCsvQuery(query.price_change_percentage).map((value) => value.toLowerCase());
    const { snapshotAccessPolicy, rows } = parseMarketRowsRequest(database, runtimeState, marketFreshnessThresholdSeconds, query);
    const shouldBypassPageSliceForExplicitSelector = [
      query.ids,
      query.names,
      query.symbols,
    ].some((value) => parseCsvQuery(value).length > 0);
    const start = (page - 1) * perPage;

    const pagedRows = shouldBypassPageSliceForExplicitSelector
      ? rows
      : rows.slice(start, start + perPage);

    const payload = pagedRows.map((row) => buildMarketRow(database, row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, runtimeState, {
      sparkline,
      precision,
      priceChangePercentages,
    }));

    coinMarketsCache.set(cacheKey, {
      value: cloneCoinMarketsResponse(payload),
      expiresAt: now + COINS_MARKETS_CACHE_TTL_MS,
      revision: runtimeState.hotDataRevision,
    });

    return sendCacheableJson(request, reply, payload, COINS_MARKETS_HTTP_CACHE_POLICY);
  });

  app.get('/coins/top_gainers_losers', async (request, reply) => {
    const query = topGainersLosersQuerySchema.parse(request.query);
    const vsCurrency = query.vs_currency.toLowerCase();
    const duration = parseMoverDuration(query.duration);
    const requestedWindows = Array.from(new Set([...parseMoverPriceChangePercentage(query.price_change_percentage), duration.days === 1 ? '24h' : `${duration.days}d`]));
    const topCoinsLimit = parseTopCoinsLimit(query.top_coins);
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
    const rankedUniverse = getMarketRows(database, 'usd', { status: 'active' })
      .map((row) => ({
        coin: row.coin,
        snapshot: getUsableSnapshot(row.snapshot, marketFreshnessThresholdSeconds, snapshotAccessPolicy),
      }))
      .sort((left, right) => {
        const leftRank = left.snapshot?.marketCapRank ?? left.coin.marketCapRank ?? Number.MAX_SAFE_INTEGER;
        const rightRank = right.snapshot?.marketCapRank ?? right.coin.marketCapRank ?? Number.MAX_SAFE_INTEGER;

        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }

        return left.coin.id.localeCompare(right.coin.id);
      })
      .slice(0, Math.min(topCoinsLimit, 250));

    const movers = rankedUniverse
      .map((row) => ({
        row,
        change: getSeriesChangePercentageForWindow(
          database,
          row.coin.id,
          vsCurrency,
          marketFreshnessThresholdSeconds,
          snapshotAccessPolicy,
          duration.days,
        ),
      }))
      .filter((entry) => entry.change !== null);

    const topGainers = movers
      .filter((entry) => (entry.change ?? 0) > 0)
      .sort((left, right) => (right.change ?? Number.NEGATIVE_INFINITY) - (left.change ?? Number.NEGATIVE_INFINITY))
      .slice(0, 30)
      .map((entry) => buildMoverRow(database, entry.row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, runtimeState, duration.days, requestedWindows));

    const topLosers = movers
      .filter((entry) => (entry.change ?? 0) < 0)
      .sort((left, right) => (left.change ?? Number.POSITIVE_INFINITY) - (right.change ?? Number.POSITIVE_INFINITY))
      .slice(0, 30)
      .map((entry) => buildMoverRow(database, entry.row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, runtimeState, duration.days, requestedWindows));

    return sendCacheableJson(request, reply, {
      top_gainers: topGainers,
      top_losers: topLosers,
      meta: buildMoverMeta({
        rankedUniverse,
        durationDays: duration.days,
        requestedWindows,
        topCoinsLimit,
        moverCount: topGainers.length + topLosers.length,
      }),
    }, COIN_AUXILIARY_HTTP_CACHE_POLICY);
  });

  app.get('/coins/list/new', async (request, reply) => {
    const rows = getCoins(database, { status: 'active' })
      .slice()
      .sort((left, right) => {
        const rightActivatedAt = right.activatedAt ?? right.createdAt;
        const leftActivatedAt = left.activatedAt ?? left.createdAt;
        const timeDelta = rightActivatedAt.getTime() - leftActivatedAt.getTime();

        if (timeDelta !== 0) {
          return timeDelta;
        }

        return left.id.localeCompare(right.id);
      });

    return sendCacheableJson(request, reply, {
      coins: rows.map(buildNewListingRow),
      meta: {
        fixture: false,
        source: 'catalog',
        updated_at: rows.reduce<Date | null>((latest, row) => {
          const rowUpdatedAt = row.updatedAt ?? row.activatedAt ?? row.createdAt;
          return latest === null || rowUpdatedAt.getTime() > latest.getTime() ? rowUpdatedAt : latest;
        }, null)?.toISOString() ?? null,
        coin_count: rows.length,
        note: 'Coin listings are sourced from the persisted catalog and scheduler rescans',
      },
    }, COIN_AUXILIARY_HTTP_CACHE_POLICY);
  });

  app.get('/coins/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
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
    const params = z.object({ id: z.string() }).parse(request.params);
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
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinTickersQuerySchema.parse(request.query);
    const coin = getRequiredCoin(database, params.id);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 100);
    const tickerPayload = getCoinTickers(database, params.id, {
      exchangeIds: parseCsvQuery(query.exchange_ids),
      includeExchangeLogo: parseBooleanQuery(query.include_exchange_logo, false),
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

  app.get('/coins/:id/market_chart', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinChartQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const vsCurrency = query.vs_currency.toLowerCase();
    const sourceRows = getSourceBackedChartRowsForDays(database, params.id, query.days, query.interval);
    const canonicalRows = sourceRows.length > 0
      ? []
      : getCanonicalChartRowsForDays(database, params.id, query.days, query.interval);
    const providerRows = sourceRows.length > 0 || canonicalRows.length > 0
      ? null
      : await fetchProviderChartRowsForDays(database, params.id, query.days, query.interval);
    const rows = sourceRows.length > 0
      ? sourceRows
      : canonicalRows.length > 0
        ? canonicalRows
        : providerRows ?? [];
    const responseSource = sourceRows.length > 0
      ? 'source_backed'
      : canonicalRows.length > 0
        ? 'canonical'
        : providerRows && providerRows.length > 0
          ? 'provider_filled'
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
      buildChartPayload(database, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision)),
      HISTORICAL_CHART_HTTP_CACHE_POLICY,
    );
  });

  app.get('/coins/:id/market_chart/range', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinChartRangeQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const vsCurrency = query.vs_currency.toLowerCase();
    const range = parseExplicitRange(query);
    const sourceRows = getSourceBackedChartRowsForRange(database, params.id, range, query.interval);
    const canonicalRows = sourceRows.length > 0
      ? []
      : getCanonicalChartRowsForRange(database, params.id, range, query.interval);
    const providerRows = sourceRows.length > 0 || canonicalRows.length > 0
      ? null
      : await fetchProviderChartRowsForRange(database, params.id, range, query.interval);
    const rows = sourceRows.length > 0
      ? sourceRows
      : canonicalRows.length > 0
        ? canonicalRows
        : providerRows ?? [];
    const responseSource = sourceRows.length > 0
      ? 'source_backed'
      : canonicalRows.length > 0
        ? 'canonical'
        : providerRows && providerRows.length > 0
          ? 'provider_filled'
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
      buildChartPayload(database, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision)),
      HISTORICAL_CHART_HTTP_CACHE_POLICY,
    );
  });

  app.get('/coins/:id/ohlc', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinChartQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const precision = parsePrecision(query.precision);
    const vsCurrency = query.vs_currency.toLowerCase();
    const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState));
    const sourceRows = getSourceBackedOhlcRowsForDays(database, params.id, query.days, query.interval);
    const providerRows = sourceRows.length > 0
      ? null
      : await fetchProviderOhlcRowsForDays(database, params.id, query.days, query.interval);
    const canonicalRows = sourceRows.length > 0 || providerRows
      ? []
      : getCanonicalOhlcRowsForDays(database, params.id, query.days, query.interval);
    const rows = sourceRows.length > 0
      ? sourceRows
      : providerRows ?? canonicalRows;
    const responseSource = sourceRows.length > 0
      ? 'source_backed'
      : providerRows && providerRows.length > 0
        ? 'provider_filled'
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
    const params = z.object({ id: z.string() }).parse(request.params);
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
    const providerRows = sourceRows.length > 0 || canonicalRows.length > 0
      ? null
      : await fetchProviderOhlcRowsForRange(database, params.id, range, query.interval);
    const rows = sourceRows.length > 0
      ? sourceRows
      : canonicalRows.length > 0
        ? canonicalRows
        : providerRows ?? [];
    const responseSource = sourceRows.length > 0
      ? 'source_backed'
      : canonicalRows.length > 0
        ? 'canonical'
        : providerRows && providerRows.length > 0
          ? 'provider_filled'
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

  app.get('/coins/:id/circulating_supply_chart', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
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
    const params = z.object({ id: z.string() }).parse(request.params);
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
    const params = z.object({ id: z.string() }).parse(request.params);
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
    const params = z.object({ id: z.string() }).parse(request.params);
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

  app.get('/coins/categories/list', async (request, reply) => {
    const categories = getCategories(database);

    return sendCacheableJson(request, reply, categories.map((category) => ({
        category_id: category.id,
        name: category.name,
      })), {
      maxAgeSeconds: 3_600,
      staleWhileRevalidateSeconds: 3_600,
    });
  });

  app.get('/coins/categories', async (request, reply) => {
    const query = categoriesQuerySchema.parse(request.query);
    const sorted = sortCategories(getCategories(database), query.order);
    const fixture = !categoriesAreLiveAggregated(sorted);

    return sendCacheableJson(request, reply, {
      data: sorted.map((category) => {
        const topCoinIds = parseJsonArray<string>(category.top3CoinsJson);

        return {
          id: category.id,
          name: category.name,
          market_cap: category.marketCap,
          market_cap_change_24h: category.marketCapChange24h,
          content: category.content,
          ...buildCategoryTopCoinFields(database, topCoinIds),
          volume_24h: category.volume24h,
          updated_at: category.updatedAt.toISOString(),
        };
      }),
      meta: buildFixtureAwareMeta({
        fixture,
        countKey: 'category_count',
        count: sorted.length,
        updatedAt: sorted.reduce<Date | null>((latest, category) =>
          latest === null || category.updatedAt.getTime() > latest.getTime() ? category.updatedAt : latest, null),
        fixtureNote: `Categories data is seeded fixture (${sorted.length} categories)`,
        liveNote: 'Category metrics are computed from persisted market snapshots',
      }),
    }, {
      maxAgeSeconds: 300,
      staleWhileRevalidateSeconds: 300,
    });
  });

  app.get('/coins/:platform_id/contract/:contract_address', async (request, reply) => {
    const params = z.object({ platform_id: z.string(), contract_address: z.string() }).parse(request.params);
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
    const params = z.object({ platform_id: z.string(), contract_address: z.string() }).parse(request.params);
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
      buildChartPayload(database, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision)),
      HISTORICAL_CHART_HTTP_CACHE_POLICY,
    );
  });

  app.get('/coins/:platform_id/contract/:contract_address/market_chart/range', async (request, reply) => {
    const params = z.object({ platform_id: z.string(), contract_address: z.string() }).parse(request.params);
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
      buildChartPayload(database, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision)),
      HISTORICAL_CHART_HTTP_CACHE_POLICY,
    );
  });
}
