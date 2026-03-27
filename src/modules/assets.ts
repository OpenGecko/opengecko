import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { assetPlatforms } from '../db/schema';
import { HttpError } from '../http/errors';
import { getAssetPlatformById, getCoins, resolveCoinPlatformContract } from './catalog';

const assetPlatformsQuerySchema = z.object({
  filter: z.enum(['nft']).optional(),
});

const tokenListParamsSchema = z.object({
  asset_platform_id: z.string(),
});

function getTokenDecimals(coinId: string, assetPlatformId: string) {
  if (assetPlatformId === 'ethereum' && coinId === 'usd-coin') {
    return 6;
  }

  return 18;
}

function buildTokenList(database: AppDatabase, assetPlatformId: string) {
  const platform = getAssetPlatformById(database, assetPlatformId);

  if (!platform) {
    throw new HttpError(404, 'not_found', `Asset platform not found: ${assetPlatformId}`);
  }

  const tokens = getCoins(database, { status: 'active' })
    .flatMap((coin) => {
      const match = resolveCoinPlatformContract(database, coin, assetPlatformId);

      if (!match) {
        return [];
      }

      return [{
        chainId: platform.chainIdentifier,
        address: match.contractAddress,
        name: coin.name,
        symbol: coin.symbol.toUpperCase(),
        decimals: getTokenDecimals(coin.id, platform.id),
        logoURI: coin.imageSmallUrl ?? coin.imageThumbUrl ?? coin.imageLargeUrl ?? undefined,
        extensions: {
          geckoId: coin.id,
        },
      }];
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol));

  return {
    name: `OpenGecko ${platform.name} Token List`,
    timestamp: platform.updatedAt.toISOString(),
    version: {
      major: 1,
      minor: 0,
      patch: 0,
    },
    keywords: ['opengecko', platform.id],
    logoURI: platform.imageUrl,
    tokens,
  };
}

export function registerAssetPlatformRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/asset_platforms', async (request) => {
    const query = assetPlatformsQuerySchema.parse(request.query);
    const queryBuilder = database.db.select().from(assetPlatforms).orderBy(asc(assetPlatforms.name));

    const rows = query.filter === 'nft' ? queryBuilder.where(eq(assetPlatforms.isNft, true)).all() : queryBuilder.all();

    return rows.map((row) => ({
      id: row.id,
      chain_identifier: row.chainIdentifier,
      name: row.name,
      shortname: row.shortname,
      native_coin_id: row.nativeCoinId,
      image: row.imageUrl,
    }));
  });

  app.get('/token_lists/:asset_platform_id/all.json', async (request) => {
    const params = tokenListParamsSchema.parse(request.params);

    return buildTokenList(database, params.asset_platform_id);
  });
}
