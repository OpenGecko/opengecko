import { asc, desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { coins, marketSnapshots } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt, parsePrecision } from '../http/params';
import { getConversionRate } from '../lib/conversion';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import { getCategories, getCoinByContract, getCoinById, getCoins, getMarketRows, parseJsonArray } from './catalog';
import { getSnapshotAccessPolicy, type SnapshotAccessPolicy, getUsableSnapshot } from './market-freshness';
import {
  buildSupplySeriesRowsFromChart,
  buildChartPayload,
  getChartRowsForDays,
  getChartRowsForRange,
  getOhlcRowsForDays,
  getOhlcRowsForRange,
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
  parseMarketOrder,
  type CoinMarketsCacheEntry,
  type CoinMarketsResponseRow,
} from './coins/market-data';
import {
  buildNewListingRow,
  buildSupplyPayload,
  normalizeCategoryId,
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

const categoriesQuerySchema = z.object({
  order: z.string().optional(),
});

const coinTickersQuerySchema = z.object({
  exchange_ids: z.string().optional(),
  include_exchange_logo: z.enum(['true', 'false']).optional(),
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

export function registerCoinRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
) {
  const coinMarketsCache = new Map<string, CoinMarketsCacheEntry>();

  app.get('/coins/list', async (request) => {
    const query = coinsListQuerySchema.parse(request.query);
    const includePlatforms = parseBooleanQuery(query.include_platform, false);
    const rows = getCoins(database, { status: query.status ?? 'active' });

    return rows.map((row) => {
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
  });

  app.get('/coins/markets', async (request) => {
    const query = coinMarketsQuerySchema.parse(request.query);
    const cacheKey = createCoinMarketsCacheKey(query);
    const cached = coinMarketsCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.revision === runtimeState.hotDataRevision && cached.expiresAt > now) {
      app.metrics.recordCacheHit('coins_markets');
      return cloneCoinMarketsResponse(cached.value);
    }

    app.metrics.recordCacheMiss('coins_markets');

    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const precision = parsePrecision(query.precision);
    const sparkline = parseBooleanQuery(query.sparkline, false);
    const vsCurrency = query.vs_currency.toLowerCase();
    const priceChangePercentages = parseCsvQuery(query.price_change_percentage).map((value) => value.toLowerCase());
    const { snapshotAccessPolicy, rows } = parseMarketRowsRequest(database, runtimeState, marketFreshnessThresholdSeconds, query);
    const start = (page - 1) * perPage;

    const payload = rows.slice(start, start + perPage).map((row) => buildMarketRow(database, row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, runtimeState, {
      sparkline,
      precision,
      priceChangePercentages,
    }));

    coinMarketsCache.set(cacheKey, {
      value: cloneCoinMarketsResponse(payload),
      expiresAt: now + COINS_MARKETS_CACHE_TTL_MS,
      revision: runtimeState.hotDataRevision,
    });

    return payload;
  });

  app.get('/coins/top_gainers_losers', async (request) => {
    const query = topGainersLosersQuerySchema.parse(request.query);
    const vsCurrency = query.vs_currency.toLowerCase();
    const duration = parseMoverDuration(query.duration);
    const requestedWindows = Array.from(new Set([...parseMoverPriceChangePercentage(query.price_change_percentage), duration.days === 1 ? '24h' : `${duration.days}d`]));
    const topCoinsLimit = parseTopCoinsLimit(query.top_coins);
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
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

    return {
      top_gainers: topGainers,
      top_losers: topLosers,
    };
  });

  app.get('/coins/list/new', async () => {
    const rows = getCoins(database, { status: 'active' })
      .slice()
      .sort((left, right) => {
        const timeDelta = right.createdAt.getTime() - left.createdAt.getTime();

        if (timeDelta !== 0) {
          return timeDelta;
        }

        return left.id.localeCompare(right.id);
      });

    return {
      coins: rows.map(buildNewListingRow),
    };
  });

  app.get('/coins/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinDetailQuerySchema.parse(request.query);
    parseDexPairFormat(query.dex_pair_format);
    const row = getMarketRows(database, 'usd', { ids: [params.id], status: 'all' })[0];
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);

    if (!row) {
      throw new HttpError(404, 'not_found', `Coin not found: ${params.id}`);
    }

    return buildCoinDetail(database, row.coin, getUsableSnapshot(row.snapshot, marketFreshnessThresholdSeconds, snapshotAccessPolicy), marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
      includeLocalization: parseBooleanQuery(query.localization, true),
      includeMarketData: parseBooleanQuery(query.market_data, true),
      includeTickers: parseBooleanQuery(query.tickers, true),
      includeCommunityData: parseBooleanQuery(query.community_data, true),
      includeDeveloperData: parseBooleanQuery(query.developer_data, true),
      includeSparkline: parseBooleanQuery(query.sparkline, false),
      includeCategoriesDetails: parseBooleanQuery(query.include_categories_details, false),
    });
  });

  app.get('/coins/:id/history', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinHistoryQuerySchema.parse(request.query);
    const coin = getCoinById(database, params.id);

    if (!coin) {
      throw new HttpError(404, 'not_found', `Coin not found: ${params.id}`);
    }

    const historicalSnapshot = getHistorySnapshot(database, coin.id, parseHistoryDate(query.date));

    return buildCoinDetail(database, coin, historicalSnapshot, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), {
      includeLocalization: parseBooleanQuery(query.localization, true),
      includeMarketData: true,
      includeTickers: false,
      includeCommunityData: false,
      includeDeveloperData: false,
      includeSparkline: false,
      includeCategoriesDetails: false,
    });
  });

  app.get('/coins/:id/tickers', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinTickersQuerySchema.parse(request.query);
    const coin = getRequiredCoin(database, params.id);
    const page = parsePositiveInt(query.page, 1);
    const tickerPayload = getCoinTickers(database, params.id, {
      exchangeIds: parseCsvQuery(query.exchange_ids),
      includeExchangeLogo: parseBooleanQuery(query.include_exchange_logo, false),
      page,
      order: query.order,
      marketFreshnessThresholdSeconds,
      snapshotAccessPolicy: getSnapshotAccessPolicy(runtimeState),
    });

    return {
      name: coin.name,
      tickers: tickerPayload.tickers,
    };
  });

  app.get('/coins/:id/market_chart', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinChartQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const vsCurrency = query.vs_currency.toLowerCase();
    const rows = getChartRowsForDays(database, params.id, query.days, query.interval);

    return buildChartPayload(database, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision));
  });

  app.get('/coins/:id/market_chart/range', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinChartRangeQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const vsCurrency = query.vs_currency.toLowerCase();
    const rows = getChartRowsForRange(database, params.id, parseExplicitRange(query), query.interval);

    return buildChartPayload(database, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision));
  });

  app.get('/coins/:id/ohlc', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinChartQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const precision = parsePrecision(query.precision);
    const vsCurrency = query.vs_currency.toLowerCase();
    const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState));
    const rows = getOhlcRowsForDays(database, params.id, query.days, query.interval);

    return rows.map((row) => {
      const open = toNumberOrNull(row.open * rate, precision);
      const high = toNumberOrNull(row.high * rate, precision);
      const low = toNumberOrNull(row.low * rate, precision);
      const close = toNumberOrNull(row.close * rate, precision);

      return [row.timestamp.getTime(), open, high, low, close];
    });
  });

  app.get('/coins/:id/ohlc/range', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = coinChartRangeQuerySchema.parse(request.query);
    getRequiredCoin(database, params.id);
    const precision = parsePrecision(query.precision);
    const vsCurrency = query.vs_currency.toLowerCase();
    const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState));
    const rows = getOhlcRowsForRange(database, params.id, parseChartRange(query), query.interval);

    return rows.map((row) => {
      const open = toNumberOrNull(row.open * rate, precision);
      const high = toNumberOrNull(row.high * rate, precision);
      const low = toNumberOrNull(row.low * rate, precision);
      const close = toNumberOrNull(row.close * rate, precision);

      return [row.timestamp.getTime(), open, high, low, close];
    });
  });

  app.get('/coins/:id/circulating_supply_chart', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ days: z.string(), interval: z.string().optional() }).parse(request.query);
    getRequiredCoin(database, params.id);
    const rows = getChartRowsForDays(database, params.id, query.days, query.interval);

    return buildSupplyPayload(
      buildSupplySeriesRowsFromChart(database, params.id, rows, (snapshot) => snapshot.circulatingSupply),
      'circulating_supply',
    );
  });

  app.get('/coins/:id/circulating_supply_chart/range', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ from: z.string(), to: z.string(), interval: z.string().optional() }).parse(request.query);
    getRequiredCoin(database, params.id);
    const rows = getChartRowsForRange(database, params.id, parseExplicitRange(query), query.interval);

    return buildSupplyPayload(
      buildSupplySeriesRowsFromChart(database, params.id, rows, (snapshot) => snapshot.circulatingSupply),
      'circulating_supply',
    );
  });

  app.get('/coins/:id/total_supply_chart', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ days: z.string(), interval: z.string().optional() }).parse(request.query);
    getRequiredCoin(database, params.id);
    const rows = getChartRowsForDays(database, params.id, query.days, query.interval);

    return buildSupplyPayload(
      buildSupplySeriesRowsFromChart(database, params.id, rows, (snapshot) => snapshot.totalSupply),
      'total_supply',
    );
  });

  app.get('/coins/:id/total_supply_chart/range', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ from: z.string(), to: z.string(), interval: z.string().optional() }).parse(request.query);
    getRequiredCoin(database, params.id);
    const rows = getChartRowsForRange(database, params.id, parseExplicitRange(query), query.interval);

    return buildSupplyPayload(
      buildSupplySeriesRowsFromChart(database, params.id, rows, (snapshot) => snapshot.totalSupply),
      'total_supply',
    );
  });

  app.get('/coins/categories/list', async () => {
    return getCategories(database).map((category) => ({
      category_id: category.id,
      name: category.name,
    }));
  });

  app.get('/coins/categories', async (request) => {
    const query = categoriesQuerySchema.parse(request.query);

    return sortCategories(getCategories(database), query.order).map((category) => ({
      id: category.id,
      name: category.name,
      market_cap: category.marketCap,
      market_cap_change_24h: category.marketCapChange24h,
      content: category.content,
      top_3_coins: parseJsonArray<string>(category.top3CoinsJson),
      volume_24h: category.volume24h,
      updated_at: category.updatedAt.toISOString(),
    }));
  });

  app.get('/coins/:platform_id/contract/:contract_address', async (request) => {
    const params = z.object({ platform_id: z.string(), contract_address: z.string() }).parse(request.params);
    const query = coinDetailQuerySchema.parse(request.query);
    parseDexPairFormat(query.dex_pair_format);
    const coin = getCoinByContract(database, params.platform_id, params.contract_address);

    if (!coin) {
      throw new HttpError(404, 'not_found', `Contract not found: ${params.contract_address}`);
    }

    const marketRow = getMarketRows(database, 'usd', { ids: [coin.id] })[0] ?? { coin, snapshot: null };
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);

    return buildCoinDetail(database, marketRow.coin, getUsableSnapshot(marketRow.snapshot, marketFreshnessThresholdSeconds, snapshotAccessPolicy), marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
      includeLocalization: parseBooleanQuery(query.localization, true),
      includeMarketData: parseBooleanQuery(query.market_data, true),
      includeTickers: parseBooleanQuery(query.tickers, true),
      includeCommunityData: parseBooleanQuery(query.community_data, true),
      includeDeveloperData: parseBooleanQuery(query.developer_data, true),
      includeSparkline: parseBooleanQuery(query.sparkline, false),
      includeCategoriesDetails: parseBooleanQuery(query.include_categories_details, false),
    });
  });

  app.get('/coins/:platform_id/contract/:contract_address/market_chart', async (request) => {
    const params = z.object({ platform_id: z.string(), contract_address: z.string() }).parse(request.params);
    const query = coinChartQuerySchema.parse(request.query);
    const coin = getCoinByContract(database, params.platform_id, params.contract_address);

    if (!coin) {
      throw new HttpError(404, 'not_found', `Contract not found: ${params.contract_address}`);
    }

    const vsCurrency = query.vs_currency.toLowerCase();
    const rows = getChartRowsForDays(database, coin.id, query.days, query.interval);

    return buildChartPayload(database, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision));
  });

  app.get('/coins/:platform_id/contract/:contract_address/market_chart/range', async (request) => {
    const params = z.object({ platform_id: z.string(), contract_address: z.string() }).parse(request.params);
    const query = coinChartRangeQuerySchema.parse(request.query);
    const coin = getCoinByContract(database, params.platform_id, params.contract_address);

    if (!coin) {
      throw new HttpError(404, 'not_found', `Contract not found: ${params.contract_address}`);
    }

    const vsCurrency = query.vs_currency.toLowerCase();
    const rows = getChartRowsForRange(database, coin.id, parseChartRange(query), query.interval);

    return buildChartPayload(database, rows, vsCurrency, marketFreshnessThresholdSeconds, getSnapshotAccessPolicy(runtimeState), parsePrecision(query.precision));
  });
}
