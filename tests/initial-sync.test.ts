import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq, count } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData } from '../src/db/client';
import { coins, exchanges, marketSnapshots, coinTickers, ohlcvCandles, assetPlatforms } from '../src/db/schema';
import { runInitialMarketSync, syncExchangesFromCCXT } from '../src/services/initial-sync';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx', 'gate'].includes(value),
}));

import { fetchExchangeMarkets, fetchExchangeTickers, fetchExchangeOHLCV, fetchExchangeNetworks } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeTickers = fetchExchangeTickers as ReturnType<typeof vi.fn>;
const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
const mockedFetchExchangeNetworks = fetchExchangeNetworks as ReturnType<typeof vi.fn>;

describe('initial market sync', () => {
  let tempDir: string;
  let database: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-initial-sync-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    mockedFetchExchangeMarkets.mockReset();
    mockedFetchExchangeTickers.mockReset();
    mockedFetchExchangeOHLCV.mockReset();
    mockedFetchExchangeNetworks.mockReset();
    mockedFetchExchangeNetworks.mockResolvedValue([]);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('discovers coins and populates market snapshots from CCXT exchanges', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
      ];
      return [];
    });
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [{
        exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT',
        last: 90_000, bid: 89_950, ask: 90_050, high: 91_000, low: 89_000,
        baseVolume: 1_000, quoteVolume: 90_000_000, percentage: 2,
        timestamp: Date.now(), raw: {} as never,
      }];
      return [];
    });
    mockedFetchExchangeOHLCV.mockResolvedValue([]);

    const result = await runInitialMarketSync(database, {
      ccxtExchanges: ['binance', 'coinbase', 'kraken'],
      marketFreshnessThresholdSeconds: 300,
      providerFanoutConcurrency: 2,
    });

    expect(result.coinsDiscovered).toBeGreaterThan(0);
    expect(result.snapshotsCreated).toBeGreaterThan(0);

    // Verify live snapshots exist with sourceCount > 0
    const liveSnapshots = database.db.select().from(marketSnapshots).all();
    expect(liveSnapshots.length).toBeGreaterThan(0);
    for (const snap of liveSnapshots) {
      expect(snap.sourceCount).toBeGreaterThan(0);
    }

    // Verify exchange records created
    const exchangeRecords = database.db.select().from(exchanges).all();
    expect(exchangeRecords.length).toBeGreaterThan(0);
  });

  it('creates exchange records from CCXT metadata', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
      if (exchangeId === 'kraken') return [
        { exchangeId: 'kraken', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
      return [];
    });
    mockedFetchExchangeTickers.mockResolvedValue([]);
    mockedFetchExchangeOHLCV.mockResolvedValue([]);

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
    await syncExchangesFromCCXT(database, ['binance', 'coinbase', 'kraken'], mockLogger as never);

    const exchangeRecords = database.db.select().from(exchanges).all();
    expect(exchangeRecords.length).toBe(3);

    const binance = exchangeRecords.find(e => e.id === 'binance');
    expect(binance).toBeDefined();
    expect(binance!.name).toBe('Binance');
    expect(binance!.url).toBe('https://www.binance.com');
  });

  it('limits exchange metadata fanout concurrency during initial sync setup', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;

      return [
        { exchangeId, symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
    });

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
    await syncExchangesFromCCXT(database, ['binance', 'coinbase', 'kraken'], mockLogger as never, 2);

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('defers OHLCV history work to the background worker after snapshot sync', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
      return [];
    });
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [{
        exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT',
        last: 90_000, bid: null, ask: null, high: null, low: null,
        baseVolume: null, quoteVolume: null, percentage: null,
        timestamp: Date.now(), raw: {} as never,
      }];
      return [];
    });
    mockedFetchExchangeOHLCV.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', timeframe: '1d', timestamp: Date.parse('2026-03-01T00:00:00Z'), open: 80_000, high: 82_000, low: 79_000, close: 81_000, volume: 1_000, raw: [0, 0, 0, 0, 0, 0] },
        { exchangeId: 'binance', symbol: 'BTC/USDT', timeframe: '1d', timestamp: Date.parse('2026-03-02T00:00:00Z'), open: 81_000, high: 83_000, low: 80_500, close: 82_500, volume: 1_200, raw: [0, 0, 0, 0, 0, 0] },
      ];
      return [];
    });

    const result = await runInitialMarketSync(database, {
      ccxtExchanges: ['binance'],
      marketFreshnessThresholdSeconds: 300,
      providerFanoutConcurrency: 2,
    });

    expect(result.ohlcvCandlesWritten).toBe(0);
    expect(fetchExchangeOHLCV).not.toHaveBeenCalled();
  });

  it('starts serving without waiting for full ohlcv history backfill', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([]);
    mockedFetchExchangeTickers.mockResolvedValue([]);
    mockedFetchExchangeOHLCV.mockResolvedValue([]);

    const result = await runInitialMarketSync(database, {
      ccxtExchanges: ['binance'],
      marketFreshnessThresholdSeconds: 300,
      providerFanoutConcurrency: 2,
    });

    expect(result.ohlcvCandlesWritten).toBe(0);
    expect(fetchExchangeOHLCV).not.toHaveBeenCalled();
  });

  it('continues initial sync when one exchange market discovery times out', async () => {
    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'gate') {
        const timeoutError = new Error('gate GET https://api.gateio.ws/api/v4/spot/currencies request timed out (10000 ms)');
        timeoutError.name = 'RequestTimeout';
        throw timeoutError;
      }

      if (exchangeId === 'binance') {
        return [
          { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        ];
      }

      return [];
    });

    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') {
        return [{
          exchangeId: 'binance',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          last: 90_000,
          bid: null,
          ask: null,
          high: null,
          low: null,
          baseVolume: 1_000,
          quoteVolume: 90_000_000,
          percentage: 2,
          timestamp: Date.now(),
          raw: {} as never,
        }];
      }

      return [];
    });

    mockedFetchExchangeOHLCV.mockResolvedValue([]);

    await expect(runInitialMarketSync(database, {
      ccxtExchanges: ['gate', 'binance'],
      marketFreshnessThresholdSeconds: 300,
      providerFanoutConcurrency: 2,
    })).resolves.toMatchObject({
      exchangesSynced: 2,
    });

    const bitcoin = database.db.select().from(coins).where(eq(coins.id, 'bitcoin')).get();
    expect(bitcoin).toBeDefined();
  });

  it('discovers and upserts chain catalogs from exchange network metadata', async () => {
    mockedFetchExchangeMarkets.mockResolvedValue([]);
    mockedFetchExchangeTickers.mockResolvedValue([]);
    mockedFetchExchangeOHLCV.mockResolvedValue([]);
    mockedFetchExchangeNetworks.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') {
        return [
          { exchangeId: 'binance', networkId: 'eth', networkName: 'Ethereum', chainIdentifier: 1 },
          { exchangeId: 'binance', networkId: 'bsc', networkName: 'BNB Smart Chain', chainIdentifier: 56 },
        ];
      }

      if (exchangeId === 'coinbase') {
        return [{ exchangeId: 'coinbase', networkId: 'solana', networkName: 'Solana', chainIdentifier: 101 }];
      }

      return [];
    });

    const result = await runInitialMarketSync(database, {
      ccxtExchanges: ['binance', 'coinbase', 'kraken'],
      marketFreshnessThresholdSeconds: 300,
      providerFanoutConcurrency: 2,
    });

    expect(result.chainsDiscovered).toBe(3);

    const platformRows = database.db
      .select()
      .from(assetPlatforms)
      .all();

    expect(platformRows.some((row) => row.id === 'eth')).toBe(true);
    expect(platformRows.some((row) => row.id === 'bsc')).toBe(true);
    expect(platformRows.some((row) => row.id === 'solana')).toBe(true);
  });
});
