import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { rebuildSearchIndex } from './search-index';
import { assetPlatforms, categories, chartPoints, coinTickers, coins, derivativeTickers, derivativesExchanges, exchangeVolumePoints, exchanges, marketSnapshots, onchainDexes, onchainNetworks, treasuryEntities, treasuryHoldings } from './schema';

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
      coinTickers,
      coins,
      derivativeTickers,
      derivativesExchanges,
      exchangeVolumePoints,
      exchanges,
      marketSnapshots,
      onchainDexes,
      onchainNetworks,
      treasuryEntities,
      treasuryHoldings,
    },
  });

  return {
    client,
    db,
    url: resolvedUrl,
  };
}

const seedTimestamp = Date.parse('2026-03-20T00:00:00.000Z');
const athTimestamp = Date.parse('2025-12-17T00:00:00.000Z');
const atlTimestamp = Date.parse('2023-11-21T00:00:00.000Z');

const seededCoins = [
  {
    id: 'bitcoin',
    symbol: 'btc',
    name: 'Bitcoin',
    apiSymbol: 'bitcoin',
    hashingAlgorithm: 'SHA-256',
    blockTimeInMinutes: 10,
    categoriesJson: JSON.stringify(['Smart Contract Platform']),
    descriptionJson: JSON.stringify({
      en: 'Bitcoin is the first decentralized digital currency and remains the reference asset for the broader crypto market.',
    }),
    linksJson: JSON.stringify({
      homepage: ['https://bitcoin.org'],
      blockchain_site: ['https://mempool.space'],
      official_forum_url: ['https://bitcointalk.org'],
      chat_url: [],
      announcement_url: [],
      twitter_screen_name: 'bitcoin',
      facebook_username: '',
      telegram_channel_identifier: '',
      subreddit_url: 'https://reddit.com/r/bitcoin',
      repos_url: {
        github: ['https://github.com/bitcoin/bitcoin'],
        bitbucket: [],
      },
    }),
    imageThumbUrl: 'https://assets.coingecko.com/coins/images/1/thumb/bitcoin.png',
    imageSmallUrl: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
    imageLargeUrl: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
    marketCapRank: 1,
    genesisDate: '2009-01-03',
    platformsJson: '{}',
    status: 'active' as const,
    createdAt: new Date(seedTimestamp),
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'ethereum',
    symbol: 'eth',
    name: 'Ethereum',
    apiSymbol: 'ethereum',
    hashingAlgorithm: 'Ethash',
    blockTimeInMinutes: 1,
    categoriesJson: JSON.stringify(['Smart Contract Platform', 'Layer 1']),
    descriptionJson: JSON.stringify({
      en: 'Ethereum is a programmable blockchain that powers smart contracts, token issuance, and a large share of crypto applications.',
    }),
    linksJson: JSON.stringify({
      homepage: ['https://ethereum.org'],
      blockchain_site: ['https://etherscan.io'],
      official_forum_url: ['https://ethereum-magicians.org'],
      chat_url: ['https://discord.gg/ethereum-org'],
      announcement_url: [],
      twitter_screen_name: 'ethereum',
      facebook_username: '',
      telegram_channel_identifier: '',
      subreddit_url: 'https://reddit.com/r/ethereum',
      repos_url: {
        github: ['https://github.com/ethereum/go-ethereum'],
        bitbucket: [],
      },
    }),
    imageThumbUrl: 'https://assets.coingecko.com/coins/images/279/thumb/ethereum.png',
    imageSmallUrl: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    imageLargeUrl: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
    marketCapRank: 2,
    genesisDate: '2015-07-30',
    platformsJson: '{}',
    status: 'active' as const,
    createdAt: new Date(seedTimestamp),
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'usd-coin',
    symbol: 'usdc',
    name: 'USDC',
    apiSymbol: 'usd-coin',
    hashingAlgorithm: null,
    blockTimeInMinutes: null,
    categoriesJson: JSON.stringify(['Stablecoins']),
    descriptionJson: JSON.stringify({
      en: 'USDC is a fiat-backed stablecoin designed to track the value of the United States dollar.',
    }),
    linksJson: JSON.stringify({
      homepage: ['https://www.circle.com/usdc'],
      blockchain_site: ['https://etherscan.io/token/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
      official_forum_url: [],
      chat_url: [],
      announcement_url: [],
      twitter_screen_name: 'circle',
      facebook_username: '',
      telegram_channel_identifier: '',
      subreddit_url: '',
      repos_url: {
        github: [],
        bitbucket: [],
      },
    }),
    imageThumbUrl: 'https://assets.coingecko.com/coins/images/6319/thumb/usdc.png',
    imageSmallUrl: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
    imageLargeUrl: 'https://assets.coingecko.com/coins/images/6319/large/usdc.png',
    marketCapRank: 6,
    genesisDate: '2018-09-26',
    platformsJson: JSON.stringify({ ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }),
    status: 'active' as const,
    createdAt: new Date(seedTimestamp),
    updatedAt: new Date(seedTimestamp),
  },
];

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

const seededExchanges = [
  {
    id: 'binance',
    name: 'Binance',
    yearEstablished: 2017,
    country: 'Cayman Islands',
    description: 'Binance is a global cryptocurrency exchange with broad spot market coverage.',
    url: 'https://www.binance.com',
    imageUrl: 'https://assets.coingecko.com/markets/images/52/small/binance.jpg',
    hasTradingIncentive: false,
    trustScore: 10,
    trustScoreRank: 1,
    tradeVolume24hBtc: 320000,
    tradeVolume24hBtcNormalized: 310000,
    facebookUrl: 'https://www.facebook.com/binanceexchange',
    redditUrl: 'https://reddit.com/r/binance',
    telegramUrl: 'https://t.me/binanceexchange',
    slackUrl: null,
    otherUrlJson: JSON.stringify([]),
    twitterHandle: 'binance',
    centralised: true,
    publicNotice: null,
    alertNotice: null,
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'coinbase_exchange',
    name: 'Coinbase Exchange',
    yearEstablished: 2012,
    country: 'United States',
    description: 'Coinbase Exchange is a regulated spot exchange serving retail and institutional markets.',
    url: 'https://exchange.coinbase.com',
    imageUrl: 'https://assets.coingecko.com/markets/images/23/small/Coinbase.jpg',
    hasTradingIncentive: false,
    trustScore: 10,
    trustScoreRank: 2,
    tradeVolume24hBtc: 145000,
    tradeVolume24hBtcNormalized: 142500,
    facebookUrl: 'https://www.facebook.com/Coinbase',
    redditUrl: 'https://reddit.com/r/CoinBase',
    telegramUrl: null,
    slackUrl: null,
    otherUrlJson: JSON.stringify([]),
    twitterHandle: 'coinbase',
    centralised: true,
    publicNotice: null,
    alertNotice: null,
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
    description: 'Binance Futures is Binance’s derivatives venue for perpetual and dated futures markets.',
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
    nativeCurrencyCoinId: null,
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

const seededSnapshots = [
  {
    coinId: 'bitcoin',
    vsCurrency: 'usd',
    price: 85_000,
    marketCap: 1_700_000_000_000,
    totalVolume: 25_000_000_000,
    marketCapRank: 1,
    fullyDilutedValuation: 1_785_000_000_000,
    circulatingSupply: 19_850_000,
    totalSupply: 21_000_000,
    maxSupply: 21_000_000,
    ath: 109_000,
    athChangePercentage: -22,
    athDate: new Date(athTimestamp),
    atl: 15_000,
    atlChangePercentage: 466.67,
    atlDate: new Date(atlTimestamp),
    priceChange24h: 1_500,
    priceChangePercentage24h: 1.8,
    sourceProvidersJson: '[]',
    sourceCount: 0,
    updatedAt: new Date(seedTimestamp),
    lastUpdated: new Date(seedTimestamp),
  },
  {
    coinId: 'ethereum',
    vsCurrency: 'usd',
    price: 2_000,
    marketCap: 240_000_000_000,
    totalVolume: 10_000_000_000,
    marketCapRank: 2,
    fullyDilutedValuation: 240_000_000_000,
    circulatingSupply: 120_000_000,
    totalSupply: 120_000_000,
    maxSupply: null,
    ath: 4_800,
    athChangePercentage: -58.3,
    athDate: new Date(athTimestamp),
    atl: 900,
    atlChangePercentage: 122.2,
    atlDate: new Date(atlTimestamp),
    priceChange24h: 50,
    priceChangePercentage24h: 2.56,
    sourceProvidersJson: '[]',
    sourceCount: 0,
    updatedAt: new Date(seedTimestamp),
    lastUpdated: new Date(seedTimestamp),
  },
  {
    coinId: 'usd-coin',
    vsCurrency: 'usd',
    price: 1,
    marketCap: 60_000_000_000,
    totalVolume: 6_000_000_000,
    marketCapRank: 6,
    fullyDilutedValuation: 60_000_000_000,
    circulatingSupply: 60_000_000_000,
    totalSupply: 60_000_000_000,
    maxSupply: null,
    ath: 1.17,
    athChangePercentage: -14.53,
    athDate: new Date(athTimestamp),
    atl: 0.95,
    atlChangePercentage: 5.26,
    atlDate: new Date(atlTimestamp),
    priceChange24h: 0.001,
    priceChangePercentage24h: 0.1,
    sourceProvidersJson: '[]',
    sourceCount: 0,
    updatedAt: new Date(seedTimestamp),
    lastUpdated: new Date(seedTimestamp),
  },
];

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
  'usd-coin': {
    prices: [0.999, 1.001, 1.0, 1.0, 0.9995, 1.0002, 1.0],
    marketCaps: [59_700_000_000, 59_800_000_000, 59_850_000_000, 59_900_000_000, 59_950_000_000, 59_980_000_000, 60_000_000_000],
    volumes: [5_500_000_000, 5_600_000_000, 5_700_000_000, 5_800_000_000, 5_900_000_000, 5_950_000_000, 6_000_000_000],
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

function buildSeededExchangeVolumePoints() {
  const baseDate = Date.parse('2026-03-14T00:00:00.000Z');
  const seededExchangeVolumes: Array<[string, number[]]> = [
    ['binance', [295000, 300500, 305000, 299500, 308000, 315000, 320000]],
    ['coinbase_exchange', [132000, 134500, 136000, 137500, 140000, 142000, 145000]],
  ];

  return seededExchangeVolumes.flatMap(([exchangeId, volumes]) =>
    volumes.map((volumeBtc, index) => ({
      exchangeId,
      timestamp: new Date(baseDate + index * 24 * 60 * 60 * 1000),
      volumeBtc,
    })),
  );
}

const seededCoinTickers = [
  {
    coinId: 'bitcoin',
    exchangeId: 'binance',
    base: 'BTC',
    target: 'USDT',
    marketName: 'BTC/USDT',
    last: 85010,
    volume: 120000,
    convertedLastUsd: 85010,
    convertedLastBtc: 1,
    convertedVolumeUsd: 10201200000,
    bidAskSpreadPercentage: 0.01,
    trustScore: 'green',
    lastTradedAt: new Date(seedTimestamp),
    lastFetchAt: new Date(seedTimestamp),
    isAnomaly: false,
    isStale: false,
    tradeUrl: 'https://www.binance.com/en/trade/BTC_USDT',
    tokenInfoUrl: null,
    coinGeckoUrl: 'https://www.coingecko.com/en/coins/bitcoin',
  },
  {
    coinId: 'bitcoin',
    exchangeId: 'coinbase_exchange',
    base: 'BTC',
    target: 'USD',
    marketName: 'BTC/USD',
    last: 84980,
    volume: 24000,
    convertedLastUsd: 84980,
    convertedLastBtc: 1,
    convertedVolumeUsd: 2039520000,
    bidAskSpreadPercentage: 0.02,
    trustScore: 'green',
    lastTradedAt: new Date(seedTimestamp),
    lastFetchAt: new Date(seedTimestamp),
    isAnomaly: false,
    isStale: false,
    tradeUrl: 'https://exchange.coinbase.com/trade/BTC-USD',
    tokenInfoUrl: null,
    coinGeckoUrl: 'https://www.coingecko.com/en/coins/bitcoin',
  },
  {
    coinId: 'ethereum',
    exchangeId: 'binance',
    base: 'ETH',
    target: 'USDT',
    marketName: 'ETH/USDT',
    last: 2005,
    volume: 350000,
    convertedLastUsd: 2005,
    convertedLastBtc: 2005 / 85000,
    convertedVolumeUsd: 701750000,
    bidAskSpreadPercentage: 0.01,
    trustScore: 'green',
    lastTradedAt: new Date(seedTimestamp),
    lastFetchAt: new Date(seedTimestamp),
    isAnomaly: false,
    isStale: false,
    tradeUrl: 'https://www.binance.com/en/trade/ETH_USDT',
    tokenInfoUrl: 'https://www.binance.com/en/price/ethereum',
    coinGeckoUrl: 'https://www.coingecko.com/en/coins/ethereum',
  },
  {
    coinId: 'ethereum',
    exchangeId: 'coinbase_exchange',
    base: 'ETH',
    target: 'USD',
    marketName: 'ETH/USD',
    last: 1998,
    volume: 82000,
    convertedLastUsd: 1998,
    convertedLastBtc: 1998 / 85000,
    convertedVolumeUsd: 163836000,
    bidAskSpreadPercentage: 0.03,
    trustScore: 'green',
    lastTradedAt: new Date(seedTimestamp),
    lastFetchAt: new Date(seedTimestamp),
    isAnomaly: false,
    isStale: false,
    tradeUrl: 'https://exchange.coinbase.com/trade/ETH-USD',
    tokenInfoUrl: 'https://www.coinbase.com/price/ethereum',
    coinGeckoUrl: 'https://www.coingecko.com/en/coins/ethereum',
  },
  {
    coinId: 'usd-coin',
    exchangeId: 'binance',
    base: 'USDC',
    target: 'USDT',
    marketName: 'USDC/USDT',
    last: 1,
    volume: 950000,
    convertedLastUsd: 1,
    convertedLastBtc: 1 / 85000,
    convertedVolumeUsd: 950000,
    bidAskSpreadPercentage: 0.01,
    trustScore: 'green',
    lastTradedAt: new Date(seedTimestamp),
    lastFetchAt: new Date(seedTimestamp),
    isAnomaly: false,
    isStale: false,
    tradeUrl: 'https://www.binance.com/en/trade/USDC_USDT',
    tokenInfoUrl: null,
    coinGeckoUrl: 'https://www.coingecko.com/en/coins/usd-coin',
  },
];

export function migrateDatabase(database: AppDatabase) {
  if (!existsSync(MIGRATION_JOURNAL)) {
    return;
  }

  migrate(database.db, {
    migrationsFolder: MIGRATIONS_FOLDER,
  });
}

export function seedReferenceData(database: AppDatabase) {
  const [{ value: coinCount }] = database.db.select({ value: count() }).from(coins).all();
  const [{ value: assetPlatformCount }] = database.db.select({ value: count() }).from(assetPlatforms).all();
  const [{ value: categoryCount }] = database.db.select({ value: count() }).from(categories).all();
  const [{ value: chartPointCount }] = database.db.select({ value: count() }).from(chartPoints).all();
  const [{ value: exchangeCount }] = database.db.select({ value: count() }).from(exchanges).all();
  const [{ value: derivativeTickerCount }] = database.db.select({ value: count() }).from(derivativeTickers).all();
  const [{ value: derivativesExchangeCount }] = database.db.select({ value: count() }).from(derivativesExchanges).all();
  const [{ value: exchangeVolumePointCount }] = database.db.select({ value: count() }).from(exchangeVolumePoints).all();
  const [{ value: coinTickerCount }] = database.db.select({ value: count() }).from(coinTickers).all();
  const [{ value: treasuryEntityCount }] = database.db.select({ value: count() }).from(treasuryEntities).all();
  const [{ value: treasuryHoldingCount }] = database.db.select({ value: count() }).from(treasuryHoldings).all();
  const [{ value: onchainNetworkCount }] = database.db.select({ value: count() }).from(onchainNetworks).all();
  const [{ value: onchainDexCount }] = database.db.select({ value: count() }).from(onchainDexes).all();

  if (coinCount === 0) {
    database.db.insert(coins).values(seededCoins).run();
  }

  if (assetPlatformCount === 0) {
    database.db.insert(assetPlatforms).values(seededAssetPlatforms).run();
  }

  if (categoryCount === 0) {
    database.db.insert(categories).values(seededCategories).run();
  }

  const existingSnapshot = database.db
    .select({ coinId: marketSnapshots.coinId })
    .from(marketSnapshots)
    .where(eq(marketSnapshots.coinId, 'bitcoin'))
    .limit(1)
    .all();

  if (existingSnapshot.length === 0) {
    database.db.insert(marketSnapshots).values(seededSnapshots).onConflictDoNothing().run();
  }

  if (chartPointCount === 0) {
    database.db.insert(chartPoints).values(buildSeededChartPoints()).onConflictDoNothing().run();
  }

  if (exchangeCount === 0) {
    database.db.insert(exchanges).values(seededExchanges).run();
  }

  if (derivativesExchangeCount === 0) {
    database.db.insert(derivativesExchanges).values(seededDerivativesExchanges).run();
  }

  if (derivativeTickerCount === 0) {
    database.db.insert(derivativeTickers).values(seededDerivativeTickers).run();
  }

  if (treasuryEntityCount === 0) {
    database.db.insert(treasuryEntities).values(seededTreasuryEntities).run();
  }

  if (treasuryHoldingCount === 0) {
    database.db.insert(treasuryHoldings).values(seededTreasuryHoldings).run();
  }

  if (onchainNetworkCount === 0) {
    database.db.insert(onchainNetworks).values(seededOnchainNetworks).run();
  }

  if (onchainDexCount === 0) {
    database.db.insert(onchainDexes).values(seededOnchainDexes).run();
  }

  if (exchangeVolumePointCount === 0) {
    database.db.insert(exchangeVolumePoints).values(buildSeededExchangeVolumePoints()).onConflictDoNothing().run();
  }

  if (coinTickerCount === 0) {
    database.db.insert(coinTickers).values(seededCoinTickers).onConflictDoNothing().run();
  }
}

export function initializeDatabase(database: AppDatabase) {
  migrateDatabase(database);
  seedReferenceData(database);
  rebuildSearchIndex(database);
}
