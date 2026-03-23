import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
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
    expect(chartResponse.json().prices[0]).toEqual([1774224000000, 85000]);

    expect(maxChartResponse.statusCode).toBe(200);
    expect(maxChartResponse.json().prices).toHaveLength(1);

    expect(rangeChartResponse.statusCode).toBe(200);
    expect(rangeChartResponse.json()).toMatchObject({
      prices: [],
    });

    expect(ohlcResponse.statusCode).toBe(200);
    expect(ohlcResponse.json()[0]).toEqual([1774224000000, 85000, 85000, 85000, 85000]);
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
});
