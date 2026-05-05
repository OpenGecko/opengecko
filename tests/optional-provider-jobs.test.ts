import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { runMarketChartSyncJob } from '../src/jobs/sync-market-charts';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: 1773964800000, raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: 1773964800000, raw: {} as never },
  ]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('optional provider job diagnostics', () => {
  it('reports all optional sync jobs as not configured when target envs are empty', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/diagnostics/jobs',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        summary: {
          total: 6,
          not_configured: 6,
          configured_pending: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
        },
        jobs: expect.arrayContaining([
          expect.objectContaining({
            id: 'market_charts',
            status: 'not_configured',
            command: 'bun run market:charts:sync',
            target_env: 'MARKET_CHART_TARGETS',
            provider_base_url_env: 'MARKET_CHART_BASE_URL',
            configured_target_count: 0,
          }),
        ]),
      });
    } finally {
      await app.close();
    }
  });

  it('reports configured-pending and last success state for configured jobs', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        marketChartTargets: 'mock.chart=bitcoin:1d:usd,mock.chart=ethereum:1d:usd',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const pendingResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/jobs',
      });

      expect(pendingResponse.statusCode).toBe(200);
      expect(pendingResponse.json().data.jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'market_charts',
          status: 'configured_pending',
          configured_target_count: 2,
          last_started_at: null,
          last_rows_written: null,
          last_failure_reason: null,
        }),
      ]));

      app.optionalProviderJobs.recordSuccess('market_charts', {
        startedAt: new Date('2026-05-05T02:00:00.000Z'),
        finishedAt: new Date('2026-05-05T02:00:01.250Z'),
        targetsAttempted: 2,
        rowsWritten: 6,
      });

      const successResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/jobs',
      });

      expect(successResponse.statusCode).toBe(200);
      expect(successResponse.json().data).toMatchObject({
        summary: {
          succeeded: 1,
          failed: 0,
        },
        jobs: expect.arrayContaining([
          expect.objectContaining({
            id: 'market_charts',
            status: 'succeeded',
            configured_target_count: 2,
            last_started_at: '2026-05-05T02:00:00.000Z',
            last_finished_at: '2026-05-05T02:00:01.250Z',
            last_duration_ms: 1250,
            last_targets_attempted: 2,
            last_rows_written: 6,
            last_failure_reason: null,
          }),
        ]),
      });
    } finally {
      await app.close();
    }
  });

  it('reports last failure state without leaking provider credentials', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        exchangeVolumeTargets: 'mock.volume=binance',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      app.optionalProviderJobs.recordFailure('exchange_volumes', {
        startedAt: new Date('2026-05-05T03:00:00.000Z'),
        finishedAt: new Date('2026-05-05T03:00:00.500Z'),
        targetsAttempted: 1,
        error: 'provider request failed with status 500',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/diagnostics/jobs',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        summary: {
          failed: 1,
        },
        jobs: expect.arrayContaining([
          expect.objectContaining({
            id: 'exchange_volumes',
            status: 'failed',
            target_env: 'EXCHANGE_VOLUME_TARGETS',
            provider_base_url_env: 'EXCHANGE_VOLUME_BASE_URL',
            configured_target_count: 1,
            last_duration_ms: 500,
            last_targets_attempted: 1,
            last_rows_written: null,
            last_failure_reason: 'provider request failed with status 500',
          }),
        ]),
        notes: expect.stringContaining('without exposing provider credentials'),
      });
    } finally {
      await app.close();
    }
  });

  it('surfaces no-target standalone job outcomes after app restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-job-diagnostics-'));
    const databaseUrl = join(tempDir, 'jobs.db');

    try {
      await runMarketChartSyncJob({
        DATABASE_URL: databaseUrl,
        MARKET_CHART_TARGETS: '',
        LOG_LEVEL: 'silent',
      } as NodeJS.ProcessEnv);

      const app = buildApp({
        config: {
          databaseUrl,
          logLevel: 'silent',
        },
        startBackgroundJobs: false,
      });

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/diagnostics/jobs',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data.jobs).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'market_charts',
            status: 'succeeded',
            configured_target_count: 0,
            last_targets_attempted: 0,
            last_rows_written: 0,
            last_failure_reason: null,
          }),
        ]));
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('persists standalone job failures and exposes them after app restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-job-diagnostics-'));
    const databaseUrl = join(tempDir, 'jobs.db');

    try {
      await expect(runMarketChartSyncJob({
        DATABASE_URL: databaseUrl,
        MARKET_CHART_TARGETS: 'mock.chart=bitcoin:1d:usd',
        LOG_LEVEL: 'silent',
      } as NodeJS.ProcessEnv)).rejects.toThrow('MARKET_CHART_BASE_URL is required');

      const app = buildApp({
        config: {
          databaseUrl,
          marketChartTargets: 'mock.chart=bitcoin:1d:usd',
          logLevel: 'silent',
        },
        startBackgroundJobs: false,
      });

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/diagnostics/jobs',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().data.jobs).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'market_charts',
            status: 'failed',
            configured_target_count: 1,
            last_targets_attempted: 1,
            last_rows_written: null,
            last_failure_reason: expect.stringContaining('MARKET_CHART_BASE_URL is required'),
          }),
        ]));
      } finally {
        await app.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
