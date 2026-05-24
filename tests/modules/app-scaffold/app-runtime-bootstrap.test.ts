import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildApp, getDatabaseStartupLogContext } from '../../../src/app';
import { chartPoints, coins, marketChartSourcePoints, marketSnapshots, ohlcvCandles } from '../../../src/db/schema';
import type { MetricsRegistry } from '../../../src/services/metrics';
import type { MarketDataRuntimeState } from '../../../src/services/market-runtime-state';
import * as candleStore from '../../../src/services/candle-store';
import * as catalogModule from '../../../src/modules/catalog';
import * as ccxtProvider from '../../../src/providers/ccxt';
import * as defillamaProvider from '../../../src/providers/defillama';
import * as sqdProvider from '../../../src/providers/sqd';
import * as startupPrewarmModule from '../../../src/services/startup-prewarm';
import * as currencyRatesModule from '../../../src/services/currency-rates';
import { resetCurrencyApiSnapshotForTests } from '../../../src/services/currency-rates';
import { syncOnchainTrades } from '../../../src/services/onchain-trade-sync';
import contractFixtures from '../../fixtures/contract-fixtures.json';

const currentDailyBucket = () => candleStore.toDailyBucket(Date.now()).getTime();
const defaultDefillamaTokenPriceMock = () => vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
const defaultDefillamaOnchainCatalogMocks = () => {
  vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);
  vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);
};

function resetCcxtProviderMocks() {
  const mockedFetchExchangeMarkets = ccxtProvider.fetchExchangeMarkets as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeTickers = ccxtProvider.fetchExchangeTickers as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeDerivativeTickers = ccxtProvider.fetchExchangeDerivativeTickers as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeOHLCV = ccxtProvider.fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeNetworks = ccxtProvider.fetchExchangeNetworks as ReturnType<typeof vi.fn>;
  const mockedCloseExchangePool = ccxtProvider.closeExchangePool as ReturnType<typeof vi.fn>;

  mockedFetchExchangeMarkets.mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', active: true, spot: true, baseName: 'Ripple', raw: {} },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', active: true, spot: true, baseName: 'Dogecoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', active: true, spot: true, baseName: 'Cardano', raw: {} },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', active: true, spot: true, baseName: 'Chainlink', raw: {} },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
  ]);
  mockedFetchExchangeTickers.mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', last: 2.5, bid: 2.49, ask: 2.51, high: 2.55, low: 2.45, baseVolume: 1000000, quoteVolume: 2500000, percentage: 3.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', last: 0.28, bid: 0.279, ask: 0.281, high: 0.29, low: 0.27, baseVolume: 10000000, quoteVolume: 2800000, percentage: 5.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', last: 1.05, bid: 1.049, ask: 1.051, high: 1.08, low: 1.02, baseVolume: 5000000, quoteVolume: 5250000, percentage: 2.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', last: 24, bid: 23.9, ask: 24.1, high: 25, low: 23, baseVolume: 500000, quoteVolume: 12000000, percentage: 3.5, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
  ]);
  mockedFetchExchangeDerivativeTickers.mockResolvedValue([]);
  mockedFetchExchangeOHLCV.mockResolvedValue([]);
  mockedFetchExchangeNetworks.mockResolvedValue([]);
  mockedCloseExchangePool.mockResolvedValue(undefined);
}

vi.mock('../../../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', active: true, spot: true, baseName: 'Ripple', raw: {} },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', active: true, spot: true, baseName: 'Dogecoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', active: true, spot: true, baseName: 'Cardano', raw: {} },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', active: true, spot: true, baseName: 'Chainlink', raw: {} },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', last: 2.5, bid: 2.49, ask: 2.51, high: 2.55, low: 2.45, baseVolume: 1000000, quoteVolume: 2500000, percentage: 3.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', last: 0.28, bid: 0.279, ask: 0.281, high: 0.29, low: 0.27, baseVolume: 10000000, quoteVolume: 2800000, percentage: 5.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', last: 1.05, bid: 1.049, ask: 1.051, high: 1.08, low: 1.02, baseVolume: 5000000, quoteVolume: 5250000, percentage: 2.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', last: 24, bid: 23.9, ask: 24.1, high: 25, low: 23, baseVolume: 500000, quoteVolume: 12000000, percentage: 3.5, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
  ]),
  fetchExchangeDerivativeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));



