import type { FastifyInstance } from 'fastify';
import { asc } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { HttpError } from '../http/errors';
import { exchanges } from '../db/schema';
import { searchDocuments } from '../db/search-index';
import { getCategories, getCoins, getMarketRows, parseJsonArray } from './catalog';

const searchQuerySchema = z.object({
  query: z.string().trim().min(1),
});

const trendingQuerySchema = z.object({
  show_max: z.string().optional(),
});

function parseShowMax(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid show_max value: ${value}`);
  }

  return Number.parseInt(value, 10);
}

function getRankDrivenScore(marketCapRank: number | null | undefined) {
  return marketCapRank ?? 0;
}

function compareAscendingRankWithNullsLast(
  left: { marketCapRank: number | null; coinId: string },
  right: { marketCapRank: number | null; coinId: string },
) {
  const rankDelta = (left.marketCapRank ?? Number.MAX_SAFE_INTEGER) - (right.marketCapRank ?? Number.MAX_SAFE_INTEGER);

  if (rankDelta !== 0) {
    return rankDelta;
  }

  return left.coinId.localeCompare(right.coinId);
}

export function registerSearchRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/search', async (request) => {
    const query = searchQuerySchema.parse(request.query).query.toLowerCase();
    const matches = searchDocuments(database, query, 20);
    const marketRows = getMarketRows(database, 'usd', { status: 'all' });
    const marketRowById = new Map(marketRows.map((row) => [row.coin.id, row]));
    const coinOrder = matches.filter((match) => match.docType === 'coin').map((match) => match.refId);
    const categoryOrder = matches.filter((match) => match.docType === 'category').map((match) => match.refId);
    const exchangeOrder = matches.filter((match) => match.docType === 'exchange').map((match) => match.refId);
    const coinById = new Map(getCoins(database, { status: 'all' }).map((coin) => [coin.id, coin]));
    const categoryById = new Map(getCategories(database).map((category) => [category.id, category]));
    const exchangeById = new Map(database.db.select().from(exchanges).orderBy(asc(exchanges.id)).all().map((exchange) => [exchange.id, exchange]));

    const coins = coinOrder
      .map((coinId) => coinById.get(coinId))
      .filter((coin): coin is NonNullable<typeof coin> => Boolean(coin))
      .slice(0, 10)
      .map((coin) => {
        const marketRow = marketRowById.get(coin.id);

        return {
          id: coin.id,
          name: coin.name,
          api_symbol: coin.apiSymbol,
          symbol: coin.symbol,
          market_cap_rank: coin.marketCapRank,
          thumb: coin.imageThumbUrl,
          large: coin.imageLargeUrl,
          categories: parseJsonArray<string>(coin.categoriesJson),
        };
      });

    const categories = categoryOrder
      .map((categoryId) => categoryById.get(categoryId))
      .filter((category): category is NonNullable<typeof category> => Boolean(category))
      .slice(0, 10)
      .map((category) => ({
        id: category.id,
        name: category.name,
      }));

    const exchangeResults = exchangeOrder
      .map((exchangeId) => exchangeById.get(exchangeId))
      .filter((exchange): exchange is NonNullable<typeof exchange> => Boolean(exchange))
      .slice(0, 10)
      .map((exchange) => ({
        id: exchange.id,
        name: exchange.name,
        market_type: exchange.centralised ? 'cex' : 'dex',
        thumb: exchange.imageUrl,
        large: exchange.imageUrl,
      }));

    return {
      coins,
      exchanges: exchangeResults,
      icos: [],
      categories,
      nfts: [],
    };
  });

  app.get('/search/trending', async (request) => {
    const query = trendingQuerySchema.parse(request.query);
    const showMax = parseShowMax(query.show_max);
    const marketRows = getMarketRows(database, 'usd', { status: 'all' });
    const coins = marketRows
      .filter((row) => row.snapshot !== null)
      .map((row) => ({
        row,
        marketCapRank: row.snapshot?.marketCapRank ?? row.coin.marketCapRank ?? null,
      }))
      .sort((left, right) => compareAscendingRankWithNullsLast(
        { marketCapRank: left.marketCapRank, coinId: left.row.coin.id },
        { marketCapRank: right.marketCapRank, coinId: right.row.coin.id },
      ))
      .slice(0, showMax ?? 7)
      .map(({ row, marketCapRank }) => {
        const snapshot = row.snapshot;

        if (!snapshot) {
          return null;
        }

        return ({
          item: {
            id: row.coin.id,
            coin_id: getRankDrivenScore(marketCapRank),
            name: row.coin.name,
            symbol: row.coin.symbol,
            market_cap_rank: marketCapRank ?? null,
            thumb: row.coin.imageThumbUrl,
            small: row.coin.imageSmallUrl,
            large: row.coin.imageLargeUrl,
            slug: row.coin.id,
            price_btc: snapshot.price / 85_000,
            score: getRankDrivenScore(marketCapRank),
            data: {
              price: snapshot.price,
              price_btc: snapshot.price / 85_000,
              market_cap: snapshot.marketCap,
              market_cap_btc: snapshot.marketCap ? snapshot.marketCap / 85_000 : null,
              total_volume: snapshot.totalVolume,
              total_volume_btc: snapshot.totalVolume ? snapshot.totalVolume / 85_000 : null,
              sparkline: '',
              content: null,
            },
          },
        });
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    const categories = getCategories(database)
      .slice()
      .sort((left, right) => {
        const marketCapDelta = (right.marketCap ?? 0) - (left.marketCap ?? 0);

        if (marketCapDelta !== 0) {
          return marketCapDelta;
        }

        return left.id.localeCompare(right.id);
      })
      .slice(0, showMax ?? 7)
      .map((category, index) => ({
        id: index + 1,
        name: category.name,
        market_cap_1h_change: category.marketCapChange24h,
        slug: category.id,
        coins_count: parseJsonArray<string>(category.top3CoinsJson).length,
        data: {
          market_cap: category.marketCap,
          market_cap_btc: category.marketCap ? category.marketCap / 85_000 : null,
          total_volume: category.volume24h,
          total_volume_btc: category.volume24h ? category.volume24h / 85_000 : null,
          sparkline: '',
          content: category.content,
        },
      }));

    return {
      coins,
      nfts: [],
      categories,
    };
  });
}
