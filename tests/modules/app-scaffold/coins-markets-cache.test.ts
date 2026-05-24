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

  it('returns coin market rows', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&sparkline=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({
      id: 'bitcoin',
      current_price: expect.any(Number),
      image: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
    });
    expect(Array.isArray(response.json()[0].sparkline_in_7d.price)).toBe(true);
  });
  it('hydrates missing images only for explicit trusted asset identities', async () => {
    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'bitcoin'))
      .run();

    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'usd-coin'))
      .run();

    await getApp().db.db
      .insert(coins)
      .values({
        id: 'wrapped-bitcoin',
        symbol: 'wbtc',
        name: 'Wrapped Bitcoin',
        apiSymbol: 'wrapped-bitcoin',
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: JSON.stringify({ en: 'Wrapped Bitcoin fixture.' }),
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: 99,
        genesisDate: null,
        platformsJson: JSON.stringify({
          ethereum: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
          solana: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
        }),
        status: 'active',
        activatedAt: new Date('2026-03-20T00:00:00.000Z'),
        createdAt: new Date('2026-03-20T00:00:00.000Z'),
        updatedAt: new Date('2026-03-20T00:00:00.000Z'),
      })
      .onConflictDoNothing()
      .run();

    const marketsResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,usd-coin,wrapped-bitcoin',
    });
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/usd-coin',
    });

    expect(marketsResponse.statusCode).toBe(200);
    expect(detailResponse.statusCode).toBe(200);

    expect(marketsResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'bitcoin',
        image: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
      }),
      expect.objectContaining({
        id: 'usd-coin',
        image: 'http://localhost:3001/assets/chains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
      }),
      expect.objectContaining({
        id: 'wrapped-bitcoin',
        image: null,
      }),
    ]));

    expect(detailResponse.json().image).toEqual({
      thumb: 'http://localhost:3001/assets/chains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
      small: 'http://localhost:3001/assets/chains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
      large: 'http://localhost:3001/assets/chains/ethereum/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/logo.png',
    });
  });
  it('keeps frontend-critical asset images coherent across list and detail surfaces', async () => {
    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'bitcoin'))
      .run();

    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'ripple'))
      .run();

    await getApp().db.db
      .update(coins)
      .set({
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
      })
      .where(eq(coins.id, 'dogecoin'))
      .run();

    const marketsResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ripple,dogecoin',
    });

    const bitcoinDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin',
    });

    const rippleDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/ripple',
    });

    const dogecoinDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/dogecoin',
    });

    expect(marketsResponse.statusCode).toBe(200);
    expect(bitcoinDetailResponse.statusCode).toBe(200);
    expect(rippleDetailResponse.statusCode).toBe(200);
    expect(dogecoinDetailResponse.statusCode).toBe(200);

    expect(marketsResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'bitcoin',
        image: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
      }),
      expect.objectContaining({
        id: 'ripple',
        image: 'http://localhost:3001/assets/chains/xrp/logo.png',
      }),
      expect.objectContaining({
        id: 'dogecoin',
        image: 'http://localhost:3001/assets/chains/dogecoin/logo.png',
      }),
    ]));

    expect(bitcoinDetailResponse.json().image).toEqual({
      thumb: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
      small: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
      large: 'http://localhost:3001/assets/chains/bitcoin/logo.png',
    });
    expect(rippleDetailResponse.json().image).toEqual({
      thumb: 'http://localhost:3001/assets/chains/xrp/logo.png',
      small: 'http://localhost:3001/assets/chains/xrp/logo.png',
      large: 'http://localhost:3001/assets/chains/xrp/logo.png',
    });
    expect(dogecoinDetailResponse.json().image).toEqual({
      thumb: 'http://localhost:3001/assets/chains/dogecoin/logo.png',
      small: 'http://localhost:3001/assets/chains/dogecoin/logo.png',
      large: 'http://localhost:3001/assets/chains/dogecoin/logo.png',
    });
  });
  it('refuses to hydrate assets from unsupported or ambiguous platform mappings', async () => {
    await getApp().db.db
      .insert(coins)
      .values([
        {
          id: 'test-solana-token',
          symbol: 'tst',
          name: 'Test Solana Token',
          apiSymbol: 'test-solana-token',
          hashingAlgorithm: null,
          blockTimeInMinutes: null,
          categoriesJson: '[]',
          descriptionJson: JSON.stringify({ en: 'Unsupported non-EVM token fixture.' }),
          linksJson: '{}',
          imageThumbUrl: null,
          imageSmallUrl: null,
          imageLargeUrl: null,
          marketCapRank: 150,
          genesisDate: null,
          platformsJson: JSON.stringify({
            solana: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
          }),
          status: 'active',
          activatedAt: new Date('2026-03-20T00:00:00.000Z'),
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-20T00:00:00.000Z'),
        },
        {
          id: 'test-multi-platform-token',
          symbol: 'tmpt',
          name: 'Test Multi Platform Token',
          apiSymbol: 'test-multi-platform-token',
          hashingAlgorithm: null,
          blockTimeInMinutes: null,
          categoriesJson: '[]',
          descriptionJson: JSON.stringify({ en: 'Ambiguous multi-platform fixture.' }),
          linksJson: '{}',
          imageThumbUrl: null,
          imageSmallUrl: null,
          imageLargeUrl: null,
          marketCapRank: 151,
          genesisDate: null,
          platformsJson: JSON.stringify({
            ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            solana: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
          }),
          status: 'active',
          activatedAt: new Date('2026-03-20T00:00:00.000Z'),
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-20T00:00:00.000Z'),
        },
      ])
      .onConflictDoNothing()
      .run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=test-solana-token,test-multi-platform-token',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'test-solana-token',
        image: null,
      }),
      expect.objectContaining({
        id: 'test-multi-platform-token',
        image: null,
      }),
    ]));
  });
  it('omits sparkline_in_7d when sparkline is false on coin market rows', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&sparkline=false',
    });

    expect(response.statusCode).toBe(200);
    expect('sparkline_in_7d' in response.json()[0]).toBe(false);
  });
  it('preserves sub-cent current_price values by default', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=btc&ids=usd-coin',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0]).toMatchObject({
      id: 'usd-coin',
    });
    expect(response.json()[0].current_price).toBeGreaterThan(0);
    expect(response.json()[0].current_price).toBeLessThan(0.001);
  });
  it('supports market category filters and extra price change windows', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&category=smart-contract-platform&price_change_percentage=24h,7d',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(0);
    expect(response.json()).toEqual([]);
  });
  it('keeps market filtering and order deterministic across repeated requests', async () => {
    const [firstResponse, secondResponse, pageOneResponse, pageTwoResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=market_cap_desc&ids=bitcoin,cardano,ethereum',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=market_cap_desc&ids=bitcoin,cardano,ethereum',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=2&page=1',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=2&page=2',
      }),
    ]);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(firstResponse.json().map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'cardano', 'ethereum']);
    expect(secondResponse.json()).toEqual(firstResponse.json());

    expect(pageOneResponse.statusCode).toBe(200);
    expect(pageTwoResponse.statusCode).toBe(200);
    expect(pageOneResponse.json().map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'ethereum']);
    expect(pageTwoResponse.json().map((row: { id: string }) => row.id)).toEqual(['ripple', 'usd-coin']);
  });
  it('isolates coins markets cache entries by pagination, ordering, filters, sparkline windows, and precision-sensitive flags', async () => {
    const getMarketRowsSpy = vi.spyOn(catalogModule, 'getMarketRows');
    const marketsCallCount = () => getMarketRowsSpy.mock.calls.filter(
      ([, vsCurrency, filters]) => {
        if (vsCurrency !== 'usd' && vsCurrency !== 'btc') {
          return false;
        }

        return !filters?.status;
      },
    ).length;

    const baselineResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&ids=bitcoin,cardano,ethereum',
    });
    const baselineCalls = marketsCallCount();
    const repeatedBaselineResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?ids=ethereum,cardano,bitcoin&order=market_cap_desc&vs_currency=usd',
    });
    const pageOneResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=2&page=1',
    });
    const repeatedPageOneResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?order=market_cap_desc&page=1&vs_currency=usd&per_page=2',
    });
    const pageTwoResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=2&page=2',
    });
    const sparklineWindowResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&per_page=1&page=1&sparkline=true&price_change_percentage=24h,7d',
    });
    const noSparklineResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&per_page=1&page=1',
    });
    const precisionResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=btc&ids=usd-coin&precision=2',
    });
    const categoryResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&category=smart-contract-platform&price_change_percentage=24h,7d',
    });
    const repeatedCategoryResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?price_change_percentage=7d,24h&category=smart-contract-platform&vs_currency=usd',
    });

    expect(baselineResponse.statusCode).toBe(200);
    expect(repeatedBaselineResponse.statusCode).toBe(200);
    expect(pageOneResponse.statusCode).toBe(200);
    expect(repeatedPageOneResponse.statusCode).toBe(200);
    expect(pageTwoResponse.statusCode).toBe(200);
    expect(sparklineWindowResponse.statusCode).toBe(200);
    expect(noSparklineResponse.statusCode).toBe(200);
    expect(precisionResponse.statusCode).toBe(200);
    expect(categoryResponse.statusCode).toBe(200);
    expect(repeatedCategoryResponse.statusCode).toBe(200);

    expect(repeatedBaselineResponse.json()).toEqual(baselineResponse.json());
    expect(baselineResponse.json().map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'cardano', 'ethereum']);
    expect(repeatedPageOneResponse.json()).toEqual(pageOneResponse.json());
    expect(pageOneResponse.json().map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'ethereum']);
    expect(pageTwoResponse.json().map((row: { id: string }) => row.id)).toEqual(['ripple', 'usd-coin']);
    expect(new Set([
      ...pageOneResponse.json().map((row: { id: string }) => row.id),
      ...pageTwoResponse.json().map((row: { id: string }) => row.id),
    ]).size).toBe(4);

    const sparklineRow = sparklineWindowResponse.json()[0];
    const noSparklineRow = noSparklineResponse.json()[0];
    expect(sparklineRow).toHaveProperty('sparkline_in_7d');
    expect(sparklineRow.sparkline_in_7d).toHaveProperty('price');
    expect(sparklineRow).toHaveProperty('price_change_percentage_24h_in_currency');
    expect(sparklineRow).toHaveProperty('price_change_percentage_7d_in_currency');
    expect('sparkline_in_7d' in noSparklineRow).toBe(false);
    expect('price_change_percentage_24h_in_currency' in noSparklineRow).toBe(false);
    expect('price_change_percentage_7d_in_currency' in noSparklineRow).toBe(false);

    expect(precisionResponse.json()).toEqual([
      expect.objectContaining({
        id: 'usd-coin',
        current_price: 0,
      }),
    ]);
    expect(repeatedCategoryResponse.json()).toEqual(categoryResponse.json());
    expect(categoryResponse.json()).toEqual([]);
    expect(baselineCalls).toBeGreaterThan(0);
    expect(marketsCallCount() - baselineCalls).toBe(6);
  });
  it('invalidates simple price and coins markets hot caches together after a shared data revision', async () => {
    const state = getApp().marketDataRuntimeState;
    const getMarketRowsSpy = vi.spyOn(catalogModule, 'getMarketRows');
    await getApp().ready();
    const originalRevision = state.hotDataRevision;

    const countSharedAssetCalls = () => getMarketRowsSpy.mock.calls.filter(
      ([, vsCurrency, filters]) => vsCurrency === 'usd'
        && Array.isArray(filters?.ids)
        && filters.ids.length === 1
        && filters.ids[0] === 'bitcoin',
    ).length;

    const simpleBefore = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const marketsBefore = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });
    const callsAfterWarm = countSharedAssetCalls();

    const simpleCached = await getApp().inject({
      method: 'GET',
      url: '/simple/price?vs_currencies=usd&ids=bitcoin',
    });
    const marketsCached = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?ids=bitcoin&vs_currency=usd',
    });

    expect(simpleBefore.statusCode).toBe(200);
    expect(marketsBefore.statusCode).toBe(200);
    expect(simpleCached.json()).toEqual(simpleBefore.json());
    expect(marketsCached.json()).toEqual(marketsBefore.json());
    expect(countSharedAssetCalls()).toBe(callsAfterWarm);
    expect(state.hotDataRevision).toBe(originalRevision);

    state.hotDataRevision += 1;

    const simpleAfterRevision = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const marketsAfterRevision = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(simpleAfterRevision.statusCode).toBe(200);
    expect(marketsAfterRevision.statusCode).toBe(200);
    expect(simpleAfterRevision.json()).toEqual(simpleBefore.json());
    expect(marketsAfterRevision.json()).toEqual(marketsBefore.json());
    expect(countSharedAssetCalls()).toBeGreaterThan(callsAfterWarm);
  });
  it('invalidates hot caches when onReady bootstrap first makes hot data visible without background runtime', async () => {
    await getApp().close();
    app = undefined;

    const bootstrapApp = buildApp({
      config: {
        databaseUrl: join(tempDir, 'bootstrap-only.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    app = bootstrapApp;

    const state = getApp().marketDataRuntimeState;
    const getMarketRowsSpy = vi.spyOn(catalogModule, 'getMarketRows');
    const countSharedAssetCalls = () => getMarketRowsSpy.mock.calls.filter(
      ([, vsCurrency, filters]) => vsCurrency === 'usd'
        && Array.isArray(filters?.ids)
        && filters.ids.length === 1
        && filters.ids[0] === 'bitcoin',
    ).length;

    expect(state.initialSyncCompleted).toBe(false);
    expect(state.hotDataRevision).toBe(0);

    await getApp().ready();

    expect(state.initialSyncCompleted).toBe(true);

    const warmCallCountBeforeRequests = countSharedAssetCalls();

    const simpleAfterBootstrap = await getApp().inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });
    const marketsAfterBootstrap = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });

    expect(simpleAfterBootstrap.statusCode).toBe(200);
    expect(simpleAfterBootstrap.json()).toEqual({
      bitcoin: {
        usd: marketsAfterBootstrap.json()[0].current_price,
      },
    });
    expect(marketsAfterBootstrap.statusCode).toBe(200);
    expect(marketsAfterBootstrap.json()).toEqual([
      expect.objectContaining({
        id: 'bitcoin',
        current_price: 85000,
      }),
    ]);
    expect(countSharedAssetCalls()).toBeGreaterThan(warmCallCountBeforeRequests);
  });
});
