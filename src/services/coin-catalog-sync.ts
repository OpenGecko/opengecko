import { coins } from '../db/schema';
import type { AppDatabase } from '../db/client';
import { fetchExchangeMarkets } from '../providers/ccxt';

const CATALOG_BASELINE_QUOTES = new Set(['USD', 'USDT', 'EUR']);

const COIN_ID_OVERRIDES = {
  AAVE: 'aave',
  ADA: 'cardano',
  ALGO: 'algorand',
  APE: 'apecoin',
  APT: 'aptos',
  ARB: 'arbitrum',
  ATOM: 'cosmos',
  AVAX: 'avalanche-2',
  BCH: 'bitcoin-cash',
  BTC: 'bitcoin',
  CRV: 'curve-dao-token',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  ETC: 'ethereum-classic',
  ETH: 'ethereum',
  FIL: 'filecoin',
  ICP: 'internet-computer',
  INJ: 'injective-protocol',
  LINK: 'chainlink',
  LTC: 'litecoin',
  NEAR: 'near',
  OP: 'optimism',
  SHIB: 'shiba-inu',
  SOL: 'solana',
  SUI: 'sui',
  UNI: 'uniswap',
  USDC: 'usd-coin',
  XRP: 'ripple',
  XLM: 'stellar',
  XTZ: 'tezos',
} satisfies Record<string, string>;

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildCoinId(symbol: string, baseName: string | null) {
  const normalizedSymbol = symbol.toUpperCase();
  const override = COIN_ID_OVERRIDES[normalizedSymbol as keyof typeof COIN_ID_OVERRIDES];

  if (override) {
    return override;
  }

  const nameSlug = slugify(baseName ?? symbol);

  if (nameSlug && nameSlug !== normalizedSymbol.toLowerCase()) {
    return nameSlug;
  }

  return normalizedSymbol.toLowerCase();
}

function buildCoinName(symbol: string, baseName: string | null) {
  return baseName?.trim() || symbol.toUpperCase();
}

export async function syncCoinCatalogWithBinance(database: AppDatabase) {
  const markets = await fetchExchangeMarkets('binance');
  const existingCoinsById = new Map(database.db.select().from(coins).all().map((coin) => [coin.id, coin]));
  const now = new Date();
  const discoveredCoins = new Map<string, typeof coins.$inferInsert>();

  for (const market of markets) {
    if (!market.active || !market.spot || !CATALOG_BASELINE_QUOTES.has(market.quote)) {
      continue;
    }

    const coinId = buildCoinId(market.base, market.baseName);
    const existingCoin = existingCoinsById.get(coinId);

    if (existingCoin && existingCoin.symbol.toLowerCase() !== market.base.toLowerCase()) {
      continue;
    }

    if (discoveredCoins.has(coinId)) {
      continue;
    }

    discoveredCoins.set(coinId, {
      id: coinId,
      symbol: market.base.toLowerCase(),
      name: buildCoinName(market.base, market.baseName),
      apiSymbol: coinId,
      hashingAlgorithm: existingCoin?.hashingAlgorithm ?? null,
      blockTimeInMinutes: existingCoin?.blockTimeInMinutes ?? null,
      categoriesJson: existingCoin?.categoriesJson ?? '[]',
      descriptionJson: existingCoin?.descriptionJson ?? JSON.stringify({
        en: market.baseName ? `${market.baseName} imported from Binance market discovery.` : `${market.base} imported from Binance market discovery.`,
      }),
      linksJson: existingCoin?.linksJson ?? '{}',
      imageThumbUrl: existingCoin?.imageThumbUrl ?? null,
      imageSmallUrl: existingCoin?.imageSmallUrl ?? null,
      imageLargeUrl: existingCoin?.imageLargeUrl ?? null,
      marketCapRank: existingCoin?.marketCapRank ?? null,
      genesisDate: existingCoin?.genesisDate ?? null,
      platformsJson: existingCoin?.platformsJson ?? '{}',
      status: existingCoin?.status ?? 'active',
      createdAt: existingCoin?.createdAt ?? now,
      updatedAt: now,
    });
  }

  if (discoveredCoins.size === 0) {
    return { insertedOrUpdated: 0 };
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
          updatedAt: value.updatedAt,
          status: value.status,
        },
      })
      .run();
  }

  return {
    insertedOrUpdated: values.length,
  };
}
