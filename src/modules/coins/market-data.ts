import { asc, desc } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { coins, marketSnapshots, type CoinRow, type MarketSnapshotRow } from '../../db/schema';
import { HttpError } from '../../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt, parsePrecision } from '../../http/params';
import { getConversionRate } from '../../lib/conversion';
import { getChartSeries, getMarketRows } from '../catalog';
import { downsampleTimeSeries } from '../chart-semantics';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, getUsableSnapshot, type SnapshotAccessPolicy } from '../market-freshness';
import type { MarketDataRuntimeState } from '../../services/market-runtime-state';
import { withResolvedCoinImages } from '../../services/asset-image-identity';
import {
  getGranularityMs,
  isSeededBootstrapSnapshot,
  normalizeCategoryId,
  normalizeSelector,
  sortNumber,
  toNumberOrNull,
} from './helpers';

export type CoinMarketsResponseRow = ReturnType<typeof buildMarketRow>;
export type CoinMarketsCacheEntry = {
  value: CoinMarketsResponseRow[];
  expiresAt: number;
  revision: number;
};

export const COINS_MARKETS_CACHE_TTL_MS = 5_000;

export function getSeriesExtremes(
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

export function getSeriesChangePercentage(
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

export function parseMarketOrder(order: string | undefined) {
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

export function buildSparkline(chartSeries: ReturnType<typeof getChartSeries>, rate: number) {
  const rows = downsampleTimeSeries(chartSeries, getGranularityMs(7 * 24 * 60 * 60 * 1000));

  return {
    price: rows.map((point) => point.price * rate),
  };
}

export function getSeriesChangePercentageForWindowDays(
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

export function buildMarketPriceChangeFields(
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

function buildNullMarketPriceChangeFields(requestedWindows: string[]) {
  return Object.fromEntries(
    requestedWindows
      .map((window) => {
        const field = {
          '24h': 'price_change_percentage_24h_in_currency',
          '7d': 'price_change_percentage_7d_in_currency',
          '14d': 'price_change_percentage_14d_in_currency',
          '30d': 'price_change_percentage_30d_in_currency',
          '200d': 'price_change_percentage_200d_in_currency',
          '1y': 'price_change_percentage_1y_in_currency',
        }[window];

        return field ? [field, null] : null;
      })
      .filter((entry): entry is [string, null] => entry !== null),
  );
}

export function buildMarketRow(
  database: AppDatabase,
  row: { coin: CoinRow; snapshot: MarketSnapshotRow | null },
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
  runtimeState: MarketDataRuntimeState,
  options: { sparkline: boolean; precision: number | 'full'; priceChangePercentages: string[] },
) {
  const snapshot = row.snapshot;
  const coin = withResolvedCoinImages(row.coin);
  const seededBootstrapSnapshot = isSeededBootstrapSnapshot(snapshot);
  const validationOverrideMode = runtimeState.validationOverride?.mode ?? 'off';
  const validationStaleDisallowed = validationOverrideMode === 'stale_disallowed';
  const degradedMarketSnapshot = validationOverrideMode === 'degraded_seeded_bootstrap'
    ? snapshot !== null
    : seededBootstrapSnapshot;
  const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const chartSeries = getChartSeries(database, row.coin.id, 'usd');
  const prices = chartSeries.map((point) => point.price * rate);

  return {
    id: row.coin.id,
    symbol: coin.symbol,
    name: coin.name,
    image: coin.imageLargeUrl,
    current_price: toNumberOrNull(snapshot ? snapshot.price * rate : null, options.precision),
    market_cap: toNumberOrNull(snapshot?.marketCap ? snapshot.marketCap * rate : null, options.precision),
    market_cap_rank: snapshot?.marketCapRank ?? row.coin.marketCapRank,
    fully_diluted_valuation: toNumberOrNull(snapshot?.fullyDilutedValuation ? snapshot.fullyDilutedValuation * rate : null, options.precision),
    total_volume: degradedMarketSnapshot ? null : toNumberOrNull(snapshot?.totalVolume ? snapshot.totalVolume * rate : null, options.precision),
    high_24h: degradedMarketSnapshot || validationStaleDisallowed || prices.length === 0 ? null : toNumberOrNull(Math.max(...prices), options.precision),
    low_24h: degradedMarketSnapshot || validationStaleDisallowed || prices.length === 0 ? null : toNumberOrNull(Math.min(...prices), options.precision),
    price_change_24h: degradedMarketSnapshot ? null : toNumberOrNull(snapshot?.priceChange24h ? snapshot.priceChange24h * rate : null, options.precision),
    price_change_percentage_24h: degradedMarketSnapshot ? null : toNumberOrNull(snapshot?.priceChangePercentage24h, options.precision),
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
    ...(
      degradedMarketSnapshot || validationStaleDisallowed
        ? buildNullMarketPriceChangeFields(options.priceChangePercentages)
        : buildMarketPriceChangeFields(chartSeries, rate, options.priceChangePercentages, options.precision)
    ),
    ...(options.sparkline ? { sparkline_in_7d: buildSparkline(chartSeries, rate) } : {}),
  };
}

export function createCoinMarketsCacheKey(query: {
  vs_currency: string;
  ids?: string;
  names?: string;
  symbols?: string;
  category?: string;
  order?: string;
  per_page?: string;
  page?: string;
  price_change_percentage?: string;
  sparkline?: 'true' | 'false';
  precision?: string;
}) {
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

export function cloneCoinMarketsResponse(value: CoinMarketsResponseRow[]) {
  return JSON.parse(JSON.stringify(value)) as CoinMarketsResponseRow[];
}

export function getSeriesChangePercentageForWindow(
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

export function buildMoverRow(
  database: AppDatabase,
  row: { coin: CoinRow; snapshot: MarketSnapshotRow | null },
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
  runtimeState: MarketDataRuntimeState,
  _durationDays: number,
  requestedWindows: string[],
) {
  return buildMarketRow(database, row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, runtimeState, {
    sparkline: false,
    precision: 'full',
    priceChangePercentages: requestedWindows,
  });
}

export function parseMarketRowsRequest(
  database: AppDatabase,
  runtimeState: MarketDataRuntimeState,
  marketFreshnessThresholdSeconds: number,
  query: {
    vs_currency: string;
    ids?: string;
    names?: string;
    symbols?: string;
    category?: string;
    order?: string;
  },
) {
  const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
  const marketOrder = parseMarketOrder(query.order);

  return {
    snapshotAccessPolicy,
    rows: getMarketRows(database, 'usd', {
      ids: parseCsvQuery(query.ids),
      names: parseCsvQuery(query.names),
      symbols: parseCsvQuery(query.symbols),
      categoryId: query.category ? normalizeCategoryId(query.category) : undefined,
    }, marketOrder.orderBy).map((row) => ({
      coin: row.coin,
      snapshot: getUsableSnapshot(
        getEffectiveSnapshot(row.snapshot, runtimeState),
        marketFreshnessThresholdSeconds,
        snapshotAccessPolicy,
      ),
    })),
  };
}
