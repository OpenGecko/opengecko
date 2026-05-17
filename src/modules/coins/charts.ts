import type { AppDatabase } from '../../db/client';
import type { MarketSnapshotRow } from '../../db/schema';
import { coinTickers } from '../../db/schema';
import { HttpError } from '../../http/errors';
import { getConversionRate } from '../../lib/conversion';
import { getChartSeries, getMarketRows } from '../catalog';
import { downsampleTimeSeries, getRangeDurationMs } from '../chart-semantics';
import { fetchExchangeOHLCV } from '../../providers/ccxt';
import { getCanonicalCandles, upsertCanonicalOhlcvCandle } from '../../services/candle-store';
import {
  readMarketChartSourceOhlcRowsForDays,
  readMarketChartSourceOhlcRowsForRange,
  readMarketChartSourceRowsForDays,
  readMarketChartSourceRowsForRange,
} from '../../services/market-chart-ingestion';
import { getGranularityMs, parseChartInterval, parseUnixTimestampSeconds, toNumberOrNull } from './helpers';
import { asc, eq } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60 * 1000;

type ChartPayloadRow = {
  timestamp: Date;
  price: number;
  marketCap: number | null;
  totalVolume: number | null;
};

type OhlcPayloadRow = {
  timestamp: Date;
  marketCap: number | null;
  totalVolume: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
};

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidTimestamp(value: Date) {
  return Number.isFinite(value.getTime()) && value.getTime() > 0;
}

function isValidPrice(value: number) {
  return isFiniteNumber(value) && value > 0;
}

function nullableNonNegative(value: number | null | undefined) {
  return isFiniteNumber(value) && value >= 0 ? value : null;
}

function normalizeChartRows<T extends ChartPayloadRow>(rows: T[]): T[] {
  return rows
    .filter((row) => isValidTimestamp(row.timestamp) && isValidPrice(row.price))
    .map((row) => ({
      ...row,
      marketCap: nullableNonNegative(row.marketCap),
      totalVolume: nullableNonNegative(row.totalVolume),
    }));
}

function getCurrentMarketRatios(database: AppDatabase, coinId: string) {
  const snapshot = getMarketRows(database, 'usd', { ids: [coinId], status: 'all' })[0]?.snapshot;

  if (!snapshot || !isValidPrice(snapshot.price)) {
    return {
      marketCapToPrice: null,
      totalVolumeToPrice: null,
    };
  }

  return {
    marketCapToPrice: isFiniteNumber(snapshot.marketCap) && snapshot.marketCap >= 0
      ? snapshot.marketCap / snapshot.price
      : null,
    totalVolumeToPrice: isFiniteNumber(snapshot.totalVolume) && snapshot.totalVolume >= 0
      ? snapshot.totalVolume / snapshot.price
      : null,
  };
}

function deriveSparseChartFieldsFromCurrentMarket<T extends ChartPayloadRow>(
  rows: T[],
  ratios: { marketCapToPrice: number | null; totalVolumeToPrice: number | null },
) {
  return rows.map((row) => ({
    ...row,
    marketCap: row.marketCap ?? (ratios.marketCapToPrice === null ? null : row.price * ratios.marketCapToPrice),
    totalVolume: row.totalVolume ?? (ratios.totalVolumeToPrice === null ? null : row.price * ratios.totalVolumeToPrice),
  }));
}

function hasValidOhlcInvariants(row: OhlcPayloadRow) {
  if (![row.open, row.high, row.low, row.close].every(isValidPrice)) {
    return false;
  }

  return row.low <= row.open
    && row.low <= row.close
    && row.high >= row.open
    && row.high >= row.close
    && row.low <= row.high;
}

function normalizeOhlcRows<T extends OhlcPayloadRow>(rows: T[]): T[] {
  return rows
    .filter((row) => isValidTimestamp(row.timestamp) && hasValidOhlcInvariants(row))
    .map((row) => ({
      ...row,
      marketCap: nullableNonNegative(row.marketCap),
      totalVolume: nullableNonNegative(row.totalVolume),
    }));
}

