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

  it('returns onchain token detail, multi, and token-pools with canonical network-scoped identity continuity', async () => {
    const tokenDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const tokenDetailIncludedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?include=top_pools&include_inactive_source=true&include_composition=true',
    });
    const tokenMultiResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/multi/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const tokenPoolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/pools?page=1',
    });

    expect(tokenDetailResponse.statusCode).toBe(200);
    expect(tokenDetailResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token',
        attributes: {
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
          name: 'USDC',
          price_usd: 1,
        },
        relationships: {
          network: {
            data: {
              type: 'network',
              id: 'eth',
            },
          },
        },
      },
    });

    expect(tokenDetailIncludedResponse.statusCode).toBe(200);
    expect(tokenDetailIncludedResponse.json().data.attributes.price_usd).toBe(1);
    expect(tokenDetailIncludedResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        attributes: {
          top_pools: [
            '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
            '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          ],
          inactive_source: false,
          composition: {
            pools: expect.arrayContaining([
              expect.objectContaining({
                pool_address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
                role: 'base',
              }),
              expect.objectContaining({
                pool_address: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
                role: 'base',
              }),
            ]),
          },
        },
      },
      included: expect.arrayContaining([
        expect.objectContaining({
          id: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
          type: 'pool',
        }),
        expect.objectContaining({
          id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          type: 'pool',
        }),
      ]),
    });

    expect(tokenMultiResponse.statusCode).toBe(200);
    expect(tokenMultiResponse.json()).toMatchObject({
      data: [
        expect.objectContaining({
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          type: 'token',
        }),
      ],
    });
    expect(tokenMultiResponse.json().data).toHaveLength(1);

    expect(tokenPoolsResponse.statusCode).toBe(200);
    expect(tokenPoolsResponse.json().meta).toMatchObject({
      page: 1,
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    expect(tokenPoolsResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);
    expect(tokenPoolsResponse.json().data.every((pool: { attributes: { base_token_address: string; quote_token_address: string } }) =>
      pool.attributes.base_token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      || pool.attributes.quote_token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true);
  });
  it('proves the token detail route surfaces live defillama pricing and falls back to seeded pricing when live pricing fails', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValueOnce({
      'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
        price: 1.234567,
        symbol: 'USDC',
        decimals: 6,
        confidence: 0.99,
        timestamp: 1710000000,
      },
    });

    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token',
        attributes: expect.objectContaining({
          price_usd: 1.234567,
        }),
        relationships: {
          network: {
            data: {
              type: 'network',
              id: 'eth',
            },
          },
        },
      },
    });

    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValueOnce(null);

    const fallbackResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });

    expect(fallbackResponse.statusCode).toBe(200);
    expect(fallbackResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token',
        attributes: expect.objectContaining({
          price_usd: 1,
        }),
      },
    });
    expect(fallbackResponse.json().data.attributes.top_pools).toEqual([
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    ]);
  });
  it('rejects unknown or wrong-network onchain token lookups without bleeding identities across routes', async () => {
    const unknownTokenResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0x0000000000000000000000000000000000000001',
    });
    const wrongNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/solana/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const wrongNetworkPoolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/solana/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/pools',
    });

    expect(unknownTokenResponse.statusCode).toBe(404);
    expect(unknownTokenResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain token not found: 0x0000000000000000000000000000000000000001',
    });

    expect(wrongNetworkResponse.statusCode).toBe(404);
    expect(wrongNetworkResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain token not found: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });

    expect(wrongNetworkPoolsResponse.statusCode).toBe(404);
    expect(wrongNetworkPoolsResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain token not found: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
  });
  it('returns onchain simple token prices with optional field gating and network scoping', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue({
      'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
        price: 1.0025,
        symbol: 'USDC',
        decimals: 6,
        confidence: 0.99,
        timestamp: 1710000000,
      },
      'ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': {
        price: 85250,
        symbol: 'WBTC',
        decimals: 8,
        confidence: 0.98,
        timestamp: 1710000000,
      },
    });

    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });
    const includedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?include_market_cap=true&include_24hr_vol=true&include_24hr_price_change=true&include_total_reserve_in_usd=true',
    });
    const mixedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,0x0000000000000000000000000000000000000001',
    });
    const wrongNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/solana/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(baselineResponse.json()).toMatchObject({
      data: {
        id: 'eth',
        type: 'simple_token_price',
        attributes: {
          token_prices: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1.0025',
          },
        },
      },
    });
    expect(baselineResponse.json().data.attributes).not.toHaveProperty('market_cap_usd');
    expect(baselineResponse.json().data.attributes).not.toHaveProperty('h24_volume_usd');
    expect(baselineResponse.json().data.attributes).not.toHaveProperty('h24_price_change_percentage');
    expect(baselineResponse.json().data.attributes).not.toHaveProperty('total_reserve_in_usd');

    expect(includedResponse.statusCode).toBe(200);
    expect(includedResponse.json()).toMatchObject({
      data: {
        id: 'eth',
        type: 'simple_token_price',
        attributes: {
          token_prices: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1.0025',
          },
          market_cap_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': expect.any(String),
          },
          h24_volume_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': expect.any(String),
          },
          h24_price_change_percentage: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': expect.any(String),
          },
          total_reserve_in_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': expect.any(String),
          },
        },
      },
    });

    expect(mixedResponse.statusCode).toBe(200);
    expect(mixedResponse.json()).toMatchObject({
      data: {
        id: 'eth',
        type: 'simple_token_price',
        attributes: {
          token_prices: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1.0025',
          },
        },
      },
    });

    expect(wrongNetworkResponse.statusCode).toBe(200);
    expect(wrongNetworkResponse.json()).toEqual({
      data: {
        id: 'solana',
        type: 'simple_token_price',
        attributes: {
          token_prices: {},
        },
      },
    });
  });
  it('prefers live aggregate fields for onchain simple token prices when live pricing succeeds', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue({
      'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
        price: 1.1111,
        symbol: 'USDC',
        decimals: 6,
        confidence: 0.99,
        timestamp: 1710000000,
      },
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'USDC-WETH',
          tvlUsd: 123456789,
          pool: 'live-usdc-weth',
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          ],
          volumeUsd1d: 22222222,
          volumeUsd7d: 0,
        },
        {
          chain: 'Ethereum',
          project: 'curve',
          symbol: 'USDC-USDT',
          tvlUsd: 98765432,
          pool: 'live-usdc-usdt',
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xdac17f958d2ee523a2206206994597c13d831ec7',
          ],
          volumeUsd1d: 33333333,
          volumeUsd7d: 0,
        },
      ],
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      total24h: 166666665,
      total7d: null,
      total30d: null,
      totalAllTime: null,
      protocols: [
        {
          name: 'Uniswap V3',
          total24h: 88888888,
        },
        {
          name: 'Curve',
          total24h: 77777777,
        },
      ],
    });

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?include_market_cap=true&include_24hr_vol=true&include_total_reserve_in_usd=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: 'eth',
        type: 'simple_token_price',
        attributes: {
          token_prices: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1.1111',
          },
          market_cap_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '222222221',
          },
          h24_volume_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '55555555',
          },
          total_reserve_in_usd: {
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '222222221',
          },
        },
      },
    });
  });
});
