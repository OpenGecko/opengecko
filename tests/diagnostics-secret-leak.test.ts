import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import * as ccxtProvider from '../src/providers/ccxt';
import * as defillamaProvider from '../src/providers/defillama';
import * as sqdProvider from '../src/providers/sqd';
import { resetCurrencyApiSnapshotForTests } from '../src/services/currency-rates';

const DIAGNOSTIC_ROUTES = [
  '/diagnostics/runtime',
  '/diagnostics/jobs',
  '/diagnostics/coverage_matrix',
  '/diagnostics/freshness_budgets',
  '/diagnostics/ohlcv_sync',
  '/diagnostics/providers',
] as const;

const CREDENTIAL_LIKE_PATTERNS = [
  /api_key/i,
  /secret/i,
  /password/i,
  /token=/i,
  /Bearer/i,
] as const;

const SECRET_ERROR_TEXT = [
  'GET https://client:password@example.test/prices?api_key=route-secret',
  'Authorization: Bearer runtime-secret-token',
  'token=query-secret',
  'password=hunter2',
].join(' ');

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeDerivativeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('diagnostics secret leak guard', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-diagnostics-secret-'));
    vi.restoreAllMocks();
    resetCurrencyApiSnapshotForTests();
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);
    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);
    (ccxtProvider.closeExchangePool as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
        port: 3102,
        disableRemoteCurrencyRefresh: true,
        startupPrewarmBudgetMs: 0,
      },
      startBackgroundJobs: false,
      exposeSchedulerDiagnostics: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    vi.clearAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps credential-like substrings out of diagnostics route bodies', async () => {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    const providerFailureResponse = await app.inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_failure',
      payload: {
        active: true,
        reason: SECRET_ERROR_TEXT,
      },
    });
    expect(providerFailureResponse.statusCode).toBe(200);

    const degradedStateResponse = await app.inject({
      method: 'POST',
      url: '/diagnostics/runtime/degraded_state',
      payload: {
        mode: 'stale_allowed',
        reason: SECRET_ERROR_TEXT,
      },
    });
    expect(degradedStateResponse.statusCode).toBe(200);

    const sqliteFaultResponse = await app.inject({
      method: 'POST',
      url: '/diagnostics/runtime/sqlite_fault_validation',
      payload: {
        mode: 'fatal_persistence',
        operation: SECRET_ERROR_TEXT,
      },
    });
    expect(sqliteFaultResponse.statusCode).toBe(200);

    app.optionalProviderJobs.recordFailure('market_charts', {
      startedAt: new Date('2026-05-12T00:00:00.000Z'),
      finishedAt: new Date('2026-05-12T00:00:01.000Z'),
      targetsAttempted: 1,
      error: SECRET_ERROR_TEXT,
    });

    app.scheduler?.register({
      name: 'leak-regression',
      intervalSeconds: 60,
      run: vi.fn(async () => {
        throw new Error(SECRET_ERROR_TEXT);
      }),
    });
    await app.scheduler?.runNow('leak-regression');

    for (const route of DIAGNOSTIC_ROUTES) {
      const response = await app.inject({
        method: 'GET',
        url: route,
      });

      if (route === '/diagnostics/providers' && response.statusCode === 404) {
        continue;
      }

      expect(response.statusCode, route).toBe(200);
      for (const pattern of CREDENTIAL_LIKE_PATTERNS) {
        expect(response.body, `${route} leaked ${pattern}`).not.toMatch(pattern);
      }
      expect(response.body, `${route} leaked URL credentials`).not.toContain('client:password@');
      expect(response.body, `${route} leaked raw credential value`).not.toContain('hunter2');
    }
  });
});
