import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Database as BetterSqlite3DatabaseClient } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Database as BunDatabase } from 'bun:sqlite';

import { rebuildSearchIndex } from './search-index';
export { rebuildSearchIndex } from './search-index';
import { seedDailyCandlesFromCloseSeries } from '../services/candle-store';
import {
  assetPlatforms,
  categories,
  chartPoints,
  coins,
  derivativeTickers,
  derivativesExchanges,
  exchanges,
  ohlcvCandles,
  ohlcvSyncTargets,
  onchainDexes,
  onchainNetworks,
  onchainPools,
  treasuryEntities,
  treasuryHoldings,
  treasuryTransactions,
} from './schema';

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');
const MIGRATION_JOURNAL = resolve(MIGRATIONS_FOLDER, 'meta', '_journal.json');
const TARGETED_RUNTIME_INDEX_MIGRATION_HASH = '8301ee03effe7ffc4e7723bb625c4a009dfa80811cdd268979f756b9a4cab40e';
const TARGETED_RUNTIME_INDEX_MIGRATION_CREATED_AT = 1774800000000;

const schema = {
  assetPlatforms,
  categories,
  chartPoints,
  coins,
  derivativeTickers,
  derivativesExchanges,
  ohlcvSyncTargets,
  onchainDexes,
  onchainNetworks,
  onchainPools,
  treasuryEntities,
  treasuryHoldings,
  treasuryTransactions,
};

type AppSchema = typeof schema;

type SqliteRuntime = 'node' | 'bun';

type SqliteStatement<Row = unknown> = {
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  run(...params: unknown[]): unknown;
};

export type SqliteClient = {
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  close(): void;
};

type AppDrizzleDatabase = BetterSQLite3Database<AppSchema> | BunSQLiteDatabase<AppSchema>;

export type AppDatabase = {
  client: SqliteClient;
  db: AppDrizzleDatabase;
  runtime: SqliteRuntime;
  url: string;
};

class BunSqliteClient implements SqliteClient {
  constructor(private readonly database: BunDatabase) {}

  prepare<Row = unknown>(sql: string): SqliteStatement<Row> {
    const statement = this.database.query<Row>(sql);

    return {
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
      run: (...params) => statement.run(...params),
    };
  }

  exec(sql: string) {
    this.database.exec(sql);
  }

  pragma(sql: string) {
    return this.database.query(`PRAGMA ${sql}`).get();
  }

  close() {
    this.database.close();
  }
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' || Boolean(process.versions.bun);
}

export function detectSqliteRuntime(): SqliteRuntime {
  return isBunRuntime() ? 'bun' : 'node';
}

function resolveDatabaseUrl(databaseUrl: string) {
  if (databaseUrl === ':memory:') {
    return databaseUrl;
  }

  return resolve(process.cwd(), databaseUrl);
}

function createNodeDatabase(resolvedUrl: string): AppDatabase {
  const Database = require('better-sqlite3') as new (path?: string) => BetterSqlite3DatabaseClient;
  const { drizzle } = require('drizzle-orm/better-sqlite3') as {
    drizzle: (client: BetterSqlite3DatabaseClient, config: { schema: AppSchema }) => BetterSQLite3Database<AppSchema>;
  };

  const client = new Database(resolvedUrl);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');

  return {
    client,
    db: drizzle(client, { schema }),
    runtime: 'node',
    url: resolvedUrl,
  };
}

function createBunDatabase(resolvedUrl: string): AppDatabase {
  const { Database } = require('bun:sqlite') as { Database: new (filename?: string) => BunDatabase };
  const { drizzle } = require('drizzle-orm/bun-sqlite') as {
    drizzle: (client: BunDatabase, config: { schema: AppSchema }) => BunSQLiteDatabase<AppSchema>;
  };

  const rawClient = new Database(resolvedUrl);
  const client = new BunSqliteClient(rawClient);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');

  return {
    client,
    db: drizzle(rawClient, { schema }),
    runtime: 'bun',
    url: resolvedUrl,
  };
}

