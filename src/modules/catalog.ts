import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { assetPlatforms, categories, coins, marketSnapshots, onchainNetworks } from '../db/schema';
import { getPlatformLookupIds, normalizePlatformId, resolveCanonicalPlatformId } from '../lib/platform-id';
import { parseJsonObject, parseJsonArray, normalizeCategoryId } from '../lib/shared';
import { getCanonicalCloseSeries } from '../services/candle-store';

export { parseJsonObject, parseJsonArray } from '../lib/shared';

type CoinFilters = {
  ids?: string[];
  names?: string[];
  symbols?: string[];
  status?: 'active' | 'inactive' | 'all';
  categoryId?: string;
};

function getSelectorWhereClause(filters: CoinFilters) {
  if (filters.ids?.length) {
    return inArray(coins.id, filters.ids);
  }

  if (filters.names?.length) {
    const normalizedNames = filters.names
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);

    if (normalizedNames.length > 0) {
      return or(...normalizedNames.map((name) => sql`lower(${coins.name}) = ${name}`));
    }
  }

  if (filters.symbols?.length) {
    return inArray(coins.symbol, filters.symbols);
  }

  return undefined;
}

function getCoinWhereClauses(filters: CoinFilters) {
  const clauses = [];

  if (filters.status && filters.status !== 'all') {
    clauses.push(eq(coins.status, filters.status));
  }

  const selectorClause = getSelectorWhereClause(filters);

  if (selectorClause) {
    clauses.push(selectorClause);
  }

  return clauses;
}

function applyCategoryFilter<T extends { coin: { categoriesJson: string } }>(rows: T[], categoryId?: string) {
  if (!categoryId) {
    return rows;
  }

  return rows.filter((row) => parseJsonArray<string>(row.coin.categoriesJson)
    .map((entry) => normalizeCategoryId(entry))
    .includes(categoryId));
}

export function getCoins(database: AppDatabase, filters: CoinFilters = {}) {
  const clauses = getCoinWhereClauses({ ...filters, status: filters.status ?? 'active' });
  const whereClause = clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : and(...clauses);
  const rows = whereClause
    ? database.db.select().from(coins).where(whereClause).orderBy(asc(coins.id)).all()
    : database.db.select().from(coins).orderBy(asc(coins.id)).all();

  return applyCategoryFilter(rows.map((coin) => ({ coin })), filters.categoryId).map((row) => row.coin);
}

export function getCoinById(database: AppDatabase, id: string) {
  return database.db.select().from(coins).where(eq(coins.id, id)).limit(1).get();
}

function resolveRequestedPlatformIds(database: AppDatabase, platformId: string) {
  const normalizedRequestedPlatformId = normalizePlatformId(platformId);
  const candidates = new Set(getPlatformLookupIds(normalizedRequestedPlatformId));
  const matchingPlatform = database.db
    .select()
    .from(assetPlatforms)
    .all()
    .find((row) => row.id === normalizedRequestedPlatformId || row.shortname === normalizedRequestedPlatformId);

  if (matchingPlatform) {
    candidates.add(matchingPlatform.id);
    candidates.add(matchingPlatform.shortname);
    candidates.add(resolveCanonicalPlatformId(matchingPlatform.id, {
      networkName: matchingPlatform.name,
      chainIdentifier: matchingPlatform.chainIdentifier,
    }));
  }

  const matchingOnchainNetwork = database.db
    .select()
    .from(onchainNetworks)
    .where(eq(onchainNetworks.id, normalizedRequestedPlatformId))
    .limit(1)
    .get();

  if (matchingOnchainNetwork?.coingeckoAssetPlatformId) {
    candidates.add(matchingOnchainNetwork.coingeckoAssetPlatformId);
  }

  return [...candidates].filter((value) => value.length > 0);
}

export function resolveCoinPlatformContract(
  database: AppDatabase,
  coin: { platformsJson: string },
  platformId: string,
) {
  const platforms = parseJsonObject<Record<string, string>>(coin.platformsJson);

  for (const candidatePlatformId of resolveRequestedPlatformIds(database, platformId)) {
    const address = platforms[candidatePlatformId];
    if (typeof address === 'string' && address.length > 0) {
      return {
        platformId: candidatePlatformId,
        contractAddress: address.toLowerCase(),
      };
    }
  }

  return null;
}

