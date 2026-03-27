import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeMarkets, fetchExchangeTickers, fetchExchangeOHLCV } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeTickers = fetchExchangeTickers as ReturnType<typeof vi.fn>;
const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;

describe('CoinGecko API compatibility', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(async () => {
    mockedFetchExchangeMarkets.mockReset();
    mockedFetchExchangeTickers.mockReset();
    mockedFetchExchangeOHLCV.mockReset();

    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
        { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
        { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', active: true, spot: true, baseName: 'Ripple', raw: {} },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
      return [];
    });

    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
        { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp: Date.now(), raw: {} as never },
        { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', last: 2.5, bid: 2.49, ask: 2.51, high: 2.55, low: 2.45, baseVolume: 1000000, quoteVolume: 2500000, percentage: 3.0, timestamp: Date.now(), raw: {} as never },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', last: 85100, bid: 85050, ask: 85150, high: 86100, low: 84100, baseVolume: 3000, quoteVolume: 255300000, percentage: 1.7, timestamp: Date.now(), raw: {} as never },
      ];
      return [];
    });

    mockedFetchExchangeOHLCV.mockResolvedValue([]);

    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-compare-'));
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
        marketFreshnessThresholdSeconds: 300,
      },
      startBackgroundJobs: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ========================================
  // /ping
  // ========================================
  describe('GET /ping', () => {
    it('matches CoinGecko ping response format', async () => {
      const response = await app.inject({ method: 'GET', url: '/ping' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // CoinGecko returns { gecko_says: "(V3) To the Moon!" }
      expect(body).toHaveProperty('gecko_says');
      expect(typeof body.gecko_says).toBe('string');
    });
  });

  // ========================================
  // /simple/supported_vs_currencies
  // ========================================
  describe('GET /simple/supported_vs_currencies', () => {
    it('returns array of currency strings', async () => {
      const response = await app.inject({ method: 'GET', url: '/simple/supported_vs_currencies' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      expect(body).toContain('usd');
    });
  });

  // ========================================
  // /exchange_rates
  // ========================================
  describe('GET /exchange_rates', () => {
    it('matches CoinGecko exchange_rates format', async () => {
      const response = await app.inject({ method: 'GET', url: '/exchange_rates' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // CoinGecko: { data: { btc: { name, type, unit, value }, ... } }
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('btc');
      expect(body.data.btc).toHaveProperty('name');
      expect(body.data.btc).toHaveProperty('type');
      expect(body.data.btc).toHaveProperty('unit');
      expect(body.data.btc).toHaveProperty('value');
    });
  });

  // ========================================
  // /simple/price
  // ========================================
  describe('GET /simple/price', () => {
    it('matches CoinGecko simple/price format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // CoinGecko format: { bitcoin: { usd: number, usd_market_cap: number, ... }, ethereum: ... }
      expect(body).toHaveProperty('bitcoin');
      expect(body).toHaveProperty('ethereum');

      for (const coin of ['bitcoin', 'ethereum']) {
        expect(body[coin]).toHaveProperty('usd');
        expect(body[coin]).toHaveProperty('eur');
        expect(body[coin]).toHaveProperty('usd_market_cap');
        expect(body[coin]).toHaveProperty('eur_market_cap');
        expect(body[coin]).toHaveProperty('usd_24h_vol');
        expect(body[coin]).toHaveProperty('eur_24h_vol');
        expect(body[coin]).toHaveProperty('usd_24h_change');
        expect(body[coin]).toHaveProperty('eur_24h_change');
        expect(body[coin]).toHaveProperty('last_updated_at');
        expect(typeof body[coin].usd).toBe('number');
        // market_cap may be null if not computed from mock data
        if (body[coin].usd_market_cap !== null) {
          expect(typeof body[coin].usd_market_cap).toBe('number');
        }
      }
    });

    it('returns 400 when no ids provided', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/simple/price?vs_currencies=usd',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ========================================
  // /simple/token_price/:id
  // ========================================
  describe('GET /simple/token_price/:id', () => {
    it('requires contract_addresses and vs_currencies', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
      });
      expect(response.statusCode).toBe(200);
      // Returns empty object when no match (CoinGecko compatible)
      expect(typeof response.json()).toBe('object');
    });
  });

  // ========================================
  // /coins/list
  // ========================================
  describe('GET /coins/list', () => {
    it('matches CoinGecko coins/list format', async () => {
      const response = await app.inject({ method: 'GET', url: '/coins/list' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

      // CoinGecko: [{ id, symbol, name }]
      const coin = body[0];
      expect(coin).toHaveProperty('id');
      expect(coin).toHaveProperty('symbol');
      expect(coin).toHaveProperty('name');
      expect(typeof coin.id).toBe('string');
      expect(typeof coin.symbol).toBe('string');
      expect(typeof coin.name).toBe('string');
    });

    it('supports include_platform parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/list?include_platform=true',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body[0]).toHaveProperty('platforms');
    });
  });

  // ========================================
  // /coins/markets
  // ========================================
  describe('GET /coins/markets', () => {
    it('matches CoinGecko coins/markets format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

      // CoinGecko coins/markets fields
      const coin = body[0];
      const requiredFields = [
        'id', 'symbol', 'name', 'image', 'current_price',
        'market_cap', 'market_cap_rank', 'fully_diluted_valuation',
        'total_volume', 'high_24h', 'low_24h',
        'price_change_24h', 'price_change_percentage_24h',
        'market_cap_change_24h', 'market_cap_change_percentage_24h',
        'circulating_supply', 'total_supply', 'max_supply',
        'ath', 'ath_change_percentage', 'ath_date',
        'atl', 'atl_change_percentage', 'atl_date',
        'roi', 'last_updated',
      ];

      for (const field of requiredFields) {
        expect(coin).toHaveProperty(field);
      }
    });

    it('supports sparkline parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&sparkline=true',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body[0].sparkline_in_7d).toHaveProperty('price');
      expect(Array.isArray(body[0].sparkline_in_7d.price)).toBe(true);
    });

    it('supports pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&per_page=2&page=1',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.length).toBeLessThanOrEqual(2);
    });

    it('supports price_change_percentage parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&price_change_percentage=24h,7d',
      });
      expect(response.statusCode).toBe(200);
    });
  });

  // ========================================
  // /coins/:id
  // ========================================
  describe('GET /coins/:id', () => {
    it('matches CoinGecko coin detail format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Core fields from CoinGecko
      const requiredFields = [
        'id', 'symbol', 'name', 'web_slug', 'asset_platform_id',
        'platforms', 'detail_platforms', 'block_time_in_minutes',
        'hashing_algorithm', 'categories', 'description',
        'links', 'image', 'country_origin', 'genesis_date',
        'sentiment_votes_up_percentage', 'sentiment_votes_down_percentage',
        'market_cap_rank', 'coingecko_rank', 'coingecko_score',
        'developer_score', 'community_score', 'liquidity_score',
        'public_interest_score', 'watchlist_portfolio_users',
        'public_interest_stats', 'market_data', 'community_data',
        'developer_data', 'status_updates', 'last_updated',
        'tickers',
      ];

      for (const field of requiredFields) {
        expect(body).toHaveProperty(field);
      }

      // Image sub-fields
      expect(body.image).toHaveProperty('thumb');
      expect(body.image).toHaveProperty('small');
      expect(body.image).toHaveProperty('large');

      // Links sub-fields
      expect(body.links).toBeDefined();
    });

    it('returns 404 for unknown coin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/not-a-real-coin',
      });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body).toHaveProperty('error');
    });
  });

  // ========================================
  // /coins/:id/history
  // ========================================
  describe('GET /coins/:id/history', () => {
    it('matches CoinGecko history format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/history?date=20-03-2026&localization=false',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('symbol');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('market_data');
    });
  });

  // ========================================
  // /coins/:id/tickers
  // ========================================
  describe('GET /coins/:id/tickers', () => {
    it('matches CoinGecko tickers format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/tickers',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('tickers');
      expect(Array.isArray(body.tickers)).toBe(true);

      if (body.tickers.length > 0) {
        const ticker = body.tickers[0];
        expect(ticker).toHaveProperty('base');
        expect(ticker).toHaveProperty('target');
        expect(ticker).toHaveProperty('market');
        expect(ticker).toHaveProperty('last');
        expect(ticker).toHaveProperty('volume');
        expect(ticker).toHaveProperty('converted_last');
        expect(ticker).toHaveProperty('converted_volume');
        expect(ticker).toHaveProperty('trust_score');
        expect(ticker).toHaveProperty('bid_ask_spread_percentage');
        expect(ticker).toHaveProperty('timestamp');
        expect(ticker).toHaveProperty('last_traded_at');
        expect(ticker).toHaveProperty('last_fetch_at');
        expect(ticker).toHaveProperty('is_anomaly');
        expect(ticker).toHaveProperty('is_stale');
        expect(ticker).toHaveProperty('trade_url');
        expect(ticker).toHaveProperty('token_info_url');
        expect(ticker).toHaveProperty('coin_id');
        expect(ticker).toHaveProperty('target_coin_id');

        // Market sub-fields
        expect(ticker.market).toHaveProperty('name');
        expect(ticker.market).toHaveProperty('identifier');
        expect(ticker.market).toHaveProperty('has_trading_incentive');
      }
    });

    it('supports include_exchange_logo parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/tickers?include_exchange_logo=true',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      if (body.tickers.length > 0) {
        expect(body.tickers[0].market).toHaveProperty('logo');
      }
    });
  });

  // ========================================
  // /coins/:id/market_chart
  // ========================================
  describe('GET /coins/:id/market_chart', () => {
    it('matches CoinGecko market_chart format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // CoinGecko: { prices: [[ts, price], ...], market_caps: [[ts, cap], ...], total_volumes: [[ts, vol], ...] }
      expect(body).toHaveProperty('prices');
      expect(body).toHaveProperty('market_caps');
      expect(body).toHaveProperty('total_volumes');
      expect(Array.isArray(body.prices)).toBe(true);
      expect(Array.isArray(body.market_caps)).toBe(true);
      expect(Array.isArray(body.total_volumes)).toBe(true);

      // Each entry is [timestamp, value]
      for (const entry of body.prices) {
        expect(entry).toHaveLength(2);
        expect(typeof entry[0]).toBe('number'); // timestamp
        expect(typeof entry[1]).toBe('number'); // price
      }
    });

    it('supports daily interval', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart?vs_currency=usd&days=30&interval=daily',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('prices');
    });
  });

  // ========================================
  // /coins/:id/market_chart/range
  // ========================================
  describe('GET /coins/:id/market_chart/range', () => {
    it('matches CoinGecko market_chart/range format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('prices');
      expect(body).toHaveProperty('market_caps');
      expect(body).toHaveProperty('total_volumes');
    });
  });

  // ========================================
  // /coins/:id/ohlc
  // ========================================
  describe('GET /coins/:id/ohlc', () => {
    it('matches CoinGecko OHLC format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/ohlc?vs_currency=usd&days=7',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      // Each entry is [timestamp, open, high, low, close]
      if (body.length > 0) {
        expect(body[0]).toHaveLength(5);
        expect(typeof body[0][0]).toBe('number'); // timestamp
        expect(typeof body[0][1]).toBe('number'); // open
        expect(typeof body[0][2]).toBe('number'); // high
        expect(typeof body[0][3]).toBe('number'); // low
        expect(typeof body[0][4]).toBe('number'); // close
      }
    });
  });

  // ========================================
  // /coins/categories/list
  // ========================================
  describe('GET /coins/categories/list', () => {
    it('matches CoinGecko categories list format', async () => {
      const response = await app.inject({ method: 'GET', url: '/coins/categories/list' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      if (body.length > 0) {
        expect(body[0]).toHaveProperty('category_id');
        expect(body[0]).toHaveProperty('name');
      }
    });
  });

  // ========================================
  // /coins/categories
  // ========================================
  describe('GET /coins/categories', () => {
    it('matches CoinGecko categories format', async () => {
      const response = await app.inject({ method: 'GET', url: '/coins/categories' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      if (body.length > 0) {
        const cat = body[0];
        expect(cat).toHaveProperty('id');
        expect(cat).toHaveProperty('name');
        expect(cat).toHaveProperty('market_cap');
        expect(cat).toHaveProperty('market_cap_change_24h');
        expect(cat).toHaveProperty('content');
        expect(cat).toHaveProperty('top_3_coins');
        expect(cat).toHaveProperty('volume_24h');
        expect(cat).toHaveProperty('updated_at');
      }
    });
  });

  // ========================================
  // /coins/:platform_id/contract/:address
  // ========================================
  describe('GET /coins/:platform_id/contract/:contract_address', () => {
    it('returns 404 for unknown contract', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/ethereum/contract/0x0000000000000000000000000000000000000000',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // ========================================
  // /search
  // ========================================
  describe('GET /search', () => {
    it('matches CoinGecko search format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/search?query=bitcoin',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // CoinGecko: { coins, exchanges, icos, categories, nfts }
      expect(body).toHaveProperty('coins');
      expect(body).toHaveProperty('exchanges');
      expect(body).toHaveProperty('icos');
      expect(body).toHaveProperty('categories');
      expect(body).toHaveProperty('nfts');
      expect(Array.isArray(body.coins)).toBe(true);

      if (body.coins.length > 0) {
        const coin = body.coins[0];
        expect(coin).toHaveProperty('id');
        expect(coin).toHaveProperty('name');
        expect(coin).toHaveProperty('api_symbol');
        expect(coin).toHaveProperty('symbol');
        expect(coin).toHaveProperty('market_cap_rank');
        expect(coin).toHaveProperty('thumb');
        expect(coin).toHaveProperty('large');
        expect(coin).toHaveProperty('categories');
      }
    });
  });

  // ========================================
  // /exchanges/list
  // ========================================
  describe('GET /exchanges/list', () => {
    it('matches CoinGecko exchanges/list format', async () => {
      const response = await app.inject({ method: 'GET', url: '/exchanges/list' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      if (body.length > 0) {
        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('name');
      }
    });
  });

  // ========================================
  // /exchanges
  // ========================================
  describe('GET /exchanges', () => {
    it('matches CoinGecko exchanges format', async () => {
      const response = await app.inject({ method: 'GET', url: '/exchanges' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      if (body.length > 0) {
        const exchange = body[0];
        const requiredFields = [
          'id', 'name', 'year_established', 'country',
          'description', 'url', 'image', 'has_trading_incentive',
          'trust_score', 'trust_score_rank',
          'trade_volume_24h_btc', 'trade_volume_24h_btc_normalized',
        ];
        for (const field of requiredFields) {
          expect(exchange).toHaveProperty(field);
        }
      }
    });
  });

  // ========================================
  // /exchanges/:id
  // ========================================
  describe('GET /exchanges/:id', () => {
    it('matches CoinGecko exchange detail format', async () => {
      const response = await app.inject({ method: 'GET', url: '/exchanges/binance' });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      const requiredFields = [
        'id', 'name', 'year_established', 'country',
        'description', 'url', 'image', 'has_trading_incentive',
        'trust_score', 'trust_score_rank',
        'trade_volume_24h_btc', 'trade_volume_24h_btc_normalized',
        'facebook_url', 'reddit_url', 'telegram_url',
        'slack_url', 'other_url_1', 'other_url_2',
        'twitter_handle', 'centralized', 'public_notice',
        'alert_notice', 'tickers',
      ];
      for (const field of requiredFields) {
        expect(body).toHaveProperty(field);
      }
    });
  });

  // ========================================
  // /exchanges/:id/tickers
  // ========================================
  describe('GET /exchanges/:id/tickers', () => {
    it('matches CoinGecko exchange tickers format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/exchanges/binance/tickers',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('tickers');
      expect(Array.isArray(body.tickers)).toBe(true);
    });
  });

  // ========================================
  // /exchanges/:id/volume_chart
  // ========================================
  describe('GET /exchanges/:id/volume_chart', () => {
    it('matches CoinGecko volume chart format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart?days=7',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      // Each entry is [timestamp, volumeBtc]
      for (const entry of body) {
        expect(entry).toHaveLength(2);
        expect(typeof entry[0]).toBe('number');
        expect(typeof entry[1]).toBe('number');
      }
    });
  });

  // ========================================
  // /asset_platforms
  // ========================================
  describe('GET /asset_platforms', () => {
    it('matches CoinGecko asset_platforms format', async () => {
      const response = await app.inject({ method: 'GET', url: '/asset_platforms' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      if (body.length > 0) {
        const platform = body[0];
        expect(platform).toHaveProperty('id');
        expect(platform).toHaveProperty('chain_identifier');
        expect(platform).toHaveProperty('name');
        expect(platform).toHaveProperty('shortname');
        expect(platform).toHaveProperty('native_coin_id');
        expect(platform).toHaveProperty('image');
      }
    });
  });

  // ========================================
  // /global
  // ========================================
  describe('GET /global', () => {
    it('matches CoinGecko global format', async () => {
      const response = await app.inject({ method: 'GET', url: '/global' });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // CoinGecko: { data: { ... } }
      expect(body).toHaveProperty('data');
      const data = body.data;

      const requiredFields = [
        'active_cryptocurrencies', 'upcoming_icos', 'ongoing_icos',
        'ended_icos', 'markets', 'total_market_cap', 'total_volume',
        'market_cap_percentage', 'market_cap_change_percentage_24h_usd',
        'updated_at',
      ];
      for (const field of requiredFields) {
        expect(data).toHaveProperty(field);
      }

      // Sub-objects
      expect(typeof data.total_market_cap).toBe('object');
      expect(typeof data.total_volume).toBe('object');
      expect(typeof data.market_cap_percentage).toBe('object');
    });
  });

  // ========================================
  // /derivatives
  // ========================================
  describe('GET /derivatives', () => {
    it('matches CoinGecko derivatives format', async () => {
      const response = await app.inject({ method: 'GET', url: '/derivatives' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      // Mock data has derivatives from fixtures
      if (body.length > 0) {
        const derivative = body[0];
        const requiredFields = [
          'market', 'symbol', 'index_id', 'price',
          'price_percentage_change_24h', 'contract_type',
          'index', 'basis', 'spread', 'funding_rate',
          'open_interest_btc', 'trade_volume_24h_btc',
          'last_traded_at', 'expired_at',
        ];
        for (const field of requiredFields) {
          expect(derivative).toHaveProperty(field);
        }
      }
    });
  });

  // ========================================
  // /derivatives/exchanges
  // ========================================
  describe('GET /derivatives/exchanges', () => {
    it('matches CoinGecko derivatives exchanges format', async () => {
      const response = await app.inject({ method: 'GET', url: '/derivatives/exchanges' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      if (body.length > 0) {
        const exchange = body[0];
        const requiredFields = [
          'name', 'id', 'open_interest_btc',
          'trade_volume_24h_btc', 'number_of_perpetual_pairs',
          'number_of_futures_pairs', 'year_established',
          'country', 'description', 'url', 'image', 'centralized',
        ];
        for (const field of requiredFields) {
          expect(exchange).toHaveProperty(field);
        }
      }
    });
  });

  // ========================================
  // /derivatives/exchanges/list
  // ========================================
  describe('GET /derivatives/exchanges/list', () => {
    it('matches CoinGecko derivatives exchanges list format', async () => {
      const response = await app.inject({ method: 'GET', url: '/derivatives/exchanges/list' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      if (body.length > 0) {
        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('name');
      }
    });
  });

  // ========================================
  // /entities/list
  // ========================================
  describe('GET /entities/list', () => {
    it('returns entity list with correct fields', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/entities/list',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);

      if (body.length > 0) {
        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('name');
        expect(body[0]).toHaveProperty('symbol');
        expect(body[0]).toHaveProperty('country');
        expect(body[0]).toHaveProperty('entity_type');
      }
    });

    it('supports entity_type filter', async () => {
      const companies = await app.inject({
        method: 'GET',
        url: '/entities/list?entity_type=companies',
      });
      expect(companies.statusCode).toBe(200);
      for (const entity of companies.json()) {
        expect(entity.entity_type).toBe('company');
      }

      const govts = await app.inject({
        method: 'GET',
        url: '/entities/list?entity_type=governments',
      });
      expect(govts.statusCode).toBe(200);
      for (const entity of govts.json()) {
        expect(entity.entity_type).toBe('government');
      }
    });
  });

  // ========================================
  // /:entity/public_treasury/:coin_id
  // ========================================
  describe('GET /:entity/public_treasury/:coin_id', () => {
    it('returns treasury data with correct structure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/companies/public_treasury/bitcoin',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('coin_id');
      expect(body).toHaveProperty('current_price_usd');
      expect(body).toHaveProperty('total_holdings');
      expect(body).toHaveProperty('total_value_usd');
      expect(body).toHaveProperty('market_cap_percentage');
      expect(body).toHaveProperty('companies');
      expect(Array.isArray(body.companies)).toBe(true);
    });
  });

  // ========================================
  // /public_treasury/:entity_id
  // ========================================
  describe('GET /public_treasury/:entity_id', () => {
    it('returns entity treasury detail', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/public_treasury/strategy',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('symbol');
      expect(body).toHaveProperty('entity_type');
      expect(body).toHaveProperty('country');
      expect(body).toHaveProperty('description');
      expect(body).toHaveProperty('website_url');
      expect(body).toHaveProperty('total_entry_value_usd');
      expect(body).toHaveProperty('total_current_value_usd');
      expect(body).toHaveProperty('total_unrealized_pnl_usd');
      expect(body).toHaveProperty('holdings');
      expect(Array.isArray(body.holdings)).toBe(true);
    });
  });

  // ========================================
  // /onchain/networks
  // ========================================
  describe('GET /onchain/networks', () => {
    it('returns onchain networks with correct structure', async () => {
      const response = await app.inject({ method: 'GET', url: '/onchain/networks' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(Array.isArray(body.data)).toBe(true);

      if (body.data.length > 0) {
        const network = body.data[0];
        expect(network).toHaveProperty('id');
        expect(network).toHaveProperty('type');
        expect(network).toHaveProperty('attributes');
        expect(network.attributes).toHaveProperty('name');
      }
    });
  });

  // ========================================
  // /onchain/networks/:network/dexes
  // ========================================
  describe('GET /onchain/networks/:network/dexes', () => {
    it('returns onchain dexes with correct structure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/dexes',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(Array.isArray(body.data)).toBe(true);

      if (body.data.length > 0) {
        const dex = body.data[0];
        expect(dex).toHaveProperty('id');
        expect(dex).toHaveProperty('type');
        expect(dex).toHaveProperty('attributes');
        expect(dex).toHaveProperty('relationships');
        expect(dex.relationships).toHaveProperty('network');
      }
    });
  });

  // ========================================
  // /onchain/networks/:network/pools
  // ========================================
  describe('GET /onchain/networks/:network/pools', () => {
    it('returns onchain pools with correct structure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(Array.isArray(body.data)).toBe(true);

      if (body.data.length > 0) {
        const pool = body.data[0];
        expect(pool).toHaveProperty('id');
        expect(pool).toHaveProperty('type', 'pool');
        expect(pool).toHaveProperty('attributes');
        expect(pool.attributes).toHaveProperty('name');
        expect(pool.attributes).toHaveProperty('base_token_symbol');
        expect(pool.attributes).toHaveProperty('quote_token_symbol');
        expect(pool.attributes).toHaveProperty('volume_usd');
        expect(pool.attributes).toHaveProperty('transactions');
        expect(pool).toHaveProperty('relationships');
        expect(pool.relationships).toHaveProperty('network');
        expect(pool.relationships).toHaveProperty('dex');
      }
    });
  });

  // ========================================
  // /onchain/networks/:network/pools/:address
  // ========================================
  describe('GET /onchain/networks/:network/pools/:address', () => {
    it('returns onchain pool detail with correct structure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('type', 'pool');
      expect(body.data).toHaveProperty('attributes');
      expect(body.data.attributes).toHaveProperty('name');
      expect(body.data).toHaveProperty('relationships');
      expect(body.data.relationships).toHaveProperty('network');
      expect(body.data.relationships).toHaveProperty('dex');
    });
  });

  // ========================================
  // /onchain/networks/:network/dexes/:dex/pools
  // ========================================
  describe('GET /onchain/networks/:network/dexes/:dex/pools', () => {
    it('returns dex-scoped pools with correct structure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/dexes/uniswap_v3/pools',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(Array.isArray(body.data)).toBe(true);

      if (body.data.length > 0) {
        const pool = body.data[0];
        expect(pool).toHaveProperty('type', 'pool');
        expect(pool).toHaveProperty('relationships.dex.data.id');
      }
    });
  });

  // ========================================
  // /onchain/networks/:network/new_pools
  // ========================================
  describe('GET /onchain/networks/:network/new_pools', () => {
    it('returns newest pools with correct structure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/new_pools',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(Array.isArray(body.data)).toBe(true);

      if (body.data.length > 0) {
        const pool = body.data[0];
        expect(pool).toHaveProperty('type', 'pool');
        expect(pool).toHaveProperty('attributes.pool_created_at');
      }
    });
  });

  // ========================================
  // /onchain/networks/:network/pools/multi/:addresses
  // ========================================
  describe('GET /onchain/networks/:network/pools/multi/:addresses', () => {
    it('returns multi pool lookup with correct structure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools/multi/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b,0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      if (body.data.length > 0) {
        const pool = body.data[0];
        expect(pool).toHaveProperty('id');
        expect(pool).toHaveProperty('type', 'pool');
      }
    });
  });

  // ========================================
  // Token list
  // ========================================
  describe('GET /token_lists/:platform/all.json', () => {
    it('returns token list with correct structure', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/token_lists/ethereum/all.json',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('keywords');
      expect(body).toHaveProperty('logoURI');
      expect(body).toHaveProperty('tokens');
      expect(body.version).toHaveProperty('major');
      expect(body.version).toHaveProperty('minor');
      expect(body.version).toHaveProperty('patch');
    });
  });

  // ========================================
  // Error handling
  // ========================================
  describe('Error responses', () => {
    it('returns structured error for 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/not-a-coin',
      });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('message');
    });

    it('returns structured error for invalid parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=invalid_order',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ========================================
  // Field presence summary
  // ========================================
  describe('API field coverage summary', () => {
    it('all core CoinGecko v3 endpoints are implemented', async () => {
      const endpoints = [
        { method: 'GET', url: '/ping', expectedStatus: 200 },
        { method: 'GET', url: '/simple/supported_vs_currencies', expectedStatus: 200 },
        { method: 'GET', url: '/exchange_rates', expectedStatus: 200 },
        { method: 'GET', url: '/simple/price?ids=bitcoin&vs_currencies=usd', expectedStatus: 200 },
        { method: 'GET', url: '/coins/list', expectedStatus: 200 },
        { method: 'GET', url: '/coins/markets?vs_currency=usd', expectedStatus: 200 },
        { method: 'GET', url: '/coins/bitcoin', expectedStatus: 200 },
        { method: 'GET', url: '/coins/bitcoin/tickers', expectedStatus: 200 },
        { method: 'GET', url: '/coins/bitcoin/history?date=20-03-2026', expectedStatus: 200 },
        { method: 'GET', url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7', expectedStatus: 200 },
        { method: 'GET', url: '/coins/bitcoin/ohlc?vs_currency=usd&days=7', expectedStatus: 200 },
        { method: 'GET', url: '/coins/categories/list', expectedStatus: 200 },
        { method: 'GET', url: '/coins/categories', expectedStatus: 200 },
        { method: 'GET', url: '/search?query=bitcoin', expectedStatus: 200 },
        { method: 'GET', url: '/exchanges/list', expectedStatus: 200 },
        { method: 'GET', url: '/exchanges', expectedStatus: 200 },
        { method: 'GET', url: '/exchanges/binance', expectedStatus: 200 },
        { method: 'GET', url: '/exchanges/binance/tickers', expectedStatus: 200 },
        { method: 'GET', url: '/exchanges/binance/volume_chart?days=7', expectedStatus: 200 },
        { method: 'GET', url: '/asset_platforms', expectedStatus: 200 },
        { method: 'GET', url: '/global', expectedStatus: 200 },
        { method: 'GET', url: '/derivatives', expectedStatus: 200 },
        { method: 'GET', url: '/derivatives/exchanges', expectedStatus: 200 },
        { method: 'GET', url: '/derivatives/exchanges/list', expectedStatus: 200 },
        { method: 'GET', url: '/entities/list', expectedStatus: 200 },
        { method: 'GET', url: '/companies/public_treasury/bitcoin', expectedStatus: 200 },
        { method: 'GET', url: '/onchain/networks', expectedStatus: 200 },
        { method: 'GET', url: '/onchain/networks/eth/dexes', expectedStatus: 200 },
        { method: 'GET', url: '/onchain/networks/eth/pools', expectedStatus: 200 },
        { method: 'GET', url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b', expectedStatus: 200 },
        { method: 'GET', url: '/onchain/networks/eth/dexes/uniswap_v3/pools', expectedStatus: 200 },
        { method: 'GET', url: '/onchain/networks/eth/new_pools', expectedStatus: 200 },
        { method: 'GET', url: '/onchain/networks/eth/pools/multi/0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b,0x4e68ccd3e89f51c3074ca5072bbac773960dfa36', expectedStatus: 200 },
        { method: 'GET', url: '/token_lists/ethereum/all.json', expectedStatus: 200 },
      ];

      const results = [];
      for (const endpoint of endpoints) {
        const response = await app.inject({ method: endpoint.method as 'GET', url: endpoint.url });
        results.push({
          endpoint: endpoint.url,
          status: response.statusCode,
          pass: response.statusCode === endpoint.expectedStatus,
        });
      }

      console.log('\n=== OpenGecko API Endpoint Coverage ===\n');
      for (const result of results) {
        const icon = result.pass ? '✅' : '❌';
        console.log(`${icon} ${result.endpoint} → ${result.status}`);
      }
      console.log(`\n${results.filter(r => r.pass).length}/${results.length} endpoints passing\n`);

      const failed = results.filter(r => !r.pass);
      if (failed.length > 0) {
        console.log('Failed endpoints:', failed.map(r => r.endpoint).join(', '));
      }

      // All endpoints should pass
      expect(results.every(r => r.pass)).toBe(true);
    });
  });
});
