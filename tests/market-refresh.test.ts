import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coinHistorySnapshots, coinTickers, coins, exchanges, exchangeVolumePoints, marketSnapshots, quoteSnapshots, supplyChartPoints } from '../src/db/schema';
import { runMarketRefreshOnce, withExchangeFetchTimeout } from '../src/services/market-refresh';
import { createMarketDataRuntimeState } from '../src/services/market-runtime-state';
import { createMetricsRegistry } from '../src/services/metrics';
import { seedRuntimeSnapshotsFromPersistentStore } from '../src/services/bootstrap';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx', 'gate'].includes(value),
}));

import { fetchExchangeMarkets, fetchExchangeNetworks, fetchExchangeTickers } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeNetworks = fetchExchangeNetworks as ReturnType<typeof vi.fn>;
const mockedFetchExchangeTickers = fetchExchangeTickers as ReturnType<typeof vi.fn>;

const now = new Date();

function expireProviderBreakers(runtimeState: ReturnType<typeof createMarketDataRuntimeState>) {
  for (const entry of Object.values(runtimeState.providerBreakers?.providers ?? {})) {
    entry.openedUntil = Date.now() - 1;
  }
}

const seededExchanges = [
  { id: 'binance', name: 'Binance', url: 'https://www.binance.com', trustScore: 10, updatedAt: now },
  { id: 'coinbase', name: 'Coinbase', url: 'https://www.coinbase.com', trustScore: 10, updatedAt: now },
  { id: 'kraken', name: 'Kraken', url: 'https://www.kraken.com', trustScore: 10, updatedAt: now },
  { id: 'bybit', name: 'Bybit', url: 'https://www.bybit.com', trustScore: 10, updatedAt: now },
];

