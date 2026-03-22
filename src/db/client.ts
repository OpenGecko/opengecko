import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { rebuildSearchIndex } from './search-index';
export { rebuildSearchIndex } from './search-index';
import { assetPlatforms, categories, chartPoints, coins, derivativeTickers, derivativesExchanges, onchainDexes, onchainNetworks, treasuryEntities, treasuryHoldings, treasuryTransactions } from './schema';

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');
const MIGRATION_JOURNAL = resolve(MIGRATIONS_FOLDER, 'meta', '_journal.json');

export type AppDatabase = ReturnType<typeof createDatabase>;

function resolveDatabaseUrl(databaseUrl: string) {
  if (databaseUrl === ':memory:') {
    return databaseUrl;
  }

  return resolve(process.cwd(), databaseUrl);
}

export function createDatabase(databaseUrl: string) {
  const resolvedUrl = resolveDatabaseUrl(databaseUrl);

  if (resolvedUrl !== ':memory:') {
    mkdirSync(dirname(resolvedUrl), { recursive: true });
  }

  const client = new Database(resolvedUrl);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');

  const db = drizzle(client, {
    schema: {
      assetPlatforms,
      categories,
      chartPoints,
      coins,
      derivativeTickers,
      derivativesExchanges,
      onchainDexes,
      onchainNetworks,
      treasuryEntities,
      treasuryHoldings,
      treasuryTransactions,
    },
  });

  return {
    client,
    db,
    url: resolvedUrl,
  };
}

export function migrateDatabase(database: AppDatabase) {
  migrate(database.db, {
    migrationsFolder: MIGRATIONS_FOLDER,
  });
}

// ---------------------------------------------------------------------------
// Static reference seed data
// ---------------------------------------------------------------------------

const seedTimestamp = Date.parse('2026-03-20T00:00:00.000Z');

const seededAssetPlatforms = [
  {
    id: 'ethereum',
    chainIdentifier: 1,
    name: 'Ethereum',
    shortname: 'eth',
    nativeCoinId: 'ethereum',
    imageUrl: null,
    isNft: true,
    createdAt: new Date(seedTimestamp),
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'bitcoin',
    chainIdentifier: null,
    name: 'Bitcoin',
    shortname: 'btc',
    nativeCoinId: 'bitcoin',
    imageUrl: null,
    isNft: false,
    createdAt: new Date(seedTimestamp),
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'solana',
    chainIdentifier: 101,
    name: 'Solana',
    shortname: 'sol',
    nativeCoinId: 'solana',
    imageUrl: null,
    isNft: true,
    createdAt: new Date(seedTimestamp),
    updatedAt: new Date(seedTimestamp),
  },
];

const seededCategories = [
  {
    id: 'smart-contract-platform',
    name: 'Smart Contract Platform',
    marketCap: 1_940_000_000_000,
    marketCapChange24h: 2.3,
    volume24h: 35_000_000_000,
    content: 'Assets that provide general-purpose smart contract execution environments.',
    top3CoinsJson: JSON.stringify(['bitcoin', 'ethereum']),
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'stablecoins',
    name: 'Stablecoins',
    marketCap: 60_000_000_000,
    marketCapChange24h: 0.1,
    volume24h: 6_000_000_000,
    content: 'Tokens designed to track a reference asset such as the US dollar.',
    top3CoinsJson: JSON.stringify(['usd-coin']),
    updatedAt: new Date(seedTimestamp),
  },
];

const seededDerivativesExchanges = [
  {
    id: 'binance_futures',
    name: 'Binance Futures',
    openInterestBtc: 185000,
    tradeVolume24hBtc: 910000,
    numberOfPerpetualPairs: 412,
    numberOfFuturesPairs: 38,
    yearEstablished: 2019,
    country: 'Cayman Islands',
    description: "Binance Futures is Binance's derivatives venue for perpetual and dated futures markets.",
    url: 'https://www.binance.com/en/futures',
    imageUrl: 'https://assets.coingecko.com/markets/images/52/small/binance.jpg',
    centralised: true,
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'bybit',
    name: 'Bybit',
    openInterestBtc: 132500,
    tradeVolume24hBtc: 640000,
    numberOfPerpetualPairs: 356,
    numberOfFuturesPairs: 24,
    yearEstablished: 2018,
    country: 'United Arab Emirates',
    description: 'Bybit is a crypto derivatives exchange focused on perpetual and futures trading.',
    url: 'https://www.bybit.com',
    imageUrl: 'https://assets.coingecko.com/markets/images/698/small/bybit_spot.png',
    centralised: true,
    updatedAt: new Date(seedTimestamp),
  },
];

