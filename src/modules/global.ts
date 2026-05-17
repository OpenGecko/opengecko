import type { FastifyInstance } from 'fastify';
import BigNumber from 'bignumber.js';

import type { AppDatabase } from '../db/client';
import { chartPoints, type MarketSnapshotRow } from '../db/schema';
import { sendCacheableJson } from '../http/cache';
import { asc } from 'drizzle-orm';
import { getConversionRate, SUPPORTED_VS_CURRENCIES } from '../lib/conversion';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import { exchanges } from '../db/schema';
import { getCategories, getMarketRows, parseJsonArray } from './catalog';
import { getSnapshotAccessPolicy, getUsableSnapshot } from './market-freshness';
import { HttpError } from '../http/errors';
import { getChartGranularityMs, downsampleTimeSeries } from './chart-semantics';
import { z } from 'zod';
import { getCanonicalCandles } from '../services/candle-store';

function computeMarketCapChangePercentage24hUsd(
  marketRows: Array<{ snapshot: MarketSnapshotRow }>,
) {
  const currentMarketCapUsd = marketRows.reduce((sum, row) => sum.plus(row.snapshot.marketCap ?? 0), new BigNumber(0));
  const previousMarketCapUsd = marketRows.reduce((sum, row) => {
    const marketCap = row.snapshot.marketCap;
    const changePercentage = row.snapshot.priceChangePercentage24h;

    if (marketCap === null || changePercentage === null || changePercentage <= -100) {
      return sum;
    }

    return sum.plus(new BigNumber(marketCap).dividedBy(new BigNumber(1).plus(new BigNumber(changePercentage).dividedBy(100))));
  }, new BigNumber(0));

  if (previousMarketCapUsd.isZero()) {
    return 0;
  }

  return currentMarketCapUsd.minus(previousMarketCapUsd).dividedBy(previousMarketCapUsd).multipliedBy(100).toNumber();
}

function compareNullableNumbersDescending(left: number | null | undefined, right: number | null | undefined) {
  return (right ?? -Infinity) - (left ?? -Infinity);
}

function safePercentage(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }

  return (numerator / denominator) * 100;
}

function getLatestSnapshotTimestamp(
  rows: Array<{ snapshot: MarketSnapshotRow }>,
) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = row.snapshot.lastUpdated ?? row.snapshot.updatedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function getSnapshotProviderIds(rows: Array<{ snapshot: MarketSnapshotRow }>) {
  return [...new Set(rows.flatMap((row) => parseJsonArray<string>(row.snapshot.sourceProvidersJson)))]
    .filter((providerId) => providerId.trim().length > 0)
    .sort();
}

function buildDefiGlobalMeta(
  activeMarketRows: Array<{ snapshot: MarketSnapshotRow }>,
  defiMarketRows: Array<{ snapshot: MarketSnapshotRow }>,
) {
  const marketCapRowCount = defiMarketRows.filter((row) => Number.isFinite(row.snapshot.marketCap) && (row.snapshot.marketCap ?? 0) > 0).length;
  const volumeRowCount = defiMarketRows.filter((row) => Number.isFinite(row.snapshot.totalVolume) && (row.snapshot.totalVolume ?? 0) >= 0).length;
  const latestSourceAt = getLatestSnapshotTimestamp(activeMarketRows);
  const providerIds = getSnapshotProviderIds(activeMarketRows);
  const reasonCodes: string[] = [];

  if (activeMarketRows.length === 0) {
    reasonCodes.push('defi_source_unavailable');
  }

  if (defiMarketRows.length === 0 || marketCapRowCount === 0) {
    reasonCodes.push('defi_market_rows_sparse');
  }

  if (!latestSourceAt) {
    reasonCodes.push('missing_defi_source_timestamp');
  }

  const state = activeMarketRows.length === 0
    ? 'unavailable'
    : reasonCodes.length === 0
      ? 'live'
      : 'degraded';

  return {
    source: state === 'unavailable' ? 'unavailable' : 'market_snapshots',
    state,
    source_state: state,
    classification: state,
    live: state === 'live',
    unavailable: state === 'unavailable',
    degraded: state === 'degraded',
    fallback: state !== 'live',
    provider_ids: providerIds,
    latest_source_at: latestSourceAt?.toISOString() ?? null,
    usable_market_row_count: activeMarketRows.length,
    defi_market_row_count: defiMarketRows.length,
    market_cap_row_count: marketCapRowCount,
    volume_row_count: volumeRowCount,
    reason_codes: reasonCodes,
    note: state === 'live'
      ? 'DeFi global aggregates are derived from current market snapshot rows with provider and freshness evidence.'
      : 'DeFi global aggregates are returned with explicit degraded or unavailable provenance when source market snapshot coverage is sparse.',
  };
}

