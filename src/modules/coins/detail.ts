import { and, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { coinTickers, exchanges, type CoinRow, type MarketSnapshotRow } from '../../db/schema';
import { HttpError } from '../../http/errors';
import { getConversionRates } from '../../lib/conversion';
import { SUPPORTED_VS_CURRENCIES } from '../../lib/conversion';
import { getCategories, getChartSeries, getCoinById, getMarketRows, parseJsonArray, parseJsonObject } from '../catalog';
import type { SnapshotAccessPolicy } from '../market-freshness';
import { withResolvedCoinImages } from '../../services/asset-image-identity';
import {
  buildCategoriesDetails,
  buildCommunityData,
  buildDetailPlatforms,
  buildDeveloperData,
  buildLocalizationPayload,
  parsePlatforms,
  sortNumber,
  toNumberOrNull,
} from './helpers';
import { buildSparkline, getSeriesChangePercentage, getSeriesExtremes } from './market-data';

export function buildCoinDetail(
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
  const hydratedCoin = withResolvedCoinImages(coin);
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
  const sparklineRate = getConversionRates(database, marketFreshnessThresholdSeconds, snapshotAccessPolicy).usd;
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
    id: hydratedCoin.id,
    symbol: hydratedCoin.symbol,
    name: hydratedCoin.name,
    web_slug: hydratedCoin.id,
    asset_platform_id: null,
    localization: buildLocalizationPayload(hydratedCoin, options.includeLocalization),
    platforms: parsePlatforms(hydratedCoin.platformsJson),
    detail_platforms: buildDetailPlatforms(hydratedCoin.platformsJson),
    block_time_in_minutes: hydratedCoin.blockTimeInMinutes,
    hashing_algorithm: hydratedCoin.hashingAlgorithm,
    categories: categoriesList,
    categories_details: options.includeCategoriesDetails ? buildCategoriesDetails(database, categoriesList, getCategories) : [],
    public_notice: null,
    additional_notices: [],
    description: options.includeLocalization ? description : { en: description.en ?? '' },
    links,
    image: {
      thumb: hydratedCoin.imageThumbUrl,
      small: hydratedCoin.imageSmallUrl,
      large: hydratedCoin.imageLargeUrl,
    },
    country_origin: null,
    genesis_date: hydratedCoin.genesisDate,
    sentiment_votes_up_percentage: null,
    sentiment_votes_down_percentage: null,
    market_cap_rank: hydratedCoin.marketCapRank,
    coingecko_rank: hydratedCoin.marketCapRank,
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
    last_updated: snapshot?.lastUpdated.toISOString() ?? hydratedCoin.updatedAt.toISOString(),
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

export function getCoinTickers(
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

export function getRequiredCoin(database: AppDatabase, coinId: string) {
  const coin = getCoinById(database, coinId);

  if (!coin) {
    throw new HttpError(404, 'not_found', `Coin not found: ${coinId}`);
  }

  return coin;
}

export function getHistorySnapshot(database: AppDatabase, coinId: string, targetDate: number) {
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