const seededDerivativeTickers = [
  {
    exchangeId: 'binance_futures',
    symbol: 'BTCUSDT',
    market: 'Binance Futures',
    indexId: 'bitcoin',
    price: 85120,
    pricePercentageChange24h: 1.7,
    contractType: 'perpetual',
    indexValue: 85080,
    basis: 40,
    spread: 0.012,
    fundingRate: 0.0001,
    openInterestBtc: 120000,
    tradeVolume24hBtc: 420000,
    lastTradedAt: new Date(seedTimestamp),
    expiredAt: null,
  },
  {
    exchangeId: 'binance_futures',
    symbol: 'ETHUSDT',
    market: 'Binance Futures',
    indexId: 'ethereum',
    price: 2010,
    pricePercentageChange24h: 2.2,
    contractType: 'perpetual',
    indexValue: 2004,
    basis: 6,
    spread: 0.018,
    fundingRate: 0.00012,
    openInterestBtc: 42000,
    tradeVolume24hBtc: 110000,
    lastTradedAt: new Date(seedTimestamp),
    expiredAt: null,
  },
  {
    exchangeId: 'bybit',
    symbol: 'BTC-27JUN26',
    market: 'Bybit',
    indexId: 'bitcoin',
    price: 85840,
    pricePercentageChange24h: 1.1,
    contractType: 'futures',
    indexValue: 85080,
    basis: 760,
    spread: 0.025,
    fundingRate: null,
    openInterestBtc: 18500,
    tradeVolume24hBtc: 56000,
    lastTradedAt: new Date(seedTimestamp),
    expiredAt: new Date(Date.parse('2026-06-27T08:00:00.000Z')),
  },
];

const seededTreasuryEntities = [
  {
    id: 'strategy',
    name: 'Strategy',
    symbol: 'MSTR',
    entityType: 'company' as const,
    country: 'United States',
    description: 'Strategy is a public company with a large bitcoin treasury position.',
    websiteUrl: 'https://www.strategy.com',
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'el-salvador',
    name: 'El Salvador',
    symbol: null,
    entityType: 'government' as const,
    country: 'El Salvador',
    description: 'El Salvador publishes sovereign bitcoin treasury disclosures.',
    websiteUrl: 'https://bitcoin.gob.sv',
    updatedAt: new Date(seedTimestamp),
  },
];

const seededTreasuryHoldings = [
  {
    entityId: 'strategy',
    coinId: 'bitcoin',
    amount: 499096,
    entryValueUsd: 33150000000,
    reportedAt: new Date(seedTimestamp),
    sourceUrl: 'https://www.strategy.com/press',
  },
  {
    entityId: 'el-salvador',
    coinId: 'bitcoin',
    amount: 6100,
    entryValueUsd: 402000000,
    reportedAt: new Date(seedTimestamp),
    sourceUrl: 'https://bitcoin.gob.sv',
  },
];

const seededTreasuryTransactions = [
  {
    id: 'strategy-bitcoin-2026-03-14',
    entityId: 'strategy',
    coinId: 'bitcoin',
    type: 'buy' as const,
    holdingNetChange: 420000,
    transactionValueUsd: 27090000000,
    holdingBalance: 420000,
    averageEntryValueUsd: 64500,
    happenedAt: new Date(Date.parse('2026-03-14T00:00:00.000Z')),
    sourceUrl: 'https://www.strategy.com/press/march-2026-bitcoin-update',
  },
  {
    id: 'strategy-bitcoin-2026-03-17',
    entityId: 'strategy',
    coinId: 'bitcoin',
    type: 'buy' as const,
    holdingNetChange: 60000,
    transactionValueUsd: 4020000000,
    holdingBalance: 480000,
    averageEntryValueUsd: 64770.833333333336,
    happenedAt: new Date(Date.parse('2026-03-17T00:00:00.000Z')),
    sourceUrl: 'https://www.strategy.com/press/march-2026-bitcoin-update',
  },
  {
    id: 'strategy-bitcoin-2026-03-20',
    entityId: 'strategy',
    coinId: 'bitcoin',
    type: 'buy' as const,
    holdingNetChange: 19096,
    transactionValueUsd: 2040000000,
    holdingBalance: 499096,
    averageEntryValueUsd: 66420.08751823296,
    happenedAt: new Date(seedTimestamp),
    sourceUrl: 'https://www.strategy.com/press/march-2026-bitcoin-update',
  },
  {
    id: 'el-salvador-bitcoin-2026-03-15',
    entityId: 'el-salvador',
    coinId: 'bitcoin',
    type: 'buy' as const,
    holdingNetChange: 3500,
    transactionValueUsd: 210000000,
    holdingBalance: 3500,
    averageEntryValueUsd: 60000,
    happenedAt: new Date(Date.parse('2026-03-15T00:00:00.000Z')),
    sourceUrl: 'https://bitcoin.gob.sv/treasury-disclosures/march-2026',
  },
  {
    id: 'el-salvador-bitcoin-2026-03-18',
    entityId: 'el-salvador',
    coinId: 'bitcoin',
    type: 'buy' as const,
    holdingNetChange: 1600,
    transactionValueUsd: 108000000,
    holdingBalance: 5100,
    averageEntryValueUsd: 62352.94117647059,
    happenedAt: new Date(Date.parse('2026-03-18T00:00:00.000Z')),
    sourceUrl: 'https://bitcoin.gob.sv/treasury-disclosures/march-2026',
  },
  {
    id: 'el-salvador-bitcoin-2026-03-20',
    entityId: 'el-salvador',
    coinId: 'bitcoin',
    type: 'buy' as const,
    holdingNetChange: 1000,
    transactionValueUsd: 84000000,
    holdingBalance: 6100,
    averageEntryValueUsd: 65901.6393442623,
    happenedAt: new Date(seedTimestamp),
    sourceUrl: 'https://bitcoin.gob.sv/treasury-disclosures/march-2026',
  },
];