export function getAssetPlatformById(database: AppDatabase, platformId: string) {
  const requestedIds = resolveRequestedPlatformIds(database, platformId);

  return database.db
    .select()
    .from(assetPlatforms)
    .all()
    .find((row) => requestedIds.includes(row.id) || requestedIds.includes(row.shortname)) ?? null;
}

const KNOWN_PLATFORM_CONTRACT_COIN_IDS: Record<string, Record<string, string>> = {
  ethereum: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'usd-coin',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'tether',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ethereum',
  },
};

export function getCoinByContract(database: AppDatabase, platformId: string, contractAddress: string) {
  const normalizedContract = contractAddress.toLowerCase();
  const requestedPlatformIds = resolveRequestedPlatformIds(database, platformId);

  const platformMappedCoin = getCoins(database, { status: 'all' }).find((coin) =>
    resolveCoinPlatformContract(database, coin, platformId)?.contractAddress === normalizedContract,
  );

  if (platformMappedCoin) {
    return platformMappedCoin;
  }

  for (const requestedPlatformId of requestedPlatformIds) {
    const canonicalPlatformId = resolveCanonicalPlatformId(requestedPlatformId);
    const fallbackCoinId = KNOWN_PLATFORM_CONTRACT_COIN_IDS[canonicalPlatformId]?.[normalizedContract];
    if (fallbackCoinId) {
      return getCoinById(database, fallbackCoinId) ?? null;
    }
  }

  return undefined;
}

export function getMarketRows(
  database: AppDatabase,
  vsCurrency: string,
  filters: CoinFilters = {},
  orderBy: Array<SQL<unknown> | ReturnType<typeof asc>> = [asc(coins.marketCapRank), asc(coins.id)],
) {
  const clauses = getCoinWhereClauses(filters);
  const whereClause = clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : and(...clauses);
  const query = database.db
    .select()
    .from(coins)
    .leftJoin(
      marketSnapshots,
      and(eq(marketSnapshots.coinId, coins.id), eq(marketSnapshots.vsCurrency, vsCurrency)),
    );

  const explicitSelectorOrder = filters.ids?.length
    ? filters.ids
    : filters.names?.length
      ? filters.names.map((name) => name.trim().toLowerCase()).filter(Boolean)
      : filters.symbols?.length
        ? filters.symbols.map((symbol) => symbol.trim().toLowerCase()).filter(Boolean)
        : [];
  const joinedRows = (whereClause ? query.where(whereClause) : query)
    .orderBy(...orderBy)
    .all();

  const rows = applyCategoryFilter(
    joinedRows
      .filter(({ coins: coin }) => Boolean(coin))
    .map((row) => ({
      coin: row.coins,
      snapshot: row.market_snapshots,
    }))
    .filter((row): row is { coin: NonNullable<typeof row.coin>; snapshot: typeof row.snapshot } => Boolean(row.coin)),
    filters.categoryId,
  );

  if (explicitSelectorOrder.length === 0) {
    return rows;
  }

  const selectorValueForRow = (row: typeof rows[number]) => {
    if (filters.ids?.length) {
      return row.coin.id;
    }

    if (filters.names?.length) {
      return row.coin.name.trim().toLowerCase();
    }

    if (filters.symbols?.length) {
      return row.coin.symbol.trim().toLowerCase();
    }

    return row.coin.id;
  };

  const requestedSelectorOrder = new Map(explicitSelectorOrder.map((value, index) => [value, index] as const));
  return [...rows].sort((left, right) => {
    const leftIndex = requestedSelectorOrder.get(selectorValueForRow(left)) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = requestedSelectorOrder.get(selectorValueForRow(right)) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export function getCategories(database: AppDatabase) {
  return database.db.select().from(categories).orderBy(asc(categories.name)).all();
}

export function getChartSeries(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  range?: { from?: number; to?: number },
) {
  return getCanonicalCloseSeries(database, coinId, vsCurrency, '1d', range);
}
