import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coinTickers, coins, exchanges, exchangeVolumePoints } from '../src/db/schema';
import { runMarketRefreshOnce, withExchangeFetchTimeout } from '../src/services/market-refresh';
import { createMarketDataRuntimeState } from '../src/services/market-runtime-state';
import { createMetricsRegistry } from '../src/services/metrics';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeMarkets, fetchExchangeNetworks, fetchExchangeTickers } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeNetworks = fetchExchangeNetworks as ReturnType<typeof vi.fn>;
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
    mockedFetchExchangeNetworks.mockReset();
    mockedFetchExchangeTickers.mockReset();
    mockedFetchExchangeNetworks.mockResolvedValue([]);
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
    const metrics = createMetricsRegistry();

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

    await runMarketRefreshOnce(database, {
      ccxtExchanges: ['binance', 'coinbase'],
      providerFanoutConcurrency: 2,
    }, undefined, runtimeState, metrics);

    const metricsText = metrics.renderPrometheus();
    expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="forced_failure"} 1');
    expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="cooldown_skip"} 1');
    expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="partial_failure"} 1');
    expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="success"} 1');

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

  it('times out hung exchange ticker fetches after 60 seconds and continues with other exchanges', { timeout: 70000 }, async () => {
    vi.useFakeTimers();

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

    try {
      const refreshPromise = runMarketRefreshOnce(database, {
        ccxtExchanges: ['binance', 'kraken'],
        providerFanoutConcurrency: 2,
      });

      vi.advanceTimersByTime(60_000);
      vi.useRealTimers();
      await expect(refreshPromise).resolves.toBeUndefined();

      const ingestedTickers = database.db.select().from(coinTickers).all();
      expect(ingestedTickers.some((ticker) => ticker.exchangeId === 'binance')).toBe(true);
      expect(ingestedTickers.some((ticker) => ticker.exchangeId === 'kraken')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a hung exchange fetch helper after 60 seconds', { timeout: 70000 }, async () => {
    const startedAt = Date.now();

    await expect(
      withExchangeFetchTimeout('kraken', new Promise(() => undefined), 60_000),
    ).rejects.toThrow('kraken ticker fetch timed out after 60000ms');

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60_000);
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
