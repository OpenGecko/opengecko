import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { coinTickers, coins, exchanges, marketSnapshots, type CoinRow, type MarketSnapshotRow } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt, parsePrecision } from '../http/params';
import { getConversionRate, getConversionRates } from '../lib/conversion';
import { SUPPORTED_VS_CURRENCIES } from '../lib/conversion';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import { getCategories, getChartSeries, getCoinByContract, getCoinById, getCoins, getMarketRows, parseJsonArray, parseJsonObject } from './catalog';
import { downsampleTimeSeries, getChartGranularityMs, getRangeDurationMs } from './chart-semantics';
import { getSnapshotAccessPolicy, type SnapshotAccessPolicy, getUsableSnapshot } from './market-freshness';
import { getCanonicalCandles } from '../services/candle-store';

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

type CoinMarketsResponseRow = ReturnType<typeof buildMarketRow>;
type CoinMarketsCacheEntry = {
  value: CoinMarketsResponseRow[];
  expiresAt: number;
  revision: number;
};

const COINS_MARKETS_CACHE_TTL_MS = 5_000;

function toNumberOrNull(value: number | null | undefined, precision: number | 'full') {
  if (value === null || value === undefined) {
    return null;
  }

  if (precision === 'full') {
    return value;
  }

  return Number(value.toFixed(precision));
}

function parsePlatforms(platformsJson: string) {
  return parseJsonObject<Record<string, string>>(platformsJson);
}

function buildDetailPlatforms(platformsJson: string) {
  return Object.fromEntries(
    Object.entries(parsePlatforms(platformsJson)).map(([platformId, contractAddress]) => [
      platformId,
      {
        decimal_place: null,
        contract_address: contractAddress,
      },
    ]),
  );
}

function buildLocalizationPayload(coin: CoinRow, includeLocalization: boolean) {
  if (!includeLocalization) {
    return {};
  }

  return {
    en: coin.name,
  };
}

function buildCommunityData(includeCommunityData: boolean) {
  if (!includeCommunityData) {
    return null;
  }

  return {
    facebook_likes: null,
    twitter_followers: null,
    reddit_average_posts_48h: null,
    reddit_average_comments_48h: null,
    reddit_subscribers: null,
    reddit_accounts_active_48h: null,
    telegram_channel_user_count: null,
  };
}

function buildDeveloperData(includeDeveloperData: boolean) {
  if (!includeDeveloperData) {
    return null;
  }

  return {
    forks: null,
    stars: null,
    subscribers: null,
    total_issues: null,
    closed_issues: null,
    pull_requests_merged: null,
    pull_request_contributors: null,
    code_additions_deletions_4_weeks: {
      additions: null,
      deletions: null,
    },
    commit_count_4_weeks: null,
    last_4_weeks_commit_activity_series: [],
  };
}

function getSeriesExtremes(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
  precision: number | 'full' = 'full',
) {
  const rows = getChartSeries(database, coinId, 'usd');
  const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const values = rows.map((row) => row.price * rate);

  if (values.length === 0) {
    return {
      high24h: null,
      low24h: null,
    };
  }

  return {
    high24h: toNumberOrNull(Math.max(...values), precision),
    low24h: toNumberOrNull(Math.min(...values), precision),
  };
}

function getSeriesChangePercentage(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
) {
  const rows = getChartSeries(database, coinId, 'usd');

  if (rows.length < 2) {
    return null;
  }

  const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const first = rows[0]!.price * rate;
  const last = rows.at(-1)!.price * rate;

  if (first === 0) {
    return null;
  }

  return ((last - first) / first) * 100;
}

function normalizeCategoryId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sortNumber(value: number | null | undefined, fallback: number) {
  return value ?? fallback;
}

function parseDexPairFormat(value: string | undefined) {
  if (!value) {
    return 'symbol';
  }

  const normalized = value.toLowerCase();

  if (normalized === 'symbol' || normalized === 'contract_address') {
    return normalized;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported dex_pair_format value: ${value}`);
}

function parseChartInterval(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();

  if (normalized === 'hourly' || normalized === 'daily' || normalized === 'weekly') {
    return normalized;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported interval value: ${value}`);
}

