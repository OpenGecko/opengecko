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

  it('returns onchain holder and trader analytics with deterministic ordering, count limits, enrichment gating, and holders chart windows', async () => {
    const topHoldersResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_holders',
    });
    const topHoldersLimitedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_holders?holders=2&include_pnl_details=true&include=token,network',
    });
    const topTradersResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_traders',
    });
    const topTradersSortedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_traders?traders=2&sort=realized_pnl_usd_desc&include_address_label=true',
    });
    const holdersChartResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/holders_chart',
    });
    const holdersChartShortResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/holders_chart?days=7',
    });

    expect(topHoldersResponse.statusCode).toBe(200);
    expect(topHoldersResponse.json().meta).toMatchObject({
      network: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      holders: 3,
    });
    expect(topHoldersResponse.json().data.map((holder: { id: string }) => holder.id)).toEqual([
      '0xholder000000000000000000000000000000000003',
      '0xholder000000000000000000000000000000000002',
      '0xholder000000000000000000000000000000000001',
    ]);
    expect(topHoldersResponse.json().data.map((holder: { attributes: { balance: string } }) => Number(holder.attributes.balance))).toEqual([
      200000000,
      150000000,
      100000000,
    ]);
    expect(topHoldersResponse.json().data[0].attributes).not.toHaveProperty('pnl_usd');

    expect(topHoldersLimitedResponse.statusCode).toBe(200);
    expect(topHoldersLimitedResponse.json().meta).toMatchObject({
      holders: 2,
      include_pnl_details: true,
    });
    expect(topHoldersLimitedResponse.json().data).toHaveLength(2);
    expect(topHoldersLimitedResponse.json().data).toEqual([
      expect.objectContaining({
        id: '0xholder000000000000000000000000000000000003',
        attributes: expect.objectContaining({
          pnl_usd: '2000000',
          avg_buy_price_usd: '0.98',
          realized_pnl_usd: '700000',
        }),
      }),
      expect.objectContaining({
        id: '0xholder000000000000000000000000000000000002',
        attributes: expect.objectContaining({
          pnl_usd: '1000000',
          avg_buy_price_usd: '0.99',
          realized_pnl_usd: '300000',
        }),
      }),
    ]);
    expect(topHoldersLimitedResponse.json()).toMatchObject({
      included: expect.arrayContaining([
        expect.objectContaining({
          id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          type: 'token',
        }),
        expect.objectContaining({
          id: 'eth',
          type: 'network',
        }),
      ]),
    });
    expect(topHoldersLimitedResponse.json().included).toHaveLength(2);

    expect(topTradersResponse.statusCode).toBe(200);
    expect(topTradersResponse.json().meta).toMatchObject({
      network: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      traders: 3,
      sort: 'volume_usd_desc',
    });
    expect(topTradersResponse.json().data.map((trader: { id: string }) => trader.id)).toEqual([
      '0xtrader000000000000000000000000000000000002',
      '0xtrader000000000000000000000000000000000001',
      '0xtrader000000000000000000000000000000000003',
    ]);
    expect(topTradersResponse.json().data.map((trader: { attributes: { is_whale: boolean } }) => trader.attributes.is_whale)).toEqual([
      true,
      false,
      false,
    ]);
    expect(topTradersResponse.json().data.map((trader: { attributes: { volume_usd: string } }) => Number(trader.attributes.volume_usd))).toEqual([
      12500000,
      9000000,
      4000000,
    ]);
    expect(topTradersResponse.json().data[0].attributes).not.toHaveProperty('address_label');

    expect(topTradersSortedResponse.statusCode).toBe(200);
    expect(topTradersSortedResponse.json().meta).toMatchObject({
      traders: 2,
      sort: 'realized_pnl_usd_desc',
      include_address_label: true,
    });
    expect(topTradersSortedResponse.json().data).toEqual([
      expect.objectContaining({
        id: '0xtrader000000000000000000000000000000000001',
        attributes: expect.objectContaining({
          realized_pnl_usd: '450000',
          address_label: 'Whale One',
        }),
      }),
      expect.objectContaining({
        id: '0xtrader000000000000000000000000000000000003',
        attributes: expect.objectContaining({
          realized_pnl_usd: '300000',
          address_label: 'Arb Bot',
        }),
      }),
    ]);

    expect(holdersChartResponse.statusCode).toBe(200);
    expect(holdersChartResponse.json().meta).toMatchObject({
      network: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      days: 30,
    });
    expect(holdersChartResponse.json().data.map((point: { attributes: { timestamp: number } }) => point.attributes.timestamp)).toEqual([
      1710028800,
      1710633600,
      1711238400,
      1711843200,
    ]);
    expect(holdersChartResponse.json().data.map((point: { attributes: { holder_count: number } }) => point.attributes.holder_count)).toEqual([
      181200,
      184500,
      188900,
      193400,
    ]);

    expect(holdersChartShortResponse.statusCode).toBe(200);
    expect(holdersChartShortResponse.json().meta).toMatchObject({
      days: 7,
    });
    expect(holdersChartShortResponse.json().data.map((point: { attributes: { timestamp: number } }) => point.attributes.timestamp)).toEqual([
      1711238400,
      1711843200,
    ]);
  });
  it('returns onchain categories and category pools with deterministic sorting, stable pagination, category scoping, and include handling', async () => {
    const categoriesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories?sort=h24_volume_usd_desc&page=1',
    });
    const categoriesPageTwoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories?sort=h24_volume_usd_desc&page=2',
    });
    const categoryPoolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/stablecoins/pools?sort=reserve_in_usd_desc&page=1',
    });
    const categoryPoolsIncludedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/stablecoins/pools?sort=reserve_in_usd_desc&page=1&include=network,dex',
    });

    expect(categoriesResponse.statusCode).toBe(200);
    expect(categoriesResponse.json()).toMatchObject({
      data: [
        expect.objectContaining({
          id: 'stablecoins',
          type: 'category',
          attributes: expect.objectContaining({
            name: 'Stablecoins',
          }),
        }),
      ],
      meta: expect.objectContaining({
        page: 1,
        per_page: 1,
        total_count: 2,
        total_pages: 2,
        sort: 'h24_volume_usd_desc',
      }),
    });
    expect(categoriesResponse.json().data).toHaveLength(1);
    expect(categoriesResponse.json().data.map((category: { id: string }) => category.id)).toEqual(['stablecoins']);

    expect(categoriesPageTwoResponse.statusCode).toBe(200);
    expect(categoriesPageTwoResponse.json()).toMatchObject({
      data: [
        expect.objectContaining({
          id: 'smart-contract-platform',
          type: 'category',
        }),
      ],
      meta: expect.objectContaining({
        page: 2,
        per_page: 1,
        total_count: 2,
        total_pages: 2,
        sort: 'h24_volume_usd_desc',
      }),
    });
    expect(categoriesPageTwoResponse.json().data).toHaveLength(1);
    expect(categoriesPageTwoResponse.json().data.map((category: { id: string }) => category.id)).toEqual(['smart-contract-platform']);
    expect(new Set([
      ...categoriesResponse.json().data.map((category: { id: string }) => category.id),
      ...categoriesPageTwoResponse.json().data.map((category: { id: string }) => category.id),
    ])).toEqual(new Set(['smart-contract-platform', 'stablecoins']));

    expect(categoryPoolsResponse.statusCode).toBe(200);
    expect(categoryPoolsResponse.json()).toMatchObject({
      meta: expect.objectContaining({
        page: 1,
        per_page: 100,
        total_count: 4,
        total_pages: 1,
        sort: 'reserve_in_usd_desc',
        category_id: 'stablecoins',
      }),
    });
    expect(categoryPoolsResponse.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    ]);
    expect(categoryPoolsResponse.json().data.every((pool: {
      attributes: { base_token_symbol: string; quote_token_symbol: string };
    }) => ['USDC', 'USDT'].includes(pool.attributes.base_token_symbol) || ['USDC', 'USDT'].includes(pool.attributes.quote_token_symbol))).toBe(true);

    expect(categoryPoolsIncludedResponse.statusCode).toBe(200);
    expect(categoryPoolsIncludedResponse.json()).toMatchObject({
      data: expect.any(Array),
      included: expect.arrayContaining([
        expect.objectContaining({ id: 'eth', type: 'network' }),
        expect.objectContaining({ id: 'solana', type: 'network' }),
        expect.objectContaining({ id: 'uniswap_v3', type: 'dex' }),
        expect.objectContaining({ id: 'curve', type: 'dex' }),
        expect.objectContaining({ id: 'raydium', type: 'dex' }),
      ]),
    });
    expect(categoryPoolsIncludedResponse.json().data).toHaveLength(4);
  });
  it('rejects invalid onchain category sort/include values explicitly and returns not found for unknown categories', async () => {
    const invalidCategorySortResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories?sort=unsupported',
    });
    const invalidCategoryPoolsSortResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/stablecoins/pools?sort=unsupported',
    });
    const invalidCategoryPoolsIncludeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/stablecoins/pools?include=token',
    });
    const unknownCategoryResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/categories/not-a-category/pools',
    });

    expect(invalidCategorySortResponse.statusCode).toBe(400);
    expect(invalidCategorySortResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported sort value: unsupported',
    });

    expect(invalidCategoryPoolsSortResponse.statusCode).toBe(400);
    expect(invalidCategoryPoolsSortResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported sort value: unsupported',
    });

    expect(invalidCategoryPoolsIncludeResponse.statusCode).toBe(400);
    expect(invalidCategoryPoolsIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: token',
    });

    expect(unknownCategoryResponse.statusCode).toBe(404);
    expect(unknownCategoryResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain category not found: not-a-category',
    });
  });
  it('validates malformed addresses and include flags for onchain simple token prices', async () => {
    const malformedAddressResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/not-an-address',
    });
    const invalidMarketCapFlagResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?include_market_cap=yes',
    });

    expect(malformedAddressResponse.statusCode).toBe(400);
    expect(malformedAddressResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid onchain address: not-an-address',
    });

    expect(invalidMarketCapFlagResponse.statusCode).toBe(400);
    expect(invalidMarketCapFlagResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid boolean query value: yes',
    });
  });
  it('returns metadata-focused onchain token info, pool info, and recently updated token info', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue({
      'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
        price: 1.0025,
        symbol: 'USDC',
        decimals: 6,
        confidence: 0.99,
        timestamp: 1710000000,
      },
      'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': {
        price: 3495.12,
        symbol: 'WETH',
        decimals: 18,
        confidence: 0.97,
        timestamp: 1710000000,
      },
    });

    const tokenInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
    });
    const poolInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/info',
    });
    const poolInfoIncludedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/info?include=pool',
    });
    const recentlyUpdatedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/tokens/info_recently_updated',
    });
    const recentlyUpdatedWithNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/tokens/info_recently_updated?include=network&network=eth',
    });

    expect(tokenInfoResponse.statusCode).toBe(200);
    expect(tokenInfoResponse.json()).toMatchObject({
      data: {
        id: 'eth_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token_info',
        attributes: {
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          name: 'USDC',
          symbol: 'USDC',
          coingecko_coin_id: 'usd-coin',
          decimals: 6,
          image_url: null,
          price_usd: 1.0025,
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

    expect(poolInfoResponse.statusCode).toBe(200);
    expect(poolInfoResponse.json().data).toHaveLength(2);
    expect(poolInfoResponse.json().data.map((entry: { id: string }) => entry.id)).toContain('eth_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(poolInfoResponse.json().data.map((entry: { id: string }) => entry.id)).toContain('eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(poolInfoResponse.json().data[0]).toMatchObject({
      type: 'token_info',
      attributes: {
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        symbol: 'USDC',
      },
    });
    expect(poolInfoResponse.json().data[1]).toMatchObject({
      type: 'token_info',
      attributes: {
        address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        symbol: 'WETH',
      },
    });

    expect(poolInfoIncludedResponse.statusCode).toBe(200);
    expect(poolInfoIncludedResponse.json()).toMatchObject({
      data: expect.any(Array),
      included: [
        expect.objectContaining({
          id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          type: 'pool',
        }),
      ],
    });

    expect(recentlyUpdatedResponse.statusCode).toBe(200);
    expect(recentlyUpdatedResponse.json().meta).toEqual({ page: 1 });
    expect(recentlyUpdatedResponse.json().data.length).toBeGreaterThanOrEqual(4);
    expect(recentlyUpdatedResponse.json().data[0]).toMatchObject({
      type: 'token_info',
      attributes: {
        symbol: 'USDC',
        price_usd: 1.0025,
      },
    });
    expect(recentlyUpdatedResponse.json().data.some((entry: { attributes: { symbol: string } }) => entry.attributes.symbol === 'USDC')).toBe(true);
    expect(recentlyUpdatedResponse.json().data[0].attributes.updated_at).toBeGreaterThanOrEqual(
      recentlyUpdatedResponse.json().data[1].attributes.updated_at,
    );

    expect(recentlyUpdatedWithNetworkResponse.statusCode).toBe(200);
    expect(recentlyUpdatedWithNetworkResponse.json()).toMatchObject({
      data: expect.any(Array),
      included: [
        {
          id: 'eth',
          type: 'network',
          attributes: expect.objectContaining({
            name: 'Ethereum',
          }),
        },
      ],
    });
    expect(recentlyUpdatedWithNetworkResponse.json().data.every((entry: { relationships: { network: { data: { id: string } } } }) =>
      entry.relationships.network.data.id === 'eth')).toBe(true);
  });
  it('proves token info falls back to seeded metadata pricing when defillama live pricing is unavailable', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: 'eth_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        type: 'token_info',
        attributes: {
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'USDC',
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
  });
  it('surfaces live pricing for a non-hardcoded ethereum token info route and keeps seeded fallback when live pricing is unavailable', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices')
      .mockResolvedValueOnce({
        'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7': {
          price: 1.0099,
          symbol: 'USDT',
          decimals: 6,
          confidence: 0.98,
          timestamp: 1710000000,
        },
      })
      .mockResolvedValueOnce(null);

    const liveResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xdac17f958d2ee523a2206206994597c13d831ec7/info',
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(liveResponse.json()).toMatchObject({
      data: {
        id: 'eth_0xdac17f958d2ee523a2206206994597c13d831ec7',
        type: 'token_info',
        attributes: {
          address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
          symbol: 'USDT',
          coingecko_coin_id: 'tether',
          price_usd: 1.0099,
        },
      },
    });

    const fallbackResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xdac17f958d2ee523a2206206994597c13d831ec7/info',
    });

    expect(fallbackResponse.statusCode).toBe(200);
    expect(fallbackResponse.json()).toMatchObject({
      data: {
        id: 'eth_0xdac17f958d2ee523a2206206994597c13d831ec7',
        type: 'token_info',
        attributes: {
          address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
          symbol: 'USDT',
          coingecko_coin_id: 'tether',
          price_usd: 1,
        },
      },
    });
  });
  it('validates onchain token info and recently updated token info parameters explicitly', async () => {
    const unknownTokenInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0x0000000000000000000000000000000000000001/info',
    });
    const invalidPoolInfoIncludeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/info?include=dex',
    });
    const invalidRecentlyUpdatedIncludeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/tokens/info_recently_updated?include=dex',
    });
    const invalidRecentlyUpdatedNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/tokens/info_recently_updated?network=not-a-network',
    });

    expect(unknownTokenInfoResponse.statusCode).toBe(404);
    expect(unknownTokenInfoResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain token not found: 0x0000000000000000000000000000000000000001',
    });

    expect(invalidPoolInfoIncludeResponse.statusCode).toBe(400);
    expect(invalidPoolInfoIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: dex',
    });

    expect(invalidRecentlyUpdatedIncludeResponse.statusCode).toBe(400);
    expect(invalidRecentlyUpdatedIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: dex',
    });

    expect(invalidRecentlyUpdatedNetworkResponse.statusCode).toBe(400);
    expect(invalidRecentlyUpdatedNetworkResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unknown onchain network: not-a-network',
    });
  });
});
