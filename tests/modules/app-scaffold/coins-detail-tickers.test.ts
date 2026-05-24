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

  it('returns a detailed coin payload', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.coinDetail);
  });
  it('supports optional coin detail flags and omits market data when requested', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin?market_data=false&localization=false&community_data=false&developer_data=false&sparkline=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      description: {
        en: 'Bitcoin imported from binance market discovery.',
      },
      market_data: null,
      community_data: null,
      developer_data: null,
    });
  });
  it('keeps equivalent compact and rich resources on the same null-vs-omitted policy', async () => {
    const [coinMarketsResponse, coinDetailResponse, exchangeListResponse, exchangeDetailResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&ids=bitcoin' }),
      getApp().inject({
        method: 'GET',
        url: '/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false',
      }),
      getApp().inject({ method: 'GET', url: '/exchanges?per_page=1&page=2' }),
      getApp().inject({ method: 'GET', url: '/exchanges/binance' }),
    ]);

    const compactCoin = coinMarketsResponse.json()[0];
    const richCoin = coinDetailResponse.json();
    const compactExchange = exchangeListResponse.json()[0];
    const richExchange = exchangeDetailResponse.json();

    expect(compactCoin.current_price).not.toBeNull();
    expect(richCoin.market_data).not.toBeNull();
    expect(compactCoin.roi).toBeNull();
    expect(richCoin.public_notice).toBeNull();

    expect(typeof compactExchange.description).toBe(typeof richExchange.description);
    expect(typeof compactExchange.description).toBe('string');
    expect(typeof richExchange.description).toBe('string');
    expect(compactExchange.year_established === null || typeof compactExchange.year_established === 'number').toBe(true);
    expect(richExchange.year_established === null || typeof richExchange.year_established === 'number').toBe(true);
    expect(compactExchange).not.toHaveProperty('facebook_url');
    expect(richExchange).toHaveProperty('facebook_url');
    expect(richExchange.facebook_url === null || typeof richExchange.facebook_url === 'string').toBe(true);
  });
  it('returns richer default coin detail sections', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum?sparkline=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'ethereum',
      localization: {
        en: 'Ethereum',
      },
      detail_platforms: {},
      community_data: {
        twitter_followers: null,
      },
      developer_data: {
        forks: null,
        code_additions_deletions_4_weeks: {
          additions: null,
          deletions: null,
        },
      },
      community_score: null,
      developer_score: null,
      liquidity_score: null,
      public_interest_score: null,
      public_interest_stats: {
        alexa_rank: null,
        bing_matches: null,
      },
      market_data: {
        high_24h: {
          usd: expect.any(Number),
        },
        low_24h: {
          usd: expect.any(Number),
        },
        sparkline_7d: {
          price: expect.any(Array),
        },
      },
    });
    expect(response.json().market_data.sparkline_7d.price.length).toBeGreaterThan(0);
  });
  it('supports category detail flags on coin detail responses', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum?include_categories_details=true&dex_pair_format=symbol',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().categories_details).toEqual([]);
  });
  it('includes seeded tickers in default coin detail responses', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tickers.length).toBeGreaterThanOrEqual(3);
    expect(response.json().tickers[0]).toMatchObject({
      base: 'BTC',
      target: 'USDT',
      market: {
        identifier: 'binance',
      },
      trade_url: 'https://www.binance.com/trade/BTC-USDT',
    });
  });
  it('returns coin tickers with exchange metadata', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/tickers?include_exchange_logo=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'Bitcoin',
    });
    expect(response.json().tickers.length).toBeGreaterThanOrEqual(2);
    expect(response.json().tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        base: 'BTC',
        target: 'USDT',
        coin_id: 'bitcoin',
        last: 85000,
        market: expect.objectContaining({
          name: 'Binance',
          identifier: 'binance',
        }),
      }),
      expect.objectContaining({
        base: 'BTC',
        target: 'USDT',
        coin_id: 'bitcoin',
        last: expect.any(Number),
        market: expect.objectContaining({
          name: 'Coinbase Exchange',
          identifier: 'coinbase',
        }),
      }),
    ]));
  });
  it('filters and orders coin tickers', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/tickers?exchange_ids=coinbase&order=volume_asc',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tickers).toHaveLength(1);
    expect(response.json().tickers[0]).toMatchObject({
      market: {
        identifier: 'coinbase',
      },
      target: 'USDT',
    });
  });
  it('uses a default ticker page size of 100 and preserves explicit pagination semantics', async () => {
    const app = getApp();
    const originalGetCoinById = catalogModule.getCoinById;
    vi.spyOn(catalogModule, 'getCoinById').mockImplementation((database, coinId) => {
      if (coinId === 'bitcoin') {
        return {
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
          genesisDate: null,
          marketCapRank: 1,
          platformsJson: '{}',
          status: 'active',
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-20T00:00:00.000Z'),
          activatedAt: new Date('2026-03-20T00:00:00.000Z'),
        };
      }

      return originalGetCoinById(database, coinId);
    });
    const getCoinTickerRowsSpy = vi.spyOn(await import('../../../src/modules/coins/detail'), 'getCoinTickers');

    const syntheticTickers = Array.from({ length: 105 }, (_, index) => ({
      base: `BTC${index.toString().padStart(3, '0')}`,
      target: 'USDT',
      market: {
        name: 'Binance',
        identifier: 'binance',
        has_trading_incentive: false,
      },
      last: 100000 - index,
      volume: 1000 + index,
      converted_last: { btc: 1, usd: 100000 - index, eth: 40 },
      converted_volume: { btc: 10, usd: 1000000 - index, eth: 400 },
      trust_score: 'green',
      bid_ask_spread_percentage: 0.1,
      timestamp: Date.UTC(2026, 2, 20, 0, 0, index),
      last_traded_at: new Date(Date.UTC(2026, 2, 20, 0, 0, index)).toISOString(),
      last_fetch_at: new Date(Date.UTC(2026, 2, 20, 0, 1, index)).toISOString(),
      is_anomaly: false,
      is_stale: false,
      trade_url: `https://example.com/btc-${index}`,
      token_info_url: null,
      coin_id: 'bitcoin',
      target_coin_id: null,
    }));

    getCoinTickerRowsSpy.mockImplementation((_database, _coinId, options) => {
      const start = (options.page - 1) * options.perPage;

      return {
        tickers: syntheticTickers.slice(start, start + options.perPage),
      };
    });

    const [defaultResponse, explicitHundredResponse, explicitSmallPageResponse, explicitSecondPageResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/coins/bitcoin/tickers',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/bitcoin/tickers?per_page=100',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/bitcoin/tickers?per_page=5',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/bitcoin/tickers?per_page=5&page=2',
      }),
    ]);

    expect(defaultResponse.statusCode).toBe(200);
    expect(explicitHundredResponse.statusCode).toBe(200);
    expect(explicitSmallPageResponse.statusCode).toBe(200);
    expect(explicitSecondPageResponse.statusCode).toBe(200);

    const defaultTickers = defaultResponse.json().tickers;
    const explicitHundredTickers = explicitHundredResponse.json().tickers;
    const explicitSmallPageTickers = explicitSmallPageResponse.json().tickers;
    const explicitSecondPageTickers = explicitSecondPageResponse.json().tickers;

    expect(defaultTickers).toHaveLength(100);
    expect(explicitHundredTickers).toHaveLength(100);
    expect(defaultTickers).toEqual(explicitHundredTickers);
    expect(explicitSmallPageTickers).toHaveLength(5);
    expect(explicitSecondPageTickers).toHaveLength(5);
    expect(explicitSecondPageTickers).toEqual(defaultTickers.slice(5, 10));
  });
});