const seededOnchainNetworks = [
  {
    id: 'eth',
    name: 'Ethereum',
    chainIdentifier: 1,
    coingeckoAssetPlatformId: 'ethereum',
    nativeCurrencyCoinId: 'ethereum',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/279/small/ethereum.png',
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'solana',
    name: 'Solana',
    chainIdentifier: 101,
    coingeckoAssetPlatformId: 'solana',
    nativeCurrencyCoinId: 'solana',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/4128/small/solana.png',
    updatedAt: new Date(seedTimestamp),
  },
];

const seededOnchainDexes = [
  {
    id: 'uniswap_v3',
    networkId: 'eth',
    name: 'Uniswap V3',
    url: 'https://app.uniswap.org',
    imageUrl: 'https://assets.coingecko.com/markets/images/665/small/uniswap.png',
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'curve',
    networkId: 'eth',
    name: 'Curve',
    url: 'https://curve.fi',
    imageUrl: 'https://assets.coingecko.com/markets/images/538/small/curve.png',
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'raydium',
    networkId: 'solana',
    name: 'Raydium',
    url: 'https://raydium.io',
    imageUrl: 'https://assets.coingecko.com/markets/images/609/small/Raydium.png',
    updatedAt: new Date(seedTimestamp),
  },
];

// Chart points used by treasury holding chart endpoint
const seededChartPointValues = {
  bitcoin: {
    prices: [79_000, 80_500, 82_250, 81_750, 83_000, 84_250, 85_000],
    marketCaps: [1_580_000_000_000, 1_610_000_000_000, 1_640_000_000_000, 1_630_000_000_000, 1_650_000_000_000, 1_680_000_000_000, 1_700_000_000_000],
    volumes: [22_000_000_000, 23_500_000_000, 24_000_000_000, 21_500_000_000, 23_000_000_000, 24_500_000_000, 25_000_000_000],
  },
  ethereum: {
    prices: [1_850, 1_890, 1_920, 1_930, 1_960, 1_980, 2_000],
    marketCaps: [222_000_000_000, 226_000_000_000, 230_000_000_000, 231_000_000_000, 235_000_000_000, 238_000_000_000, 240_000_000_000],
    volumes: [8_000_000_000, 8_300_000_000, 8_700_000_000, 8_900_000_000, 9_200_000_000, 9_600_000_000, 10_000_000_000],
  },
  ripple: {
    prices: [2.2, 2.25, 2.3, 2.34, 2.4, 2.48, 2.55],
    marketCaps: [128_000_000_000, 131_000_000_000, 134_000_000_000, 136_000_000_000, 140_000_000_000, 144_000_000_000, 148_000_000_000],
    volumes: [8_800_000_000, 9_100_000_000, 9_500_000_000, 9_800_000_000, 10_400_000_000, 11_200_000_000, 12_000_000_000],
  },
  solana: {
    prices: [154, 158, 160, 162, 166, 170, 175],
    marketCaps: [74_000_000_000, 76_000_000_000, 77_000_000_000, 78_000_000_000, 80_000_000_000, 82_000_000_000, 84_000_000_000],
    volumes: [6_200_000_000, 6_500_000_000, 6_700_000_000, 7_100_000_000, 7_500_000_000, 8_200_000_000, 9_000_000_000],
  },
  dogecoin: {
    prices: [0.24, 0.245, 0.252, 0.258, 0.265, 0.273, 0.28],
    marketCaps: [35_000_000_000, 36_000_000_000, 37_000_000_000, 38_000_000_000, 39_000_000_000, 40_000_000_000, 41_000_000_000],
    volumes: [2_400_000_000, 2_600_000_000, 2_800_000_000, 3_000_000_000, 3_200_000_000, 3_500_000_000, 3_800_000_000],
  },
  'usd-coin': {
    prices: [0.999, 1.001, 1.0, 1.0, 0.9995, 1.0002, 1.0],
    marketCaps: [59_700_000_000, 59_800_000_000, 59_850_000_000, 59_900_000_000, 59_950_000_000, 59_980_000_000, 60_000_000_000],
    volumes: [5_500_000_000, 5_600_000_000, 5_700_000_000, 5_800_000_000, 5_900_000_000, 5_950_000_000, 6_000_000_000],
  },
  cardano: {
    prices: [0.94, 0.96, 0.98, 1.0, 1.01, 1.03, 1.05],
    marketCaps: [33_000_000_000, 33_600_000_000, 34_300_000_000, 35_000_000_000, 35_500_000_000, 36_200_000_000, 37_000_000_000],
    volumes: [1_200_000_000, 1_300_000_000, 1_400_000_000, 1_500_000_000, 1_600_000_000, 1_750_000_000, 1_900_000_000],
  },
  chainlink: {
    prices: [20.5, 21, 21.5, 22.1, 22.8, 23.4, 24],
    marketCaps: [12_800_000_000, 13_100_000_000, 13_400_000_000, 13_800_000_000, 14_200_000_000, 14_600_000_000, 15_000_000_000],
    volumes: [820_000_000, 880_000_000, 940_000_000, 1_000_000_000, 1_050_000_000, 1_120_000_000, 1_200_000_000],
  },
} satisfies Record<string, { prices: number[]; marketCaps: number[]; volumes: number[] }>;

