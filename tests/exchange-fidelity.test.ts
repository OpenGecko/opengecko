import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('returns empty exchange registry when live exchange discovery is unavailable', async () => {
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
      expect(exchangesListResponse.json()).toEqual([]);
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

  it('documents exchange divergences in a structured analysis file', () => {
    const filePath = '/home/whoami/dev/openGecko/docs/analysis/exchange-divergences.md';
    const contents = readFileSync(filePath, 'utf8');

    expect(contents).toContain('| endpoint | field | description |');
    expect(contents).toContain('/exchanges/{id}/tickers');
    expect(contents).toContain('/derivatives');
  });
});