const globalMarketCapChartQuerySchema = z.object({
  vs_currency: z.string(),
  days: z.string(),
});

const GLOBAL_HTTP_CACHE_POLICY = {
  maxAgeSeconds: 60,
  staleWhileRevalidateSeconds: 60,
};

function getGlobalMarketCapChartRows(database: AppDatabase, days: string) {
  const allChartRows = database.db
    .select()
    .from(chartPoints)
    .orderBy(asc(chartPoints.timestamp))
    .all();
  const canonicalCandles = getCanonicalCandles(database, 'bitcoin', 'usd', '1d');
  const chartRowsByTimestamp = new Map<number, typeof allChartRows>();
  const bitcoinRows = allChartRows.filter((row) => row.coinId === 'bitcoin');

  for (const row of allChartRows) {
    const timestampMs = row.timestamp.getTime();
    chartRowsByTimestamp.set(timestampMs, [...(chartRowsByTimestamp.get(timestampMs) ?? []), row]);
  }

  const canonicalRows = canonicalCandles
    .map((anchorRow, matchingIndex) => {
      const timestampMs = anchorRow.timestamp.getTime();
      const rowsAtTimestamp = chartRowsByTimestamp.get(timestampMs) ?? [];

      const fallbackMarketCap = rowsAtTimestamp
        .find((row) => row.coinId === 'bitcoin')?.marketCap ?? null;

      if (rowsAtTimestamp.length > 0) {
        return rowsAtTimestamp;
      }

      return bitcoinRows
        .map((row) => ({
          ...row,
          timestamp: anchorRow.timestamp,
        }))
        .filter((_, index) => index === matchingIndex)
        .map((row) => ({
          ...row,
          marketCap: row.marketCap ?? fallbackMarketCap,
        }));
    })
    .flat();

  if (canonicalRows.length > 0) {
    const canonicalTimestamps = new Set(canonicalRows.map((row) => row.timestamp.getTime()));
    const nonCanonicalRows = allChartRows.filter((row) => !canonicalTimestamps.has(row.timestamp.getTime()));
    const aggregateRows = [...canonicalRows, ...nonCanonicalRows].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

    if (days === 'max') {
      return aggregateRows;
    }

    const parsedDays = Number(days);

    if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
      throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
    }

    const latestTimestamp = aggregateRows.at(-1)?.timestamp.getTime();
    const cutoffMs = latestTimestamp === undefined
      ? Date.now() - parsedDays * 24 * 60 * 60 * 1000
      : latestTimestamp - parsedDays * 24 * 60 * 60 * 1000;

    return aggregateRows.filter((row) => row.timestamp.getTime() >= cutoffMs);
  }

  if (days === 'max') {
    return allChartRows;
  }

  const parsedDays = Number(days);

  if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
  }

  const cutoffMs = Date.now() - parsedDays * 24 * 60 * 60 * 1000;

  return allChartRows.filter((row) => row.timestamp.getTime() >= cutoffMs);
}

function buildGlobalChartMeta(rows: Array<{ timestamp: Date; marketCap: number }>) {
  const latestTimestamp = rows.reduce<Date | null>((latest, row) =>
    latest === null || row.timestamp.getTime() > latest.getTime() ? row.timestamp : latest, null);

  return {
    fixture: rows.length === 0,
    source: rows.length > 0 ? 'market_snapshots' : 'fixture',
    updated_at: latestTimestamp?.toISOString() ?? null,
    point_count: rows.length,
    note: rows.length > 0
      ? 'Global market cap chart is derived from persisted market/chart snapshots'
      : 'Global market cap chart has no persisted data available',
  };
}