function getGranularityMs(durationMs: number, interval?: string) {
  const parsedInterval = parseChartInterval(interval);

  if (!parsedInterval) {
    return getChartGranularityMs(durationMs);
  }

  switch (parsedInterval) {
    case 'hourly':
      return 60 * 60 * 1000;
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'weekly':
      return 7 * 24 * 60 * 60 * 1000;
  }
}

function parseMarketOrder(order: string | undefined) {
  const normalizedOrder = (order ?? 'market_cap_desc').toLowerCase();

  switch (normalizedOrder) {
    case 'market_cap_desc':
      return { normalizedOrder, orderBy: [asc(coins.marketCapRank), asc(coins.id)] };
    case 'market_cap_asc':
      return { normalizedOrder, orderBy: [desc(coins.marketCapRank), asc(coins.id)] };
    case 'volume_desc':
      return { normalizedOrder, orderBy: [desc(marketSnapshots.totalVolume), asc(coins.id)] };
    case 'volume_asc':
      return { normalizedOrder, orderBy: [asc(marketSnapshots.totalVolume), asc(coins.id)] };
    case 'id_asc':
      return { normalizedOrder, orderBy: [asc(coins.id)] };
    case 'id_desc':
      return { normalizedOrder, orderBy: [desc(coins.id)] };
    case 'gecko_desc':
      return { normalizedOrder, orderBy: [asc(coins.marketCapRank), asc(coins.id)] };
    case 'gecko_asc':
      return { normalizedOrder, orderBy: [desc(coins.marketCapRank), asc(coins.id)] };
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported order value: ${order}`);
  }
}

function buildSparkline(chartSeries: ReturnType<typeof getChartSeries>, rate: number) {
  const rows = downsampleTimeSeries(chartSeries, getChartGranularityMs(7 * 24 * 60 * 60 * 1000));

  return {
    price: rows.map((point) => point.price * rate),
  };
}

function getSeriesChangePercentageForWindowDays(
  chartSeries: ReturnType<typeof getChartSeries>,
  rate: number,
  windowDays: number,
) {
  if (chartSeries.length < 2) {
    return null;
  }

  const latestTimestamp = chartSeries.at(-1)!.timestamp.getTime();
  const cutoff = latestTimestamp - windowDays * 24 * 60 * 60 * 1000;
  const firstRow = chartSeries.find((row) => row.timestamp.getTime() >= cutoff) ?? chartSeries[0]!;
  const first = firstRow.price * rate;
  const last = chartSeries.at(-1)!.price * rate;

  if (first === 0) {
    return null;
  }

  return ((last - first) / first) * 100;
}

function buildMarketPriceChangeFields(
  chartSeries: ReturnType<typeof getChartSeries>,
  rate: number,
  requestedWindows: string[],
  precision: number | 'full',
) {
  const supportedWindows = [
    { input: '24h', field: 'price_change_percentage_24h_in_currency', days: 1 },
    { input: '7d', field: 'price_change_percentage_7d_in_currency', days: 7 },
    { input: '14d', field: 'price_change_percentage_14d_in_currency', days: 14 },
    { input: '30d', field: 'price_change_percentage_30d_in_currency', days: 30 },
    { input: '200d', field: 'price_change_percentage_200d_in_currency', days: 200 },
    { input: '1y', field: 'price_change_percentage_1y_in_currency', days: 365 },
  ] as const;

  return Object.fromEntries(
    supportedWindows
      .filter((window) => requestedWindows.includes(window.input))
      .map((window) => [
        window.field,
        toNumberOrNull(getSeriesChangePercentageForWindowDays(chartSeries, rate, window.days), precision),
      ]),
  );
}

function buildMarketRow(
  database: AppDatabase,
  row: { coin: CoinRow; snapshot: MarketSnapshotRow | null },
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
  options: { sparkline: boolean; precision: number | 'full'; priceChangePercentages: string[] },
) {
  const snapshot = row.snapshot;
  const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const chartSeries = getChartSeries(database, row.coin.id, 'usd');
  const prices = chartSeries.map((point) => point.price * rate);

  return {
    id: row.coin.id,
    symbol: row.coin.symbol,
    name: row.coin.name,
    image: row.coin.imageLargeUrl,
    current_price: toNumberOrNull(snapshot ? snapshot.price * rate : null, options.precision),
    market_cap: toNumberOrNull(snapshot?.marketCap ? snapshot.marketCap * rate : null, options.precision),
    market_cap_rank: snapshot?.marketCapRank ?? row.coin.marketCapRank,
    fully_diluted_valuation: toNumberOrNull(snapshot?.fullyDilutedValuation ? snapshot.fullyDilutedValuation * rate : null, options.precision),
    total_volume: toNumberOrNull(snapshot?.totalVolume ? snapshot.totalVolume * rate : null, options.precision),
    high_24h: prices.length === 0 ? null : toNumberOrNull(Math.max(...prices), options.precision),
    low_24h: prices.length === 0 ? null : toNumberOrNull(Math.min(...prices), options.precision),
    price_change_24h: toNumberOrNull(snapshot?.priceChange24h ? snapshot.priceChange24h * rate : null, options.precision),
    price_change_percentage_24h: toNumberOrNull(snapshot?.priceChangePercentage24h, options.precision),
    market_cap_change_24h: null,
    market_cap_change_percentage_24h: null,
    circulating_supply: toNumberOrNull(snapshot?.circulatingSupply, options.precision),
    total_supply: toNumberOrNull(snapshot?.totalSupply, options.precision),
    max_supply: toNumberOrNull(snapshot?.maxSupply, options.precision),
    ath: toNumberOrNull(snapshot?.ath ? snapshot.ath * rate : null, options.precision),
    ath_change_percentage: toNumberOrNull(snapshot?.athChangePercentage, options.precision),
    ath_date: snapshot?.athDate?.toISOString() ?? null,
    atl: toNumberOrNull(snapshot?.atl ? snapshot.atl * rate : null, options.precision),
    atl_change_percentage: toNumberOrNull(snapshot?.atlChangePercentage, options.precision),
    atl_date: snapshot?.atlDate?.toISOString() ?? null,
    roi: null,
    last_updated: snapshot?.lastUpdated?.toISOString() ?? null,
    ...buildMarketPriceChangeFields(chartSeries, rate, options.priceChangePercentages, options.precision),
    ...(options.sparkline ? { sparkline_in_7d: buildSparkline(chartSeries, rate) } : {}),
  };
}

function normalizeSelector(values: string[]) {
  return [...new Set(values)].sort();
}

function createCoinMarketsCacheKey(query: z.infer<typeof coinMarketsQuerySchema>) {
  return JSON.stringify({
    vsCurrency: query.vs_currency.toLowerCase(),
    ids: normalizeSelector(parseCsvQuery(query.ids)),
    names: normalizeSelector(parseCsvQuery(query.names)),
    symbols: normalizeSelector(parseCsvQuery(query.symbols)),
    category: query.category ? normalizeCategoryId(query.category) : null,
    order: query.order?.toLowerCase() ?? null,
    perPage: Math.min(parsePositiveInt(query.per_page, 100), 250),
    page: parsePositiveInt(query.page, 1),
    priceChangePercentages: normalizeSelector(parseCsvQuery(query.price_change_percentage).map((value) => value.toLowerCase())),
    sparkline: parseBooleanQuery(query.sparkline, false),
    precision: parsePrecision(query.precision),
  });
}

function cloneCoinMarketsResponse(value: CoinMarketsResponseRow[]) {
  return JSON.parse(JSON.stringify(value)) as CoinMarketsResponseRow[];
}

function parseMoverDuration(value: string | undefined) {
  if (!value) {
    return { days: 1, field: 'price_change_percentage_24h' as const };
  }

  const normalized = value.toLowerCase();

  switch (normalized) {
    case '24h':
      return { days: 1, field: 'price_change_percentage_24h' as const };
    case '7d':
      return { days: 7, field: 'price_change_percentage_7d_in_currency' as const };
    case '14d':
      return { days: 14, field: 'price_change_percentage_14d_in_currency' as const };
    case '30d':
      return { days: 30, field: 'price_change_percentage_30d_in_currency' as const };
    case '60d':
      return { days: 60, field: 'price_change_percentage_60d_in_currency' as const };
    case '1y':
      return { days: 365, field: 'price_change_percentage_1y_in_currency' as const };
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported duration value: ${value}`);
  }
}

