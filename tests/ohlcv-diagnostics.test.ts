import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import type { OhlcvSyncSummary } from '../src/services/ohlcv-runtime';
import * as ohlcvRuntimeModule from '../src/services/ohlcv-runtime';
import * as defillamaProvider from '../src/providers/defillama';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('ohlcv diagnostics route', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-ohlcv-diagnostics-'));
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('mirrors summarized ohlcv sync metrics at the HTTP boundary', async () => {
    const summary: OhlcvSyncSummary = {
      top100: {
        total: 100,
        ready: 97,
      },
      targets: {
        waiting: 11,
        running: 2,
        failed: 3,
      },
      lag: {
        oldest_recent_sync_ms: 120_000,
        oldest_historical_gap_ms: 86_400_000,
      },
      backfill: {
        healthy: 94,
        behind: 6,
        retry_scheduled: 3,
        max_target_history_days: 365,
      },
      history: {
        target_depth_days: 365,
        desired_oldest_at: '2025-03-23T00:00:00.000Z',
        oldest_covered_at: '2025-03-22T00:00:00.000Z',
        newest_covered_at: '2026-03-22T00:00:00.000Z',
        targets_with_any_history: 97,
        targets_at_target_depth: 94,
        by_tier: {
          top100: {
            total: 100,
            with_any_history: 97,
            at_target_depth: 94,
            oldest_covered_at: '2025-03-22T00:00:00.000Z',
            remaining_depth_days: 6,
            estimated_remaining_chunks: 1,
            depth_status_counts: {
              complete: 94,
              catching_up: 6,
              blocked: 0,
            },
            retry_recovery_counts: {
              due: 0,
              backoff: 0,
            },
            retry_starvation_counts: {
              starved: 0,
            },
          },
          requested: {
            total: 0,
            with_any_history: 0,
            at_target_depth: 0,
            oldest_covered_at: null,
            remaining_depth_days: 0,
            estimated_remaining_chunks: 0,
            depth_status_counts: {
              complete: 0,
              catching_up: 0,
              blocked: 0,
            },
            retry_recovery_counts: {
              due: 0,
              backoff: 0,
            },
            retry_starvation_counts: {
              starved: 0,
            },
          },
          long_tail: {
            total: 0,
            with_any_history: 0,
            at_target_depth: 0,
            oldest_covered_at: null,
            remaining_depth_days: 0,
            estimated_remaining_chunks: 0,
            depth_status_counts: {
              complete: 0,
              catching_up: 0,
              blocked: 0,
            },
            retry_recovery_counts: {
              due: 0,
              backoff: 0,
            },
            retry_starvation_counts: {
              starved: 0,
            },
          },
        },
        depth_status_counts: {
          complete: 94,
          catching_up: 6,
          blocked: 0,
        },
        retry_recovery_counts: {
          due: 0,
          backoff: 0,
        },
        retry_starvation_counts: {
          starved: 0,
        },
        retry_starvation_thresholds: {
          due_age_seconds: 120,
        },
        queue_priority_summary: {
          totals: {
            eligible_for_lease: 94,
            retry_due_failed: 0,
            retry_backoff_failed: 0,
            incomplete_depth: 6,
            complete_depth: 94,
            running: 0,
            starved_retry_due: 0,
          },
          by_tier: {
            top100: {
              eligible_for_lease: 94,
              retry_due_failed: 0,
              retry_backoff_failed: 0,
              incomplete_depth: 6,
              complete_depth: 94,
              running: 0,
              starved_retry_due: 0,
            },
            requested: {
              eligible_for_lease: 0,
              retry_due_failed: 0,
              retry_backoff_failed: 0,
              incomplete_depth: 0,
              complete_depth: 0,
              running: 0,
              starved_retry_due: 0,
            },
            long_tail: {
              eligible_for_lease: 0,
              retry_due_failed: 0,
              retry_backoff_failed: 0,
              incomplete_depth: 0,
              complete_depth: 0,
              running: 0,
              starved_retry_due: 0,
            },
          },
        },
        depth_alert_thresholds: {
          complete_remaining_depth_days: 0,
          catching_up_min_remaining_depth_days: 1,
          blocked_statuses: ['failed'],
        },
        completion_estimate: {
          chunk_days: 180,
          overlap_days: 2,
          targets_incomplete: 6,
          remaining_depth_days: 6,
          estimated_remaining_chunks: 1,
          max_remaining_depth_days: 1,
        },
        most_behind_samples: {
          top100: [
            {
              coin_id: 'bitcoin',
              exchange_id: 'binance',
              symbol: 'BTC/USDT',
              vs_currency: 'usd',
              interval: '1d',
              status: 'idle',
              target_history_days: 365,
              oldest_synced_at: '2025-03-24T00:00:00.000Z',
              latest_synced_at: '2026-03-22T00:00:00.000Z',
              remaining_depth_days: 1,
              estimated_remaining_chunks: 1,
            },
          ],
          requested: [],
          long_tail: [],
        },
        blocked_target_samples: {
          top100: [
            {
              coin_id: 'bitcoin',
              exchange_id: 'binance',
              symbol: 'BTC/USDT',
              vs_currency: 'usd',
              interval: '1d',
              status: 'failed',
              target_history_days: 365,
              oldest_synced_at: '2025-03-24T00:00:00.000Z',
              latest_synced_at: '2026-03-22T00:00:00.000Z',
              remaining_depth_days: 1,
              estimated_remaining_chunks: 1,
              failure_count: 2,
              next_retry_at: '2026-03-23T00:10:00.000Z',
              retry_in_seconds: 600,
              last_attempt_at: '2026-03-23T00:00:00.000Z',
              last_success_at: '2026-03-22T00:00:00.000Z',
              last_error: 'rate limit',
            },
          ],
          requested: [],
          long_tail: [],
        },
      },
    };

    const summarizeSpy = vi
      .spyOn(ohlcvRuntimeModule, 'summarizeOhlcvSyncStatus')
      .mockReturnValue(summary);

    const response = await app.inject({
      method: 'GET',
      url: '/diagnostics/ohlcv_sync',
    });

    expect(response.statusCode).toBe(200);
    expect(summarizeSpy).toHaveBeenCalledTimes(1);
    expect(summarizeSpy).toHaveBeenCalledWith(app.db, expect.any(Date));
    expect(response.json()).toEqual({
      data: {
        top100: {
          total: 100,
          ready: 97,
        },
        targets: {
          waiting: 11,
          running: 2,
          failed: 3,
        },
        lag: {
          oldest_recent_sync_ms: 120_000,
          oldest_historical_gap_ms: 86_400_000,
        },
        backfill: {
          healthy: 94,
          behind: 6,
          retry_scheduled: 3,
          max_target_history_days: 365,
        },
        history: summary.history,
      },
    });

    expect(response.json().data.top100.total).toBeGreaterThanOrEqual(response.json().data.top100.ready);
    expect(response.json().data.targets.waiting).toBeGreaterThanOrEqual(0);
    expect(response.json().data.targets.running).toBeGreaterThanOrEqual(0);
    expect(response.json().data.targets.failed).toBeGreaterThanOrEqual(0);
    expect(response.json().data.lag.oldest_recent_sync_ms).toBeGreaterThanOrEqual(0);
    expect(response.json().data.lag.oldest_historical_gap_ms).toBeGreaterThanOrEqual(0);
    expect(response.json().data.backfill.healthy).toBeGreaterThanOrEqual(0);
    expect(response.json().data.backfill.behind).toBeGreaterThanOrEqual(0);
    expect(response.json().data.backfill.retry_scheduled).toBeGreaterThanOrEqual(0);
    expect(response.json().data.backfill.max_target_history_days).toBeGreaterThanOrEqual(0);
    expect(response.json().data.history.target_depth_days).toBe(365);
    expect(response.json().data.history.targets_with_any_history).toBeGreaterThanOrEqual(response.json().data.history.targets_at_target_depth);
  });
});
