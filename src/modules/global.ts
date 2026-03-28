import type { FastifyInstance } from 'fastify';

import type { AppDatabase } from '../db/client';
import { chartPoints, type MarketSnapshotRow } from '../db/schema';
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
  const currentMarketCapUsd = marketRows.reduce((sum, row) => sum + (row.snapshot.marketCap ?? 0), 0);
  const previousMarketCapUsd = marketRows.reduce((sum, row) => {
    const marketCap = row.snapshot.marketCap;
    const changePercentage = row.snapshot.priceChangePercentage24h;

    if (marketCap === null || changePercentage === null || changePercentage <= -100) {
      return sum;
    }

    return sum + (marketCap / (1 + (changePercentage / 100)));
  }, 0);

  if (previousMarketCapUsd === 0) {
    return 0;
  }

  return ((currentMarketCapUsd - previousMarketCapUsd) / previousMarketCapUsd) * 100;
}

const globalMarketCapChartQuerySchema = z.object({
  vs_currency: z.string(),
  days: z.string(),
});

function getGlobalMarketCapChartRows(database: AppDatabase, days: string) {
  const canonicalRows = getCanonicalCandles(database, 'bitcoin', 'usd', '1d')
    .map((anchorRow) => {
      const timestampMs = anchorRow.timestamp.getTime();
      const rowsAtTimestamp = database.db
        .select()
        .from(chartPoints)
        .orderBy(asc(chartPoints.timestamp))
        .all()
        .filter((row) => row.timestamp.getTime() === timestampMs);

      const fallbackMarketCap = database.db
        .select()
        .from(chartPoints)
        .orderBy(asc(chartPoints.timestamp))
        .all()
        .filter((row) => row.coinId === 'bitcoin' && row.timestamp.getTime() === timestampMs)
        .at(0)?.marketCap ?? null;

      if (rowsAtTimestamp.length > 0) {
        return rowsAtTimestamp;
      }

      const canonicalSeriesRows = database.db
        .select()
        .from(chartPoints)
        .orderBy(asc(chartPoints.timestamp))
        .all()
        .filter((row) => row.coinId === 'bitcoin');

      const matchingIndex = getCanonicalCandles(database, 'bitcoin', 'usd', '1d')
        .findIndex((row) => row.timestamp.getTime() === timestampMs);

      if (matchingIndex === -1) {
        return [];
      }

      return canonicalSeriesRows
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
    if (days === 'max') {
      return canonicalRows;
    }

    const parsedDays = Number(days);

    if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
      throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
    }

    const latestTimestamp = canonicalRows.at(-1)?.timestamp.getTime();
    const cutoffMs = latestTimestamp === undefined
      ? Date.now() - parsedDays * 24 * 60 * 60 * 1000
      : latestTimestamp - parsedDays * 24 * 60 * 60 * 1000;

    return canonicalRows.filter((row) => row.timestamp.getTime() >= cutoffMs);
  }

  const allRows = database.db
    .select()
    .from(chartPoints)
    .orderBy(asc(chartPoints.timestamp))
    .all();

  if (days === 'max') {
    return allRows;
  }

  const parsedDays = Number(days);

  if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
  }

  const cutoffMs = Date.now() - parsedDays * 24 * 60 * 60 * 1000;

  return allRows.filter((row) => row.timestamp.getTime() >= cutoffMs);
}