function parseTopCoinsLimit(value: string | undefined) {
  if (!value) {
    return 30;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || ![300, 500, 1000].includes(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Unsupported top_coins value: ${value}`);
  }

  return parsed;
}

function parseMoverPriceChangePercentage(value: string | undefined) {
  if (!value) {
    return ['24h'];
  }

  const entries = parseCsvQuery(value).map((entry) => entry.toLowerCase());
  const supported = new Set(['24h', '7d', '14d', '30d', '200d', '1y']);

  if (entries.length === 0 || entries.some((entry) => !supported.has(entry))) {
    throw new HttpError(400, 'invalid_parameter', `Unsupported price_change_percentage value: ${value}`);
  }

  return entries;
}

function getSeriesChangePercentageForWindow(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
  durationDays: number,
) {
  if (durationDays === 1) {
    const marketRow = getMarketRows(database, 'usd', { ids: [coinId], status: 'all' })[0];

    return marketRow?.snapshot?.priceChangePercentage24h ?? null;
  }

  const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const chartSeries = getChartSeries(database, coinId, 'usd');

  return getSeriesChangePercentageForWindowDays(
    chartSeries,
    rate,
    durationDays,
  );
}

function buildMoverRow(
  database: AppDatabase,
  row: { coin: CoinRow; snapshot: MarketSnapshotRow | null },
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
  durationDays: number,
  requestedWindows: string[],
) {
  return buildMarketRow(database, row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
    sparkline: false,
    precision: 'full',
    priceChangePercentages: requestedWindows,
  });
}

function buildNewListingRow(coin: CoinRow) {
  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    activated_at: Math.floor(coin.createdAt.getTime() / 1000),
  };
}

function buildCategoriesDetails(database: AppDatabase, categoriesList: string[]) {
  const categoriesById = new Map(getCategories(database).map((category) => [category.id, category]));

  return categoriesList.map((entry) => {
    const categoryId = normalizeCategoryId(entry);
    const category = categoriesById.get(categoryId);

    return {
      id: categoryId,
      name: category?.name ?? entry,
      market_cap: category?.marketCap ?? null,
      market_cap_change_24h: category?.marketCapChange24h ?? null,
      volume_24h: category?.volume24h ?? null,
    };
  });
}

function buildCoinDetail(
  database: AppDatabase,
  coin: CoinRow,
  snapshot: MarketSnapshotRow | null,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
  options: {
    includeLocalization: boolean;
    includeMarketData: boolean;
    includeTickers: boolean;
    includeCommunityData: boolean;
    includeDeveloperData: boolean;
    includeSparkline: boolean;
    includeCategoriesDetails: boolean;
  },
) {
  const categoriesList = parseJsonArray<string>(coin.categoriesJson);
  const description = parseJsonObject<Record<string, string>>(coin.descriptionJson);
  const links = parseJsonObject<Record<string, unknown>>(coin.linksJson);
  const seriesExtremes = getSeriesExtremes(database, coin.id, 'usd', marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const priceChangePercentage7d = getSeriesChangePercentage(
    database,
    coin.id,
    'usd',
    marketFreshnessThresholdSeconds,
    snapshotAccessPolicy,
  );
  const sparklineRate = getConversionRate(database, 'usd', marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const sparklineSeries = getChartSeries(database, coin.id, 'usd');
  const conversionRates = getConversionRates(database, marketFreshnessThresholdSeconds, snapshotAccessPolicy);

  function toMultiCurrency(value: number | null | undefined) {
    if (value == null) {
      return Object.fromEntries(SUPPORTED_VS_CURRENCIES.map((c) => [c, null]));
    }

    return Object.fromEntries(
      SUPPORTED_VS_CURRENCIES.map((c) => [c, toNumberOrNull(value * conversionRates[c as keyof typeof conversionRates], 'full')]),
    );
  }

  const marketData = !options.includeMarketData || !snapshot
    ? null
    : {
        current_price: toMultiCurrency(snapshot.price),
        market_cap: toMultiCurrency(snapshot.marketCap),
        total_volume: toMultiCurrency(snapshot.totalVolume),
        high_24h: toMultiCurrency(seriesExtremes.high24h),
        low_24h: toMultiCurrency(seriesExtremes.low24h),
        fully_diluted_valuation: toMultiCurrency(snapshot.fullyDilutedValuation),
        circulating_supply: snapshot.circulatingSupply,
        total_supply: snapshot.totalSupply,
        max_supply: snapshot.maxSupply,
        ath: toMultiCurrency(snapshot.ath),
        ath_change_percentage: Object.fromEntries(
          SUPPORTED_VS_CURRENCIES.map((c) => [c, toNumberOrNull(snapshot?.athChangePercentage, 'full')]),
        ),
        ath_date: Object.fromEntries(
          SUPPORTED_VS_CURRENCIES.map((c) => [c, snapshot?.athDate?.toISOString() ?? null]),
        ),
        atl: toMultiCurrency(snapshot.atl),
        atl_change_percentage: Object.fromEntries(
          SUPPORTED_VS_CURRENCIES.map((c) => [c, toNumberOrNull(snapshot?.atlChangePercentage, 'full')]),
        ),
        atl_date: Object.fromEntries(
          SUPPORTED_VS_CURRENCIES.map((c) => [c, snapshot?.atlDate?.toISOString() ?? null]),
        ),
        price_change_24h: snapshot.priceChange24h,
        price_change_percentage_24h: snapshot.priceChangePercentage24h,
        price_change_percentage_7d: priceChangePercentage7d,
        price_change_percentage_7d_in_currency: Object.fromEntries(
          SUPPORTED_VS_CURRENCIES.map((c) => [c, toNumberOrNull(priceChangePercentage7d, 'full')]),
        ),
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        market_cap_rank: snapshot.marketCapRank,
        last_updated: snapshot.lastUpdated.toISOString(),
        sparkline_7d: options.includeSparkline
          ? buildSparkline(sparklineSeries, sparklineRate)
          : null,
      };

  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    web_slug: coin.id,
    asset_platform_id: null,
    localization: buildLocalizationPayload(coin, options.includeLocalization),
    platforms: parsePlatforms(coin.platformsJson),
    detail_platforms: buildDetailPlatforms(coin.platformsJson),
    block_time_in_minutes: coin.blockTimeInMinutes,
    hashing_algorithm: coin.hashingAlgorithm,
    categories: categoriesList,
    categories_details: options.includeCategoriesDetails ? buildCategoriesDetails(database, categoriesList) : [],
    public_notice: null,
    additional_notices: [],
    description: options.includeLocalization ? description : { en: description.en ?? '' },
    links,
    image: {
      thumb: coin.imageThumbUrl,
      small: coin.imageSmallUrl,
      large: coin.imageLargeUrl,
    },
    country_origin: null,
    genesis_date: coin.genesisDate,
    sentiment_votes_up_percentage: null,
    sentiment_votes_down_percentage: null,
    market_cap_rank: coin.marketCapRank,
    coingecko_rank: coin.marketCapRank,
    coingecko_score: null,
    developer_score: null,
    community_score: null,
    liquidity_score: null,
    public_interest_score: null,
    watchlist_portfolio_users: null,
    public_interest_stats: {
      alexa_rank: null,
      bing_matches: null,
    },
    market_data: marketData,
    community_data: buildCommunityData(options.includeCommunityData),
    developer_data: buildDeveloperData(options.includeDeveloperData),
    status_updates: [],
    last_updated: snapshot?.lastUpdated.toISOString() ?? coin.updatedAt.toISOString(),
    tickers: options.includeTickers
      ? getCoinTickers(database, coin.id, {
        includeExchangeLogo: false,
        page: 1,
        marketFreshnessThresholdSeconds,
        snapshotAccessPolicy,
      }).tickers
      : [],
  };
}

function getCoinTickerRows(database: AppDatabase, coinId: string, exchangeIds?: string[]) {
  const whereCondition = exchangeIds?.length
    ? and(eq(coinTickers.coinId, coinId), inArray(coinTickers.exchangeId, exchangeIds))
    : eq(coinTickers.coinId, coinId);

  return database.db
    .select()
    .from(coinTickers)
    .innerJoin(exchanges, eq(exchanges.id, coinTickers.exchangeId))
    .where(whereCondition)
    .all();
}

function sortCoinTickerRows(
  rows: ReturnType<typeof getCoinTickerRows>,
  order: string | undefined,
) {
  const normalizedOrder = (order ?? 'trust_score_desc').toLowerCase();
  const sortableRows = [...rows];

  switch (normalizedOrder) {
    case 'trust_score_desc':
      return sortableRows.sort((left, right) => {
        const trustRankDelta = sortNumber(left.exchanges.trustScoreRank, Number.MAX_SAFE_INTEGER) - sortNumber(right.exchanges.trustScoreRank, Number.MAX_SAFE_INTEGER);

        if (trustRankDelta !== 0) {
          return trustRankDelta;
        }

        return sortNumber(right.coin_tickers.convertedVolumeUsd, -1) - sortNumber(left.coin_tickers.convertedVolumeUsd, -1);
      });
    case 'volume_desc':
      return sortableRows.sort((left, right) => sortNumber(right.coin_tickers.convertedVolumeUsd, -1) - sortNumber(left.coin_tickers.convertedVolumeUsd, -1));
    case 'volume_asc':
      return sortableRows.sort((left, right) => sortNumber(left.coin_tickers.convertedVolumeUsd, Number.MAX_SAFE_INTEGER) - sortNumber(right.coin_tickers.convertedVolumeUsd, Number.MAX_SAFE_INTEGER));
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported order value: ${order}`);
  }
}

