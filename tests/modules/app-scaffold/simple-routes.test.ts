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

  it('returns simple prices with optional market fields', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      bitcoin: {
        usd: 85000,
        eur: expect.any(Number),
        usd_24h_change: 1.8,
        eur_24h_change: 1.8,
      },
      ethereum: {
        usd: 2000,
        eur: expect.any(Number),
        usd_24h_change: 2.56,
        eur_24h_change: 2.56,
      },
    });
  });
  it('preserves the exact invalid-selector 400 envelope for simple price requests', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/price?vs_currencies=usd',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      error: 'invalid_parameter',
      message: 'One of ids, names, or symbols must be provided.',
    });
  });
  it('rejects empty vs_currencies for simple price requests with the contract 400 envelope', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_parameter',
      message: 'At least one vs_currency must be provided.',
    });
  });
  it('keeps equivalent simple price selector requests stable across parameter ordering', async () => {
    const [baselineResponse, reorderedResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_change=true',
      }),
      getApp().inject({
        method: 'GET',
        url: '/simple/price?vs_currencies=usd,eur&include_24hr_change=true&include_market_cap=true&ids=bitcoin,ethereum',
      }),
    ]);

    expect(baselineResponse.statusCode).toBe(200);
    expect(reorderedResponse.statusCode).toBe(200);
    expect(reorderedResponse.json()).toEqual(baselineResponse.json());
  });
  it('caches equivalent simple price requests across query ordering without widening selector semantics', async () => {
    const getMarketRowsSpy = vi.spyOn(catalogModule, 'getMarketRows');
    const baselineSelectorCalls = () => getMarketRowsSpy.mock.calls.filter(
      ([, vsCurrency, filters]) => vsCurrency === 'usd'
        && Array.isArray(filters?.ids)
        && filters.ids.length === 2
        && filters.ids.includes('bitcoin')
        && filters.ids.includes('ethereum'),
    ).length;

    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_change=true',
    });
    const afterBaselineCalls = baselineSelectorCalls();

    const reorderedResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?include_24hr_change=true&vs_currencies=eur,usd&include_market_cap=true&ids=ethereum,bitcoin',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(reorderedResponse.statusCode).toBe(200);
    expect(reorderedResponse.json()).toEqual(baselineResponse.json());
    expect(afterBaselineCalls).toBe(1);
    expect(baselineSelectorCalls()).toBe(1);
  });
  it('isolates simple price cache entries by precision and include flags', async () => {
    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const repeatedBaselineResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?vs_currencies=usd&ids=bitcoin',
    });
    const precisionResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd&precision=2',
    });
    const includeResponse = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(repeatedBaselineResponse.statusCode).toBe(200);
    expect(precisionResponse.statusCode).toBe(200);
    expect(includeResponse.statusCode).toBe(200);

    expect(repeatedBaselineResponse.json()).toEqual(baselineResponse.json());
    expect(baselineResponse.json()).toEqual({
      bitcoin: {
        usd: 85000,
      },
    });
    expect(precisionResponse.json()).toEqual({
      bitcoin: {
        usd: 85000,
      },
    });
    expect(includeResponse.json()).toEqual({
      bitcoin: {
        usd: 85000,
        usd_market_cap: null,
      },
    });
    expect('usd_market_cap' in baselineResponse.json().bitcoin).toBe(false);
  });
  it('returns token prices by contract address', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(contractFixtures.tokenPrice);
  });
  it('rejects empty token-price selector lists with explicit invalid_parameter errors', async () => {
    const [missingContractsResponse, missingVsCurrenciesResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/simple/token_price/ethereum?contract_addresses=&vs_currencies=usd',
      }),
      getApp().inject({
        method: 'GET',
        url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=',
      }),
    ]);

    expect(missingContractsResponse.statusCode).toBe(400);
    expect(missingContractsResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'At least one contract address must be provided.',
    });

    expect(missingVsCurrenciesResponse.statusCode).toBe(400);
    expect(missingVsCurrenciesResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'At least one vs_currency must be provided.',
    });
  });
  it('returns explicit fresh-boot price errors when no usable live snapshots exist', async () => {
    const freshBootApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'fresh-boot-simple-price.db'),
        ccxtExchanges: [],
        logLevel: 'silent',
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
    });

    try {
      const [simplePriceResponse, tokenPriceResponse] = await Promise.all([
        freshBootApp.inject({
          method: 'GET',
          url: '/simple/price?ids=bitcoin&vs_currencies=usd',
        }),
        freshBootApp.inject({
          method: 'GET',
          url: '/simple/token_price/eth?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
        }),
      ]);

      expect(simplePriceResponse.statusCode).toBe(503);
      expect(simplePriceResponse.json()).toEqual({
        error: 'service_unavailable',
        message: 'No usable live market snapshots are available for simple/price.',
      });
      expect(freshBootApp.marketDataRuntimeState.initialSyncCompleted).toBe(true);
      expect(freshBootApp.marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots).toBe(true);

      expect(tokenPriceResponse.statusCode).toBe(503);
      expect(tokenPriceResponse.json()).toEqual({
        error: 'service_unavailable',
        message: 'No usable live market snapshots are available for simple/token_price.',
      });

      const diagnosticsResponse = await freshBootApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data.readiness).toMatchObject({
        state: 'ready',
        initial_sync_completed: true,
        degraded: false,
        zero_live_completed_boot: true,
        validation_override_active: false,
      });
    } finally {
      await freshBootApp.close();
    }
  });
  it('keeps direct simple-price cache warming non-fatal for fresh zero-live startup prewarm paths', async () => {
    const prewarmApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'fresh-boot-prewarm.db'),
        ccxtExchanges: [],
        logLevel: 'silent',
        startupPrewarmBudgetMs: 5_000,
      },
      startBackgroundJobs: false,
    });

    try {
      const pingResponse = await prewarmApp.inject({
        method: 'GET',
        url: '/ping',
      });

      expect(pingResponse.statusCode).toBe(200);
      expect(prewarmApp.marketDataRuntimeState.initialSyncCompleted).toBe(true);
      expect(prewarmApp.marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots).toBe(true);
      expect(prewarmApp.marketDataRuntimeState.startupPrewarm.targetResults).toEqual([
        expect.objectContaining({
          id: 'simple_price_bitcoin_usd',
          status: 'completed',
          cacheSurface: 'simple_price',
        }),
      ]);

      const simplePriceResponse = await prewarmApp.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      });

      expect(simplePriceResponse.statusCode).toBe(503);
      expect(simplePriceResponse.json()).toEqual({
        error: 'service_unavailable',
        message: 'No usable live market snapshots are available for simple/price.',
      });
    } finally {
      await prewarmApp.close();
    }
  });
  it('accepts canonical platform aliases for token-price, contract, and token-list routes', async () => {
    const [tokenPriceResponse, contractResponse, tokenListResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/simple/token_price/eth?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/eth/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({
        method: 'GET',
        url: '/token_lists/eth/all.json',
      }),
    ]);

    expect(tokenPriceResponse.statusCode).toBe(200);
    expect(tokenPriceResponse.json()).toEqual(contractFixtures.tokenPrice);
    expect(contractResponse.statusCode).toBe(200);
    expect(contractResponse.json()).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USDC' });
    expect(tokenListResponse.statusCode).toBe(200);
    expect(tokenListResponse.json()).toMatchObject({
      name: 'OpenGecko Ethereum Token List',
      keywords: ['opengecko', 'ethereum'],
      tokens: expect.arrayContaining([
        expect.objectContaining({
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          extensions: { geckoId: 'usd-coin' },
        }),
      ]),
    });
  });
  it('accepts multiple alias variants for contract routes and returns 404 for truly unknown platforms', async () => {
    const [ethResponse, ethereumResponse, erc20Response, missingResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/coins/eth/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/erc20/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/nonexistent-chain/contract/0x0000000000000000000000000000000000000000?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
    ]);

    expect(ethResponse.statusCode).toBe(200);
    expect(ethereumResponse.statusCode).toBe(200);
    expect(erc20Response.statusCode).toBe(200);
    expect(ethResponse.json()).toMatchObject({ id: 'usd-coin' });
    expect(ethereumResponse.json()).toMatchObject({ id: 'usd-coin' });
    expect(erc20Response.json()).toMatchObject({ id: 'usd-coin' });
    expect(ethResponse.json()).toEqual(ethereumResponse.json());
    expect(erc20Response.json()).toEqual(ethereumResponse.json());

    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({
      error: 'not_found',
      message: 'Contract not found: 0x0000000000000000000000000000000000000000',
    });
  });
});