export function registerGlobalRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
) {
  app.get('/global/market_cap_chart', async (request, reply) => {
    const query = globalMarketCapChartQuerySchema.parse(request.query);
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    const vsCurrency = query.vs_currency.toLowerCase();
    const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
    const rows = getGlobalMarketCapChartRows(database, query.days);

    const groupedRows = new Map<number, number>();

    for (const row of rows) {
      const timestamp = row.timestamp.getTime();
      groupedRows.set(
        timestamp,
        new BigNumber(groupedRows.get(timestamp) ?? 0).plus(new BigNumber(row.marketCap ?? 0).multipliedBy(rate)).toNumber(),
      );
    }

    const orderedRows = [...groupedRows.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([timestamp, marketCap]) => ({
        timestamp: new Date(timestamp),
        marketCap,
      }));

    const downsampledRows = downsampleTimeSeries(
      orderedRows,
      getChartGranularityMs(orderedRows.length > 1 ? orderedRows.at(-1)!.timestamp.getTime() - orderedRows[0]!.timestamp.getTime() : 0),
    );

    return sendCacheableJson(request, reply, {
      market_cap_chart: downsampledRows.map((row) => [row.timestamp.getTime(), row.marketCap]),
      meta: buildGlobalChartMeta(downsampledRows),
    }, GLOBAL_HTTP_CACHE_POLICY);
  });

  app.get('/global/decentralized_finance_defi', async (request, reply) => {
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    const marketRows = getMarketRows(database, 'usd', { status: 'active' })
      .map((row) => ({
        coin: row.coin,
        snapshot: getUsableSnapshot(row.snapshot, marketFreshnessThresholdSeconds, snapshotAccessPolicy),
      }));

    const stablecoinCategoryIds = new Set(
      getCategories(database)
        .filter((category) => category.id === 'stablecoins')
        .map((category) => category.id),
    );

    const activeMarketRows = marketRows
      .filter((row): row is typeof row & { snapshot: NonNullable<typeof row.snapshot> } => row.snapshot !== null);
    const defiMarketRows = activeMarketRows.filter((row) => !parseJsonArray<string>(row.coin.categoriesJson)
      .map((categoryId) => categoryId.toLowerCase())
      .some((categoryId) => stablecoinCategoryIds.has(categoryId)));

    const defiMarketCap = defiMarketRows.reduce((sum, row) => sum.plus(row.snapshot.marketCap ?? 0), new BigNumber(0)).toNumber();
    const tradingVolume24h = defiMarketRows.reduce((sum, row) => sum.plus(row.snapshot.totalVolume ?? 0), new BigNumber(0)).toNumber();
    const ethMarketCap = activeMarketRows.find((row) => row.coin.id === 'ethereum')?.snapshot.marketCap ?? 0;
    const totalMarketCapUsd = activeMarketRows.reduce((sum, row) => sum.plus(row.snapshot.marketCap ?? 0), new BigNumber(0)).toNumber();
    const topCoin = [...defiMarketRows]
      .sort((left, right) => compareNullableNumbersDescending(left.snapshot.marketCap, right.snapshot.marketCap))[0];
    const topCoinMarketCap = topCoin?.snapshot.marketCap ?? 0;

    return sendCacheableJson(request, reply, {
      data: {
        defi_market_cap: defiMarketCap,
        eth_market_cap: ethMarketCap,
        defi_to_eth_ratio: ethMarketCap > 0 ? defiMarketCap / ethMarketCap : null,
        trading_volume_24h: tradingVolume24h,
        defi_dominance: totalMarketCapUsd > 0 ? (defiMarketCap / totalMarketCapUsd) * 100 : null,
        top_coin_name: topCoin?.coin.name ?? null,
        top_coin_defi_dominance: defiMarketCap > 0 ? (topCoinMarketCap / defiMarketCap) * 100 : null,
      },
      meta: buildDefiGlobalMeta(activeMarketRows, defiMarketRows),
    }, GLOBAL_HTTP_CACHE_POLICY);
  });

  app.get('/global', async (request, reply) => {
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    const marketRows = getMarketRows(database, 'usd', { status: 'active' })
      .map((row) => ({
        coin: row.coin,
        snapshot: getUsableSnapshot(row.snapshot, marketFreshnessThresholdSeconds, snapshotAccessPolicy),
      }))
      .filter((row): row is typeof row & { snapshot: NonNullable<typeof row.snapshot> } => row.snapshot !== null);
    const activeCoinCount = getMarketRows(database, 'usd', { status: 'active' }).length;
    const exchangeCount = database.db.select().from(exchanges).all().length;
    const totalMarketCapUsd = marketRows.reduce((sum, row) => sum.plus(row.snapshot?.marketCap ?? 0), new BigNumber(0)).toNumber();
    const totalVolumeUsd = marketRows.reduce((sum, row) => sum.plus(row.snapshot?.totalVolume ?? 0), new BigNumber(0)).toNumber();
    const totalMarketCap = Object.fromEntries(
      SUPPORTED_VS_CURRENCIES.map((currency) => [currency, totalMarketCapUsd * getConversionRate(database, currency, marketFreshnessThresholdSeconds, snapshotAccessPolicy)]),
    );
    const totalVolume = Object.fromEntries(
      SUPPORTED_VS_CURRENCIES.map((currency) => [currency, totalVolumeUsd * getConversionRate(database, currency, marketFreshnessThresholdSeconds, snapshotAccessPolicy)]),
    );
    const btcMarketCap = marketRows.find((row) => row.coin.id === 'bitcoin')?.snapshot?.marketCap ?? 0;
    const ethMarketCap = marketRows.find((row) => row.coin.id === 'ethereum')?.snapshot?.marketCap ?? 0;
    const usdcMarketCap = marketRows.find((row) => row.coin.id === 'usd-coin')?.snapshot?.marketCap ?? 0;
    const preferredDominanceCoinIds = ['bitcoin', 'ethereum', 'tether', 'binancecoin', 'ripple', 'usd-coin', 'solana'];
    const marketCapPercentage = Object.fromEntries(
      marketRows
        .filter((row) => preferredDominanceCoinIds.includes(row.coin.id))
        .sort((left, right) => {
          const leftIndex = preferredDominanceCoinIds.indexOf(left.coin.id);
          const rightIndex = preferredDominanceCoinIds.indexOf(right.coin.id);
          return leftIndex - rightIndex;
        })
        .map((row) => [row.coin.symbol.toLowerCase(), safePercentage(row.snapshot.marketCap ?? 0, totalMarketCapUsd)]),
    );
    const volumeChangePercentage24hUsd = totalVolumeUsd === 0
      ? new BigNumber(0)
      : marketRows.reduce((sum, row) => {
        const volume = row.snapshot.totalVolume;
        const changePercentage = row.snapshot.priceChangePercentage24h;

        if (volume === null || changePercentage === null || changePercentage <= -100) {
          return sum;
        }

        return sum.plus(new BigNumber(volume).dividedBy(new BigNumber(1).plus(new BigNumber(changePercentage).dividedBy(100))));
      }, new BigNumber(0));
    const updatedAt = marketRows.reduce((maxTimestamp, row) => Math.max(maxTimestamp, row.snapshot.lastUpdated.getTime()), 0);

    return sendCacheableJson(request, reply, {
      data: {
        active_cryptocurrencies: activeCoinCount,
        upcoming_icos: 0,
        ongoing_icos: 0,
        ended_icos: 0,
        markets: exchangeCount,
        total_market_cap: totalMarketCap,
        total_volume: totalVolume,
        market_cap_percentage: {
          btc: safePercentage(btcMarketCap, totalMarketCapUsd),
          eth: safePercentage(ethMarketCap, totalMarketCapUsd),
          usdc: safePercentage(usdcMarketCap, totalMarketCapUsd),
          ...marketCapPercentage,
        },
        market_cap_change_percentage_24h_usd: computeMarketCapChangePercentage24hUsd(marketRows),
        volume_change_percentage_24h_usd: volumeChangePercentage24hUsd.isZero()
          ? 0
          : new BigNumber(totalVolumeUsd).minus(volumeChangePercentage24hUsd).dividedBy(volumeChangePercentage24hUsd).multipliedBy(100).toNumber(),
        updated_at: Math.floor(updatedAt / 1000),
      },
    }, GLOBAL_HTTP_CACHE_POLICY);
  });
}
