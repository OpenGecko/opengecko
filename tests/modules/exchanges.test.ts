import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app';

vi.mock('../../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (_value: string): _value is string => true,
}));

vi.mock('../../src/providers/defillama', () => ({
  fetchDefillamaTokenPrices: vi.fn().mockResolvedValue(null),
  fetchDefillamaPoolData: vi.fn().mockResolvedValue(null),
  fetchDefillamaDexVolumes: vi.fn().mockResolvedValue(null),
  fetchDefillamaDiscoveredPools: vi.fn().mockResolvedValue(null),
}));

describe('derivatives fixture metadata', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-deriv-'));
    vi.restoreAllMocks();
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

  it('GET /derivatives returns fixture metadata in response meta', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    expect(body).toHaveProperty('meta');
    expect(body.meta).toMatchObject({
      fixture: true,
      frozen_at: '2026-03-20',
      note: 'Derivatives data is seeded fixture, not live',
    });
    expect(body.meta).toHaveProperty('page');
  });

  it('GET /derivatives/exchanges returns fixture metadata in response meta', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    expect(body).toHaveProperty('meta');
    expect(body.meta).toMatchObject({
      fixture: true,
      frozen_at: '2026-03-20',
      note: 'Derivatives data is seeded fixture, not live',
    });
    expect(body.meta).toHaveProperty('page');
  });

  it('GET /derivatives/exchanges preserves fixture metadata contract fields', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges?per_page=1&page=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [expect.any(Object)],
      meta: {
        page: 1,
        fixture: true,
        frozen_at: '2026-03-20',
        note: 'Derivatives data is seeded fixture, not live',
      },
    });
  });

  it('GET /derivatives/exchanges/:id returns fixture metadata in response meta', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/binance_futures',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body).toHaveProperty('data');
    expect(body.data).toMatchObject({
      id: 'binance_futures',
      name: 'Binance Futures',
    });

    expect(body).toHaveProperty('meta');
    expect(body.meta).toMatchObject({
      fixture: true,
      frozen_at: '2026-03-20',
      note: 'Derivatives data is seeded fixture, not live',
    });
  });

  it('GET /derivatives/exchanges/:id with include_tickers returns fixture metadata alongside tickers', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/binance_futures?include_tickers=true',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body).toHaveProperty('data');
    expect(body.data).toHaveProperty('tickers');
    expect(Array.isArray(body.data.tickers)).toBe(true);
    expect(body.data.tickers.length).toBeGreaterThan(0);

    expect(body).toHaveProperty('meta');
    expect(body.meta).toMatchObject({
      fixture: true,
      frozen_at: '2026-03-20',
    });
  });

  it('GET /derivatives/exchanges/:id paginated returns fixture metadata with page', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges?order=trade_volume_24h_btc_desc&per_page=1&page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.data).toHaveLength(1);
    expect(body.meta).toMatchObject({
      page: 1,
      fixture: true,
      frozen_at: '2026-03-20',
    });
  });

  it('GET /derivatives/exchanges/list does NOT include fixture metadata (unmodified contract)', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/derivatives/exchanges/list',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(Array.isArray(body)).toBe(true);
    expect(body).not.toHaveProperty('meta');
  });
});