export function createDatabase(databaseUrl: string): AppDatabase {
  const resolvedUrl = resolveDatabaseUrl(databaseUrl);

  if (resolvedUrl !== ':memory:') {
    mkdirSync(dirname(resolvedUrl), { recursive: true });
  }

  return detectSqliteRuntime() === 'bun' ? createBunDatabase(resolvedUrl) : createNodeDatabase(resolvedUrl);
}

export function migrateDatabase(database: AppDatabase) {
  database.client.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);

  const targetedRuntimeIndexes = [
    'coins_status_market_cap_rank_id_idx',
    'market_snapshots_vs_currency_market_cap_rank_coin_id_idx',
  ] as const;
  const targetedIndexesExist = database.client.prepare<{ name: string }>(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'index'
       AND name IN (${targetedRuntimeIndexes.map(() => '?').join(', ')})
     ORDER BY name`,
  ).all(...targetedRuntimeIndexes);

  if (targetedIndexesExist.length === targetedRuntimeIndexes.length) {
    const targetedMigrationRecorded = database.client.prepare<{ count: number }>(
      'SELECT COUNT(*) AS count FROM __drizzle_migrations WHERE hash = ?',
    ).get(TARGETED_RUNTIME_INDEX_MIGRATION_HASH);

    if ((targetedMigrationRecorded?.count ?? 0) === 0) {
      database.client.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
      ).run(TARGETED_RUNTIME_INDEX_MIGRATION_HASH, TARGETED_RUNTIME_INDEX_MIGRATION_CREATED_AT);
    }
  }

  if (database.runtime === 'bun') {
    const { migrate } = require('drizzle-orm/bun-sqlite/migrator') as {
      migrate: (db: BunSQLiteDatabase<AppSchema>, config: { migrationsFolder: string }) => void;
    };

    migrate(database.db as BunSQLiteDatabase<AppSchema>, {
      migrationsFolder: MIGRATIONS_FOLDER,
    });

    return;
  }

  const { migrate } = require('drizzle-orm/better-sqlite3/migrator') as {
    migrate: (db: BetterSQLite3Database<AppSchema>, config: { migrationsFolder: string }) => void;
  };

  migrate(database.db as BetterSQLite3Database<AppSchema>, {
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

const seededSpotExchanges = [
  {
    id: 'binance',
    name: 'Binance',
    yearEstablished: 2017,
    country: 'Cayman Islands',
    description: 'One of the world’s largest cryptocurrency exchanges by trading volume, offering a wide range of services including spot, futures, and staking options.',
    url: 'https://www.binance.com/',
    imageUrl: 'https://coin-images.coingecko.com/markets/images/52/small/binance.jpg?1706864274',
    hasTradingIncentive: false,
    trustScore: 10,
    trustScoreRank: 1,
    tradeVolume24hBtc: 139508.1218951856,
    tradeVolume24hBtcNormalized: null,
    facebookUrl: 'https://www.facebook.com/binanceexchange',
    redditUrl: 'https://www.reddit.com/r/binance/',
    telegramUrl: '',
    slackUrl: '',
    otherUrlJson: JSON.stringify([
      'https://medium.com/binanceexchange',
      'https://steemit.com/@binanceexchange',
    ]),
    twitterHandle: 'binance',
    centralised: true,
    publicNotice: '',
    alertNotice: '',
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'bybit_spot',
    name: 'Bybit',
    yearEstablished: 2018,
    country: 'British Virgin Islands',
    description: 'Bybit is the world’s second-largest cryptocurrency exchange by trading volume.',
    url: 'https://www.bybit.com',
    imageUrl: 'https://coin-images.coingecko.com/markets/images/698/small/bybit_spot.png?1706864649',
    hasTradingIncentive: false,
    trustScore: 10,
    trustScoreRank: 2,
    tradeVolume24hBtc: 31354.586546252525,
    tradeVolume24hBtcNormalized: null,
    facebookUrl: null,
    redditUrl: null,
    telegramUrl: null,
    slackUrl: null,
    otherUrlJson: '[]',
    twitterHandle: null,
    centralised: true,
    publicNotice: null,
    alertNotice: null,
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'gdax',
    name: 'Coinbase Exchange',
    yearEstablished: 2012,
    country: 'United States',
    description: 'A leading U.S.-based exchange known for fiat-to-crypto trading.',
    url: 'https://www.coinbase.com/',
    imageUrl: 'https://coin-images.coingecko.com/markets/images/23/small/Coinbase_Coin_Primary.png?1706864258',
    hasTradingIncentive: false,
    trustScore: 10,
    trustScoreRank: 3,
    tradeVolume24hBtc: 28639.82177338897,
    tradeVolume24hBtcNormalized: null,
    facebookUrl: null,
    redditUrl: null,
    telegramUrl: null,
    slackUrl: null,
    otherUrlJson: '[]',
    twitterHandle: null,
    centralised: true,
    publicNotice: null,
    alertNotice: null,
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'gate',
    name: 'Gate',
    yearEstablished: 2013,
    country: 'Panama',
    description: 'Gate provides digital asset trading and related blockchain services.',
    url: 'https://www.gate.com',
    imageUrl: 'https://coin-images.coingecko.com/markets/images/60/small/Frame_1.png?1747795534',
    hasTradingIncentive: false,
    trustScore: 10,
    trustScoreRank: 4,
    tradeVolume24hBtc: 25125.993617291915,
    tradeVolume24hBtcNormalized: null,
    facebookUrl: null,
    redditUrl: null,
    telegramUrl: null,
    slackUrl: null,
    otherUrlJson: '[]',
    twitterHandle: null,
    centralised: true,
    publicNotice: null,
    alertNotice: null,
    updatedAt: new Date(seedTimestamp),
  },
  {
    id: 'okex',
    name: 'OKX',
    yearEstablished: 2017,
    country: 'Seychelles',
    description: 'OKX is a global cryptocurrency exchange with spot and derivatives markets.',
    url: 'https://www.okx.com',
    imageUrl: 'https://coin-images.coingecko.com/markets/images/96/small/WeChat_Image_20220117220452.png?1706864283',
    hasTradingIncentive: false,
    trustScore: 10,
    trustScoreRank: 5,
    tradeVolume24hBtc: 24349.950465989154,
    tradeVolume24hBtcNormalized: null,
    facebookUrl: null,
    redditUrl: null,
    telegramUrl: null,
    slackUrl: null,
    otherUrlJson: '[]',
    twitterHandle: null,
    centralised: true,
    publicNotice: null,
    alertNotice: null,
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

const seededOnchainPools = [
  {
    networkId: 'eth',
    address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    dexId: 'uniswap_v3',
    name: 'USDC / WETH 0.05%',
    baseTokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    baseTokenSymbol: 'USDC',
    quoteTokenAddress: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
    quoteTokenSymbol: 'WETH',
    priceUsd: 1,
    reserveUsd: 325000000,
    volume24hUsd: 64500000,
    transactions24hBuys: 12840,
    transactions24hSells: 12590,
    createdAtTimestamp: new Date(Date.parse('2024-04-10T00:00:00.000Z')),
    updatedAt: new Date(seedTimestamp),
  },
  {
    networkId: 'eth',
    address: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
    dexId: 'uniswap_v3',
    name: 'WETH / USDT 0.30%',
    baseTokenAddress: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
    baseTokenSymbol: 'WETH',
    quoteTokenAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    quoteTokenSymbol: 'USDT',
    priceUsd: 3500,
    reserveUsd: 410000000,
    volume24hUsd: 74200000,
    transactions24hBuys: 15400,
    transactions24hSells: 14910,
    createdAtTimestamp: new Date(Date.parse('2024-05-03T00:00:00.000Z')),
    updatedAt: new Date(seedTimestamp),
  },
  {
    networkId: 'eth',
    address: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    dexId: 'curve',
    name: 'DAI / USDC / USDT',
    baseTokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    baseTokenSymbol: 'USDC',
    quoteTokenAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    quoteTokenSymbol: 'USDT',
    priceUsd: 1,
    reserveUsd: 680000000,
    volume24hUsd: 28500000,
    transactions24hBuys: 7250,
    transactions24hSells: 7040,
    createdAtTimestamp: new Date(Date.parse('2024-02-11T00:00:00.000Z')),
    updatedAt: new Date(seedTimestamp),
  },
  {
    networkId: 'solana',
    address: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    dexId: 'raydium',
    name: 'SOL / USDC',
    baseTokenAddress: 'So11111111111111111111111111111111111111112',
    baseTokenSymbol: 'SOL',
    quoteTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    quoteTokenSymbol: 'USDC',
    priceUsd: 180,
    reserveUsd: 128000000,
    volume24hUsd: 31800000,
    transactions24hBuys: 11020,
    transactions24hSells: 10880,
    createdAtTimestamp: new Date(Date.parse('2024-07-15T00:00:00.000Z')),
    updatedAt: new Date(seedTimestamp),
  },
];

const seededChartPointValues = {
  bitcoin: {
    prices: [70_681.22808943377, 68_882, 67_850, 66_904, 66_145, 66_587, 66_194],
    marketCaps: [1_413_000_000_000, 1_377_800_000_000, 1_356_900_000_000, 1_339_400_000_000, 1_325_500_000_000, 1_332_400_000_000, 1_323_878_876_195],
    volumes: [47_657_767_940, 50_700_000_000, 49_300_000_000, 48_200_000_000, 47_900_000_000, 47_657_767_940, 47_657_767_940],
  },
  ethereum: {
    prices: [2_153.248566172594, 2_068.73, 2_041.62, 2_021.44, 2_006.21, 1_972.03, 1_987.94],
    marketCaps: [260_000_000_000, 250_300_000_000, 246_900_000_000, 243_900_000_000, 241_800_000_000, 238_100_000_000, 239_883_065_644],
    volumes: [18_589_171_218, 20_900_000_000, 19_700_000_000, 19_100_000_000, 18_800_000_000, 18_589_171_218, 18_589_171_218],
  },
  ripple: {
    prices: [2.2, 2.25, 2.3, 2.34, 2.4, 2.48, 2.55],
    marketCaps: [128_000_000_000, 131_000_000_000, 134_000_000_000, 136_000_000_000, 140_000_000_000, 144_000_000_000, 148_000_000_000],
    volumes: [8_800_000_000, 9_100_000_000, 9_500_000_000, 9_800_000_000, 10_400_000_000, 11_200_000_000, 12_000_000_000],
  },
  solana: {
    prices: [90.41360474280566, 86.47, 85.18, 84.02, 83.41, 82.14, 82.41],
    marketCaps: [51_800_000_000, 49_600_000_000, 48_900_000_000, 48_200_000_000, 47_900_000_000, 47_100_000_000, 47_168_389_011],
    volumes: [3_382_702_577, 3_900_000_000, 3_700_000_000, 3_550_000_000, 3_480_000_000, 3_382_702_577, 3_382_702_577],
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
  const baseDate = seedTimestamp - (6 * 24 * 60 * 60 * 1000);

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

const seededMinimalCoins = [
  {
    id: 'bitcoin',
    symbol: 'btc',
    name: 'Bitcoin',
    imageThumbUrl: 'https://coin-images.coingecko.com/coins/images/1/thumb/bitcoin.png?1696501400',
    imageSmallUrl: 'https://coin-images.coingecko.com/coins/images/1/small/bitcoin.png?1696501400',
    imageLargeUrl: 'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400',
  },
  {
    id: 'ethereum',
    symbol: 'eth',
    name: 'Ethereum',
    imageThumbUrl: 'https://coin-images.coingecko.com/coins/images/279/thumb/ethereum.png?1696501628',
    imageSmallUrl: 'https://coin-images.coingecko.com/coins/images/279/small/ethereum.png?1696501628',
    imageLargeUrl: 'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png?1696501628',
  },
  { id: 'ripple', symbol: 'xrp', name: 'XRP' },
  {
    id: 'solana',
    symbol: 'sol',
    name: 'Solana',
    imageThumbUrl: 'https://coin-images.coingecko.com/coins/images/4128/thumb/solana.png?1718769756',
    imageSmallUrl: 'https://coin-images.coingecko.com/coins/images/4128/small/solana.png?1718769756',
    imageLargeUrl: 'https://coin-images.coingecko.com/coins/images/4128/large/solana.png?1718769756',
  },
  { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin' },
  { id: 'usd-coin', symbol: 'usdc', name: 'USD Coin' },
  { id: 'cardano', symbol: 'ada', name: 'Cardano' },
  { id: 'chainlink', symbol: 'link', name: 'Chainlink' },
].map((coin, index) => ({
  ...coin,
  apiSymbol: coin.id,
  hashingAlgorithm: null,
  blockTimeInMinutes: null,
  categoriesJson: '[]',
  descriptionJson: JSON.stringify({
    en: `${coin.name} is available in the OpenGecko fixture catalog.`,
  }),
  linksJson: '{}',
  imageThumbUrl: coin.imageThumbUrl ?? `https://assets.opengecko.test/coins/${coin.id}-thumb.png`,
  imageSmallUrl: coin.imageSmallUrl ?? `https://assets.opengecko.test/coins/${coin.id}-small.png`,
  imageLargeUrl: coin.imageLargeUrl ?? `https://assets.opengecko.test/coins/${coin.id}-large.png`,
  marketCapRank: index + 1,
  genesisDate: coin.id === 'bitcoin' ? '2009-01-03' : null,
  platformsJson: coin.id === 'usd-coin' ? JSON.stringify({ ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }) : '{}',
  status: 'active' as const,
  createdAt: new Date(seedTimestamp),
  updatedAt: new Date(seedTimestamp),
}));