function buildCoinTickerPayload(
  row: ReturnType<typeof getCoinTickerRows>[number],
  includeExchangeLogo: boolean,
  conversionRates: ReturnType<typeof getConversionRates>,
) {
  return {
    base: row.coin_tickers.base,
    target: row.coin_tickers.target,
    market: {
      name: row.exchanges.name,
      identifier: row.exchanges.id,
      has_trading_incentive: row.exchanges.hasTradingIncentive,
      ...(includeExchangeLogo ? { logo: row.exchanges.imageUrl } : {}),
    },
    last: row.coin_tickers.last,
    volume: row.coin_tickers.volume,
    converted_last: {
      btc: row.coin_tickers.convertedLastUsd === null ? null : row.coin_tickers.convertedLastUsd * conversionRates.btc,
      usd: row.coin_tickers.convertedLastUsd,
      eth: row.coin_tickers.convertedLastUsd === null ? null : row.coin_tickers.convertedLastUsd * conversionRates.eth,
    },
    converted_volume: {
      btc: row.coin_tickers.convertedVolumeUsd === null ? null : row.coin_tickers.convertedVolumeUsd * conversionRates.btc,
      usd: row.coin_tickers.convertedVolumeUsd,
      eth: row.coin_tickers.convertedVolumeUsd === null ? null : row.coin_tickers.convertedVolumeUsd * conversionRates.eth,
    },
    trust_score: row.coin_tickers.trustScore,
    bid_ask_spread_percentage: row.coin_tickers.bidAskSpreadPercentage,
    timestamp: row.coin_tickers.lastTradedAt?.getTime() ?? null,
    last_traded_at: row.coin_tickers.lastTradedAt?.toISOString() ?? null,
    last_fetch_at: row.coin_tickers.lastFetchAt?.toISOString() ?? null,
    is_anomaly: row.coin_tickers.isAnomaly,
    is_stale: row.coin_tickers.isStale,
    trade_url: row.coin_tickers.tradeUrl,
    token_info_url: row.coin_tickers.tokenInfoUrl,
    coin_id: row.coin_tickers.coinId,
    target_coin_id: null,
  };
}

