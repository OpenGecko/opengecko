import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    { exchangeId: 'binance', symbol: 'USDT/USD', base: 'USDT', quote: 'USD', active: true, spot: true, baseName: 'Tether', raw: {} },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'USDT/USD', base: 'USDT', quote: 'USD', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 25000000, quoteVolume: 25000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
  ]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('token price parity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-token-price-parity-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves token identity and canonical response shape across supported ethereum platform aliases', async () => {
    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const requestSuffix = '?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true';
      const [ethereumResponse, ethResponse, erc20Response] = await Promise.all([
        app.inject({ method: 'GET', url: `/simple/token_price/ethereum${requestSuffix}` }),
        app.inject({ method: 'GET', url: `/simple/token_price/eth${requestSuffix}` }),
        app.inject({ method: 'GET', url: `/simple/token_price/erc20${requestSuffix}` }),
      ]);

      for (const response of [ethereumResponse, ethResponse, erc20Response]) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
            usd: 1,
            usd_market_cap: null,
            usd_24h_vol: 10_000_000,
            usd_24h_change: 0.01,
            last_updated_at: expect.any(Number),
          },
        });
      }

      expect(ethResponse.json()).toEqual(ethereumResponse.json());
      expect(erc20Response.json()).toEqual(ethereumResponse.json());

      const wethResponse = await app.inject({
        method: 'GET',
        url: '/simple/token_price/ethereum?contract_addresses=0xC02AAA39B223FE8D0A0E5C4F27EAD9083C756CC2&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
      });
      expect(wethResponse.statusCode).toBe(200);
      expect(wethResponse.json()['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']).toMatchObject({
        usd: 2000,
        usd_24h_vol: 100_000_000,
        usd_24h_change: 2.56,
        last_updated_at: expect.any(Number),
      });

      const usdtResponse = await app.inject({
        method: 'GET',
        url: '/simple/token_price/ethereum?contract_addresses=0xDAC17F958D2EE523A2206206994597C13D831EC7&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
      });
      expect(usdtResponse.statusCode).toBe(200);
      expect(usdtResponse.json()).toEqual({
        '0xdac17f958d2ee523a2206206994597c13d831ec7': {
          usd: 1,
          usd_market_cap: 110_000_000_000,
          usd_24h_vol: 25_000_000,
          usd_24h_change: 0.01,
          last_updated_at: expect.any(Number),
        },
      });
    } finally {
      await app.close();
    }
  });
});
