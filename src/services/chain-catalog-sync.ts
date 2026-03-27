import { eq } from 'drizzle-orm';
import { assetPlatforms } from '../db/schema';
import type { AppDatabase } from '../db/client';
import type { Logger } from 'pino';
import { mapWithConcurrency } from '../lib/async';
import {
  getCanonicalPlatformName,
  getCanonicalPlatformShortname,
  normalizePlatformId,
  resolveCanonicalPlatformId,
} from '../lib/platform-id';
import { fetchExchangeNetworks, type ExchangeId } from '../providers/ccxt';

type ChainCatalogSyncResult = {
  insertedOrUpdated: number;
};

export async function syncChainCatalogFromExchanges(
  database: AppDatabase,
  exchangeIds: ExchangeId[],
  logger?: Logger,
  concurrency = exchangeIds.length,
): Promise<ChainCatalogSyncResult> {
  const startTime = Date.now();

  // Fetch all exchange networks in parallel
  const results = await mapWithConcurrency(
    exchangeIds,
    concurrency,
    async (exchangeId) => Promise.allSettled([fetchExchangeNetworks(exchangeId)]).then(([result]) => result),
  );

  const networksById = new Map<string, { name: string; shortname: string; chainIdentifier: number | null; legacyIds: Set<string> }>();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < exchangeIds.length; i++) {
    const exchangeId = exchangeIds[i];
    const result = results[i];
    const exchangeLogger = logger?.child({ exchange: exchangeId });

    if (result.status === 'rejected') {
      failed += 1;
      const errorInfo = result.reason instanceof Error
        ? { message: result.reason.message, name: result.reason.name }
        : { message: String(result.reason) };
      exchangeLogger?.warn(errorInfo, 'chain catalog sync failed for exchange');
      continue;
    }

    succeeded += 1;
    const networks = result.value;
    exchangeLogger?.debug({ networkCount: networks.length }, 'fetched networks for chain discovery');

    for (const network of networks) {
      const canonicalPlatformId = resolveCanonicalPlatformId(network.networkId, {
        networkName: network.networkName,
        chainIdentifier: network.chainIdentifier,
      });
      const legacyPlatformId = normalizePlatformId(network.networkId);
      const existing = networksById.get(canonicalPlatformId);
      if (!existing) {
        networksById.set(canonicalPlatformId, {
          name: getCanonicalPlatformName(canonicalPlatformId, network.networkName),
          shortname: getCanonicalPlatformShortname(canonicalPlatformId),
          chainIdentifier: network.chainIdentifier,
          legacyIds: new Set(legacyPlatformId !== canonicalPlatformId ? [legacyPlatformId] : []),
        });
        continue;
      }

      if (legacyPlatformId !== canonicalPlatformId) {
        existing.legacyIds.add(legacyPlatformId);
      }

      if (existing.chainIdentifier === null && network.chainIdentifier !== null) {
        networksById.set(canonicalPlatformId, {
          ...existing,
          chainIdentifier: network.chainIdentifier,
        });
      }
    }
  }

  if (networksById.size === 0) {
    return { insertedOrUpdated: 0 };
  }

  const now = new Date();
  let upserted = 0;

  for (const [platformId, network] of networksById.entries()) {
    for (const legacyId of network.legacyIds) {
      database.db.delete(assetPlatforms).where(eq(assetPlatforms.id, legacyId)).run();
    }

    database.db
      .insert(assetPlatforms)
      .values({
        id: platformId,
        chainIdentifier: network.chainIdentifier,
        name: network.name,
        shortname: network.shortname,
        nativeCoinId: null,
        imageUrl: null,
        isNft: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: assetPlatforms.id,
        set: {
          chainIdentifier: network.chainIdentifier,
          name: network.name,
          shortname: network.shortname,
          updatedAt: now,
        },
      })
      .run();

    upserted += 1;
  }

  const durationMs = Date.now() - startTime;
  logger?.info({ chainsDiscovered: upserted, exchangeCount: exchangeIds.length, succeeded, failed, durationMs }, 'chain catalog sync complete');

  return { insertedOrUpdated: upserted };
}
