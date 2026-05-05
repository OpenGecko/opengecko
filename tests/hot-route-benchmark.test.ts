import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { runHotRouteBenchmark } from '../src/jobs/benchmark-hot-routes';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
  ]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('hot route benchmark report', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-hot-route-benchmark-'));
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'benchmark.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
        responseCompressionThresholdBytes: 64,
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records deterministic hot-route performance evidence without enforcing timing thresholds', async () => {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    const report = await runHotRouteBenchmark(app);

    expect(report.generated_at).toEqual(expect.any(String));
    expect(report.routes.map((route) => route.name)).toEqual([
      'simple_price_representative',
      'coins_markets_page_1',
      'exchange_tickers_binance',
    ]);

    for (const route of report.routes) {
      expect(route.status_code).toBe(200);
      expect(route.cold_ms).toEqual(expect.any(Number));
      expect(route.warm_ms).toEqual(expect.any(Number));
      expect(route.payload_bytes).toBeGreaterThan(0);
      expect(route.gzip_bytes === null || route.gzip_bytes > 0).toBe(true);
      expect(route.brotli_bytes === null || route.brotli_bytes > 0).toBe(true);
      expect(route.gzip_ratio === null || route.gzip_ratio > 0).toBe(true);
      expect(route.brotli_ratio === null || route.brotli_ratio > 0).toBe(true);
      expect(route.cache_control).toEqual(expect.any(String));
      expect(route.etag_present).toBe(true);
    }

    expect(report.cache_events.simple_price).toMatchObject({
      hit: expect.any(Number),
      miss: expect.any(Number),
    });
    expect(report.cache_events.coins_markets).toMatchObject({
      hit: expect.any(Number),
      miss: expect.any(Number),
    });
    expect(report.cache_probe).toEqual({
      coalesced_request_count: 5,
      producer_call_count: 1,
      eviction_count: 1,
      final_size: 2,
    });
  });
});
