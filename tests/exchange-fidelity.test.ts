import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('exchange live fidelity contracts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-exchange-fidelity-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns seeded exchange registry when live exchange discovery is unavailable', async () => {
    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'app.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const exchangesListResponse = await app.inject({
        method: 'GET',
        url: '/exchanges/list',
      });
      expect(exchangesListResponse.statusCode).toBe(200);
      expect(exchangesListResponse.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'binance', name: 'Binance' }),
      ]));
    } finally {
      await app.close();
    }
  });

  it('returns non-null derivative venue and contract freshness fields', async () => {
    const app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'derivatives.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const exchangesResponse = await app.inject({
        method: 'GET',
        url: '/derivatives/exchanges',
      });
      const derivativesResponse = await app.inject({
        method: 'GET',
        url: '/derivatives',
      });

      expect(exchangesResponse.statusCode).toBe(200);
      for (const venue of exchangesResponse.json()) {
        expect(venue.open_interest_btc).not.toBeNull();
        expect(venue.trade_volume_24h_btc).not.toBeNull();
      }

      expect(derivativesResponse.statusCode).toBe(200);
      for (const ticker of derivativesResponse.json()) {
        expect(ticker.open_interest_btc).not.toBeNull();
        expect(ticker.trade_volume_24h_btc).not.toBeNull();
        expect(ticker.funding_rate).not.toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it('keeps canonical Binance detail/ticker breadth aligned with the stored baseline fields', async () => {
    const app = buildApp({
      config: {
        host: '127.0.0.1',
        port: 3102,
        databaseUrl: ':memory:',
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const [detailResponse, tickersResponse] = await Promise.all([
        app.inject({ method: 'GET', url: '/exchanges/binance' }),
        app.inject({ method: 'GET', url: '/exchanges/binance/tickers?page=1' }),
      ]);

      expect(detailResponse.statusCode).toBe(200);
      expect(tickersResponse.statusCode).toBe(200);

      const detail = detailResponse.json();
      const tickers = tickersResponse.json().tickers;

      expect(detail.name).toBe('Binance');
      expect(detail.status_updates).toEqual([]);
      expect(typeof detail.trade_volume_24h_btc).toBe('number');
      expect(detail).toHaveProperty('trade_volume_24h_btc_normalized');
      expect(typeof detail.coins).toBe('number');
      expect(typeof detail.pairs).toBe('number');
      expect(detail.coins).toBeGreaterThan(100);
      expect(detail.pairs).toBeGreaterThan(100);
      expect(tickers[0]).toEqual(expect.objectContaining({
        base: 'BTC',
        target: 'USDT',
        target_coin_id: 'tether',
      }));
      expect(tickers[0]).toHaveProperty('timestamp');
      expect(tickers[0]).toHaveProperty('last_fetch_at');
      expect(tickers[0]).toHaveProperty('trade_url');
      expect(tickers[0].coin_mcap_usd).toEqual(expect.any(Number));
      expect(
        tickers.find((ticker: { base: string; target: string }) => ticker.base === 'USDT' && ticker.target === 'USD')?.target_coin_id ?? null,
      ).toBeNull();
      expect(
        tickers.find((ticker: { base: string; target: string }) => ticker.base === 'USD1' && ticker.target === 'USDT')?.coin_id,
      ).toBe('world-liberty-financial-usd');
      expect(tickers.slice(0, 6).map((ticker: { base: string; target: string }) => `${ticker.base}/${ticker.target}`)).toEqual([
        'BTC/USDT',
        'NIGHT/USDT',
        'USDC/USDT',
        'ETH/USDT',
        'SOL/USDT',
        'BNB/USDT',
      ]);
    } finally {
      await app.close();
    }
  });

});