function getCoinTickers(
  database: AppDatabase,
  coinId: string,
  options: {
    exchangeIds?: string[];
    includeExchangeLogo: boolean;
    page: number;
    order?: string;
    marketFreshnessThresholdSeconds: number;
    snapshotAccessPolicy: SnapshotAccessPolicy;
  },
) {
  const perPage = 100;
  const rows = sortCoinTickerRows(getCoinTickerRows(database, coinId, options.exchangeIds), options.order);
  const start = (options.page - 1) * perPage;
  const conversionRates = getConversionRates(database, options.marketFreshnessThresholdSeconds, options.snapshotAccessPolicy);

  return {
    tickers: rows.slice(start, start + perPage).map((row) => buildCoinTickerPayload(row, options.includeExchangeLogo, conversionRates)),
  };
}

function parseHistoryDate(date: string) {
  const [day, month, year] = date.split('-').map(Number);

  if (![day, month, year].every(Number.isInteger)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid history date: ${date}`);
  }

  return Date.UTC(year, month - 1, day);
}

function parseUnixTimestampSeconds(value: string, fieldName: string) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${fieldName} value: ${value}`);
  }

  return parsed * 1000;
}

function parseChartRange(query: z.infer<typeof coinChartRangeQuerySchema>) {
  const from = parseUnixTimestampSeconds(query.from, 'from');
  const to = parseUnixTimestampSeconds(query.to, 'to');

  if (from > to) {
    throw new HttpError(400, 'invalid_parameter', `Invalid time range: from must be less than or equal to to.`);
  }

  return { from, to };
}