describe('market refresh service', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-market-refresh-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    for (const exchange of seededExchanges) {
      database.db.insert(exchanges).values(exchange).run();
    }
    rebuildSearchIndex(database);
    mockedFetchExchangeMarkets.mockReset();
    mockedFetchExchangeNetworks.mockReset();
    mockedFetchExchangeTickers.mockReset();
    mockedFetchExchangeNetworks.mockResolvedValue([]);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('upserts live coin tickers from exchange refresh results', async () => {
    database.db.insert(exchanges).values({
      id: 'gate',
      name: 'Gate',
      url: 'https://www.gate.io',
      trustScore: 8,
      updatedAt: now,
    }).run();

    mockedFetchExchangeMarkets.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USD',
        base: 'BTC',
        quote: 'USD',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
      {
        exchangeId: 'binance',
        symbol: 'ETH/USD',
        base: 'ETH',
        quote: 'USD',
        active: true,
        spot: true,
        baseName: 'Ethereum',
        raw: {},
      },
      {
        exchangeId: 'binance',
        symbol: 'LTC/USD',
        base: 'LTC',
        quote: 'USD',
        active: true,
        spot: true,
        baseName: 'Litecoin',
        raw: {},
      },
    ]);
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      switch (exchangeId) {
        case 'binance':
          return [{
            exchangeId: 'binance',
            symbol: 'BTC/USDT',
            base: 'BTC',
            quote: 'USDT',
            last: 90_000,
            bid: 89_950,
            ask: 90_050,
            high: null,
            low: null,
            baseVolume: 1_234,
            quoteVolume: 111_060_000,
            percentage: 5,
            timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
            raw: {} as never,
          }];
        case 'coinbase':
          return [{
            exchangeId: 'coinbase',
            symbol: 'ETH/USD',
            base: 'ETH',
            quote: 'USD',
            last: 2_100,
            bid: 2_099,
            ask: 2_101,
            high: null,
            low: null,
            baseVolume: 5_000,
            quoteVolume: 10_500_000,
            percentage: 3,
            timestamp: Date.parse('2026-03-21T00:01:00.000Z'),
            raw: {} as never,
          }];
        case 'kraken':
          return [{
            exchangeId: 'kraken',
            symbol: 'BTC/EUR',
            base: 'BTC',
            quote: 'EUR',
            last: 82_000,
            bid: 81_900,
            ask: 82_100,
            high: null,
            low: null,
            baseVolume: 100,
            quoteVolume: 8_200_000,
            percentage: 4.5,
            timestamp: Date.parse('2026-03-21T00:02:00.000Z'),
            raw: {} as never,
          }];
        default:
          return [];
      }
    });

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase', 'kraken'],
      providerFanoutConcurrency: 2,
    });

    const bitcoinBinanceTicker = database.db
      .select()
      .from(coinTickers)
      .where(and(
        eq(coinTickers.coinId, 'bitcoin'),
        eq(coinTickers.exchangeId, 'binance'),
        eq(coinTickers.base, 'BTC'),
        eq(coinTickers.target, 'USDT'),
      ))
      .get();
    const ethereumCoinbaseTicker = database.db
      .select()
      .from(coinTickers)
      .where(and(
        eq(coinTickers.coinId, 'ethereum'),
        eq(coinTickers.exchangeId, 'coinbase'),
        eq(coinTickers.base, 'ETH'),
        eq(coinTickers.target, 'USD'),
      ))
      .get();
    const bitcoinKrakenTicker = database.db
      .select()
      .from(coinTickers)
      .where(and(
        eq(coinTickers.coinId, 'bitcoin'),
        eq(coinTickers.exchangeId, 'kraken'),
        eq(coinTickers.base, 'BTC'),
        eq(coinTickers.target, 'EUR'),
      ))
      .get();
    const litecoinCoin = database.db
      .select()
      .from(coins)
      .where(eq(coins.id, 'litecoin'))
      .get();

    expect(bitcoinBinanceTicker).toMatchObject({
      marketName: 'BTC/USDT',
      last: 90_000,
      volume: 1_234,
      convertedLastUsd: 90_000,
      convertedVolumeUsd: 111_060_000,
      trustScore: 'green',
      tradeUrl: 'https://www.binance.com/trade/BTC-USDT',
      tokenInfoUrl: null,
    });
    expect(bitcoinBinanceTicker?.bidAskSpreadPercentage).toBeCloseTo(0.1110494169905608);

    expect(ethereumCoinbaseTicker).toMatchObject({
      exchangeId: 'coinbase',
      marketName: 'ETH/USD',
      last: 2_100,
      volume: 5_000,
      convertedLastUsd: 2_100,
      convertedVolumeUsd: 10_500_000,
      tradeUrl: 'https://www.coinbase.com/trade/ETH-USD',
      tokenInfoUrl: null,
    });

    expect(bitcoinKrakenTicker).toMatchObject({
      exchangeId: 'kraken',
      marketName: 'BTC/EUR',
      last: 82_000,
      convertedLastUsd: 90_000,
      tradeUrl: 'https://www.kraken.com/trade/BTC-EUR',
      tokenInfoUrl: null,
    });
    expect(bitcoinKrakenTicker?.convertedVolumeUsd).toBeGreaterThan(8_200_000);
    expect(litecoinCoin).toMatchObject({
      id: 'litecoin',
      symbol: 'ltc',
      name: 'Litecoin',
    });

    const volumePoints = database.db
      .select()
      .from(exchangeVolumePoints)
      .all();

    expect(volumePoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        exchangeId: 'binance',
        volumeBtc: 111_060_000,
      }),
      expect.objectContaining({
        exchangeId: 'coinbase',
        volumeBtc: 10_500_000,
      }),
      expect.objectContaining({
        exchangeId: 'kraken',
        volumeBtc: 8_200_000,
      }),
    ]));

    const refreshedExchange = database.db
      .select()
      .from(exchanges)
      .where(eq(exchanges.id, 'binance'))
      .get();
    expect(refreshedExchange?.tradeVolume24hBtc).toBe(111_060_000);
  });

  it('duplicates matched tickers into both tracked quote currencies when a shared USD-like pair drives both runtime snapshots', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
    ]);
    mockedFetchExchangeTickers.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        last: 90_000,
        bid: 89_950,
        ask: 90_050,
        high: null,
        low: null,
        baseVolume: 1_234,
        quoteVolume: 111_060_000,
        percentage: 5,
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        raw: {} as never,
      },
    ]);

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance'],
      providerFanoutConcurrency: 1,
    });

    const bitcoinTickers = database.db
      .select()
      .from(coinTickers)
      .where(and(
        eq(coinTickers.coinId, 'bitcoin'),
        eq(coinTickers.exchangeId, 'binance'),
        eq(coinTickers.base, 'BTC'),
        eq(coinTickers.target, 'USDT'),
      ))
      .all();

    expect(bitcoinTickers).toHaveLength(1);

    const bitcoinSnapshots = database.db
      .select()
      .from(exchanges)
      .where(eq(exchanges.id, 'binance'))
      .get();

    expect(bitcoinSnapshots?.tradeVolume24hBtc).toBeGreaterThan(0);
  });

  it('derives market cap from source-backed persisted supply evidence during live ticker refresh', async () => {
    const olderReplayFetchedAt = new Date('2026-03-19T00:00:00.000Z');
    const liveFetchedAt = new Date('2026-03-21T00:00:00.000Z');

    database.db.insert(supplyChartPoints).values([
      {
        coinId: 'bitcoin',
        supplyType: 'circulating',
        timestamp: new Date('2026-03-19T00:00:00.000Z'),
        value: 19_000_000,
        sourceKind: 'replay',
        sourceProvider: 'fixture-replay',
        sourceFetchedAt: olderReplayFetchedAt,
      },
      {
        coinId: 'bitcoin',
        supplyType: 'circulating',
        timestamp: new Date('2026-03-21T00:00:00.000Z'),
        value: 19_850_000,
        sourceKind: 'live',
        sourceProvider: 'public-supply-provider',
        sourceFetchedAt: liveFetchedAt,
      },
      {
        coinId: 'bitcoin',
        supplyType: 'total',
        timestamp: new Date('2026-03-21T00:00:00.000Z'),
        value: 21_000_000,
        sourceKind: 'live',
        sourceProvider: 'public-supply-provider',
        sourceFetchedAt: liveFetchedAt,
      },
    ]).run();
    database.db.insert(coinHistorySnapshots).values({
      coinId: 'ethereum',
      vsCurrency: 'usd',
      snapshotAt: new Date('2026-03-20T00:00:00.000Z'),
      price: 2_000,
      marketCap: 240_000_000_000,
      totalVolume: 10_000_000_000,
      marketCapRank: 2,
      fullyDilutedValuation: 260_000_000_000,
      circulatingSupply: 120_000_000,
      totalSupply: 130_000_000,
      maxSupply: null,
      ath: 4_800,
      athChangePercentage: null,
      athDate: new Date('2021-11-10T00:00:00.000Z'),
      atl: 80,
      atlChangePercentage: null,
      atlDate: new Date('2015-10-20T00:00:00.000Z'),
      priceChange24h: null,
      priceChangePercentage24h: 2,
      sourceKind: 'replay',
      sourceProvider: 'coingecko-snapshot',
      sourceFetchedAt: new Date('2026-03-20T00:05:00.000Z'),
      rawPayloadJson: '{}',
      updatedAt: new Date('2026-03-20T00:05:00.000Z'),
      lastUpdated: new Date('2026-03-20T00:00:00.000Z'),
    }).run();
    database.db.insert(coins).values({
      id: 'no-evidence-coin',
      symbol: 'nec',
      name: 'No Evidence Coin',
      apiSymbol: 'no-evidence-coin',
      hashingAlgorithm: null,
      blockTimeInMinutes: null,
      categoriesJson: '[]',
      descriptionJson: '{}',
      linksJson: '{}',
      imageThumbUrl: null,
      imageSmallUrl: null,
      imageLargeUrl: null,
      marketCapRank: 999,
      genesisDate: null,
      platformsJson: '{}',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run();

    mockedFetchExchangeMarkets.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
      {
        exchangeId: 'binance',
        symbol: 'NEC/USDT',
        base: 'NEC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'No Evidence Coin',
        raw: {},
      },
      {
        exchangeId: 'binance',
        symbol: 'ETH/USDT',
        base: 'ETH',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Ethereum',
        raw: {},
      },
    ]);
    mockedFetchExchangeTickers.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        last: 90_000,
        bid: 89_950,
        ask: 90_050,
        high: null,
        low: null,
        baseVolume: 1_234,
        quoteVolume: 111_060_000,
        percentage: 5,
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        raw: {} as never,
      },
      {
        exchangeId: 'binance',
        symbol: 'NEC/USDT',
        base: 'NEC',
        quote: 'USDT',
        last: 150,
        bid: 149,
        ask: 151,
        high: null,
        low: null,
        baseVolume: 10_000,
        quoteVolume: 1_500_000,
        percentage: 1,
        timestamp: Date.parse('2026-03-21T00:02:00.000Z'),
        raw: {} as never,
      },
      {
        exchangeId: 'binance',
        symbol: 'ETH/USDT',
        base: 'ETH',
        quote: 'USDT',
        last: 2_100,
        bid: 2_099,
        ask: 2_101,
        high: null,
        low: null,
        baseVolume: 5_000,
        quoteVolume: 10_500_000,
        percentage: 3,
        timestamp: Date.parse('2026-03-21T00:01:00.000Z'),
        raw: {} as never,
      },
    ]);

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance'],
      providerFanoutConcurrency: 1,
    });

    const bitcoinSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(and(eq(marketSnapshots.coinId, 'bitcoin'), eq(marketSnapshots.vsCurrency, 'usd')))
      .get();
    const ethereumSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(and(eq(marketSnapshots.coinId, 'ethereum'), eq(marketSnapshots.vsCurrency, 'usd')))
      .get();
    const noEvidenceSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(and(eq(marketSnapshots.coinId, 'no-evidence-coin'), eq(marketSnapshots.vsCurrency, 'usd')))
      .get();

    expect(bitcoinSnapshot).toMatchObject({
      price: 90_000,
      circulatingSupply: 19_850_000,
      totalSupply: 21_000_000,
      marketCap: 1_786_500_000_000,
      fullyDilutedValuation: 1_890_000_000_000,
      sourceProvidersJson: JSON.stringify(['binance']),
      sourceCount: 1,
    });
    expect(ethereumSnapshot).toMatchObject({
      price: 2_100,
      circulatingSupply: 120_000_000,
      totalSupply: 130_000_000,
      marketCap: 252_000_000_000,
      fullyDilutedValuation: 273_000_000_000,
    });
    expect(noEvidenceSnapshot).toMatchObject({
      price: 150,
      circulatingSupply: null,
      totalSupply: null,
      marketCap: null,
    });
  });

  it('imports current ticker indexes from the persisted database during seeded bootstrap', async () => {
    const fixturePersistentDatabase = createDatabase(join(tempDir, 'persisted-bootstrap.db'));
    const runtimeState = createMarketDataRuntimeState();

    try {
      database.db.insert(coins).values({
        id: 'tether',
        symbol: 'usdt',
        name: 'Tether',
        apiSymbol: 'tether',
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: '{}',
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: 3,
        genesisDate: null,
        platformsJson: '{}',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();

      const upsertRuntimeSnapshot = database.client.prepare(`
        INSERT OR REPLACE INTO market_snapshots (
          coin_id, vs_currency, price, market_cap, total_volume, market_cap_rank,
          fully_diluted_valuation, circulating_supply, total_supply, max_supply, ath,
          ath_change_percentage, ath_date, atl, atl_change_percentage, atl_date,
          price_change_24h, price_change_percentage_24h, source_providers_json, source_count,
          updated_at, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      upsertRuntimeSnapshot.run('tether', 'usd', 1, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, '["seed"]', 1, now.getTime(), now.getTime());
      upsertRuntimeSnapshot.run('tether', 'eur', 0.91, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, '["seed"]', 1, now.getTime(), now.getTime());

      migrateDatabase(fixturePersistentDatabase);
      fixturePersistentDatabase.db.insert(exchanges).values({
        id: 'coinbase',
        name: 'Coinbase',
        url: 'https://www.coinbase.com',
        trustScore: 10,
        updatedAt: now,
      }).run();
      fixturePersistentDatabase.db.insert(coins).values([
        {
          id: 'bitcoin',
          symbol: 'btc',
          name: 'Bitcoin',
          apiSymbol: 'bitcoin',
          hashingAlgorithm: null,
          blockTimeInMinutes: null,
          categoriesJson: '[]',
          descriptionJson: '{}',
          linksJson: '{}',
          imageThumbUrl: null,
          imageSmallUrl: null,
          imageLargeUrl: null,
          marketCapRank: 1,
          genesisDate: null,
          platformsJson: '{}',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'ethereum',
          symbol: 'eth',
          name: 'Ethereum',
          apiSymbol: 'ethereum',
          hashingAlgorithm: null,
          blockTimeInMinutes: null,
          categoriesJson: '[]',
          descriptionJson: '{}',
          linksJson: '{}',
          imageThumbUrl: null,
          imageSmallUrl: null,
          imageLargeUrl: null,
          marketCapRank: 2,
          genesisDate: null,
          platformsJson: '{}',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ]).run();
      fixturePersistentDatabase.db.insert(marketSnapshots).values([
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          price: 90_000,
          marketCap: 1_800_000_000_000,
          totalVolume: 100_000_000,
          marketCapRank: 1,
          fullyDilutedValuation: null,
          circulatingSupply: null,
          totalSupply: null,
          maxSupply: null,
          ath: null,
          athChangePercentage: null,
          athDate: null,
          atl: null,
          atlChangePercentage: null,
          atlDate: null,
          priceChange24h: null,
          priceChangePercentage24h: null,
          sourceProvidersJson: '["ccxt"]',
          sourceCount: 1,
          updatedAt: now,
          lastUpdated: now,
        },
        {
          coinId: 'ethereum',
          vsCurrency: 'usd',
          price: 2_100,
          marketCap: 250_000_000_000,
          totalVolume: 50_000_000,
          marketCapRank: 2,
          fullyDilutedValuation: null,
          circulatingSupply: null,
          totalSupply: null,
          maxSupply: null,
          ath: null,
          athChangePercentage: null,
          athDate: null,
          atl: null,
          atlChangePercentage: null,
          atlDate: null,
          priceChange24h: null,
          priceChangePercentage24h: null,
          sourceProvidersJson: '["ccxt"]',
          sourceCount: 1,
          updatedAt: now,
          lastUpdated: now,
        },
      ]).run();
      fixturePersistentDatabase.db.insert(coinTickers).values([
        {
          coinId: 'bitcoin',
          exchangeId: 'coinbase',
          base: 'BTC',
          target: 'USD',
          marketName: 'BTC/USD',
          last: 90_000,
          volume: 1_000,
          convertedLastUsd: 90_000,
          convertedLastBtc: 1,
          convertedVolumeUsd: 90_000_000,
          bidAskSpreadPercentage: null,
          trustScore: 'green',
          lastTradedAt: now,
          lastFetchAt: now,
          isAnomaly: false,
          isStale: false,
          tradeUrl: 'https://www.coinbase.com/trade/BTC-USD',
          tokenInfoUrl: null,
          coinGeckoUrl: 'https://www.coingecko.com/en/coins/bitcoin',
        },
        {
          coinId: 'bitcoin',
          exchangeId: 'coinbase',
          base: 'BTC',
          target: 'USDT',
          marketName: 'BTC/USDT',
          last: 90_010,
          volume: 1_000,
          convertedLastUsd: 90_010,
          convertedLastBtc: 1,
          convertedVolumeUsd: 90_010_000,
          bidAskSpreadPercentage: null,
          trustScore: 'green',
          lastTradedAt: new Date(now.getTime() + 1),
          lastFetchAt: new Date(now.getTime() + 1),
          isAnomaly: false,
          isStale: false,
          tradeUrl: 'https://www.coinbase.com/trade/BTC-USDT',
          tokenInfoUrl: null,
          coinGeckoUrl: 'https://www.coingecko.com/en/coins/bitcoin',
        },
        {
          coinId: 'bitcoin',
          exchangeId: 'coinbase',
          base: 'BTC',
          target: 'EUR',
          marketName: 'BTC/EUR',
          last: 82_000,
          volume: 1_000,
          convertedLastUsd: 90_109.89,
          convertedLastBtc: 1,
          convertedVolumeUsd: 90_109_890,
          bidAskSpreadPercentage: null,
          trustScore: 'green',
          lastTradedAt: new Date(now.getTime() + 2),
          lastFetchAt: new Date(now.getTime() + 2),
          isAnomaly: false,
          isStale: false,
          tradeUrl: 'https://www.coinbase.com/trade/BTC-EUR',
          tokenInfoUrl: null,
          coinGeckoUrl: 'https://www.coingecko.com/en/coins/bitcoin',
        },
        {
          coinId: 'ethereum',
          exchangeId: 'coinbase',
          base: 'ETH',
          target: 'USD',
          marketName: 'ETH/USD',
          last: 2_100,
          volume: 5_000,
          convertedLastUsd: 2_100,
          convertedLastBtc: 2_100 / 90_000,
          convertedVolumeUsd: 10_500_000,
          bidAskSpreadPercentage: null,
          trustScore: 'green',
          lastTradedAt: new Date(now.getTime() + 3),
          lastFetchAt: new Date(now.getTime() + 3),
          isAnomaly: false,
          isStale: false,
          tradeUrl: 'https://www.coinbase.com/trade/ETH-USD',
          tokenInfoUrl: null,
          coinGeckoUrl: 'https://www.coingecko.com/en/coins/ethereum',
        },
      ]).run();

      seedRuntimeSnapshotsFromPersistentStore(database, fixturePersistentDatabase.url, runtimeState);
    } finally {
      fixturePersistentDatabase.client.close();
    }

    const bitcoinTickers = database.db
      .select()
      .from(coinTickers)
      .where(eq(coinTickers.coinId, 'bitcoin'))
      .all();

    expect(bitcoinTickers.length).toBeGreaterThanOrEqual(3);
    expect(new Set(bitcoinTickers.map((ticker) => `${ticker.exchangeId}:${ticker.target}`))).toEqual(new Set([
      'coinbase:EUR',
      'coinbase:USD',
      'coinbase:USDT',
    ]));

    const ethereumTickers = database.db
      .select()
      .from(coinTickers)
      .where(eq(coinTickers.coinId, 'ethereum'))
      .all();

    expect(ethereumTickers.length).toBeGreaterThan(0);
  });

  it('supports non-hardcoded exchanges with generic trade URLs', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([
      {
        exchangeId: 'bybit',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
    ]);
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      if (exchangeId !== 'bybit') {
        return [];
      }

      return [{
        exchangeId: 'bybit',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        last: 90_000,
        bid: 89_990,
        ask: 90_010,
        high: null,
        low: null,
        baseVolume: 1_000,
        quoteVolume: 90_000_000,
        percentage: 1,
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        raw: {} as never,
      }];
    });

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['bybit'],
      providerFanoutConcurrency: 2,
    });

    const bybitTicker = database.db
      .select()
      .from(coinTickers)
      .where(and(
        eq(coinTickers.coinId, 'bitcoin'),
        eq(coinTickers.exchangeId, 'bybit'),
        eq(coinTickers.base, 'BTC'),
        eq(coinTickers.target, 'USDT'),
      ))
      .get();

    expect(bybitTicker).toMatchObject({
      exchangeId: 'bybit',
      tradeUrl: 'https://www.bybit.com/trade/BTC-USDT',
      tokenInfoUrl: null,
    });
  });

  it('limits ticker fanout concurrency during market refresh', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    mockedFetchExchangeMarkets.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
    ]);

    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;

      return [{
        exchangeId,
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        last: 90_000,
        bid: 89_990,
        ask: 90_010,
        high: null,
        low: null,
        baseVolume: 1_000,
        quoteVolume: 90_000_000,
        percentage: 1,
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        raw: {} as never,
      }];
    });

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase', 'kraken', 'bybit'],
      providerFanoutConcurrency: 2,
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('activates cooldown after all exchanges fail and short-circuits repeated refreshes until cooldown expires', async () => {
    const runtimeState = createMarketDataRuntimeState();
    mockedFetchExchangeMarkets.mockResolvedValue([]);
    mockedFetchExchangeTickers.mockRejectedValue(new Error('provider timeout'));

    await expect(runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase'],
      providerFanoutConcurrency: 2,
    }, undefined, runtimeState)).rejects.toThrow('provider failure cooldown active after exchange refresh failure');

    expect(runtimeState.providerFailureCooldownUntil).not.toBeNull();
    expect(mockedFetchExchangeTickers).toHaveBeenCalledTimes(2);

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase'],
      providerFanoutConcurrency: 2,
    }, undefined, runtimeState);

    expect(mockedFetchExchangeTickers).toHaveBeenCalledTimes(2);

    runtimeState.providerFailureCooldownUntil = Date.now() - 1;
    expireProviderBreakers(runtimeState);
    mockedFetchExchangeTickers.mockResolvedValue([]);

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase'],
      providerFanoutConcurrency: 2,
    }, undefined, runtimeState);

    expect(mockedFetchExchangeTickers).toHaveBeenCalledTimes(4);
    expect(runtimeState.providerFailureCooldownUntil).toBeNull();
  });

  it('skips provider work when all exchange breakers are open', async () => {
    const runtimeState = createMarketDataRuntimeState();
    runtimeState.providerBreakers = {
      providers: {
        binance: {
          id: 'binance',
          status: 'open',
          failureCount: 1,
          openedUntil: Date.now() + 60_000,
          lastSuccessAt: null,
          lastFailureAt: Date.now(),
          lastFailureReason: 'timeout',
        },
        coinbase: {
          id: 'coinbase',
          status: 'open',
          failureCount: 1,
          openedUntil: Date.now() + 60_000,
          lastSuccessAt: null,
          lastFailureAt: Date.now(),
          lastFailureReason: 'timeout',
        },
      },
      options: {
        baseBackoffMs: 30_000,
        maxBackoffMs: 300_000,
        multiplier: 2,
        jitterRatio: 0,
        jitter: () => 0,
      },
    };
    const metrics = createMetricsRegistry();

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase'],
      providerFanoutConcurrency: 2,
    }, undefined, runtimeState, metrics);

    expect(mockedFetchExchangeMarkets).not.toHaveBeenCalled();
    expect(mockedFetchExchangeTickers).not.toHaveBeenCalled();
    const metricsText = metrics.renderPrometheus();
    expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="breaker_skip"} 1');
    expect(metricsText).toContain('provider_blocked_by_breaker_total{provider="binance"} 1');
    expect(metricsText).toContain('provider_blocked_by_breaker_total{provider="coinbase"} 1');
  });

  it('fails fast without hitting providers when validator-forced provider failure is active', async () => {
    const runtimeState = createMarketDataRuntimeState();
    runtimeState.forcedProviderFailure = {
      active: true,
      reason: 'validator forced outage',
    };

    await expect(runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase'],
      providerFanoutConcurrency: 2,
    }, undefined, runtimeState)).rejects.toThrow('validator forced outage');

    expect(mockedFetchExchangeTickers).not.toHaveBeenCalled();
    expect(mockedFetchExchangeMarkets).not.toHaveBeenCalled();
  });

  it('records provider refresh outcomes across forced failure, cooldown skip, partial failure, and recovery without changing refresh side effects', async () => {
    const runtimeState = createMarketDataRuntimeState();
    const metricsApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'provider-metrics.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    const metrics = metricsApp.metrics;

    try {
      runtimeState.forcedProviderFailure = {
        active: true,
        reason: 'validator forced outage',
      };

      await expect(runMarketRefreshOnce(database, {
        ccxtExchanges: ['binance', 'coinbase'],
        providerFanoutConcurrency: 2,
      }, undefined, runtimeState, metrics)).rejects.toThrow('validator forced outage');

      runtimeState.forcedProviderFailure.active = false;
      runtimeState.providerFailureCooldownUntil = Date.now() + 60_000;

      await runMarketRefreshOnce(database, {
        ccxtExchanges: ['binance', 'coinbase'],
        providerFanoutConcurrency: 2,
      }, undefined, runtimeState, metrics);

      mockedFetchExchangeMarkets.mockResolvedValue([
        {
          exchangeId: 'binance',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          active: true,
          spot: true,
          baseName: 'Bitcoin',
          raw: {},
        },
      ]);
      mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
        if (exchangeId === 'coinbase') {
          throw new Error('coinbase timeout');
        }

        return [{
          exchangeId,
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          last: 90_000,
          bid: 89_990,
          ask: 90_010,
          high: null,
          low: null,
          baseVolume: 1_000,
          quoteVolume: 90_000_000,
          percentage: 1,
          timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
          raw: {} as never,
        }];
      });
      runtimeState.providerFailureCooldownUntil = Date.now() - 1;
      expireProviderBreakers(runtimeState);

      await runMarketRefreshOnce(database, {
        ccxtExchanges: ['binance', 'coinbase'],
        providerFanoutConcurrency: 2,
      }, undefined, runtimeState, metrics);

      mockedFetchExchangeTickers.mockResolvedValue([
        {
          exchangeId: 'binance',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          last: 91_000,
          bid: 90_990,
          ask: 91_010,
          high: null,
          low: null,
          baseVolume: 1_100,
          quoteVolume: 100_100_000,
          percentage: 2,
          timestamp: Date.parse('2026-03-21T00:05:00.000Z'),
          raw: {} as never,
        },
      ]);
      expireProviderBreakers(runtimeState);

      await runMarketRefreshOnce(database, {
        ccxtExchanges: ['binance', 'coinbase'],
        providerFanoutConcurrency: 2,
      }, undefined, runtimeState, metrics);

      const metricsResponse = await metricsApp.inject({
        method: 'GET',
        url: '/metrics',
      });
      const metricsText = metricsResponse.body;
      expect(metricsResponse.statusCode).toBe(200);
      expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="forced_failure"} 1');
      expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="cooldown_skip"} 1');
      expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="partial_failure"} 1');
      expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="success"} 1');
      for (const providerHealthCounter of [
        'provider_forced_failure_total',
        'provider_blocked_by_breaker_total',
        'provider_partial_failure_total',
        'provider_recovery_total',
      ]) {
        expect(metricsText).toContain(providerHealthCounter);
      }
      expect(metricsText).toContain('provider_forced_failure_total{provider="binance"} 1');
      expect(metricsText).toContain('provider_forced_failure_total{provider="coinbase"} 1');
      expect(metricsText).toContain('provider_partial_failure_total{provider="coinbase"} 1');
      expect(metricsText).toContain('provider_recovery_total{provider="coinbase"} 1');

      const bitcoinBinanceTicker = database.db
        .select()
        .from(coinTickers)
        .where(and(
          eq(coinTickers.coinId, 'bitcoin'),
          eq(coinTickers.exchangeId, 'binance'),
          eq(coinTickers.base, 'BTC'),
          eq(coinTickers.target, 'USDT'),
        ))
        .get();

      expect(bitcoinBinanceTicker).toMatchObject({
        last: 91_000,
        convertedLastUsd: 91_000,
        convertedVolumeUsd: 100_100_000,
      });
      expect(runtimeState.providerFailureCooldownUntil).toBeNull();
    } finally {
      await metricsApp.close();
    }
  });

  it('continues ingesting successful exchanges when one exchange fails', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
      {
        exchangeId: 'coinbase',
        symbol: 'ETH/USD',
        base: 'ETH',
        quote: 'USD',
        active: true,
        spot: true,
        baseName: 'Ethereum',
        raw: {},
      },
    ]);
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'coinbase') {
        return [{
          exchangeId,
          symbol: 'ETH/USD',
          base: 'ETH',
          quote: 'USD',
          last: 2_300,
          bid: 2_299,
          ask: 2_301,
          high: null,
          low: null,
          baseVolume: 5_000,
          quoteVolume: 11_500_000,
          percentage: 2,
          timestamp: Date.parse('2026-03-21T00:01:00.000Z'),
          raw: {} as never,
        }];
      }

      if (exchangeId === 'kraken') {
        throw new Error('kraken timeout');
      }

      return [{
        exchangeId,
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        last: 90_500,
        bid: 90_490,
        ask: 90_510,
        high: null,
        low: null,
        baseVolume: 1_000,
        quoteVolume: 90_500_000,
        percentage: 1,
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        raw: {} as never,
      }];
    });

    await expect(runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase', 'kraken'],
      providerFanoutConcurrency: 2,
    })).resolves.toBeUndefined();

    const ingestedTickers = database.db.select().from(coinTickers).all();
    expect(ingestedTickers).toEqual(expect.arrayContaining([
      expect.objectContaining({ exchangeId: 'binance', coinId: 'bitcoin', convertedLastUsd: 90_500 }),
      expect.objectContaining({ exchangeId: 'coinbase', coinId: 'ethereum', convertedLastUsd: 2_300 }),
    ]));
    expect(ingestedTickers.some((ticker) => ticker.exchangeId === 'kraken')).toBe(false);
  });

  it('writes source-backed normalized snapshots while rejecting malformed, stale, and outlier provider candidates', async () => {
    const acceptedBinanceTimestamp = Date.now() - 5 * 60 * 1000;
    const acceptedCoinbaseTimestamp = acceptedBinanceTimestamp + 60_000;
    const outlierTimestamp = acceptedBinanceTimestamp + 120_000;
    const acceptedEthereumTimestamp = acceptedBinanceTimestamp + 180_000;
    mockedFetchExchangeMarkets.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
      {
        exchangeId: 'coinbase',
        symbol: 'BTC/USD',
        base: 'BTC',
        quote: 'USD',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
      {
        exchangeId: 'kraken',
        symbol: 'BTC/USD',
        base: 'BTC',
        quote: 'USD',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
      {
        exchangeId: 'bybit',
        symbol: 'ETH/USDT',
        base: 'ETH',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Ethereum',
        raw: {},
      },
    ]);
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      switch (exchangeId) {
        case 'binance':
          return [
            {
              exchangeId,
              symbol: 'BTC/USDT',
              base: 'BTC',
              quote: 'USDT',
              last: 90_000,
              bid: 89_990,
              ask: 90_010,
              high: null,
              low: null,
              baseVolume: 1_000,
              quoteVolume: 90_000_000,
              percentage: 1,
              timestamp: acceptedBinanceTimestamp,
              raw: {} as never,
            },
            {
              exchangeId,
              symbol: 'ETH/USDT',
              base: 'ETH',
              quote: 'USDT',
              last: Number.NaN,
              bid: null,
              ask: null,
              high: null,
              low: null,
              baseVolume: null,
              quoteVolume: null,
              percentage: null,
              timestamp: Date.parse('2026-03-20T00:00:00.000Z'),
              raw: {} as never,
            },
          ];
        case 'coinbase':
          return [{
            exchangeId,
            symbol: 'BTC/USD',
            base: 'BTC',
            quote: 'USD',
            last: 90_100,
            bid: 90_090,
            ask: 90_110,
            high: null,
            low: null,
            baseVolume: 1_100,
            quoteVolume: 99_110_000,
            percentage: 2,
            timestamp: acceptedCoinbaseTimestamp,
            raw: {} as never,
          }];
        case 'kraken':
          return [{
            exchangeId,
            symbol: 'BTC/USD',
            base: 'BTC',
            quote: 'USD',
            last: 9_000_000,
            bid: 8_999_000,
            ask: 9_001_000,
            high: null,
            low: null,
            baseVolume: 1,
            quoteVolume: 9_000_000,
            percentage: 50,
            timestamp: outlierTimestamp,
            raw: {} as never,
          }];
        case 'bybit':
          return [
            {
              exchangeId,
              symbol: 'ETH/USDT',
              base: 'ETH',
              quote: 'USDT',
              last: 2_200,
              bid: 2_199,
              ask: 2_201,
              high: null,
              low: null,
              baseVolume: null,
              quoteVolume: null,
              percentage: null,
              timestamp: acceptedEthereumTimestamp,
              raw: {} as never,
            },
            {
              exchangeId,
              symbol: 'BTC/USDT',
              base: 'BTC',
              quote: 'USDT',
              last: 89_000,
              bid: 88_990,
              ask: 89_010,
              high: null,
              low: null,
              baseVolume: 100,
              quoteVolume: 8_900_000,
              percentage: 1,
              timestamp: Date.parse('2009-12-31T00:00:00.000Z'),
              raw: {} as never,
            },
            {
              exchangeId,
              symbol: 'BTC/USDT',
              base: 'BTC',
              quote: 'USDT',
              last: 91_000,
              bid: 90_990,
              ask: 91_010,
              high: null,
              low: null,
              baseVolume: 100,
              quoteVolume: 9_100_000,
              percentage: 1,
              timestamp: Date.parse('2026-03-20T00:05:00.000Z'),
              raw: { isStale: true } as never,
            },
          ];
        default:
          return [];
      }
    });

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase', 'kraken', 'bybit'],
      providerFanoutConcurrency: 4,
    });

    const bitcoinSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(and(eq(marketSnapshots.coinId, 'bitcoin'), eq(marketSnapshots.vsCurrency, 'usd')))
      .get();
    const ethereumSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(and(eq(marketSnapshots.coinId, 'ethereum'), eq(marketSnapshots.vsCurrency, 'usd')))
      .get();

    expect(bitcoinSnapshot).toMatchObject({
      price: 90_050,
      sourceCount: 2,
      sourceProvidersJson: JSON.stringify(['binance', 'coinbase']),
    });
    expect(bitcoinSnapshot?.lastUpdated).toEqual(new Date(acceptedCoinbaseTimestamp));
    expect(ethereumSnapshot).toMatchObject({
      price: 2_200,
      totalVolume: null,
      priceChangePercentage24h: null,
      sourceCount: 1,
      sourceProvidersJson: JSON.stringify(['bybit']),
    });
    for (const snapshot of [bitcoinSnapshot, ethereumSnapshot]) {
      expect(snapshot).toBeDefined();
      expect(Object.values(snapshot!).some((value) => typeof value === 'number' && !Number.isFinite(value))).toBe(false);
    }

    const bybitBitcoinTicker = database.db
      .select()
      .from(coinTickers)
      .where(and(
        eq(coinTickers.coinId, 'bitcoin'),
        eq(coinTickers.exchangeId, 'bybit'),
      ))
      .get();
    const krakenBitcoinTicker = database.db
      .select()
      .from(coinTickers)
      .where(and(
        eq(coinTickers.coinId, 'bitcoin'),
        eq(coinTickers.exchangeId, 'kraken'),
      ))
      .get();
    const krakenQuoteSnapshot = database.db
      .select()
      .from(quoteSnapshots)
      .where(and(
        eq(quoteSnapshots.coinId, 'bitcoin'),
        eq(quoteSnapshots.exchangeId, 'kraken'),
      ))
      .get();
    const acceptedQuoteSnapshots = database.db
      .select()
      .from(quoteSnapshots)
      .where(eq(quoteSnapshots.coinId, 'bitcoin'))
      .all();

    expect(bybitBitcoinTicker).toBeUndefined();
    expect(krakenBitcoinTicker).toBeUndefined();
    expect(krakenQuoteSnapshot).toBeUndefined();
    expect(acceptedQuoteSnapshots.map((snapshot) => snapshot.exchangeId).sort()).toEqual(['binance', 'coinbase']);
  });

  it('preserves null public market fields for unknown optional provider values', async () => {
    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'nullable-fields.db'),
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      app.db.db
        .insert(marketSnapshots)
        .values({
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          price: 90_000,
          marketCap: null,
          totalVolume: null,
          marketCapRank: null,
          fullyDilutedValuation: null,
          circulatingSupply: null,
          totalSupply: null,
          maxSupply: null,
          ath: null,
          athChangePercentage: null,
          athDate: null,
          atl: null,
          atlChangePercentage: null,
          atlDate: null,
          priceChange24h: null,
          priceChangePercentage24h: null,
          sourceProvidersJson: JSON.stringify(['binance']),
          sourceCount: 1,
          updatedAt: new Date(),
          lastUpdated: new Date(),
        })
        .onConflictDoUpdate({
          target: [marketSnapshots.coinId, marketSnapshots.vsCurrency],
          set: {
            price: 90_000,
            marketCap: null,
            totalVolume: null,
            fullyDilutedValuation: null,
            ath: null,
            atl: null,
            priceChange24h: null,
            priceChangePercentage24h: null,
            sourceProvidersJson: JSON.stringify(['binance']),
            sourceCount: 1,
            updatedAt: new Date(),
            lastUpdated: new Date(),
          },
        })
        .run();

      const response = await app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=24h',
      });
      const [row] = response.json();

      expect(response.statusCode).toBe(200);
      expect(row.current_price).toBe(90_000);
      expect(row.market_cap).toBeNull();
      expect(row.total_volume).toBeNull();
      expect(row.fully_diluted_valuation).toBeNull();
      expect(row.ath).toBeNull();
      expect(row.atl).toBeNull();
      expect(row.price_change_24h).toBeNull();
      expect(row.price_change_percentage_24h).toBeNull();
      expect(row.price_change_percentage_24h_in_currency).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('times out hung exchange ticker fetches after 60 seconds and continues with other exchanges', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
      {
        exchangeId: 'kraken',
        symbol: 'ETH/USD',
        base: 'ETH',
        quote: 'USD',
        active: true,
        spot: true,
        baseName: 'Ethereum',
        raw: {},
      },
    ]);

    mockedFetchExchangeTickers.mockImplementation((exchangeId) => {
      if (exchangeId === 'kraken') {
        return new Promise(() => undefined);
      }

      return Promise.resolve([{
        exchangeId,
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        last: 90_500,
        bid: 90_490,
        ask: 90_510,
        high: null,
        low: null,
        baseVolume: 1_000,
        quoteVolume: 90_500_000,
        percentage: 1,
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        raw: {} as never,
      }]);
    });

    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: any,
      delay?: number,
      ...args: unknown[]
    ) => originalSetTimeout(handler, delay === 60_000 ? 1 : delay, ...(args as []))) as typeof setTimeout);

    try {
      await expect(runMarketRefreshOnce(database, {
        ccxtExchanges: ['binance', 'kraken'],
        providerFanoutConcurrency: 2,
      })).resolves.toBeUndefined();

      const ingestedTickers = database.db.select().from(coinTickers).all();
      expect(ingestedTickers.some((ticker) => ticker.exchangeId === 'binance')).toBe(true);
      expect(ingestedTickers.some((ticker) => ticker.exchangeId === 'kraken')).toBe(false);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('times out a hung exchange fetch helper after 60 seconds', async () => {
    await expect(
      withExchangeFetchTimeout('kraken', new Promise(() => undefined), 5),
    ).rejects.toThrow('kraken ticker fetch timed out after 5ms');
  });


  it('surfaces live exchange volumes and ticker stale flags through HTTP routes', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Bitcoin',
        raw: {},
      },
      {
        exchangeId: 'binance',
        symbol: 'ETH/USDT',
        base: 'ETH',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'Ethereum',
        raw: {},
      },
      {
        exchangeId: 'binance',
        symbol: 'USDC/USDT',
        base: 'USDC',
        quote: 'USDT',
        active: true,
        spot: true,
        baseName: 'USD Coin',
        raw: {},
      },
    ]);
    mockedFetchExchangeTickers.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        last: 85_000,
        bid: 84_950,
        ask: 85_050,
        high: null,
        low: null,
        baseVolume: 5_000,
        quoteVolume: 425_000_000,
        percentage: 1.8,
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        raw: {} as never,
      },
      {
        exchangeId: 'binance',
        symbol: 'ETH/USDT',
        base: 'ETH',
        quote: 'USDT',
        last: 2_000,
        bid: 1_999,
        ask: 2_001,
        high: null,
        low: null,
        baseVolume: 50_000,
        quoteVolume: 100_000_000,
        percentage: 2.56,
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        raw: {} as never,
      },
      {
        exchangeId: 'binance',
        symbol: 'USDC/USDT',
        base: 'USDC',
        quote: 'USDT',
        last: 1,
        bid: 0.9999,
        ask: 1.0001,
        high: null,
        low: null,
        baseVolume: 10_000_000,
        quoteVolume: 10_000_000,
        percentage: 0.01,
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        raw: {} as never,
      },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'http.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const exchangesResponse = await app.inject({
        method: 'GET',
        url: '/exchanges?per_page=5&page=1',
      });
      const tickersResponse = await app.inject({
        method: 'GET',
        url: '/exchanges/binance/tickers',
      });

      expect(exchangesResponse.statusCode).toBe(200);
      expect(exchangesResponse.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'binance',
          trade_volume_24h_btc: expect.any(Number),
        }),
      ]));
      expect(exchangesResponse.json().find((exchange: { id: string }) => exchange.id === 'binance').trade_volume_24h_btc).toBeGreaterThan(0);

      expect(tickersResponse.statusCode).toBe(200);
      expect(tickersResponse.json().tickers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          is_stale: false,
          last: expect.any(Number),
          converted_last: expect.objectContaining({
            usd: expect.any(Number),
          }),
          converted_volume: expect.objectContaining({
            usd: expect.any(Number),
          }),
        }),
      ]));

      const db = app.db;
      db.db
        .update(coinTickers)
        .set({
          isStale: true,
        })
        .where(and(
          eq(coinTickers.exchangeId, 'binance'),
          eq(coinTickers.coinId, 'bitcoin'),
        ))
        .run();

      const staleResponse = await app.inject({
        method: 'GET',
        url: '/exchanges/binance/tickers?coin_ids=bitcoin',
      });

      expect(staleResponse.statusCode).toBe(200);
      expect(staleResponse.json().tickers[0]).toMatchObject({
        coin_id: 'bitcoin',
        is_stale: true,
      });
    } finally {
      await app.close();
    }
  });
});
