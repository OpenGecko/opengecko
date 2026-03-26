import { and, eq, isNull, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AppDatabase } from '../db/client';
import { assetPlatforms, coins, marketSnapshots } from '../db/schema';
import { summarizeOhlcvSyncStatus } from '../services/ohlcv-runtime';
import { buildRuntimeDiagnostics } from '../services/runtime-diagnostics';

export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
) {
  app.get('/diagnostics/chain_coverage', async () => {
    const totalPlatforms = database.db.select().from(assetPlatforms).all().length;

    const platformsWithChainId = database.db
      .select()
      .from(assetPlatforms)
      .where(not(isNull(assetPlatforms.chainIdentifier)))
      .all().length;

    const contractMappedCoins = database.db
      .select()
      .from(coins)
      .where(and(eq(coins.status, 'active'), not(isNull(coins.platformsJson)), not(eq(coins.platformsJson, '{}'))))
      .all().length;

    const activeCoins = database.db
      .select()
      .from(coins)
      .where(eq(coins.status, 'active'))
      .all().length;

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

  app.get('/diagnostics/ohlcv_sync', async () => {
    return {
      data: summarizeOhlcvSyncStatus(database, new Date()),
    };
  });

  app.get('/diagnostics/runtime', async () => {
    const latestUsdSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(eq(marketSnapshots.vsCurrency, 'usd'))
      .orderBy(marketSnapshots.lastUpdated)
      .all()
      .at(-1) ?? null;

    return {
      data: buildRuntimeDiagnostics(app.marketDataRuntimeState, latestUsdSnapshot, marketFreshnessThresholdSeconds),
    };
  });
}