export function registerGlobalRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
) {
  app.get('/global/market_cap_chart', async (request) => {
    const query = globalMarketCapChartQuerySchema.parse(request.query);
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    const vsCurrency = query.vs_currency.toLowerCase();
    const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
    const rows = getGlobalMarketCapChartRows(database, query.days);

    const groupedRows = new Map<number, number>();

    for (const row of rows) {
      const timestamp = row.timestamp.getTime();
      groupedRows.set(timestamp, (groupedRows.get(timestamp) ?? 0) + ((row.marketCap ?? 0) * rate));
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

    return {
      market_cap_chart: downsampledRows.map((row) => [row.timestamp.getTime(), row.marketCap]),
    };
  });

  app.get('/global/decentralized_finance_defi', async () => {
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

    const defiMarketCap = defiMarketRows.reduce((sum, row) => sum + (row.snapshot.marketCap ?? 0), 0);
    const tradingVolume24h = defiMarketRows.reduce((sum, row) => sum + (row.snapshot.totalVolume ?? 0), 0);
    const ethMarketCap = activeMarketRows.find((row) => row.coin.id === 'ethereum')?.snapshot.marketCap ?? 0;
    const totalMarketCapUsd = activeMarketRows.reduce((sum, row) => sum + (row.snapshot.marketCap ?? 0), 0);
    const topCoin = [...defiMarketRows]
      .sort((left, right) => (right.snapshot.marketCap ?? 0) - (left.snapshot.marketCap ?? 0))[0];
    const topCoinMarketCap = topCoin?.snapshot.marketCap ?? 0;

    return {
      data: {
        defi_market_cap: defiMarketCap,
        eth_market_cap: ethMarketCap,
        defi_to_eth_ratio: ethMarketCap > 0 ? defiMarketCap / ethMarketCap : null,
        trading_volume_24h: tradingVolume24h,
        defi_dominance: totalMarketCapUsd > 0 ? (defiMarketCap / totalMarketCapUsd) * 100 : null,
        top_coin_name: topCoin?.coin.name ?? null,
        top_coin_defi_dominance: defiMarketCap > 0 ? (topCoinMarketCap / defiMarketCap) * 100 : null,
      },
    };
  });

  app.get('/global', async () => {
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    const marketRows = getMarketRows(database, 'usd', { status: 'active' })
      .map((row) => ({
        coin: row.coin,
        snapshot: getUsableSnapshot(row.snapshot, marketFreshnessThresholdSeconds, snapshotAccessPolicy),
      }))
      .filter((row): row is typeof row & { snapshot: NonNullable<typeof row.snapshot> } => row.snapshot !== null);
    const activeCoinCount = getMarketRows(database, 'usd', { status: 'active' }).length;
    const exchangeCount = database.db.select().from(exchanges).all().length;
    const totalMarketCapUsd = marketRows.reduce((sum, row) => sum + (row.snapshot?.marketCap ?? 0), 0);
    const totalVolumeUsd = marketRows.reduce((sum, row) => sum + (row.snapshot?.totalVolume ?? 0), 0);
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
        .map((row) => [row.coin.symbol.toLowerCase(), totalMarketCapUsd === 0 ? 0 : ((row.snapshot.marketCap ?? 0) / totalMarketCapUsd) * 100]),
    );
    const volumeChangePercentage24hUsd = totalVolumeUsd === 0
      ? 0
      : marketRows.reduce((sum, row) => {
        const volume = row.snapshot.totalVolume;
        const changePercentage = row.snapshot.priceChangePercentage24h;

        if (volume === null || changePercentage === null || changePercentage <= -100) {
          return sum;
        }

        return sum + (volume / (1 + (changePercentage / 100)));
      }, 0);
    const updatedAt = marketRows.reduce((maxTimestamp, row) => Math.max(maxTimestamp, row.snapshot.lastUpdated.getTime()), 0);

    return {
      data: {
        active_cryptocurrencies: activeCoinCount,
        upcoming_icos: 0,
        ongoing_icos: 0,
        ended_icos: 0,
        markets: exchangeCount,
        total_market_cap: totalMarketCap,
        total_volume: totalVolume,
        market_cap_percentage: {
          btc: totalMarketCapUsd === 0 ? 0 : (btcMarketCap / totalMarketCapUsd) * 100,
          eth: totalMarketCapUsd === 0 ? 0 : (ethMarketCap / totalMarketCapUsd) * 100,
          usdc: totalMarketCapUsd === 0 ? 0 : (usdcMarketCap / totalMarketCapUsd) * 100,
          ...marketCapPercentage,
        },
        market_cap_change_percentage_24h_usd: computeMarketCapChangePercentage24hUsd(marketRows),
        volume_change_percentage_24h_usd: volumeChangePercentage24hUsd === 0
          ? 0
          : ((totalVolumeUsd - volumeChangePercentage24hUsd) / volumeChangePercentage24hUsd) * 100,
        updated_at: Math.floor(updatedAt / 1000),
      },
    };
  });
}
