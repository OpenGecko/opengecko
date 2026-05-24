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

  it('keeps canonical identity aligned across coin list, search, market, detail, contract, treasury, and registry routes', async () => {
    const [coinsListResponse, searchResponse, marketsResponse, detailResponse, contractResponse, treasuryByCoinResponse, treasuryDetailResponse, exchangesListResponse, exchangeDetailResponse, derivativesListResponse, derivativesDetailResponse] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/coins/list?include_platform=true' }),
      getApp().inject({ method: 'GET', url: '/search?query=eth' }),
      getApp().inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&ids=ethereum,bitcoin' }),
      getApp().inject({ method: 'GET', url: '/coins/ethereum?localization=false&tickers=false&community_data=false&developer_data=false' }),
      getApp().inject({ method: 'GET', url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false' }),
      getApp().inject({ method: 'GET', url: '/companies/public_treasury/bitcoin' }),
      getApp().inject({ method: 'GET', url: '/public_treasury/strategy' }),
      getApp().inject({ method: 'GET', url: '/exchanges/list' }),
      getApp().inject({ method: 'GET', url: '/exchanges/binance' }),
      getApp().inject({ method: 'GET', url: '/derivatives/exchanges/list' }),
      getApp().inject({ method: 'GET', url: '/derivatives/exchanges/binance_futures' }),
    ]);

    expect(coinsListResponse.statusCode).toBe(200);
    expect(searchResponse.statusCode).toBe(200);
    expect(marketsResponse.statusCode).toBe(200);
    expect(detailResponse.statusCode).toBe(200);
    expect(contractResponse.statusCode).toBe(200);
    expect(treasuryByCoinResponse.statusCode).toBe(200);
    expect(treasuryDetailResponse.statusCode).toBe(200);
    expect(exchangesListResponse.statusCode).toBe(200);
    expect(exchangeDetailResponse.statusCode).toBe(200);
    expect(derivativesListResponse.statusCode).toBe(200);
    expect(derivativesDetailResponse.statusCode).toBe(200);

    const coinsListBody = coinsListResponse.json();
    const searchBody = searchResponse.json();
    const marketsBody = marketsResponse.json();
    const detailBody = detailResponse.json();
    const contractBody = contractResponse.json();
    const treasuryByCoinBody = treasuryByCoinResponse.json();
    const treasuryDetailBody = treasuryDetailResponse.json();
    const exchangesListBody = exchangesListResponse.json();
    const exchangeDetailBody = exchangeDetailResponse.json();
    const derivativesListBody = derivativesListResponse.json();
    const derivativesDetailBody = derivativesDetailResponse.json();

    const ethereumListRow = coinsListBody.find((coin: { id: string }) => coin.id === 'ethereum');
    expect(ethereumListRow).toMatchObject({
      id: 'ethereum',
      symbol: 'eth',
      name: 'Ethereum',
    });
    expect(ethereumListRow.platforms).toEqual(expect.any(Object));

    expect(searchBody.coins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ethereum', symbol: 'eth', name: 'Ethereum' }),
    ]));
    expect(marketsBody).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ethereum', symbol: 'eth', name: 'Ethereum' }),
      expect.objectContaining({ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }),
    ]));
    expect(detailBody).toMatchObject({ id: 'ethereum', symbol: 'eth', name: 'Ethereum' });
    expect(contractBody).toMatchObject({ id: 'usd-coin', symbol: 'usdc', name: 'USDC' });
    expect(treasuryByCoinBody).toMatchObject({
      data: { coin_id: 'bitcoin' },
      meta: expect.objectContaining({ fixture: true }),
    });
    expect(treasuryByCoinBody.data.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_id: 'strategy' }),
    ]));
    expect(treasuryDetailBody).toMatchObject({
      data: { id: 'strategy' },
      meta: expect.objectContaining({ fixture: true }),
    });
    expect(treasuryDetailBody.data.holdings).toEqual(expect.arrayContaining([
      expect.objectContaining({ coin_id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }),
    ]));
    expect(exchangesListBody).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'binance', name: 'Binance' }),
    ]));
    expect(exchangeDetailBody).toMatchObject({ id: 'binance', name: 'Binance' });
    expect(derivativesListBody).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'binance_futures', name: 'Binance Futures' }),
    ]));
    expect(derivativesDetailBody.data).toMatchObject({ id: 'binance_futures', name: 'Binance Futures' });
    expect(derivativesDetailBody.meta).toMatchObject({ fixture: true, frozen_at: '2026-03-20' });
  });
  it('keeps search, global, and categories contract-compatible when live snapshots have null market caps', async () => {
    getApp().db.db
      .update(marketSnapshots)
      .set({
        marketCap: null,
      })
      .run();

    const [searchResponse, globalResponse, categoriesResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/search?query=bitcoin',
      }),
      getApp().inject({
        method: 'GET',
        url: '/global',
      }),
      getApp().inject({
        method: 'GET',
        url: '/coins/categories?order=market_cap_desc',
      }),
    ]);

    expect(searchResponse.statusCode).toBe(200);
    expect(searchResponse.json()).toEqual(expect.objectContaining({
      coins: expect.any(Array),
      exchanges: expect.any(Array),
      categories: expect.any(Array),
      nfts: expect.any(Array),
    }));

    expect(globalResponse.statusCode).toBe(200);
    expect(globalResponse.json()).toEqual({
      data: expect.objectContaining({
        active_cryptocurrencies: expect.any(Number),
        markets: expect.any(Number),
        total_market_cap: expect.any(Object),
        total_volume: expect.any(Object),
        market_cap_percentage: expect.any(Object),
        updated_at: expect.any(Number),
      }),
    });

    expect(categoriesResponse.statusCode).toBe(200);
    expect(categoriesResponse.json()).toEqual(expect.objectContaining({
      data: expect.any(Array),
      meta: expect.any(Object),
    }));
  });
  it('keeps representative pagination boundaries deterministic across coin, exchange, and onchain category families', async () => {
    const [
      coinMarketsPageOne,
      coinMarketsPageTwo,
      exchangesPageOne,
      exchangesPageTwo,
      onchainCategoriesPageOne,
      onchainCategoriesPageTwo,
    ] = await Promise.all([
      getApp().inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&per_page=2&page=1' }),
      getApp().inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&per_page=2&page=2' }),
      getApp().inject({ method: 'GET', url: '/exchanges?per_page=1&page=1' }),
      getApp().inject({ method: 'GET', url: '/exchanges?per_page=1&page=2' }),
      getApp().inject({ method: 'GET', url: '/onchain/categories?sort=h24_volume_usd_desc&page=1' }),
      getApp().inject({ method: 'GET', url: '/onchain/categories?sort=h24_volume_usd_desc&page=2' }),
    ]);

    expect(coinMarketsPageOne.statusCode).toBe(200);
    expect(coinMarketsPageTwo.statusCode).toBe(200);
    const coinPageOneIds = coinMarketsPageOne.json().map((coin: { id: string }) => coin.id);
    const coinPageTwoIds = coinMarketsPageTwo.json().map((coin: { id: string }) => coin.id);
    expect(coinPageOneIds).toEqual(['bitcoin', 'ethereum']);
    expect(coinPageTwoIds).toEqual(['ripple', 'usd-coin']);
    expect(new Set([...coinPageOneIds, ...coinPageTwoIds]).size).toBe(4);

    expect(exchangesPageOne.statusCode).toBe(200);
    expect(exchangesPageTwo.statusCode).toBe(200);
    const exchangePageOneIds = exchangesPageOne.json().map((exchange: { id: string }) => exchange.id);
    const exchangePageTwoIds = exchangesPageTwo.json().map((exchange: { id: string }) => exchange.id);
    expect(exchangePageOneIds).toHaveLength(1);
    expect(exchangePageTwoIds).toHaveLength(1);
    expect(exchangePageOneIds).not.toEqual(exchangePageTwoIds);
    expect(new Set([...exchangePageOneIds, ...exchangePageTwoIds]).size).toBe(2);

    expect(onchainCategoriesPageOne.statusCode).toBe(200);
    expect(onchainCategoriesPageTwo.statusCode).toBe(200);
    expect(onchainCategoriesPageOne.json().data.map((category: { id: string }) => category.id)).toEqual(['stablecoins']);
    expect(onchainCategoriesPageTwo.json().data.map((category: { id: string }) => category.id)).toEqual(['smart-contract-platform']);
  });
});
