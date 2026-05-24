import { sendCacheableJson } from '../../http/cache';
import { HttpError } from '../../http/errors';
import { getCategories, getCoins, parseJsonArray } from '../catalog';
import { sortNumber } from './helpers';
import { categoriesQuerySchema } from './query-schemas';
import type { CoinsRouteContext } from './route-context';

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

const SEEDED_CATEGORY_TIMESTAMP_MS = Date.parse('2026-03-20T00:00:00.000Z');

function categoriesAreLiveAggregated(rows: ReturnType<typeof getCategories>) {
  return rows.some((category) => category.updatedAt.getTime() > SEEDED_CATEGORY_TIMESTAMP_MS);
}

function buildFixtureAwareMeta(options: {
  fixture: boolean;
  countKey: string;
  count: number;
  updatedAt: Date | null;
  fixtureNote: string;
  liveNote: string;
}) {
  return {
    fixture: options.fixture,
    [options.countKey]: options.count,
    source: options.fixture ? 'fixture' : 'live',
    updated_at: options.updatedAt?.toISOString() ?? null,
    note: options.fixture ? options.fixtureNote : options.liveNote,
  };
}

function buildCategoryTopCoinFields(
  database: CoinsRouteContext['database'],
  topCoinIds: string[],
) {
  const coinById = new Map(getCoins(database, { status: 'all' }).map((coin) => [coin.id, coin]));
  const topCoinImages = topCoinIds.map((coinId) => {
    const coin = coinById.get(coinId);

    return coin?.imageSmallUrl ?? coin?.imageThumbUrl ?? coin?.imageLargeUrl ?? coinId;
  });

  return {
    top_3_coins: topCoinImages,
    top_3_coins_id: topCoinIds,
  };
}

export function registerCoinCategoryRoutes({ app, database }: CoinsRouteContext) {
  app.get('/coins/categories/list', async (request, reply) => {
    const categories = getCategories(database);

    return sendCacheableJson(request, reply, categories.map((category) => ({
        category_id: category.id,
        name: category.name,
      })), {
      maxAgeSeconds: 3_600,
      staleWhileRevalidateSeconds: 3_600,
    });
  });

  app.get('/coins/categories', async (request, reply) => {
    const query = categoriesQuerySchema.parse(request.query);
    const sorted = sortCategories(getCategories(database), query.order);
    const fixture = !categoriesAreLiveAggregated(sorted);

    return sendCacheableJson(request, reply, {
      data: sorted.map((category) => {
        const topCoinIds = parseJsonArray<string>(category.top3CoinsJson);

        return {
          id: category.id,
          name: category.name,
          market_cap: category.marketCap,
          market_cap_change_24h: category.marketCapChange24h,
          content: category.content,
          ...buildCategoryTopCoinFields(database, topCoinIds),
          volume_24h: category.volume24h,
          updated_at: category.updatedAt.toISOString(),
        };
      }),
      meta: buildFixtureAwareMeta({
        fixture,
        countKey: 'category_count',
        count: sorted.length,
        updatedAt: sorted.reduce<Date | null>((latest, category) =>
          latest === null || category.updatedAt.getTime() > latest.getTime() ? category.updatedAt : latest, null),
        fixtureNote: `Categories data is seeded fixture (${sorted.length} categories)`,
        liveNote: 'Category metrics are computed from persisted market snapshots',
      }),
    }, {
      maxAgeSeconds: 300,
      staleWhileRevalidateSeconds: 300,
    });
  });
}
