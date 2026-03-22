import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coinTickers, coins, exchanges } from '../src/db/schema';
import { runMarketRefreshOnce } from '../src/services/market-refresh';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
}));

import { fetchExchangeMarkets, fetchExchangeTickers } from '../src/providers/ccxt';

const now = new Date();

const seededExchanges = [
  { id: 'binance', name: 'Binance', url: 'https://www.binance.com', trustScore: 10, updatedAt: now },
  { id: 'coinbase_exchange', name: 'Coinbase Exchange', url: 'https://exchange.coinbase.com', trustScore: 10, updatedAt: now },
  { id: 'kraken', name: 'Kraken', url: 'https://www.kraken.com', trustScore: 10, updatedAt: now },
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
    vi.mocked(fetchExchangeMarkets).mockReset();
    vi.mocked(fetchExchangeTickers).mockReset();
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('upserts live coin tickers from exchange refresh results', async () => {
    vi.mocked(fetchExchangeMarkets).mockResolvedValue([
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
    vi.mocked(fetchExchangeTickers).mockImplementation(async (exchangeId) => {
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
        eq(coinTickers.exchangeId, 'coinbase_exchange'),
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
      tradeUrl: 'https://www.binance.com/en/trade/BTC_USDT',
      tokenInfoUrl: 'https://www.binance.com/en/price/bitcoin',
    });
    expect(bitcoinBinanceTicker?.bidAskSpreadPercentage).toBeCloseTo(0.1110494169905608);

    expect(ethereumCoinbaseTicker).toMatchObject({
      exchangeId: 'coinbase_exchange',
      marketName: 'ETH/USD',
      last: 2_100,
      volume: 5_000,
      convertedLastUsd: 2_100,
      convertedVolumeUsd: 10_500_000,
      tradeUrl: 'https://exchange.coinbase.com/trade/ETH-USD',
      tokenInfoUrl: 'https://www.coinbase.com/price/ethereum',
    });

    expect(bitcoinKrakenTicker).toMatchObject({
      exchangeId: 'kraken',
      marketName: 'BTC/EUR',
      last: 82_000,
      convertedLastUsd: 90_000,
      tradeUrl: 'https://pro.kraken.com/app/trade/BTC-EUR',
      tokenInfoUrl: null,
    });
    expect(bitcoinKrakenTicker?.convertedVolumeUsd).toBeGreaterThan(8_200_000);
    expect(litecoinCoin).toMatchObject({
      id: 'litecoin',
      symbol: 'ltc',
      name: 'Litecoin',
    });
  });
});
