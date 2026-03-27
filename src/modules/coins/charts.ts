import type { AppDatabase } from '../../db/client';
import type { MarketSnapshotRow } from '../../db/schema';
import { HttpError } from '../../http/errors';
import { getConversionRate } from '../../lib/conversion';
import { getChartSeries, getMarketRows } from '../catalog';
import { downsampleTimeSeries, getRangeDurationMs } from '../chart-semantics';
import { getCanonicalCandles } from '../../services/candle-store';
import { getGranularityMs, parseChartInterval, parseUnixTimestampSeconds, toNumberOrNull } from './helpers';

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

export function getChartRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
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

export function getOhlcRowsForDays(database: AppDatabase, coinId: string, days: string, interval?: string) {
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

export function getOhlcRowsForRange(database: AppDatabase, coinId: string, range: { from: number; to: number }, interval?: string) {
  const candleInterval = parseChartInterval(interval) === 'hourly' ? '1m' : '1d';

  return getCanonicalCandles(database, coinId, 'usd', candleInterval, range);
}

export function buildChartPayload(
  database: AppDatabase,
  rows: Array<{ timestamp: Date; price: number; marketCap: number | null; totalVolume: number | null }>,
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: import('../market-freshness').SnapshotAccessPolicy,
  precision: number | 'full',
) {
  const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);

  return {
    prices: rows.map((row) => [row.timestamp.getTime(), toNumberOrNull(row.price * rate, precision)]),
    market_caps: rows.map((row) => [row.timestamp.getTime(), toNumberOrNull(row.marketCap ? row.marketCap * rate : null, precision)]),
    total_volumes: rows.map((row) => [row.timestamp.getTime(), toNumberOrNull(row.totalVolume ? row.totalVolume * rate : null, precision)]),
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
