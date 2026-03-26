import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coinTickers, coins, exchanges } from '../src/db/schema';
import { runMarketRefreshOnce } from '../src/services/market-refresh';
import { createMarketDataRuntimeState } from '../src/services/market-runtime-state';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeMarkets, fetchExchangeTickers } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeTickers = fetchExchangeTickers as ReturnType<typeof vi.fn>;

const now = new Date();

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
    mockedFetchExchangeTickers.mockReset();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('upserts live coin tickers from exchange refresh results', async () => {
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
    mockedFetchExchangeTickers.mockResolvedValue([]);

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase'],
      providerFanoutConcurrency: 2,
    }, undefined, runtimeState);

    expect(mockedFetchExchangeTickers).toHaveBeenCalledTimes(4);
    expect(runtimeState.providerFailureCooldownUntil).toBeNull();
  });
});
