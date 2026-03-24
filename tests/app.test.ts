import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp, getDatabaseStartupLogContext } from '../src/app';
import contractFixtures from './fixtures/contract-fixtures.json';

vi.mock('../src/providers/ccxt', () => ({
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
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
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
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves the CoinGecko-compatible ping response', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/ping',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(contractFixtures.ping);
  });

  it('builds startup log context for the active sqlite runtime', () => {
    expect(getDatabaseStartupLogContext({ runtime: 'bun', url: '/tmp/opengecko.db' })).toEqual({
      runtime: 'bun',
      driver: 'bun:sqlite',
      databaseUrl: '/tmp/opengecko.db',
    });

    expect(getDatabaseStartupLogContext({ runtime: 'node', url: '/tmp/opengecko.db' })).toEqual({
      runtime: 'node',
      driver: 'better-sqlite3',
      databaseUrl: '/tmp/opengecko.db',
    });
  });

  it('returns chain coverage diagnostics', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/chain_coverage',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data.platform_counts.total');
    expect(body).toHaveProperty('data.contract_mapping.active_coins');
    expect(typeof body.data.platform_counts.total).toBe('number');
    expect(typeof body.data.contract_mapping.active_coins).toBe('number');
  });

  it('returns ohlcv worker lag and failure metrics', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/ohlcv_sync',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveProperty('top100.ready');
    expect(response.json().data).toHaveProperty('targets.waiting');
    expect(response.json().data).toHaveProperty('lag.oldest_recent_sync_ms');
  });

  it('returns supported quote currencies', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/supported_vs_currencies',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining(contractFixtures.supportedVsCurrencies));
    expect(response.json()).toContain('usdt');
  });

  it('returns exchange rates keyed by currency code', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchange_rates',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.exchangeRates);
    expect(response.json().data.usdt).toBeDefined();
    expect(response.json().data.usdt.type).toBe('fiat');
    expect(typeof response.json().data.usdt.value).toBe('number');
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
        eur: 73329.5,
        usd_24h_change: 1.8,
        eur_24h_change: 1.8,
      },
      ethereum: {
        usd: 2000,
        eur: 1725.4,
        usd_24h_change: 2.56,
        eur_24h_change: 2.56,
      },
    });
  });

  it('returns token prices by contract address', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it('returns seeded asset platforms', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/asset_platforms',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      ...contractFixtures.assetPlatforms,
      {
        id: 'solana',
        chain_identifier: 101,
        name: 'Solana',
        shortname: 'sol',
        native_coin_id: 'solana',
        image: null,
      },
    ]));
  });

  it('returns seeded exchanges and exchange detail data', async () => {
    const listResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/list',
    });
    const inactiveListResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/list?status=inactive',
    });
    const exchangesResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges?per_page=2&page=1',
    });
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance',
    });
    const volumeChartResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart?days=7',
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual(expect.arrayContaining([
      {
        id: 'binance',
        name: 'Binance',
      },
      {
        id: 'coinbase',
        name: 'Coinbase',
      },
      {
        id: 'kraken',
        name: 'Kraken',
      },
    ]));

    expect(inactiveListResponse.statusCode).toBe(200);
    expect(inactiveListResponse.json()).toEqual([]);

    expect(exchangesResponse.statusCode).toBe(200);
    expect(exchangesResponse.json()).toHaveLength(2);
    expect(exchangesResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'binance',
        name: 'Binance',
        year_established: null,
        country: null,
        trust_score_rank: null,
        trade_volume_24h_btc: expect.any(Number),
        trade_volume_24h_btc_normalized: null,
      }),
    ]));

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: 'binance',
      name: 'Binance',
      year_established: null,
      country: null,
      twitter_handle: null,
      tickers: expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          target: 'USDT',
        }),
        expect.objectContaining({
          coin_id: 'usd-coin',
          target: 'USDT',
        }),
      ]),
    });

    expect(volumeChartResponse.statusCode).toBe(200);
    const volumeChart = volumeChartResponse.json();
    expect(volumeChart.length).toBeGreaterThan(0);
    // Each entry is [timestamp, volumeBtc]
    for (const entry of volumeChart) {
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe('number');
      expect(typeof entry[1]).toBe('number');
    }
  });

  it('returns ranged exchange volume tuples in ascending chronological order with finite numerics', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart/range?from=0&to=4102444800',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBeGreaterThan(0);

    const timestamps = body.map((tuple: number[]) => tuple[0]);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));

    for (const tuple of body) {
      expect(tuple).toHaveLength(2);
      expect(typeof tuple[0]).toBe('number');
      expect(typeof tuple[1]).toBe('number');
      expect(Number.isFinite(tuple[1])).toBe(true);
    }
  });

  it('returns exchange tickers and supports coin filters', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?include_exchange_logo=true',
    });
    const filteredResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?coin_ids=ethereum&order=volume_asc',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('Binance');
    expect(response.json().tickers.length).toBeGreaterThanOrEqual(7);
    expect(response.json().tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: 'bitcoin',
        target: 'USDT',
      }),
      expect.objectContaining({
        coin_id: 'ethereum',
        target: 'USDT',
      }),
      expect.objectContaining({
        coin_id: 'usd-coin',
        target: 'USDT',
      }),
    ]));

    expect(filteredResponse.statusCode).toBe(200);
    expect(filteredResponse.json().tickers).toHaveLength(1);
    expect(filteredResponse.json().tickers[0]).toMatchObject({
      coin_id: 'ethereum',
      target: 'USDT',
    });
  });

  it('supports exchange ticker depth and dex pair formatting', async () => {
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance?dex_pair_format=contract_address',
    });
    const tickersResponse = await getApp().inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?coin_ids=usd-coin&depth=true&dex_pair_format=contract_address',
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().tickers.find((ticker: { coin_id: string }) => ticker.coin_id === 'usd-coin')).toMatchObject({
      base: 'USDC',
      coin_id: 'usd-coin',
    });

    expect(tickersResponse.statusCode).toBe(200);
    expect(tickersResponse.json().tickers[0]).toMatchObject({
      base: 'USDC',
      coin_id: 'usd-coin',
    });
  });

  it('returns derivatives exchange registry rows', async () => {
    const listResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/list',
    });
    const exchangesResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges?order=trade_volume_24h_btc_desc&per_page=1&page=1',
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual(contractFixtures.derivativesExchangesList);

    expect(exchangesResponse.statusCode).toBe(200);
    expect(exchangesResponse.json()).toHaveLength(1);
    expect(exchangesResponse.json()[0]).toMatchObject(contractFixtures.derivativesExchanges[0]);
  });

  it('returns derivatives exchange detail without tickers by default and includes tickers on request', async () => {
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/binance_futures',
    });
    const includeTickersResponse = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/binance_futures?include_tickers=true',
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: 'binance_futures',
      name: 'Binance Futures',
      open_interest_btc: 185000,
      trade_volume_24h_btc: 910000,
      number_of_perpetual_pairs: 412,
      number_of_futures_pairs: 38,
      year_established: 2019,
      country: 'Cayman Islands',
      description: "Binance Futures is Binance's derivatives venue for perpetual and dated futures markets.",
      url: 'https://www.binance.com/en/futures',
      image: 'https://assets.coingecko.com/markets/images/52/small/binance.jpg',
      centralized: true,
    });
    expect(detailResponse.json()).not.toHaveProperty('tickers');

    expect(includeTickersResponse.statusCode).toBe(200);
    expect(includeTickersResponse.json()).toMatchObject({
      id: 'binance_futures',
      name: 'Binance Futures',
    });
    expect(includeTickersResponse.json()).toHaveProperty('tickers');
    expect(includeTickersResponse.json().tickers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        market: 'Binance Futures',
        market_id: 'binance_futures',
        symbol: 'BTCUSDT',
        index_id: 'bitcoin',
        contract_type: 'perpetual',
      }),
    ]));
  });

  it('returns derivatives tickers', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.derivatives);
  });

  it('returns treasury entities and grouped public treasury rows', async () => {
    const entitiesResponse = await getApp().inject({
      method: 'GET',
      url: '/entities/list?entity_type=companies&page=1&per_page=10',
    });
    const groupedResponse = await getApp().inject({
      method: 'GET',
      url: '/companies/public_treasury/bitcoin?order=value_desc',
    });
    const detailResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy',
    });

    expect(entitiesResponse.statusCode).toBe(200);
    expect(entitiesResponse.json()).toMatchObject([contractFixtures.treasuryEntities[1]]);

    expect(groupedResponse.statusCode).toBe(200);
    expect(groupedResponse.json()).toMatchObject(contractFixtures.companyTreasuryBitcoin);

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject(contractFixtures.treasuryEntityDetail);
  });

  it('returns treasury holding charts and transaction history', async () => {
    const chartResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/bitcoin/holding_chart?days=7',
    });
    const chartWithIntervalsResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/bitcoin/holding_chart?days=7&include_empty_intervals=true',
    });
    const transactionsResponse = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/transaction_history?order=date_desc',
    });

    expect(chartResponse.statusCode).toBe(200);
    expect(chartResponse.json()).toEqual(contractFixtures.treasuryHoldingChart);

    expect(chartWithIntervalsResponse.statusCode).toBe(200);
    expect(chartWithIntervalsResponse.json()).toEqual(contractFixtures.treasuryHoldingChartWithIntervals);

    expect(transactionsResponse.statusCode).toBe(200);
    expect(transactionsResponse.json()).toEqual(contractFixtures.treasuryTransactionHistory);
  });

  it('returns onchain networks and network dexes', async () => {
    const networksResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks?page=1',
    });
    const dexesResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes?page=1',
    });

    expect(networksResponse.statusCode).toBe(200);
    expect(networksResponse.json()).toMatchObject(contractFixtures.onchainNetworks);

    expect(dexesResponse.statusCode).toBe(200);
    expect(dexesResponse.json()).toMatchObject(contractFixtures.onchainDexesEth);
  });

  it('returns onchain networks with pagination metadata and asset-platform continuity', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('meta.page', 1);
    expect(body).toHaveProperty('meta.per_page', 100);
    expect(body).toHaveProperty('meta.total_pages', 1);
    expect(body).toHaveProperty('meta.total_count', 2);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'eth',
          type: 'network',
          attributes: expect.objectContaining({
            coingecko_asset_platform_id: 'ethereum',
          }),
        }),
        expect.objectContaining({
          id: 'solana',
          type: 'network',
          attributes: expect.objectContaining({
            coingecko_asset_platform_id: 'solana',
          }),
        }),
      ]),
    );
  });

  it('returns later onchain network pages with the same collection shape', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks?page=2',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [],
      meta: {
        page: 2,
        per_page: 100,
        total_pages: 1,
        total_count: 2,
      },
    });
  });

  it('returns network-scoped dexes with relationship continuity', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      meta: {
        page: 1,
        per_page: 100,
        total_pages: 1,
        total_count: 2,
        network: 'eth',
      },
    });
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'curve',
          type: 'dex',
          relationships: {
            network: {
              data: {
                type: 'network',
                id: 'eth',
              },
            },
          },
        }),
        expect.objectContaining({
          id: 'uniswap_v3',
          type: 'dex',
          relationships: {
            network: {
              data: {
                type: 'network',
                id: 'eth',
              },
            },
          },
        }),
      ]),
    );
    expect(body.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'raydium',
        }),
      ]),
    );
  });

  it('returns onchain network pools and pool detail', async () => {
    const poolsResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });
    const poolDetailResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    });

    expect(poolsResponse.statusCode).toBe(200);
    expect(poolsResponse.json()).toMatchObject(contractFixtures.onchainPoolsEth);

    expect(poolDetailResponse.statusCode).toBe(200);
    expect(poolDetailResponse.json()).toMatchObject(contractFixtures.onchainPoolEthDetail);
  });

  it('keeps onchain pool detail scoped to the requested network and supports explicit includes/toggles', async () => {
    const includedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b?include=network,dex&include_volume_breakdown=true&include_composition=true',
    });
    const wrongNetworkResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/solana/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    });

    expect(includedResponse.statusCode).toBe(200);
    expect(includedResponse.json()).toMatchObject({
      data: {
        id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
        relationships: {
          network: { data: { id: 'eth', type: 'network' } },
          dex: { data: { id: 'uniswap_v3', type: 'dex' } },
        },
        attributes: {
          volume_usd: {
            h24: 64500000,
            h24_buy_usd: 32250000,
            h24_sell_usd: 32250000,
          },
          composition: {
            base_token: {
              address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              symbol: 'USDC',
            },
            quote_token: {
              address: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
              symbol: 'WETH',
            },
          },
        },
      },
      included: expect.arrayContaining([
        expect.objectContaining({ id: 'eth', type: 'network' }),
        expect.objectContaining({ id: 'uniswap_v3', type: 'dex' }),
      ]),
    });

    expect(wrongNetworkResponse.statusCode).toBe(404);
    expect(wrongNetworkResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain pool not found: 0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    });
  });

  it('returns onchain pools scoped by dex', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes/uniswap_v3/pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty('relationships.dex.data.id', 'uniswap_v3');
  });

  it('keeps dex-scoped pools aligned to the requested dex and network', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes/uniswap_v3/pools?page=1&sort=reserve_in_usd_desc',
    });
    const mismatchedDexResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes/raydium/pools',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({ id: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36' }),
      expect.objectContaining({ id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b' }),
    ]);
    expect(response.json().data).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7' })]),
    );

    expect(mismatchedDexResponse.statusCode).toBe(404);
    expect(mismatchedDexResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain dex not found: raydium',
    });
  });

  it('returns newest onchain pools for a network', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/new_pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty('type', 'pool');
  });

  it('orders network new pools by recency while preserving pool/dex continuity', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/new_pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((pool: { id: string }) => pool.id)).toEqual([
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ]);
    expect(response.json().data[0]).toMatchObject({
      relationships: {
        network: { data: { id: 'eth', type: 'network' } },
        dex: { data: { id: 'uniswap_v3', type: 'dex' } },
      },
    });
  });

  it('returns onchain pools by multi-address lookup', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/multi/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b,0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toHaveProperty('type', 'pool');
  });

  it('returns deterministic pool-multi results for requested addresses only with deduplicated includes', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/multi/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b,0x4e68ccd3e89f51c3074ca5072bbac773960dfa36?include=network,dex',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        expect.objectContaining({ id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b' }),
        expect.objectContaining({ id: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36' }),
      ],
      included: expect.arrayContaining([
        expect.objectContaining({ id: 'eth', type: 'network' }),
        expect.objectContaining({ id: 'uniswap_v3', type: 'dex' }),
      ]),
    });
    expect(response.json().data).toHaveLength(2);
    expect(response.json().included).toHaveLength(2);
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
    expect(tokenDetailIncludedResponse.json()).toMatchObject({
      data: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        attributes: {
          top_pools: [
            '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
            '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
          ],
          inactive_source: false,
          composition: {
            pools: expect.arrayContaining([
              expect.objectContaining({
                pool_address: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
          id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
    ]);
    expect(tokenPoolsResponse.json().data.every((pool: { attributes: { base_token_address: string; quote_token_address: string } }) =>
      pool.attributes.base_token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      || pool.attributes.quote_token_address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true);
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
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1',
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
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1',
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
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '1',
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
    const tokenInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
    });
    const poolInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/info',
    });
    const poolInfoIncludedResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/info?include=pool',
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
    expect(poolInfoResponse.json().data.map((entry: { id: string }) => entry.id)).toContain('eth_0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2');
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
        address: '0xc02aa39b223fe8d0a0e5c4f27ead9083c756cc2',
        symbol: 'WETH',
      },
    });

    expect(poolInfoIncludedResponse.statusCode).toBe(200);
    expect(poolInfoIncludedResponse.json()).toMatchObject({
      data: expect.any(Array),
      included: [
        expect.objectContaining({
          id: '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
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

  it('validates onchain token info and recently updated token info parameters explicitly', async () => {
    const unknownTokenInfoResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0x0000000000000000000000000000000000000001/info',
    });
    const invalidPoolInfoIncludeResponse = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b/info?include=dex',
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

  it('returns token list data for an asset platform', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/token_lists/ethereum/all.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'OpenGecko Ethereum Token List',
      tokens: [],
    });
  });

  it('returns seeded coins with optional platform data', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/list?include_platform=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(8);
    expect(response.json()).toEqual(expect.arrayContaining([
      {
        id: 'bitcoin',
        name: 'Bitcoin',
        platforms: {},
        symbol: 'btc',
      },
      {
        id: 'ethereum',
        name: 'Ethereum',
        platforms: {},
        symbol: 'eth',
      },
      {
        id: 'usd-coin',
        name: 'USD Coin',
        platforms: {},
        symbol: 'usdc',
      },
      {
        id: 'chainlink',
        name: 'Chainlink',
        platforms: {},
        symbol: 'link',
      },
    ]));
  });

  it('returns market search results', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search?query=eth',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.searchEth);
  });

  it('returns FTS-backed category search results', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search?query=stable',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(contractFixtures.searchStable);
  });

  it('returns grouped trending search results with nested coin items', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('coins');
    expect(body).toHaveProperty('nfts');
    expect(body).toHaveProperty('categories');
    expect(Array.isArray(body.coins)).toBe(true);
    expect(Array.isArray(body.nfts)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
    expect(body.coins[0].item.id).toBe('bitcoin');
    expect(typeof body.coins[0].item.coin_id).toBe('number');
    expect(body.coins[0].item.name).toBe('Bitcoin');
    expect(body.coins[0].item.symbol).toBe('btc');
    expect(typeof body.coins[0].item.market_cap_rank === 'number' || body.coins[0].item.market_cap_rank === null).toBe(true);
    expect(body.coins.map((entry: { item: { id: string } }) => entry.item.id)).toContain('ethereum');
    expect(body.nfts).toEqual([]);
    expect(body.categories[0]).toMatchObject(contractFixtures.searchTrending.categories[0]);
    expect(body.categories[1]).toMatchObject(contractFixtures.searchTrending.categories[1]);
    expect(body.coins[0]).toHaveProperty('item');
    expect(Array.isArray(body.nfts)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
  });

  it('supports deterministic show_max truncation for trending search groups', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.coins).toHaveLength(1);
    expect(body.categories).toHaveLength(1);
    expect(body.nfts).toEqual([]);
    expect(body.coins[0].item.id).toBe('bitcoin');
    expect(body.categories[0].name).toBe('Smart Contract Platform');
  });

  it('keeps empty trending groups as arrays when show_max is zero', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/search/trending?show_max=0',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      coins: [],
      nfts: [],
      categories: [],
    });
  });

  it('returns global market aggregates', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        active_cryptocurrencies: 8,
        markets: 4,
        total_market_cap: {
          usd: 0,
        },
        total_volume: expect.objectContaining({
          usd: expect.any(Number),
        }),
      },
    });
  });

  it('returns global defi aggregates in a data envelope with stable finite-or-null fields', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global/decentralized_finance_defi',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(typeof body.data.defi_market_cap).toBe('number');
    expect(typeof body.data.eth_market_cap).toBe('number');
    expect(typeof body.data.trading_volume_24h).toBe('number');
    expect(body.data.top_coin_name === null || typeof body.data.top_coin_name === 'string').toBe(true);
    expect(body.data.defi_to_eth_ratio === null || typeof body.data.defi_to_eth_ratio === 'number').toBe(true);
    expect(body.data.defi_dominance === null || typeof body.data.defi_dominance === 'number').toBe(true);
    expect(body.data.top_coin_defi_dominance === null || typeof body.data.top_coin_defi_dominance === 'number').toBe(true);

    for (const [key, value] of Object.entries(body.data)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value)).toBe(true);
      } else {
        expect(value === null || typeof value === 'string').toBe(true);
      }

      expect(key).not.toBe('');
    }
  });

  it('returns a named global market cap chart series payload for the requested window', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/global/market_cap_chart?vs_currency=usd&days=7',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      market_cap_chart: expect.any(Array),
    });
    expect(body.market_cap_chart.length).toBeGreaterThan(0);
    expect(body.market_cap_chart[0]).toHaveLength(2);
    expect(typeof body.market_cap_chart[0][0]).toBe('number');
    expect(typeof body.market_cap_chart[0][1]).toBe('number');
    expect(body.market_cap_chart.at(-1)[0]).toBeGreaterThanOrEqual(body.market_cap_chart[0][0]);
  });

  it('validates missing required params for global market cap chart', async () => {
    const missingVsCurrencyResponse = await getApp().inject({
      method: 'GET',
      url: '/global/market_cap_chart?days=7',
    });
    const missingDaysResponse = await getApp().inject({
      method: 'GET',
      url: '/global/market_cap_chart?vs_currency=usd',
    });

    expect(missingVsCurrencyResponse.statusCode).toBe(400);
    expect(missingVsCurrencyResponse.json()).toMatchObject({
      error: 'invalid_request',
    });

    expect(missingDaysResponse.statusCode).toBe(400);
    expect(missingDaysResponse.json()).toMatchObject({
      error: 'invalid_request',
    });
  });

  it('returns coin market rows', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&sparkline=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({
      id: 'bitcoin',
      current_price: 85000,
      sparkline_in_7d: {
        price: [85000],
      },
    });
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

  it('returns dual top movers payloads with stable polarity and explicit arrays', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('top_gainers');
    expect(body).toHaveProperty('top_losers');
    expect(Array.isArray(body.top_gainers)).toBe(true);
    expect(Array.isArray(body.top_losers)).toBe(true);
    expect(body.top_gainers.length).toBeGreaterThan(0);
    expect(body.top_losers).toEqual([]);
    expect(body.top_gainers[0].id).toBe('dogecoin');
    expect(body.top_gainers[0].symbol).toBe('doge');
    expect(body.top_gainers[0].name).toBe('Dogecoin');
    expect(body.top_gainers[0].current_price).toBe(0.28);
    expect(body.top_gainers[0].price_change_percentage_24h).toBe(5);
    expect(body.top_gainers[0].market_cap_rank === null || typeof body.top_gainers[0].market_cap_rank === 'number').toBe(true);
    expect(body.top_gainers.map((row: { price_change_percentage_24h: number | null }) => row.price_change_percentage_24h)).toEqual([5, 4, 3.5, 3, 2.56, 2, 1.8, 0.01]);
  });

  it('supports mover duration and validates invalid mover params explicitly', async () => {
    const validResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&duration=24h&top_coins=300&price_change_percentage=24h',
    });
    const invalidDurationResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&duration=2h',
    });
    const invalidTopCoinsResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/top_gainers_losers?vs_currency=usd&top_coins=2',
    });

    expect(validResponse.statusCode).toBe(200);
    expect(validResponse.json().top_gainers.length).toBeLessThanOrEqual(30);
    expect(validResponse.json().top_losers).toEqual([]);

    expect(invalidDurationResponse.statusCode).toBe(400);
    expect(invalidDurationResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });

    expect(invalidTopCoinsResponse.statusCode).toBe(400);
    expect(invalidTopCoinsResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });
  });

  it('returns new listings in an object envelope ordered newest first with listing timestamps', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/list/new',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('coins');
    expect(Array.isArray(body.coins)).toBe(true);
    expect(body.coins.length).toBe(8);
    expect(body.coins[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      symbol: expect.any(String),
      name: expect.any(String),
    }));
    const activated = body.coins.map((row: { activated_at: number }) => row.activated_at);
    expect(activated.every((value: number | null) => value === null || Number.isFinite(value))).toBe(true);
    expect(activated).toEqual([...activated].sort((left, right) => right - left));
  });

  it('supports coin market ordering and pagination defaults', async () => {
    const orderResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_asc',
    });
    const paginationResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&per_page=1&page=2',
    });

    expect(orderResponse.statusCode).toBe(200);
    expect(orderResponse.json()[0]).toMatchObject({
      id: 'bitcoin',
    });

    expect(paginationResponse.statusCode).toBe(200);
    expect(paginationResponse.json()).toHaveLength(1);
    expect(paginationResponse.json()[0]).toMatchObject({
      id: 'cardano',
    });
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
          usd: 2000,
        },
        low_24h: {
          usd: 2000,
        },
        sparkline_7d: {
          price: [2000],
        },
      },
    });
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
        last: 85000,
        market: expect.objectContaining({
          name: 'Coinbase',
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

  it('returns coin history, chart, and ohlc data', async () => {
    const historyResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/history?date=20-03-2026',
    });
    const chartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily',
    });
    const maxChartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart?vs_currency=usd&days=max',
    });
    const rangeChartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800',
    });
    const ohlcResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc?vs_currency=usd&days=7&interval=daily',
    });

    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json()).toMatchObject({
      id: 'bitcoin',
      description: {
        en: 'Bitcoin imported from binance market discovery.',
      },
      market_data: null,
    });

    expect(chartResponse.statusCode).toBe(200);
    expect(chartResponse.json().prices).toHaveLength(1);
    expect(chartResponse.json().prices[0]).toEqual([1774310400000, 85000]);

    expect(maxChartResponse.statusCode).toBe(200);
    expect(maxChartResponse.json().prices).toHaveLength(1);

    expect(rangeChartResponse.statusCode).toBe(200);
    expect(rangeChartResponse.json()).toMatchObject({
      prices: [],
    });

    expect(ohlcResponse.statusCode).toBe(200);
    expect(ohlcResponse.json()).toHaveLength(1);
    expect(ohlcResponse.json()[0]).toEqual([1774310400000, 85000, 85000, 85000, 85000]);
  });

  it('returns ranged coin ohlc tuples in ascending chronological order', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1774310400&to=1774310400&interval=daily',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual([
      [1774310400000, 85000, 85000, 85000, 85000],
    ]);

    for (const tuple of body) {
      expect(tuple).toHaveLength(5);
      expect(typeof tuple[0]).toBe('number');
      expect(tuple.slice(1).every((value: unknown) => typeof value === 'number' && Number.isFinite(value))).toBe(true);
    }
  });

  it('supports ranged coin ohlc interval semantics with explicit daily and empty hourly responses', async () => {
    const dailyResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1774310400&to=1774310400&interval=daily',
    });
    const hourlyResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1774310400&to=1774314000&interval=hourly',
    });

    expect(dailyResponse.statusCode).toBe(200);
    expect(hourlyResponse.statusCode).toBe(200);

    const dailyBody = dailyResponse.json();
    const hourlyBody = hourlyResponse.json();

    expect(dailyBody.length).toBeGreaterThan(0);
    expect(hourlyBody).toEqual([]);

    for (const body of [dailyBody, hourlyBody]) {
      for (const tuple of body) {
        expect(tuple).toHaveLength(5);
        expect(typeof tuple[0]).toBe('number');
        expect(tuple.slice(1).every((value: unknown) => typeof value === 'number' && Number.isFinite(value))).toBe(true);
      }

      const timestamps = body.map((tuple: number[]) => tuple[0]);
      expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));
    }
  });

  it('returns named circulating and total supply chart series for rolling windows', async () => {
    const circulatingResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/circulating_supply_chart?days=30',
    });
    const totalResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/bitcoin/total_supply_chart?days=30',
    });

    expect(circulatingResponse.statusCode).toBe(200);
    expect(totalResponse.statusCode).toBe(200);

    const circulatingBody = circulatingResponse.json();
    const totalBody = totalResponse.json();

    expect(circulatingBody).toEqual({
      circulating_supply: expect.any(Array),
    });
    expect(totalBody).toEqual({
      total_supply: expect.any(Array),
    });

    for (const [seriesKey, body] of [
      ['circulating_supply', circulatingBody] as const,
      ['total_supply', totalBody] as const,
    ]) {
      expect(body[seriesKey].length).toBeGreaterThan(0);
      const timestamps = body[seriesKey].map((sample: number[]) => sample[0]);
      expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));

      for (const sample of body[seriesKey]) {
        expect(sample).toHaveLength(2);
        expect(typeof sample[0]).toBe('number');
        expect(typeof sample[1]).toBe('number');
        expect(Number.isFinite(sample[1])).toBe(true);
      }
    }
  });

  it('returns named supply chart series constrained to explicit ranges', async () => {
    const from = 1773792000;
    const to = 1774310400;
    const circulatingResponse = await getApp().inject({
      method: 'GET',
      url: `/coins/bitcoin/circulating_supply_chart/range?from=${from}&to=${to}`,
    });
    const totalResponse = await getApp().inject({
      method: 'GET',
      url: `/coins/bitcoin/total_supply_chart/range?from=${from}&to=${to}`,
    });

    expect(circulatingResponse.statusCode).toBe(200);
    expect(totalResponse.statusCode).toBe(200);

    for (const [seriesKey, body] of [
      ['circulating_supply', circulatingResponse.json()] as const,
      ['total_supply', totalResponse.json()] as const,
    ]) {
      expect(body).toHaveProperty(seriesKey);
      expect(body[seriesKey].length).toBeGreaterThan(0);
      const timestamps = body[seriesKey].map((sample: number[]) => sample[0]);
      expect(timestamps[0]).toBeGreaterThanOrEqual(from * 1000);
      expect(timestamps.at(-1)).toBeLessThanOrEqual(to * 1000);
      expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));
    }
  });

  it('returns categories and contract-address variants', async () => {
    const categoriesListResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/categories/list',
    });
    const categoriesResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/categories?order=name_desc',
    });
    const contractResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const contractChartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart?vs_currency=usd&days=7&interval=daily',
    });
    const contractRangeResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800&interval=weekly',
    });

    expect(categoriesListResponse.statusCode).toBe(200);
    expect(categoriesListResponse.json()).toMatchObject(contractFixtures.categoriesList);

    expect(categoriesResponse.statusCode).toBe(200);
    expect(categoriesResponse.json()[0]).toMatchObject({
      id: 'stablecoins',
    });

    expect(contractResponse.statusCode).toBe(404);

    expect(contractChartResponse.statusCode).toBe(404);

    expect(contractRangeResponse.statusCode).toBe(404);
  });

  it('returns not found for unknown chart-style coin routes', async () => {
    const chartResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/not-a-coin/market_chart?vs_currency=usd&days=7',
    });
    const ohlcResponse = await getApp().inject({
      method: 'GET',
      url: '/coins/not-a-coin/ohlc?vs_currency=usd&days=7',
    });

    expect(chartResponse.statusCode).toBe(404);
    expect(chartResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });

    expect(ohlcResponse.statusCode).toBe(404);
    expect(ohlcResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });
  });

  it('returns not found for unknown ranged ohlc coin routes', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/coins/not-a-coin/ohlc/range?vs_currency=usd&from=1773792000&to=1774310400',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });
  });
});