function buildSeededChartPoints() {
  const baseDate = Date.parse('2026-03-14T00:00:00.000Z');

  return Object.entries(seededChartPointValues).flatMap(([coinId, values]) =>
    values.prices.map((price, index) => ({
      coinId,
      vsCurrency: 'usd',
      timestamp: new Date(baseDate + index * 24 * 60 * 60 * 1000),
      price,
      marketCap: values.marketCaps[index],
      totalVolume: values.volumes[index],
    })),
  );
}

// ---------------------------------------------------------------------------
// Public seed functions
// ---------------------------------------------------------------------------

const seededMinimalCoins = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum' },
  { id: 'ripple', symbol: 'xrp', name: 'XRP' },
  { id: 'solana', symbol: 'sol', name: 'Solana' },
  { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin' },
  { id: 'usd-coin', symbol: 'usdc', name: 'USDC' },
  { id: 'cardano', symbol: 'ada', name: 'Cardano' },
  { id: 'chainlink', symbol: 'link', name: 'Chainlink' },
].map((coin, index) => ({
  ...coin,
  apiSymbol: coin.id,
  hashingAlgorithm: null,
  blockTimeInMinutes: null,
  categoriesJson: '[]',
  descriptionJson: '{}',
  linksJson: '{}',
  imageThumbUrl: null,
  imageSmallUrl: null,
  imageLargeUrl: null,
  marketCapRank: index + 1,
  genesisDate: null,
  platformsJson: '{}',
  status: 'active' as const,
  createdAt: new Date(seedTimestamp),
  updatedAt: new Date(seedTimestamp),
}));

export function seedStaticReferenceData(database: AppDatabase) {
  database.db.insert(coins).values(seededMinimalCoins).onConflictDoNothing().run();
  database.db.insert(assetPlatforms).values(seededAssetPlatforms).onConflictDoNothing().run();
  database.db.insert(categories).values(seededCategories).onConflictDoNothing().run();
  database.db.insert(derivativesExchanges).values(seededDerivativesExchanges).onConflictDoNothing().run();
  database.db.insert(derivativeTickers).values(seededDerivativeTickers).onConflictDoNothing().run();
  database.db.insert(treasuryEntities).values(seededTreasuryEntities).onConflictDoNothing().run();
  database.db.insert(treasuryHoldings).values(seededTreasuryHoldings).onConflictDoNothing().run();
  database.db.insert(treasuryTransactions).values(seededTreasuryTransactions).onConflictDoNothing().run();
  database.db.insert(onchainNetworks).values(seededOnchainNetworks).onConflictDoNothing().run();
  database.db.insert(onchainDexes).values(seededOnchainDexes).onConflictDoNothing().run();
  database.db.insert(chartPoints).values(buildSeededChartPoints()).onConflictDoNothing().run();
}

export function initializeDatabase(database: AppDatabase) {
  migrateDatabase(database);
  seedStaticReferenceData(database);
  rebuildSearchIndex(database);
}
