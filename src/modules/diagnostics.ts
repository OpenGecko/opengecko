import { and, count, eq, isNull, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AppDatabase } from '../db/client';
import { assetPlatforms, coins } from '../db/schema';

export function registerDiagnosticsRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/diagnostics/chain_coverage', async () => {
    const [{ value: totalPlatforms }] = database.db
      .select({ value: count() })
      .from(assetPlatforms)
      .all();

    const [{ value: platformsWithChainId }] = database.db
      .select({ value: count() })
      .from(assetPlatforms)
      .where(not(isNull(assetPlatforms.chainIdentifier)))
      .all();

    const [{ value: contractMappedCoins }] = database.db
      .select({ value: count() })
      .from(coins)
      .where(and(eq(coins.status, 'active'), not(isNull(coins.platformsJson)), not(eq(coins.platformsJson, '{}'))))
      .all();

    const [{ value: activeCoins }] = database.db
      .select({ value: count() })
      .from(coins)
      .where(eq(coins.status, 'active'))
      .all();

    return {
      data: {
        platform_counts: {
          total: totalPlatforms,
          with_chain_identifier: platformsWithChainId,
          without_chain_identifier: Math.max(totalPlatforms - platformsWithChainId, 0),
        },
        contract_mapping: {
          active_coins: activeCoins,
          coins_with_platform_mappings: contractMappedCoins,
          coins_without_platform_mappings: Math.max(activeCoins - contractMappedCoins, 0),
        },
      },
    };
  });
}
