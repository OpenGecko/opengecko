import { describe, expect, it, vi } from 'vitest';

import { createUnifiedScheduler, sanitizeSchedulerDiagnosticError } from '../src/services/job-scheduler';
import { createMetricsRegistry } from '../src/services/metrics';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('unified scheduler', () => {
  it('does not overlap runs for the same job and records skipped ticks', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    let release!: () => void;
    let inFlight = 0;
    let maxConcurrency = 0;
    const scheduler = createUnifiedScheduler({ logger });

    scheduler.register({
      name: 'slow-job',
      intervalSeconds: 1,
      run: vi.fn(async () => {
        inFlight += 1;
        maxConcurrency = Math.max(maxConcurrency, inFlight);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        inFlight -= 1;
      }),
    });

    const firstRun = scheduler.runNow('slow-job');
    await vi.advanceTimersByTimeAsync(0);
    const overlappingRun = scheduler.runNow('slow-job');

    expect(maxConcurrency).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'slow-job' }),
      'background job skipped because the previous run is still active job=slow-job',
    );
    expect(scheduler.diagnostics()).toEqual([
      expect.objectContaining({
        name: 'slow-job',
        running: true,
        skipped_count: 1,
      }),
    ]);

    release();
    await firstRun;
    await overlappingRun;
    vi.useRealTimers();
  });

  it('sanitizes failures, increments metrics, and uses jittered backoff before retrying', async () => {
    const logger = createLogger();
    const metrics = createMetricsRegistry();
    let currentTime = new Date('2026-05-05T00:00:00.000Z');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(1);
    const scheduler = createUnifiedScheduler({
      logger,
      metrics,
      now: () => currentTime,
    });
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('GET https://user:pass@example.test/path?token=secret-token failed\n    at secretStack'))
      .mockResolvedValueOnce(undefined);

    try {
      scheduler.register({
        name: 'failing-job',
        intervalSeconds: 10,
        run,
      });

      await scheduler.runNow('failing-job');
      const failedDiagnostic = scheduler.diagnostics()[0]!;
      expect(failedDiagnostic).toMatchObject({
        status: 'retrying',
        status_reason: 'retry_backoff_active',
        retry_attempt_count: 1,
        next_retry_at: '2026-05-05T00:00:08.000Z',
        next_scheduled_at: '2026-05-05T00:00:10.000Z',
        observed_lag_seconds: 0,
        backoff: {
          active: true,
          attempt_count: 1,
          next_retry_at: '2026-05-05T00:00:08.000Z',
        },
      });
      expect(failedDiagnostic.error_count).toBe(1);
      expect(failedDiagnostic.last_error).toContain('redacted');
      expect(failedDiagnostic.last_error).not.toContain('secret-token');
      expect(failedDiagnostic.last_error).not.toContain('secretStack');
      expect(failedDiagnostic.next_run_at).toBe('2026-05-05T00:00:08.000Z');

      currentTime = new Date('2026-05-05T00:00:07.000Z');
      await scheduler.runNow('failing-job');
      expect(run).toHaveBeenCalledTimes(1);

      currentTime = new Date('2026-05-05T00:00:08.000Z');
      await scheduler.runNow('failing-job');
      expect(run).toHaveBeenCalledTimes(2);
      expect(scheduler.diagnostics()[0]).toMatchObject({
        status: 'idle',
        error_count: 0,
        last_error: null,
        last_success_at: '2026-05-05T00:00:08.000Z',
      });
      expect(metrics.renderPrometheus()).toContain('opengecko_scheduler_job_runs_total{job="failing-job",outcome="failure"} 1');
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('keeps disabled jobs observable without executing them', async () => {
    const scheduler = createUnifiedScheduler({ logger: createLogger() });
    const run = vi.fn().mockResolvedValue(undefined);

    scheduler.register({
      name: 'disabled-job',
      intervalSeconds: 60,
      disabled: true,
      run,
    });
    scheduler.start();
    await scheduler.runNow('disabled-job');

    expect(run).not.toHaveBeenCalled();
    expect(scheduler.diagnostics()).toEqual([
      expect.objectContaining({
        name: 'disabled-job',
        status: 'blocked',
        status_reason: 'job_disabled',
        disabled: true,
        last_run_at: null,
      }),
    ]);
  });

  it('reports lagging, failed, skipped, and partial-failure states with stable allowed values', async () => {
    let currentTime = new Date('2026-05-05T00:00:00.000Z');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const scheduler = createUnifiedScheduler({
      logger: createLogger(),
      now: () => currentTime,
    });

    try {
      scheduler.register({
        name: 'lagging-job',
        intervalSeconds: 10,
        run: vi.fn(async () => undefined),
      });
      scheduler.register({
        name: 'failed-job',
        intervalSeconds: 10,
        run: vi.fn(async () => {
          throw new Error('provider failed');
        }),
      });
      scheduler.register({
        name: 'partial-job',
        intervalSeconds: 10,
        run: vi.fn(async () => ({
          partialFailures: [{ target: 'bitcoin', reason: 'transient provider failure' }],
        })),
      });
      scheduler.register({
        name: 'skipped-job',
        intervalSeconds: 10,
        run: vi.fn(async () => undefined),
      });

      await scheduler.runNow('lagging-job');
      await scheduler.runNow('partial-job');
      currentTime = new Date('2026-05-05T00:00:20.000Z');
      await scheduler.runNow('failed-job');
      await scheduler.runNow('skipped-job');
      await scheduler.stop({ inFlightTimeoutMs: 0 });
      await scheduler.runNow('skipped-job');

      currentTime = new Date('2026-05-05T00:00:30.000Z');
      const diagnosticsByName = new Map(scheduler.diagnostics().map((diagnostic) => [diagnostic.name, diagnostic]));
      const statuses = [...diagnosticsByName.values()].map((diagnostic) => diagnostic.status);

      expect(statuses.every((status) => [
        'idle',
        'blocked',
        'retrying',
        'failed',
        'skipped',
        'partial-failure',
        'lagging',
        'stale-run',
      ].includes(status))).toBe(true);
      expect(diagnosticsByName.get('lagging-job')).toMatchObject({
        status: 'lagging',
        status_reason: 'scheduled_run_lagging',
        lag_seconds: 20,
        observed_lag_seconds: 20,
        next_scheduled_at: '2026-05-05T00:00:10.000Z',
      });
      expect(diagnosticsByName.get('failed-job')).toMatchObject({
        status: 'failed',
        status_reason: 'retry_due_after_failure',
        error_count: 1,
        retry_attempt_count: 1,
        next_retry_at: '2026-05-05T00:00:28.000Z',
      });
      expect(diagnosticsByName.get('partial-job')).toMatchObject({
        status: 'partial-failure',
        status_reason: 'last_success_had_partial_failures',
        partial_failure_count: 1,
      });
      expect(diagnosticsByName.get('skipped-job')).toMatchObject({
        status: 'skipped',
        status_reason: 'last_tick_skipped',
        skipped_count: 1,
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('detects stale in-flight runs and reports recovery eligibility', async () => {
    let currentTime = new Date('2026-05-05T00:00:00.000Z');
    const scheduler = createUnifiedScheduler({
      logger: createLogger(),
      now: () => currentTime,
    });

    scheduler.register({
      name: 'stale-job',
      intervalSeconds: 10,
      staleAfterSeconds: 30,
      run: vi.fn(() => new Promise<void>(() => undefined)),
    });

    void scheduler.runNow('stale-job');
    await Promise.resolve();

    currentTime = new Date('2026-05-05T00:00:31.000Z');

    expect(scheduler.diagnostics()[0]).toMatchObject({
      name: 'stale-job',
      status: 'stale-run',
      status_reason: 'in_flight_run_exceeded_stale_threshold',
      running: true,
      stale_run: {
        is_stale: true,
        owning_job: 'stale-job',
        started_at: '2026-05-05T00:00:00.000Z',
        heartbeat_at: '2026-05-05T00:00:00.000Z',
        stale_after_seconds: 30,
        stale_duration_seconds: 1,
        recovery_eligible: true,
        recovery_reason: 'stale_run_exceeded_threshold',
      },
    });
  });

  it('bounds shutdown when a background job does not settle', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const scheduler = createUnifiedScheduler({ logger });

    scheduler.register({
      name: 'hung-job',
      intervalSeconds: 60,
      run: vi.fn(() => new Promise<void>(() => undefined)),
    });

    void scheduler.runNow('hung-job');
    await vi.advanceTimersByTimeAsync(0);

    const stopped = scheduler.stop({ inFlightTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await stopped;

    expect(scheduler.isStarted()).toBe(false);
    expect(scheduler.diagnostics()[0]).toMatchObject({
      name: 'hung-job',
      running: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobs: ['hung-job'],
        timeout_ms: 50,
      }),
      'background scheduler stopped with jobs still active after shutdown timeout',
    );
    vi.useRealTimers();
  });

  it('exposes partial failure counts and sanitized samples from successful mixed job runs', async () => {
    const logger = createLogger();
    const scheduler = createUnifiedScheduler({
      logger,
      now: () => new Date('2026-05-05T00:00:00.000Z'),
    });

    scheduler.register({
      name: 'mixed-job',
      intervalSeconds: 60,
      run: vi.fn(async () => ({
        targetsProcessed: 3,
        rowsWritten: 2,
        partialFailures: [
          {
            target: 'eth:0xpool',
            reason: 'upstream timeout token=secret-token /home/whoami/dev/opengecko/data/runtime.sqlite',
          },
        ],
      })),
    });

    await scheduler.runNow('mixed-job');

    expect(scheduler.diagnostics()[0]).toMatchObject({
      name: 'mixed-job',
      rows_written: 2,
      partial_failure_count: 1,
      partial_failure_samples: [
        {
          target: 'eth:0xpool',
          reason: expect.stringContaining('credential=[redacted]'),
        },
      ],
    });
    expect(scheduler.diagnostics()[0]?.partial_failure_samples[0]?.reason).not.toContain('secret-token');
    expect(scheduler.diagnostics()[0]?.partial_failure_samples[0]?.reason).not.toContain('/home/whoami/dev/opengecko/data/runtime.sqlite');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        job: 'mixed-job',
        rows_written: 2,
        partial_failure_count: 1,
        partial_failure_samples: [
          expect.objectContaining({
            reason: expect.stringContaining('credential=[redacted]'),
          }),
        ],
      }),
      'background job completed job=mixed-job',
    );
  });

  it('bounds and redacts standalone diagnostic error text', () => {
    const sanitized = sanitizeSchedulerDiagnosticError(
      `Authorization: Bearer scheduler-secret-token database_url=/home/whoami/dev/opengecko/data/opengecko.db path /home/whoami/dev/opengecko/data/runtime.sqlite password=hunter2 https://provider.example/v1/prices?api_key=url-secret&ids=bitcoin ${'x'.repeat(600)}`,
    );

    expect(sanitized).toContain('credential=[redacted]');
    expect(sanitized).toContain('authorization=[redacted]');
    expect(sanitized).toContain('[path redacted]');
    expect(sanitized).toContain('?redacted');
    expect(sanitized).not.toContain('hunter2');
    expect(sanitized).not.toContain('scheduler-secret-token');
    expect(sanitized).not.toContain('url-secret');
    expect(sanitized).not.toContain('/home/whoami/dev/opengecko/data/opengecko.db');
    expect(sanitized).not.toContain('/home/whoami/dev/opengecko/data/runtime.sqlite');
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });

  it('emits sanitized structured failure logs matching diagnostics', async () => {
    const logger = createLogger();
    const scheduler = createUnifiedScheduler({
      logger,
      now: () => new Date('2026-05-05T00:00:00.000Z'),
    });

    scheduler.register({
      name: 'secret-failure-job',
      intervalSeconds: 60,
      run: vi.fn(async () => {
        throw new Error(
          'POST failed Authorization=Bearer log-secret-token token=query-secret /home/whoami/dev/opengecko/data/runtime.sqlite\n    at providerStack',
        );
      }),
    });

    await scheduler.runNow('secret-failure-job');

    const diagnosticError = scheduler.diagnostics()[0]?.last_error;
    const logError = logger.error.mock.calls[0]?.[0]?.error;
    expect(logError).toBe(diagnosticError);
    expect(logError).toContain('authorization=[redacted]');
    expect(logError).toContain('credential=[redacted]');
    expect(logError).toContain('[path redacted]');
    expect(logError).not.toContain('log-secret-token');
    expect(logError).not.toContain('query-secret');
    expect(logError).not.toContain('/home/whoami/dev/opengecko/data/runtime.sqlite');
    expect(logError).not.toContain('providerStack');
  });
});
