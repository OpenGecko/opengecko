import type { FastifyInstance } from 'fastify';
import { count } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import type { MarketSnapshotRow } from '../db/schema';
import { getConversionRate, SUPPORTED_VS_CURRENCIES } from '../lib/conversion';
import { exchanges } from '../db/schema';
import { getMarketRows } from './catalog';
import { getUsableSnapshot } from './market-freshness';

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

export function registerGlobalRoutes(app: FastifyInstance, database: AppDatabase, marketFreshnessThresholdSeconds: number) {
  app.get('/global', async () => {
    const marketRows = getMarketRows(database, 'usd', { status: 'active' })
      .map((row) => ({
        coin: row.coin,
        snapshot: getUsableSnapshot(row.snapshot, marketFreshnessThresholdSeconds),
      }))
      .filter((row): row is typeof row & { snapshot: NonNullable<typeof row.snapshot> } => row.snapshot !== null);
    const activeCoinCount = getMarketRows(database, 'usd', { status: 'active' }).length;
    const [{ value: exchangeCount }] = database.db.select({ value: count() }).from(exchanges).all();
    const totalMarketCapUsd = marketRows.reduce((sum, row) => sum + (row.snapshot?.marketCap ?? 0), 0);
    const totalVolumeUsd = marketRows.reduce((sum, row) => sum + (row.snapshot?.totalVolume ?? 0), 0);
    const totalMarketCap = Object.fromEntries(
      SUPPORTED_VS_CURRENCIES.map((currency) => [currency, totalMarketCapUsd * getConversionRate(database, currency, marketFreshnessThresholdSeconds)]),
    );
    const totalVolume = Object.fromEntries(
      SUPPORTED_VS_CURRENCIES.map((currency) => [currency, totalVolumeUsd * getConversionRate(database, currency, marketFreshnessThresholdSeconds)]),
    );
    const btcMarketCap = marketRows.find((row) => row.coin.id === 'bitcoin')?.snapshot?.marketCap ?? 0;
    const ethMarketCap = marketRows.find((row) => row.coin.id === 'ethereum')?.snapshot?.marketCap ?? 0;
    const usdcMarketCap = marketRows.find((row) => row.coin.id === 'usd-coin')?.snapshot?.marketCap ?? 0;
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
        },
        market_cap_change_percentage_24h_usd: computeMarketCapChangePercentage24hUsd(marketRows),
        updated_at: Math.floor(updatedAt / 1000),
      },
    };
  });
}