function parseExplicitRange(query: { from: string; to: string }) {
  const from = parseUnixTimestampSeconds(query.from, 'from');
  const to = parseUnixTimestampSeconds(query.to, 'to');

  if (from > to) {
    throw new HttpError(400, 'invalid_parameter', `Invalid time range: from must be less than or equal to to.`);
  }

  return { from, to };
}

function getRequiredCoin(database: AppDatabase, coinId: string) {
  const coin = getCoinById(database, coinId);

  if (!coin) {
    throw new HttpError(404, 'not_found', `Coin not found: ${coinId}`);
  }

  return coin;
}

function getHistorySnapshot(database: AppDatabase, coinId: string, targetDate: number) {
  const currentRow = getMarketRows(database, 'usd', { ids: [coinId], status: 'all' })[0];
  const chartSeries = getChartSeries(database, coinId, 'usd', { to: targetDate });
  const lastPoint = chartSeries.at(-1);

  if (!lastPoint) {
    return null;
  }

  if (!currentRow?.snapshot) {
    return null;
  }

  return {
    ...currentRow.snapshot,
    price: lastPoint.price,
    marketCap: lastPoint.marketCap,
    totalVolume: lastPoint.totalVolume,
    lastUpdated: new Date(targetDate),
  };
}

function getChartRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
  const candleInterval = parseChartInterval(interval) === 'hourly' ? '1m' : '1d';
  const rows = candleInterval === '1d'
    ? getChartSeries(database, coinId, 'usd')
    : getCanonicalCandles(database, coinId, 'usd', candleInterval).map((row) => ({
      timestamp: row.timestamp,
      price: row.close,
      marketCap: row.marketCap,
      totalVolume: row.totalVolume,
    }));

  if (days === 'max') {
    if (rows.length === 0) {
      return rows;
    }

    const duration = rows.at(-1)!.timestamp.getTime() - rows[0]!.timestamp.getTime();

    return downsampleTimeSeries(rows, getGranularityMs(duration, interval));
  }

  const dayCount = Number(days);

  if (!Number.isFinite(dayCount) || dayCount <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
  }

  const latestTimestamp = rows.at(-1)?.timestamp?.getTime();

  if (!latestTimestamp) {
    return [];
  }

  const cutoff = latestTimestamp - dayCount * 24 * 60 * 60 * 1000;
  const filteredRows = rows.filter((row) => row.timestamp.getTime() >= cutoff);

  return downsampleTimeSeries(filteredRows, getGranularityMs(dayCount * 24 * 60 * 60 * 1000, interval));
}

function getChartRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  const candleInterval = parseChartInterval(interval) === 'hourly' ? '1m' : '1d';
  const rows = candleInterval === '1d'
    ? getChartSeries(database, coinId, 'usd', range)
    : getCanonicalCandles(database, coinId, 'usd', candleInterval, range).map((row) => ({
      timestamp: row.timestamp,
      price: row.close,
      marketCap: row.marketCap,
      totalVolume: row.totalVolume,
    }));

  return downsampleTimeSeries(rows, getGranularityMs(getRangeDurationMs(range), interval));
}

function getOhlcRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
  const candleInterval = parseChartInterval(interval) === 'hourly' ? '1m' : '1d';
  const rows = getCanonicalCandles(database, coinId, 'usd', candleInterval);

  if (days === 'max') {
    return rows;
  }

  const dayCount = Number(days);

  if (!Number.isFinite(dayCount) || dayCount <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
  }

  const latestTimestamp = rows.at(-1)?.timestamp?.getTime();

  if (!latestTimestamp) {
    return [];
  }

  const cutoff = latestTimestamp - dayCount * 24 * 60 * 60 * 1000;

  return rows.filter((row) => row.timestamp.getTime() >= cutoff);
}

function getOhlcRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  const candleInterval = parseChartInterval(interval) === 'hourly' ? '1m' : '1d';

  return getCanonicalCandles(database, coinId, 'usd', candleInterval, range);
}

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