describe('OpenGecko app scaffold', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-'));
    vi.restoreAllMocks();
    resetCurrencyApiSnapshotForTests();
    resetCcxtProviderMocks();
    defaultDefillamaTokenPriceMock();
    defaultDefillamaOnchainCatalogMocks();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    vi.clearAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds validation bootstrap-only in-memory runtime from persistent live snapshots before zero-live policy evaluation', async () => {
    await getApp().close();
    app = undefined;

    const sourceDatabasePath = join(tempDir, 'opengecko.db');
    const seededValidationApp = buildApp({
      config: {
        databaseUrl: sourceDatabasePath,
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await seededValidationApp.ready();

      const bitcoinSnapshotBefore = seededValidationApp.db.db
        .select()
        .from(marketSnapshots)
        .where(eq(marketSnapshots.coinId, 'bitcoin'))
        .get();
      const usdcCoinBefore = seededValidationApp.db.db
        .select()
        .from(coins)
        .where(eq(coins.id, 'usd-coin'))
        .get();

      expect(bitcoinSnapshotBefore?.sourceCount).toBeGreaterThan(0);
      expect(usdcCoinBefore?.platformsJson).toContain('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

      const validationApp = buildApp({
        config: {
          databaseUrl: ':memory:',
          ccxtExchanges: [],
          logLevel: 'silent',
          host: '127.0.0.1',
          port: 3102,
        },
        startBackgroundJobs: false,
      });

      try {
        await validationApp.ready();

        const bitcoinSnapshotAfter = validationApp.db.db
          .select()
          .from(marketSnapshots)
          .where(eq(marketSnapshots.coinId, 'bitcoin'))
          .get();
        const usdcCoinAfter = validationApp.db.db
          .select()
          .from(coins)
          .where(eq(coins.id, 'usd-coin'))
          .get();

        expect(bitcoinSnapshotAfter).toBeDefined();
        expect(bitcoinSnapshotAfter?.sourceCount).toBeGreaterThan(0);
        expect(usdcCoinAfter?.platformsJson).toContain('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
        expect(validationApp.marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots).toBe(false);
        expect(validationApp.marketDataRuntimeState.validationOverride).toMatchObject({
          mode: 'seeded_bootstrap',
          reason: 'validation runtime seeded from persistent live snapshots',
          snapshotSourceCountOverride: expect.any(Number),
        });

        const canonicalMarketsResponse = await validationApp.inject({
          method: 'GET',
          url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
        });

        expect(canonicalMarketsResponse.statusCode).toBe(200);
        const canonicalMarketsBody = canonicalMarketsResponse.json();
        expect(canonicalMarketsBody).toMatchObject([
          expect.objectContaining({ id: 'bitcoin', market_cap_rank: null }),
          expect.objectContaining({ id: 'ethereum', market_cap_rank: null }),
          expect.objectContaining({ id: 'solana', market_cap_rank: null }),
        ]);
        expect(canonicalMarketsResponse.json()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'solana',
            current_price: expect.any(Number),
            market_cap: null,
            total_volume: null,
          }),
        ]));
        const solanaVolume = canonicalMarketsResponse.json().find((row: { id?: string; total_volume?: number | null }) => row.id === 'solana')?.total_volume;
        expect(solanaVolume).toBeNull();

        const [simplePriceResponse, tokenPriceResponse, diagnosticsResponse] = await Promise.all([
          validationApp.inject({
            method: 'GET',
            url: '/simple/price?ids=bitcoin&vs_currencies=usd',
          }),
          validationApp.inject({
            method: 'GET',
            url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
          }),
          validationApp.inject({
            method: 'GET',
            url: '/diagnostics/runtime',
          }),
        ]);

        expect(simplePriceResponse.statusCode).toBe(200);
        expect(simplePriceResponse.json()).toEqual({
          bitcoin: {
            usd: expect.any(Number),
          },
        });
        expect(tokenPriceResponse.statusCode).toBe(200);
        expect(tokenPriceResponse.json()).toMatchObject({
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
            usd: expect.any(Number),
            usd_24h_vol: expect.any(Number),
            usd_24h_change: expect.any(Number),
            last_updated_at: expect.any(Number),
          },
        });
        expect(diagnosticsResponse.statusCode).toBe(200);
        expect(diagnosticsResponse.json().data).toMatchObject({
          readiness: {
            state: 'starting',
            initial_sync_completed: false,
          },
          degraded: {
            active: false,
            stale_live_enabled: true,
            reason: 'validation runtime seeded from persistent live snapshots',
            validation_override: {
              active: true,
              mode: 'seeded_bootstrap',
              reason: 'validation runtime seeded from persistent live snapshots',
            },
          },
          hot_paths: {
            shared_market_snapshot: {
              source_class: 'seeded_bootstrap',
            },
          },
        });
      } finally {
        await validationApp.close();
      }
    } finally {
      await seededValidationApp.close();
    }
  });
  it('uses bootstrap-only validation startup semantics for the port-3102 server profile', async () => {
    const validationServerApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: [],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3102,
      },
      startBackgroundJobs: false,
    });

    try {
      await validationServerApp.ready();

      expect(validationServerApp.marketRuntime).toBeNull();
      expect(validationServerApp.marketDataRuntimeState.validationOverride).toMatchObject({
        mode: 'seeded_bootstrap',
        reason: 'validation runtime seeded from persistent live snapshots',
      });
      expect(validationServerApp.marketDataRuntimeState.listenerBindDeferred).toBe(false);

      const diagnosticsResponse = await validationServerApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data.degraded.validation_override).toMatchObject({
        active: true,
        mode: 'seeded_bootstrap',
        reason: 'validation runtime seeded from persistent live snapshots',
      });
      expect(diagnosticsResponse.json().data.hot_paths.shared_market_snapshot.source_class).toBe('seeded_bootstrap');
    } finally {
      await validationServerApp.close();
    }
  });
  it('reports persisted timestamp compatibility on runtime databases opened from the shared mission store', async () => {
    const sourceDatabasePath = join(tempDir, 'shared-opengecko.db');
    copyFileSync(join(process.cwd(), 'data', 'opengecko.db'), sourceDatabasePath);

    const sharedRuntimeApp = buildApp({
      config: {
        databaseUrl: sourceDatabasePath,
        ccxtExchanges: [],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3001,
      },
      startBackgroundJobs: false,
    });

    try {
      await sharedRuntimeApp.ready();

      expect(sharedRuntimeApp.db.persistedTimestampCompatibility).toEqual({
        normalizedAtOpen: false,
        source: 'none',
      });

      const diagnosticsResponse = await sharedRuntimeApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });
      const simplePriceResponse = await sharedRuntimeApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      });
      const globalResponse = await sharedRuntimeApp.inject({
        method: 'GET',
        url: '/global',
      });

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(simplePriceResponse.statusCode).toBe(200);
      expect(simplePriceResponse.json()).toEqual({
        bitcoin: {
          usd: expect.any(Number),
        },
      });
      expect(globalResponse.statusCode).toBe(200);
      expect(globalResponse.json()).toMatchObject({
        data: {
          active_cryptocurrencies: expect.any(Number),
          markets: expect.any(Number),
          total_market_cap: expect.any(Object),
          total_volume: expect.any(Object),
          market_cap_percentage: expect.any(Object),
          updated_at: expect.any(Number),
        },
      });
    } finally {
      await sharedRuntimeApp.close();
    }
  });
  it('falls back to the canonical validation snapshot when the default persistent database is malformed', async () => {
    const originalDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db');
    const backupDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db.backup');
    let restoredDefaultDatabase = false;

    if (existsSync(originalDefaultDatabasePath)) {
      copyFileSync(originalDefaultDatabasePath, backupDefaultDatabasePath);
    }

    writeFileSync(originalDefaultDatabasePath, 'not a sqlite database');

    try {
      const freshBootApp = buildApp({
        config: {
          databaseUrl: './data/opengecko.db',
          ccxtExchanges: [],
          logLevel: 'silent',
          host: '127.0.0.1',
          port: 3001,
        },
        startBackgroundJobs: false,
      });

      try {
        await freshBootApp.ready();

        const diagnosticsResponse = await freshBootApp.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        });

        expect(diagnosticsResponse.statusCode).toBe(200);
        expect(freshBootApp.marketDataRuntimeState.validationOverride).toMatchObject({
          mode: 'off',
          reason: null,
        });
        expect(diagnosticsResponse.json().data).toMatchObject({
          readiness: {
            state: 'ready',
            initial_sync_completed: true,
            degraded: false,
            validation_override_active: false,
          },
          degraded: {
            active: false,
            stale_live_enabled: false,
            reason: null,
            validation_override: {
              active: false,
              mode: 'off',
              reason: null,
            },
          },
          hot_paths: {
            shared_market_snapshot: {
              available: false,
              source_class: 'unavailable',
              provider_count: expect.any(Number),
            },
          },
        });
        expect(existsSync(originalDefaultDatabasePath)).toBe(true);
      } finally {
        await freshBootApp.close();
      }
    } finally {
      if (existsSync(originalDefaultDatabasePath)) {
        unlinkSync(originalDefaultDatabasePath);
      }
      if (existsSync(`${originalDefaultDatabasePath}-wal`)) {
        unlinkSync(`${originalDefaultDatabasePath}-wal`);
      }
      if (existsSync(`${originalDefaultDatabasePath}-shm`)) {
        unlinkSync(`${originalDefaultDatabasePath}-shm`);
      }
      if (existsSync(backupDefaultDatabasePath)) {
        copyFileSync(backupDefaultDatabasePath, originalDefaultDatabasePath);
        unlinkSync(backupDefaultDatabasePath);
        restoredDefaultDatabase = true;
      }

      if (!restoredDefaultDatabase && existsSync(originalDefaultDatabasePath)) {
        unlinkSync(originalDefaultDatabasePath);
      }
    }
  });
  it('reopens the local runtime database after replacing a malformed default sqlite file with the fallback snapshot', async () => {
    const originalDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db');
    const backupDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db.recovery-backup');
    let restoredDefaultDatabase = false;

    if (existsSync(originalDefaultDatabasePath)) {
      copyFileSync(originalDefaultDatabasePath, backupDefaultDatabasePath);
    }

    writeFileSync(originalDefaultDatabasePath, 'not a sqlite database');

    try {
      const freshBootApp = buildApp({
        config: {
          databaseUrl: './data/opengecko.db',
          ccxtExchanges: [],
          logLevel: 'silent',
          host: '127.0.0.1',
          port: 3001,
        },
        startBackgroundJobs: false,
      });

      try {
        await freshBootApp.ready();

        const [diagnosticsResponse, simplePriceResponse, globalResponse] = await Promise.all([
          freshBootApp.inject({
            method: 'GET',
            url: '/diagnostics/runtime',
          }),
          freshBootApp.inject({
            method: 'GET',
            url: '/simple/price?ids=bitcoin&vs_currencies=usd',
          }),
          freshBootApp.inject({
            method: 'GET',
            url: '/global',
          }),
        ]);

        expect(diagnosticsResponse.statusCode).toBe(200);
        expect(simplePriceResponse.statusCode).toBe(503);
        expect(globalResponse.statusCode).toBe(200);
        expect(globalResponse.json()).toMatchObject({
          data: {
            total_market_cap: expect.any(Object),
            total_volume: expect.any(Object),
          },
        });
      } finally {
        await freshBootApp.close();
      }
    } finally {
      if (existsSync(originalDefaultDatabasePath)) {
        unlinkSync(originalDefaultDatabasePath);
      }
      if (existsSync(`${originalDefaultDatabasePath}-wal`)) {
        unlinkSync(`${originalDefaultDatabasePath}-wal`);
      }
      if (existsSync(`${originalDefaultDatabasePath}-shm`)) {
        unlinkSync(`${originalDefaultDatabasePath}-shm`);
      }
      if (existsSync(backupDefaultDatabasePath)) {
        copyFileSync(backupDefaultDatabasePath, originalDefaultDatabasePath);
        unlinkSync(backupDefaultDatabasePath);
        restoredDefaultDatabase = true;
      }

      if (!restoredDefaultDatabase && existsSync(originalDefaultDatabasePath)) {
        unlinkSync(originalDefaultDatabasePath);
      }
    }
  });
  it('keeps a deterministic zero-live completed-boot contract on the isolated validation surface when no persisted live snapshots exist', { timeout: 20_000 }, async () => {
    const originalDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db');
    const backupDefaultDatabasePath = join(process.cwd(), 'data', 'opengecko.db.backup');
    let restoredDefaultDatabase = false;

    if (existsSync(originalDefaultDatabasePath)) {
      copyFileSync(originalDefaultDatabasePath, backupDefaultDatabasePath);
      unlinkSync(originalDefaultDatabasePath);
    }

    try {
      const zeroLiveValidationApp = buildApp({
        config: {
          databaseUrl: ':memory:',
          ccxtExchanges: [],
          logLevel: 'silent',
          host: '127.0.0.1',
          port: 3102,
          startupPrewarmBudgetMs: 0,
        },
        startBackgroundJobs: false,
      });

      try {
        const [simplePriceResponse, tokenPriceResponse, marketsResponse, coinDetailResponse, diagnosticsResponse] = await Promise.all([
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/simple/price?ids=bitcoin&vs_currencies=usd',
          }),
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
          }),
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/coins/markets?vs_currency=usd&ids=bitcoin',
          }),
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/coins/bitcoin?tickers=false&community_data=false&developer_data=false&localization=false',
          }),
          zeroLiveValidationApp.inject({
            method: 'GET',
            url: '/diagnostics/runtime',
          }),
        ]);

        expect(simplePriceResponse.statusCode).toBe(200);
        expect(simplePriceResponse.json()).toEqual({
          bitcoin: {
            usd: expect.any(Number),
          },
        });
        expect(tokenPriceResponse.statusCode).toBe(200);
        expect(tokenPriceResponse.json()).toEqual({
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
            usd: expect.any(Number),
          },
        });
        expect(marketsResponse.statusCode).toBe(200);
        expect(marketsResponse.json()).toEqual([
          expect.objectContaining({
            id: 'bitcoin',
            symbol: 'btc',
            current_price: expect.any(Number),
            market_cap: null,
            market_cap_rank: null,
            total_volume: null,
            price_change_24h: null,
            price_change_percentage_24h: null,
            last_updated: null,
          }),
        ]);
        expect(coinDetailResponse.statusCode).toBe(200);
        expect(coinDetailResponse.json()).toMatchObject({
          id: 'bitcoin',
          symbol: 'btc',
          market_data: {
            current_price: { usd: expect.any(Number) },
            total_volume: { usd: expect.any(Number) },
            last_updated: expect.any(String),
          },
          tickers: [],
          community_data: null,
          developer_data: null,
        });

        expect(zeroLiveValidationApp.marketDataRuntimeState.initialSyncCompleted).toBe(false);
        expect(zeroLiveValidationApp.marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots).toBe(false);
        expect(zeroLiveValidationApp.marketDataRuntimeState.validationOverride.mode).toBe('seeded_bootstrap');

        expect(diagnosticsResponse.statusCode).toBe(200);
        expect(diagnosticsResponse.json().data).toMatchObject({
          readiness: {
            state: 'starting',
            initial_sync_completed: false,
            degraded: false,
            zero_live_completed_boot: false,
            validation_override_active: true,
          },
          degraded: {
            active: false,
            stale_live_enabled: true,
            reason: 'validation runtime seeded from persistent live snapshots',
            validation_override: {
              active: true,
              mode: 'seeded_bootstrap',
              reason: 'validation runtime seeded from persistent live snapshots',
            },
          },
          hot_paths: {
            shared_market_snapshot: {
              available: true,
              source_class: 'seeded_bootstrap',
              provider_count: expect.any(Number),
            },
          },
        });
      } finally {
        await zeroLiveValidationApp.close();
      }
    } finally {
      if (existsSync(backupDefaultDatabasePath)) {
        renameSync(backupDefaultDatabasePath, originalDefaultDatabasePath);
        restoredDefaultDatabase = true;
      }

      if (!restoredDefaultDatabase && existsSync(originalDefaultDatabasePath) === false && existsSync(backupDefaultDatabasePath)) {
        renameSync(backupDefaultDatabasePath, originalDefaultDatabasePath);
      }
    }
  });
  it('accepts seeded-bootstrap and zero-live completed-boot override scenarios on the validation surface with success envelopes', async () => {
    const validationApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: [],
        logLevel: 'silent',
        host: '127.0.0.1',
        port: 3102,
      },
      startBackgroundJobs: false,
    });

    try {
      await validationApp.ready();
      validationApp.marketDataRuntimeState.listenerBound = true;

      const seededBootstrapOverride = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'seeded_bootstrap',
          reason: 'validator seeded bootstrap',
        },
      });

      expect(seededBootstrapOverride.statusCode).toBe(200);
      expect(seededBootstrapOverride.json()).toEqual({
        data: {
          mode: 'seeded_bootstrap',
          reason: 'validator seeded bootstrap',
          cache_revision: expect.any(Number),
        },
      });

      const seededBootstrapDiagnostics = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(seededBootstrapDiagnostics.statusCode).toBe(200);
      expect(seededBootstrapDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'starting',
          initial_sync_completed: false,
          validation_override_active: true,
          zero_live_completed_boot: false,
        },
        degraded: {
          active: false,
          validation_override: {
            active: true,
            mode: 'seeded_bootstrap',
            reason: 'validator seeded bootstrap',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'seeded_bootstrap',
          },
        },
      });

      const zeroLiveOverride = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'zero_live_completed_boot',
          reason: 'validator zero live completed boot',
        },
      });

      expect(zeroLiveOverride.statusCode).toBe(200);
      expect(zeroLiveOverride.json()).toEqual({
        data: {
          mode: 'zero_live_completed_boot',
          reason: 'validator zero live completed boot',
          cache_revision: expect.any(Number),
        },
      });

      const [simplePriceResponse, zeroLiveDiagnostics] = await Promise.all([
        validationApp.inject({
          method: 'GET',
          url: '/simple/price?ids=bitcoin&vs_currencies=usd',
        }),
        validationApp.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        }),
      ]);

      expect(simplePriceResponse.statusCode).toBe(503);
      expect(simplePriceResponse.json()).toEqual({
        error: 'service_unavailable',
        message: 'No usable live market snapshots are available for simple/price.',
      });
      expect(zeroLiveDiagnostics.statusCode).toBe(200);
      expect(zeroLiveDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'ready',
          initial_sync_completed: true,
          zero_live_completed_boot: true,
          validation_override_active: true,
        },
        degraded: {
          active: false,
          stale_live_enabled: false,
          validation_override: {
            active: true,
            mode: 'zero_live_completed_boot',
            reason: 'validator zero live completed boot',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'unavailable',
          },
        },
      });
    } finally {
      await validationApp.close();
    }
  });
});
