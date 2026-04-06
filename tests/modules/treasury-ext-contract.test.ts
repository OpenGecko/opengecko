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

describe('treasury fixture compatibility', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-treasury-ext-'));
    vi.restoreAllMocks();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }

    vi.clearAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns fixture metadata on treasury holding chart responses', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/bitcoin/holding_chart?days=7',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        holdings: expect.any(Array),
        holding_value_in_usd: expect.any(Array),
      },
      meta: {
        fixture: true,
        note: 'Treasury data is seeded fixture, not live',
      },
    });
  });

  it('returns typed empty arrays for valid treasury holding-chart pairs without history', async () => {
    const response = await getApp().inject({
      method: 'GET',
      url: '/public_treasury/strategy/ethereum/holding_chart?days=7',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        holdings: [],
        holding_value_in_usd: [],
      },
      meta: {
        fixture: true,
        note: 'Treasury data is seeded fixture, not live',
      },
    });
  });
});