function buildChartPayload(
  database: AppDatabase,
  rows: Array<{ timestamp: Date; price: number; marketCap: number | null; totalVolume: number | null }>,
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
  precision: number | 'full',
) {
  const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);

  return {
    prices: rows.map((row) => [row.timestamp.getTime(), toNumberOrNull(row.price * rate, precision)]),
    market_caps: rows.map((row) => [row.timestamp.getTime(), toNumberOrNull(row.marketCap ? row.marketCap * rate : null, precision)]),
    total_volumes: rows.map((row) => [row.timestamp.getTime(), toNumberOrNull(row.totalVolume ? row.totalVolume * rate : null, precision)]),
  };
}

function buildSupplySeriesRowsFromChart(
  database: AppDatabase,
  coinId: string,
  sourceRows: Array<{ timestamp: Date }>,
  selector: (snapshot: MarketSnapshotRow) => number | null,
) {
  const currentSnapshot = getMarketRows(database, 'usd', { ids: [coinId], status: 'all' })[0]?.snapshot;
  const currentValue = currentSnapshot ? selector(currentSnapshot) : null;
  const value = currentValue ?? (coinId === 'bitcoin'
    ? (selector({
      coinId,
      vsCurrency: 'usd',
      price: 0,
      marketCap: null,
      totalVolume: null,
      marketCapRank: null,
      fullyDilutedValuation: null,
      circulatingSupply: 19_800_000,
      totalSupply: 21_000_000,
      maxSupply: 21_000_000,
      ath: null,
      athChangePercentage: null,
      athDate: null,
      atl: null,
      atlChangePercentage: null,
      atlDate: null,
      priceChange24h: null,
      priceChangePercentage24h: null,
      sourceProvidersJson: '[]',
      sourceCount: 0,
      updatedAt: new Date(0),
      lastUpdated: new Date(0),
    } satisfies MarketSnapshotRow) ?? null)
    : null);

  if (value === null) {
    return [];
  }

  return sourceRows
    .map((row) => [row.timestamp.getTime(), value] as const)
    .sort((left, right) => left[0] - right[0]);
}

function buildSupplyPayload(
  rows: ReadonlyArray<readonly [number, number]>,
  seriesKey: 'circulating_supply' | 'total_supply',
) {
  return {
    [seriesKey]: rows.map((row) => [row[0], row[1]]),
  };
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
    const category = query.category ? normalizeCategoryId(query.category) : undefined;
    const vsCurrency = query.vs_currency.toLowerCase();
    const priceChangePercentages = parseCsvQuery(query.price_change_percentage).map((value) => value.toLowerCase());
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    const marketOrder = parseMarketOrder(query.order);
    const rows = getMarketRows(database, 'usd', {
      ids: parseCsvQuery(query.ids),
      names: parseCsvQuery(query.names),
      symbols: parseCsvQuery(query.symbols),
      categoryId: category,
    }, marketOrder.orderBy).map((row) => ({
      coin: row.coin,
      snapshot: getUsableSnapshot(row.snapshot, marketFreshnessThresholdSeconds, snapshotAccessPolicy),
    }));
    const start = (page - 1) * perPage;

    const payload = rows.slice(start, start + perPage).map((row) => buildMarketRow(database, row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
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
      .map((entry) => buildMoverRow(database, entry.row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, duration.days, requestedWindows));

    const topLosers = movers
      .filter((entry) => (entry.change ?? 0) < 0)
      .sort((left, right) => (left.change ?? Number.POSITIVE_INFINITY) - (right.change ?? Number.POSITIVE_INFINITY))
      .slice(0, 30)
      .map((entry) => buildMoverRow(database, entry.row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, duration.days, requestedWindows));

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
