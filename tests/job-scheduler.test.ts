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
        disabled: true,
        last_run_at: null,
      }),
    ]);
  });

  it('bounds and redacts standalone diagnostic error text', () => {
    const sanitized = sanitizeSchedulerDiagnosticError(`password=hunter2 ${'x'.repeat(600)}`);

    expect(sanitized).toContain('password=redacted');
    expect(sanitized).not.toContain('hunter2');
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });
});
