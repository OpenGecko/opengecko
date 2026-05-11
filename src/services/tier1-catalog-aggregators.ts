import BigNumber from 'bignumber.js';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { rebuildSearchIndex, type AppDatabase } from '../db/client';
import { categories, chartPoints, coins, marketSnapshots } from '../db/schema';
import { normalizeCategoryId, parseJsonArray } from '../lib/shared';
import type { ExchangeId } from '../providers/ccxt';
import { syncCoinCatalogFromExchanges } from './coin-catalog-sync';
import { syncExchangesFromCCXT } from './initial-sync';

function categoryNameFromId(id: string) {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function computeChangePercentage(current: BigNumber, previous: BigNumber) {
  if (previous.isZero()) {
    return 0;
  }

  return current.minus(previous).dividedBy(previous).multipliedBy(100).toNumber();
}

export async function runCoinCatalogRescan(
  database: AppDatabase,
  exchangeIds: ExchangeId[],
  logger?: Logger,
  concurrency = exchangeIds.length,
) {
  const result = await syncCoinCatalogFromExchanges(database, exchangeIds, logger, concurrency);
  rebuildSearchIndex(database);

  return {
    targetsProcessed: exchangeIds.length,
    insertedOrUpdated: result.insertedOrUpdated,
  };
}

export async function runExchangeMetadataRescan(
  database: AppDatabase,
  exchangeIds: ExchangeId[],
  logger: Logger,
  concurrency = exchangeIds.length,
) {
  const result = await syncExchangesFromCCXT(database, exchangeIds, logger, concurrency);
  rebuildSearchIndex(database);

  return {
    targetsProcessed: result.succeededExchangeIds.length,
    succeededExchangeIds: result.succeededExchangeIds,
    failedExchangeIds: result.failedExchangeIds,
  };
}

export async function runGlobalAggregator(database: AppDatabase) {
  const snapshots = database.db.select().from(marketSnapshots).all();

  if (snapshots.length === 0) {
    return { targetsProcessed: 0 };
  }

  const timestamp = new Date(Math.max(...snapshots.map((snapshot) => snapshot.lastUpdated.getTime())));

  for (const snapshot of snapshots) {
    database.db
      .insert(chartPoints)
      .values({
        coinId: snapshot.coinId,
        vsCurrency: snapshot.vsCurrency,
        timestamp,
        price: snapshot.price,
        marketCap: snapshot.marketCap,
        totalVolume: snapshot.totalVolume,
      })
      .onConflictDoUpdate({
        target: [chartPoints.coinId, chartPoints.vsCurrency, chartPoints.timestamp],
        set: {
          price: snapshot.price,
          marketCap: snapshot.marketCap,
          totalVolume: snapshot.totalVolume,
        },
      })
      .run();
  }

  return { targetsProcessed: snapshots.length };
}

export async function runCategoryAggregator(database: AppDatabase) {
  const existingCategories = new Map(database.db.select().from(categories).all().map((category) => [category.id, category]));
  const marketRows = database.db
    .select()
    .from(coins)
    .leftJoin(marketSnapshots, eq(marketSnapshots.coinId, coins.id))
    .all()
    .filter((row) => row.coins.status === 'active' && row.market_snapshots?.vsCurrency === 'usd');
  const categoryIds = new Set<string>(existingCategories.keys());

  for (const row of marketRows) {
    for (const categoryId of parseJsonArray<string>(row.coins.categoriesJson).map((value) => normalizeCategoryId(value))) {
      if (categoryId) {
        categoryIds.add(categoryId);
      }
    }
  }

  const now = new Date();
  let updated = 0;

  for (const categoryId of categoryIds) {
    const members = marketRows
      .filter((row) => parseJsonArray<string>(row.coins.categoriesJson)
        .map((value) => normalizeCategoryId(value))
        .includes(categoryId))
      .filter((row): row is typeof row & { market_snapshots: NonNullable<typeof row.market_snapshots> } => row.market_snapshots !== null);

    const marketCap = members.reduce((sum, row) => sum.plus(row.market_snapshots.marketCap ?? 0), new BigNumber(0));
    const volume24h = members.reduce((sum, row) => sum.plus(row.market_snapshots.totalVolume ?? 0), new BigNumber(0));
    const previousMarketCap = members.reduce((sum, row) => {
      const currentMarketCap = row.market_snapshots.marketCap;
      const changePercentage = row.market_snapshots.priceChangePercentage24h;

      if (currentMarketCap === null || changePercentage === null || changePercentage <= -100) {
        return sum;
      }

      return sum.plus(new BigNumber(currentMarketCap).dividedBy(new BigNumber(1).plus(new BigNumber(changePercentage).dividedBy(100))));
    }, new BigNumber(0));
    const top3CoinIds = members
      .slice()
      .sort((left, right) => (right.market_snapshots.marketCap ?? -Infinity) - (left.market_snapshots.marketCap ?? -Infinity))
      .slice(0, 3)
      .map((row) => row.coins.id);
    const existing = existingCategories.get(categoryId);

    database.db
      .insert(categories)
      .values({
        id: categoryId,
        name: existing?.name ?? categoryNameFromId(categoryId),
        marketCap: marketCap.toNumber(),
        marketCapChange24h: computeChangePercentage(marketCap, previousMarketCap),
        volume24h: volume24h.toNumber(),
        content: existing?.content ?? null,
        top3CoinsJson: JSON.stringify(top3CoinIds),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: categories.id,
        set: {
          marketCap: marketCap.toNumber(),
          marketCapChange24h: computeChangePercentage(marketCap, previousMarketCap),
          volume24h: volume24h.toNumber(),
          top3CoinsJson: JSON.stringify(top3CoinIds),
          updatedAt: now,
        },
      })
      .run();
    updated += 1;
  }

  rebuildSearchIndex(database);
  return { targetsProcessed: updated };
}
