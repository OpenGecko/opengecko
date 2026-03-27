import { coins } from '../db/schema';
import type { AppDatabase } from '../db/client';
import type { Logger } from 'pino';
import { buildCoinId, buildCoinName } from '../lib/coin-id';
import { mapWithConcurrency } from '../lib/async';
import { fetchExchangeMarkets, type ExchangeId } from '../providers/ccxt';

function upsertDiscoveredCoin(
  database: AppDatabase,
  discoveredCoins: Map<string, typeof coins.$inferInsert>,
  existingCoinsById: Map<string, typeof coins.$inferSelect>,
  market: { base: string; quote: string; baseName: string | null },
  exchangeId: string,
) {
  void database;
  const coinId = buildCoinId(market.base, market.baseName);
  const existingCoin = existingCoinsById.get(coinId);

  if (existingCoin && existingCoin.symbol.toLowerCase() !== market.base.toLowerCase()) {
    return;
  }

  if (discoveredCoins.has(coinId)) {
    return;
  }

  const now = new Date();
  const existingPlatforms = existingCoin?.platformsJson && existingCoin.platformsJson !== '{}'
    ? existingCoin.platformsJson
    : coinId === 'usd-coin'
      ? JSON.stringify({ ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' })
      : '{}';

  discoveredCoins.set(coinId, {
    id: coinId,
    symbol: market.base.toLowerCase(),
    name: buildCoinName(market.base, market.baseName),
    apiSymbol: coinId,
    hashingAlgorithm: existingCoin?.hashingAlgorithm ?? null,
    blockTimeInMinutes: existingCoin?.blockTimeInMinutes ?? null,
    categoriesJson: existingCoin?.categoriesJson ?? '[]',
    descriptionJson: existingCoin?.descriptionJson ?? JSON.stringify({
      en: market.baseName
        ? `${market.baseName} imported from ${exchangeId} market discovery.`
        : `${market.base} imported from ${exchangeId} market discovery.`,
    }),
    linksJson: existingCoin?.linksJson ?? '{}',
    imageThumbUrl: existingCoin?.imageThumbUrl ?? null,
    imageSmallUrl: existingCoin?.imageSmallUrl ?? null,
    imageLargeUrl: existingCoin?.imageLargeUrl ?? null,
    marketCapRank: existingCoin?.marketCapRank ?? null,
    genesisDate: existingCoin?.genesisDate ?? null,
    platformsJson: existingPlatforms,
    status: existingCoin?.status ?? 'active',
    createdAt: existingCoin?.createdAt ?? now,
    updatedAt: now,
  });
}

function flushDiscoveredCoins(database: AppDatabase, discoveredCoins: Map<string, typeof coins.$inferInsert>) {
  if (discoveredCoins.size === 0) {
    return 0;
  }

  const values = [...discoveredCoins.values()];

  for (const value of values) {
    database.db
      .insert(coins)
      .values(value)
      .onConflictDoUpdate({
        target: coins.id,
        set: {
          symbol: value.symbol,
          name: value.name,
          apiSymbol: value.apiSymbol,
          descriptionJson: value.descriptionJson,
          platformsJson: value.platformsJson,
          updatedAt: value.updatedAt,
          status: value.status,
        },
      })
      .run();
  }

  return values.length;
}

export async function syncCoinCatalogFromExchanges(
  database: AppDatabase,
  exchangeIds: ExchangeId[],
  logger?: Logger,
  concurrency = exchangeIds.length,
) {
  const startTime = Date.now();
  const existingCoinsById = new Map(database.db.select().from(coins).all().map((coin) => [coin.id, coin]));
  const discoveredCoins = new Map<string, typeof coins.$inferInsert>();

  // Fetch all exchange markets in parallel
  const results = await mapWithConcurrency(
    exchangeIds,
    concurrency,
    async (exchangeId) => Promise.allSettled([fetchExchangeMarkets(exchangeId)]).then(([result]) => result),
  );

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
      exchangeLogger?.warn(errorInfo, 'coin catalog sync failed for exchange');
      continue;
    }

    succeeded += 1;
    const markets = result.value;
    exchangeLogger?.debug({ marketCount: markets.length }, 'fetched markets for coin discovery');

    for (const market of markets) {
      if (!market.active || !market.spot) {
        continue;
      }

      upsertDiscoveredCoin(database, discoveredCoins, existingCoinsById, market, exchangeId);
    }
  }

  const count = flushDiscoveredCoins(database, discoveredCoins);
  const durationMs = Date.now() - startTime;
  logger?.info({ coinsDiscovered: count, exchangeCount: exchangeIds.length, succeeded, failed, durationMs }, 'coin catalog sync complete');

  return { insertedOrUpdated: count };
}

export async function syncCoinCatalogWithBinance(database: AppDatabase) {
  return syncCoinCatalogFromExchanges(database, ['binance']);
}