export function parseChartRange(query: { from: string; to: string }) {
  const from = parseUnixTimestampSeconds(query.from, 'from');
  const to = parseUnixTimestampSeconds(query.to, 'to');

  if (from > to) {
    throw new HttpError(400, 'invalid_parameter', 'Invalid time range: from must be less than or equal to to.');
  }

  return { from, to };
}

export function parseExplicitRange(query: { from: string; to: string }) {
  const from = parseUnixTimestampSeconds(query.from, 'from');
  const to = parseUnixTimestampSeconds(query.to, 'to');

  if (from > to) {
    throw new HttpError(400, 'invalid_parameter', 'Invalid time range: from must be less than or equal to to.');
  }

  return { from, to };
}

export function getChartRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
  const sourceRows = getSourceBackedChartRowsForDays(database, coinId, days, interval);

  if (sourceRows.length > 0) {
    return sourceRows;
  }

  return getCanonicalChartRowsForDays(database, coinId, days, interval);
}

export function getSourceBackedChartRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
  return normalizeChartRows(readMarketChartSourceRowsForDays(database, coinId, 'usd', days, interval));
}

export function getCanonicalChartRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
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

    return normalizeChartRows(downsampleTimeSeries(rows, getGranularityMs(duration, interval)));
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

  return normalizeChartRows(downsampleTimeSeries(filteredRows, getGranularityMs(dayCount * 24 * 60 * 60 * 1000, interval)));
}

export async function fetchProviderChartRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
  const ohlcRows = await fetchProviderOhlcRowsForDays(database, coinId, days, interval);

  return ohlcRows?.map((row) => ({
    timestamp: row.timestamp,
    price: row.close,
    marketCap: row.marketCap,
    totalVolume: row.totalVolume,
  })) ?? null;
}

export function getChartRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  const sourceRows = getSourceBackedChartRowsForRange(database, coinId, range, interval);

  if (sourceRows.length > 0) {
    return sourceRows;
  }

  return getCanonicalChartRowsForRange(database, coinId, range, interval);
}

export function getSourceBackedChartRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  return normalizeChartRows(readMarketChartSourceRowsForRange(database, coinId, 'usd', range, interval));
}

export function getCanonicalChartRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  const candleInterval = parseChartInterval(interval) === 'hourly' ? '1m' : '1d';
  const rows = candleInterval === '1d'
    ? getChartSeries(database, coinId, 'usd', range)
    : getCanonicalCandles(database, coinId, 'usd', candleInterval, range).map((row) => ({
      timestamp: row.timestamp,
      price: row.close,
      marketCap: row.marketCap,
      totalVolume: row.totalVolume,
    }));

  return normalizeChartRows(downsampleTimeSeries(rows, getGranularityMs(getRangeDurationMs(range), interval)));
}

export async function fetchProviderChartRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  const ohlcRows = await fetchProviderOhlcRowsForRange(database, coinId, range, interval);

  return ohlcRows?.map((row) => ({
    timestamp: row.timestamp,
    price: row.close,
    marketCap: row.marketCap,
    totalVolume: row.totalVolume,
  })) ?? null;
}

export function getOhlcRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
  const sourceRows = getSourceBackedOhlcRowsForDays(database, coinId, days, interval);

  if (sourceRows.length > 0) {
    return sourceRows;
  }

  return getCanonicalOhlcRowsForDays(database, coinId, days, interval);
}

export function getCanonicalOhlcRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
  const candleInterval = parseChartInterval(interval) === 'hourly' ? '1m' : '1d';
  const rows = getCanonicalCandles(database, coinId, 'usd', candleInterval);

  if (days === 'max') {
    return normalizeOhlcRows(rows);
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

  return normalizeOhlcRows(rows.filter((row) => row.timestamp.getTime() >= cutoff));
}

