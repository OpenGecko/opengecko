import { sendCacheableJson } from '../../http/cache';
import { parseBooleanQuery } from '../../http/params';
import { getCoins } from '../catalog';
import { buildNewListingRow, parsePlatforms } from './helpers';
import { COIN_AUXILIARY_HTTP_CACHE_POLICY } from './http-policies';
import { coinsListQuerySchema } from './query-schemas';
import type { CoinsRouteContext } from './route-context';

export function registerCoinListRoutes({ app, database }: CoinsRouteContext) {
  app.get('/coins/list', async (request, reply) => {
    const query = coinsListQuerySchema.parse(request.query);
    const includePlatforms = parseBooleanQuery(query.include_platform, false);
    const rows = getCoins(database, { status: query.status ?? 'active' });

    const payload = rows.map((row) => {
      const payload = {
        id: row.id,
        symbol: row.symbol,
        name: row.name,
      };

      if (!includePlatforms) {
        return payload;
      }

      return {
        ...payload,
        platforms: parsePlatforms(row.platformsJson),
      };
    });

    return sendCacheableJson(request, reply, payload, {
      maxAgeSeconds: 3_600,
      staleWhileRevalidateSeconds: 3_600,
    });
  });

  app.get('/coins/list/new', async (request, reply) => {
    const rows = getCoins(database, { status: 'active' })
      .slice()
      .sort((left, right) => {
        const rightActivatedAt = right.activatedAt ?? right.createdAt;
        const leftActivatedAt = left.activatedAt ?? left.createdAt;
        const timeDelta = rightActivatedAt.getTime() - leftActivatedAt.getTime();

        if (timeDelta !== 0) {
          return timeDelta;
        }

        return left.id.localeCompare(right.id);
      });

    return sendCacheableJson(request, reply, {
      coins: rows.map(buildNewListingRow),
      meta: {
        fixture: false,
        source: 'catalog',
        updated_at: rows.reduce<Date | null>((latest, row) => {
          const rowUpdatedAt = row.updatedAt ?? row.activatedAt ?? row.createdAt;
          return latest === null || rowUpdatedAt.getTime() > latest.getTime() ? rowUpdatedAt : latest;
        }, null)?.toISOString() ?? null,
        coin_count: rows.length,
        note: 'Coin listings are sourced from the persisted catalog and scheduler rescans',
      },
    }, COIN_AUXILIARY_HTTP_CACHE_POLICY);
  });
}