export type SeedStaticReferenceDataOptions = {
  includeSeededExchanges?: boolean;
};

export function seedStaticReferenceData(
  database: AppDatabase,
  options: SeedStaticReferenceDataOptions = {},
) {
  const seededChartPoints = buildSeededChartPoints();
  const {
    includeSeededExchanges = false,
  } = options;

  database.db.insert(coins).values(seededMinimalCoins).onConflictDoNothing().run();
  database.db.insert(assetPlatforms).values(seededAssetPlatforms).onConflictDoNothing().run();
  database.db.insert(categories).values(seededCategories).onConflictDoNothing().run();
  if (includeSeededExchanges) {
    database.db.insert(exchanges).values(seededSpotExchanges).onConflictDoNothing().run();
  }
  database.db.insert(derivativesExchanges).values(seededDerivativesExchanges).onConflictDoNothing().run();
  database.db.insert(derivativeTickers).values(seededDerivativeTickers).onConflictDoNothing().run();
  database.db.insert(treasuryEntities).values(seededTreasuryEntities).onConflictDoNothing().run();
  database.db.insert(treasuryHoldings).values(seededTreasuryHoldings).onConflictDoNothing().run();
  database.db.insert(treasuryTransactions).values(seededTreasuryTransactions).onConflictDoNothing().run();
  database.db.insert(onchainNetworks).values(seededOnchainNetworks).onConflictDoNothing().run();
  database.db.insert(onchainDexes).values(seededOnchainDexes).onConflictDoNothing().run();
  database.db.insert(onchainPools).values(seededOnchainPools).onConflictDoNothing().run();
  database.db.insert(chartPoints).values(seededChartPoints).onConflictDoNothing().run();
  database.db.insert(ohlcvCandles).values(seedDailyCandlesFromCloseSeries(seededChartPoints)).onConflictDoNothing().run();
}

export function initializeDatabase(database: AppDatabase) {
  migrateDatabase(database);
  seedStaticReferenceData(database);
  rebuildSearchIndex(database);
}