export function getSourceBackedOhlcRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
  return normalizeOhlcRows(readMarketChartSourceOhlcRowsForDays(database, coinId, 'usd', days, interval));
}

export async function fetchProviderOhlcRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
  if (parseChartInterval(interval) === 'hourly' || days === 'max') {
    return null;
  }

  const dayCount = Number(days);
  if (!Number.isFinite(dayCount) || dayCount <= 0) {
    return null;
  }

  return fetchProviderOhlcRows(database, coinId, Date.now() - dayCount * DAY_MS);
}

export async function fetchProviderOhlcRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  if (parseChartInterval(interval) === 'hourly') {
    return null;
  }

  const candles = await fetchProviderOhlcRows(database, coinId, range.from, Math.ceil((range.to - range.from) / DAY_MS) + 1);

  return candles?.filter((row) => {
    const timestamp = row.timestamp.getTime();

    return timestamp >= range.from && timestamp <= range.to;
  }) ?? null;
}

async function fetchProviderOhlcRows(database: AppDatabase, coinId: string, since: number, limit?: number) {
  const ticker = database.db
    .select()
    .from(coinTickers)
    .where(eq(coinTickers.coinId, coinId))
    .orderBy(asc(coinTickers.lastFetchAt), asc(coinTickers.exchangeId), asc(coinTickers.marketName))
    .limit(1)
    .get();

  if (!ticker) {
    return null;
  }

  const candles = await fetchExchangeOHLCV(
    ticker.exchangeId,
    ticker.marketName,
    '1d',
    since,
    limit,
  ).catch(() => null);

  if (!candles || candles.length === 0) {
    return null;
  }

  const rows = normalizeOhlcRows(candles.map((candle) => ({
    coinId,
    vsCurrency: 'usd',
    source: 'canonical',
    interval: '1d',
    timestamp: new Date(candle.timestamp),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    marketCap: null,
    totalVolume: candle.volume,
  })));

  for (const candle of rows) {
    upsertCanonicalOhlcvCandle(database, {
      coinId,
      vsCurrency: 'usd',
      interval: '1d',
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      totalVolume: candle.volume,
      replaceExisting: true,
    });
  }

  return rows;
}

export function getOhlcRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  const sourceRows = getSourceBackedOhlcRowsForRange(database, coinId, range, interval);

  if (sourceRows.length > 0) {
    return sourceRows;
  }

  return getCanonicalOhlcRowsForRange(database, coinId, range, interval);
}

export function getSourceBackedOhlcRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  return normalizeOhlcRows(readMarketChartSourceOhlcRowsForRange(database, coinId, 'usd', range, interval));
}

export function getCanonicalOhlcRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  const candleInterval = parseChartInterval(interval) === 'hourly' ? '1m' : '1d';

  return normalizeOhlcRows(getCanonicalCandles(database, coinId, 'usd', candleInterval, range));
}

export function buildChartPayload(
  database: AppDatabase,
  coinId: string,
  rows: Array<{ timestamp: Date; price: number; marketCap: number | null; totalVolume: number | null }>,
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: import('../market-freshness').SnapshotAccessPolicy,
  precision: number | 'full',
) {
  const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const normalizedRows = normalizeChartRows(deriveSparseChartFieldsFromCurrentMarket(
    rows,
    getCurrentMarketRatios(database, coinId),
  ));

  return {
    prices: normalizedRows.map((row) => [row.timestamp.getTime(), toNumberOrNull(row.price * rate, precision)]),
    market_caps: normalizedRows.map((row) => [row.timestamp.getTime(), toNumberOrNull(row.marketCap === null ? null : row.marketCap * rate, precision)]),
    total_volumes: normalizedRows.map((row) => [row.timestamp.getTime(), toNumberOrNull(row.totalVolume === null ? null : row.totalVolume * rate, precision)]),
  };
}

export function buildSupplySeriesRowsFromChart(
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
