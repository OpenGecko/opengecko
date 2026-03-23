import { assetPlatforms } from '../db/schema';
import type { AppDatabase } from '../db/client';
import type { Logger } from 'pino';
import { fetchExchangeNetworks, type ExchangeId } from '../providers/ccxt';

type ChainCatalogSyncResult = {
  insertedOrUpdated: number;
};

function toPlatformId(networkId: string) {
  return networkId.toLowerCase();
}

function toShortname(networkId: string) {
  const shortname = networkId.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return shortname.slice(0, 12) || 'chain';
}

function toPlatformName(networkId: string, networkName: string) {
  const trimmed = networkName.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return networkId
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

export async function syncChainCatalogFromExchanges(
  database: AppDatabase,
  exchangeIds: ExchangeId[],
  logger?: Logger,
): Promise<ChainCatalogSyncResult> {
  const startTime = Date.now();
  const networksById = new Map<string, { name: string; chainIdentifier: number | null }>();

  for (const exchangeId of exchangeIds) {
    const exchangeLogger = logger?.child({ exchange: exchangeId });
    let networks: Awaited<ReturnType<typeof fetchExchangeNetworks>> = [];
    try {
      networks = await fetchExchangeNetworks(exchangeId);
      exchangeLogger?.debug({ networkCount: networks.length }, 'fetched networks for chain discovery');
    } catch (error) {
      const errorInfo = error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) };
      exchangeLogger?.warn(errorInfo, 'chain catalog sync failed for exchange');
      continue;
    }

    for (const network of networks) {
      const existing = networksById.get(network.networkId);
      if (!existing) {
        networksById.set(network.networkId, {
          name: network.networkName,
          chainIdentifier: network.chainIdentifier,
        });
        continue;
      }

      if (existing.chainIdentifier === null && network.chainIdentifier !== null) {
        networksById.set(network.networkId, {
          name: existing.name,
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

  for (const [networkId, network] of networksById.entries()) {
    database.db
      .insert(assetPlatforms)
      .values({
        id: toPlatformId(networkId),
        chainIdentifier: network.chainIdentifier,
        name: toPlatformName(networkId, network.name),
        shortname: toShortname(networkId),
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
          name: toPlatformName(networkId, network.name),
          shortname: toShortname(networkId),
          updatedAt: now,
        },
      })
      .run();

    upserted += 1;
  }

  const durationMs = Date.now() - startTime;
  logger?.info({ chainsDiscovered: upserted, exchangeCount: exchangeIds.length, durationMs }, 'chain catalog sync complete');

  return { insertedOrUpdated: upserted };
}
