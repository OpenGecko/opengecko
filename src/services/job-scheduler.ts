import type { FastifyBaseLogger } from 'fastify';

import { sanitizeDiagnosticText } from './diagnostic-sanitizer';
import type { MetricsRegistry } from './metrics';

export type SchedulerJobResult = {
  targetsProcessed?: number | null;
  rowsWritten?: number | null;
  rowsPruned?: number | null;
  partialFailures?: Array<{ target: string; reason: string }> | null;
};

type SchedulerJobRunner = () => Promise<SchedulerJobResult | void>;

type SchedulerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export type SchedulerJobDefinition = {
  name: string;
  intervalSeconds: number;
  staleAfterSeconds?: number;
  disabled?: boolean;
  run: SchedulerJobRunner;
  runImmediately?: boolean;
};

export const SCHEDULER_JOB_STATUS_VALUES = [
  'idle',
  'blocked',
  'retrying',
  'failed',
  'skipped',
  'partial-failure',
  'lagging',
  'stale-run',
] as const;

export type SchedulerJobStatus = typeof SCHEDULER_JOB_STATUS_VALUES[number];

export type SchedulerJobDiagnostic = {
  name: string;
  interval_seconds: number;
  disabled: boolean;
  status: SchedulerJobStatus;
  status_reason: string;
  running: boolean;
  last_run_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  error_count: number;
  lag_seconds: number | null;
  observed_lag_seconds: number | null;
  next_run_at: string | null;
  next_scheduled_at: string | null;
  next_retry_at: string | null;
  retry_attempt_count: number;
  backoff: {
    active: boolean;
    attempt_count: number;
    next_retry_at: string | null;
  };
  stale_run: {
    is_stale: boolean;
    owning_job: string | null;
    started_at: string | null;
    heartbeat_at: string | null;
    stale_after_seconds: number;
    stale_duration_seconds: number | null;
    recovery_eligible: boolean;
    recovery_reason: string | null;
  };
  run_count: number;
  success_count: number;
  skipped_count: number;
  rows_written: number | null;
  rows_pruned: number | null;
  partial_failure_count: number;
  partial_failure_samples: Array<{ target: string; reason: string }>;
};

type SchedulerJobState = {
  definition: SchedulerJobDefinition;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  inFlightStartedAt: Date | null;
  inFlightHeartbeatAt: Date | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastDurationMs: number | null;
  lastError: string | null;
  errorCount: number;
  runCount: number;
  successCount: number;
  skippedCount: number;
  rowsWritten: number | null;
  rowsPruned: number | null;
  partialFailureCount: number;
  partialFailureSamples: Array<{ target: string; reason: string }>;
  nextEligibleAt: Date | null;
  lastSkipReason: 'running' | 'backoff' | 'disabled' | 'stopped' | null;
  stopped: boolean;
};

export type UnifiedScheduler = ReturnType<typeof createUnifiedScheduler>;

type SchedulerStopOptions = {
  inFlightTimeoutMs?: number;
};

const DEFAULT_IN_FLIGHT_SHUTDOWN_TIMEOUT_MS = 2_500;
const DEFAULT_MIN_STALE_RUN_THRESHOLD_SECONDS = 60;

function formatTimestamp(date: Date | null) {
  return date?.toISOString() ?? null;
}

export function sanitizeSchedulerDiagnosticError(error: unknown) {
  return sanitizeDiagnosticText(error);
}

function computeBackoffMs(intervalSeconds: number, errorCount: number) {
  const baseMs = Math.max(1_000, Math.min(intervalSeconds * 1000, 30_000));
  const exponentialMs = Math.min(baseMs * (2 ** Math.max(errorCount - 1, 0)), 5 * 60_000);
  const jitterRatio = 0.8 + (Math.random() * 0.4);
  return Math.round(exponentialMs * jitterRatio);
}

function computeLagSeconds(state: SchedulerJobState, now: Date) {
  if (!state.lastRunAt) {
    return null;
  }

  const dueAt = state.lastRunAt.getTime() + (state.definition.intervalSeconds * 1000);
  return Math.max(0, Math.floor((now.getTime() - dueAt) / 1000));
}

function computeNextScheduledAt(state: SchedulerJobState) {
  if (!state.lastRunAt) {
    return null;
  }

  return new Date(state.lastRunAt.getTime() + (state.definition.intervalSeconds * 1000));
}

function staleAfterSecondsForDefinition(definition: SchedulerJobDefinition) {
  return definition.staleAfterSeconds
    ?? Math.max(DEFAULT_MIN_STALE_RUN_THRESHOLD_SECONDS, definition.intervalSeconds * 3);
}

function buildStaleRunDiagnostic(state: SchedulerJobState, now: Date): SchedulerJobDiagnostic['stale_run'] {
  const staleAfterSeconds = staleAfterSecondsForDefinition(state.definition);
  if (!state.inFlightStartedAt) {
    return {
      is_stale: false,
      owning_job: null,
      started_at: null,
      heartbeat_at: null,
      stale_after_seconds: staleAfterSeconds,
      stale_duration_seconds: null,
      recovery_eligible: false,
      recovery_reason: null,
    };
  }

  const heartbeatAt = state.inFlightHeartbeatAt ?? state.inFlightStartedAt;
  const staleDurationSeconds = Math.floor(
    (now.getTime() - heartbeatAt.getTime() - (staleAfterSeconds * 1000)) / 1000,
  );
  const isStale = staleDurationSeconds > 0;

  return {
    is_stale: isStale,
    owning_job: state.definition.name,
    started_at: formatTimestamp(state.inFlightStartedAt),
    heartbeat_at: formatTimestamp(heartbeatAt),
    stale_after_seconds: staleAfterSeconds,
    stale_duration_seconds: isStale ? staleDurationSeconds : null,
    recovery_eligible: isStale,
    recovery_reason: isStale ? 'stale_run_exceeded_threshold' : null,
  };
}

function buildBackoffDiagnostic(state: SchedulerJobState, now: Date): SchedulerJobDiagnostic['backoff'] {
  const active = state.nextEligibleAt !== null && now < state.nextEligibleAt;
  return {
    active,
    attempt_count: state.errorCount,
    next_retry_at: state.nextEligibleAt && state.errorCount > 0 ? state.nextEligibleAt.toISOString() : null,
  };
}

function resolveJobStatus(
  state: SchedulerJobState,
  now: Date,
  lagSeconds: number | null,
  staleRun: SchedulerJobDiagnostic['stale_run'],
  schedulerDisabled: boolean,
): { status: SchedulerJobStatus; reason: string } {
  if (schedulerDisabled) {
    return { status: 'blocked', reason: 'scheduler_disabled' };
  }

  if (state.definition.disabled) {
    return { status: 'blocked', reason: 'job_disabled' };
  }

  if (staleRun.is_stale) {
    return { status: 'stale-run', reason: 'in_flight_run_exceeded_stale_threshold' };
  }

  if (state.inFlight) {
    if (state.lastSkipReason === 'running') {
      return { status: 'blocked', reason: 'previous_run_still_active' };
    }
    return { status: 'idle', reason: 'run_in_progress' };
  }

  if (state.nextEligibleAt && now < state.nextEligibleAt) {
    return { status: 'retrying', reason: 'retry_backoff_active' };
  }

  if (state.errorCount > 0 && state.lastError) {
    return { status: 'failed', reason: 'retry_due_after_failure' };
  }

  if (state.partialFailureCount > 0) {
    return { status: 'partial-failure', reason: 'last_success_had_partial_failures' };
  }

  if (state.lastSkipReason) {
    return { status: 'skipped', reason: 'last_tick_skipped' };
  }

  if (lagSeconds !== null && lagSeconds > 0) {
    return { status: 'lagging', reason: 'scheduled_run_lagging' };
  }

  return { status: 'idle', reason: 'waiting_for_next_scheduled_run' };
}

function sanitizePartialFailures(failures: SchedulerJobResult['partialFailures']) {
  return (failures ?? [])
    .slice(0, 5)
    .map((failure) => ({
      target: sanitizeSchedulerDiagnosticError(failure.target),
      reason: sanitizeSchedulerDiagnosticError(failure.reason),
    }));
}

async function waitForInFlightJobsDuringShutdown(
  states: SchedulerJobState[],
  timeoutMs: number,
  logger: SchedulerLogger,
) {
  const inFlightStates = states.filter((state) => state.inFlight);

  if (inFlightStates.length === 0) {
    return;
  }

  if (timeoutMs <= 0) {
    logger.warn({
      timestamp: new Date().toISOString(),
      jobs: inFlightStates.map((state) => state.definition.name),
      timeout_ms: timeoutMs,
    }, 'background scheduler stopped with jobs still active after shutdown timeout');
    return;
  }

  let timeout: NodeJS.Timeout | null = null;
  const allSettled = Promise.all(inFlightStates.map(async (state) => state.inFlight)).then(() => false);
  const timedOut = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(true), timeoutMs);
    timeout.unref();
  });
  const shutdownTimedOut = await Promise.race([allSettled, timedOut]);

  if (timeout) {
    clearTimeout(timeout);
  }

  if (shutdownTimedOut) {
    logger.warn({
      timestamp: new Date().toISOString(),
      jobs: inFlightStates
        .filter((state) => state.inFlight)
        .map((state) => state.definition.name),
      timeout_ms: timeoutMs,
    }, 'background scheduler stopped with jobs still active after shutdown timeout');
  }
}

export function createUnifiedScheduler(options: {
  logger: SchedulerLogger;
  metrics?: MetricsRegistry;
  disabled?: boolean;
  now?: () => Date;
}) {
  const jobs = new Map<string, SchedulerJobState>();
  const now = options.now ?? (() => new Date());
  let started = false;

  function recordSkip(state: SchedulerJobState, reason: 'running' | 'backoff' | 'disabled' | 'stopped') {
    state.skippedCount += 1;
    state.lastSkipReason = reason;
    options.metrics?.incrementCounter('opengecko_scheduler_job_skips_total', {
      job: state.definition.name,
      reason,
    });
  }

  async function runJob(name: string) {
    const state = jobs.get(name);

    if (!state) {
      throw new Error(`Unknown scheduler job: ${name}`);
    }

    if (options.disabled || state.definition.disabled) {
      recordSkip(state, 'disabled');
      return;
    }

    if (state.stopped) {
      recordSkip(state, 'stopped');
      return;
    }

    if (state.inFlight) {
      recordSkip(state, 'running');
      options.logger.warn({ timestamp: now().toISOString(), job: name }, `background job skipped because the previous run is still active job=${name}`);
      return state.inFlight;
    }

    const currentTime = now();
    if (state.nextEligibleAt && currentTime < state.nextEligibleAt) {
      recordSkip(state, 'backoff');
      return;
    }

    state.inFlight = (async () => {
      const startedAt = now();
      state.inFlightStartedAt = startedAt;
      state.inFlightHeartbeatAt = startedAt;
      state.lastRunAt = startedAt;
      state.runCount += 1;

      try {
        const result = await state.definition.run();
        const finishedAt = now();
        state.lastDurationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
        state.lastSuccessAt = finishedAt;
        state.lastError = null;
        state.errorCount = 0;
        state.lastFailureAt = null;
        state.successCount += 1;
        state.rowsWritten = result?.rowsWritten ?? null;
        state.rowsPruned = result?.rowsPruned ?? null;
        state.partialFailureCount = result?.partialFailures?.length ?? 0;
        state.partialFailureSamples = sanitizePartialFailures(result?.partialFailures);
        state.nextEligibleAt = null;
        state.lastSkipReason = null;
        options.metrics?.incrementCounter('opengecko_scheduler_job_runs_total', {
          job: name,
          outcome: 'success',
        });
        options.metrics?.observeHistogram('opengecko_scheduler_job_duration_ms', {
          job: name,
          outcome: 'success',
        }, state.lastDurationMs);
        options.logger.info({
          timestamp: finishedAt.toISOString(),
          job: name,
          name,
          duration_ms: state.lastDurationMs,
          outcome: 'success',
          targets_processed: result?.targetsProcessed ?? null,
          rows_written: state.rowsWritten,
          rows_pruned: state.rowsPruned,
          partial_failure_count: state.partialFailureCount,
          partial_failure_samples: state.partialFailureSamples,
        }, `background job completed job=${name}`);
      } catch (error) {
        const finishedAt = now();
        const message = sanitizeSchedulerDiagnosticError(error);
        state.lastDurationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
        state.lastError = message;
        state.lastFailureAt = finishedAt;
        state.errorCount += 1;
        state.rowsWritten = null;
        state.rowsPruned = null;
        state.partialFailureCount = 0;
        state.partialFailureSamples = [];
        state.nextEligibleAt = new Date(finishedAt.getTime() + computeBackoffMs(state.definition.intervalSeconds, state.errorCount));
        options.metrics?.incrementCounter('opengecko_scheduler_job_runs_total', {
          job: name,
          outcome: 'failure',
        });
        options.metrics?.observeHistogram('opengecko_scheduler_job_duration_ms', {
          job: name,
          outcome: 'failure',
        }, state.lastDurationMs);
        options.logger.error({
          timestamp: finishedAt.toISOString(),
          job: name,
          name,
          duration_ms: state.lastDurationMs,
          outcome: 'failure',
          error: message,
          targets_processed: null,
          rows_written: null,
          rows_pruned: null,
          partial_failure_count: 0,
          partial_failure_samples: [],
        }, 'background job failed');
      } finally {
        state.inFlight = null;
        state.inFlightStartedAt = null;
        state.inFlightHeartbeatAt = null;
      }
    })();

    return state.inFlight;
  }

  return {
    register(definition: SchedulerJobDefinition) {
      if (jobs.has(definition.name)) {
        throw new Error(`Scheduler job already registered: ${definition.name}`);
      }

      jobs.set(definition.name, {
        definition,
        timer: null,
        inFlight: null,
        inFlightStartedAt: null,
        inFlightHeartbeatAt: null,
        lastRunAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDurationMs: null,
        lastError: null,
        errorCount: 0,
        runCount: 0,
        successCount: 0,
        skippedCount: 0,
        rowsWritten: null,
        rowsPruned: null,
        partialFailureCount: 0,
        partialFailureSamples: [],
        nextEligibleAt: null,
        lastSkipReason: null,
        stopped: false,
      });
    },
    start() {
      if (started) {
        return;
      }

      started = true;

      for (const state of jobs.values()) {
        state.stopped = false;

        if (state.definition.disabled || options.disabled) {
          continue;
        }

        if (state.definition.runImmediately) {
          void runJob(state.definition.name);
        }

        state.timer = setInterval(() => {
          void runJob(state.definition.name);
        }, state.definition.intervalSeconds * 1000);
      }
    },
    async runNow(name: string) {
      return runJob(name);
    },
    async stop(stopOptions: SchedulerStopOptions = {}) {
      for (const state of jobs.values()) {
        state.stopped = true;
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
      }

      await waitForInFlightJobsDuringShutdown(
        [...jobs.values()],
        stopOptions.inFlightTimeoutMs ?? DEFAULT_IN_FLIGHT_SHUTDOWN_TIMEOUT_MS,
        options.logger,
      );
      started = false;
    },
    diagnostics(): SchedulerJobDiagnostic[] {
      const snapshotTime = now();
      return [...jobs.values()].map((state) => {
        const lagSeconds = computeLagSeconds(state, snapshotTime);
        const staleRun = buildStaleRunDiagnostic(state, snapshotTime);
        const status = resolveJobStatus(state, snapshotTime, lagSeconds, staleRun, Boolean(options.disabled));
        const nextScheduledAt = computeNextScheduledAt(state);
        const nextRetryAt = state.nextEligibleAt && state.errorCount > 0 ? state.nextEligibleAt.toISOString() : null;

        return {
          name: state.definition.name,
          interval_seconds: state.definition.intervalSeconds,
          disabled: Boolean(options.disabled || state.definition.disabled),
          status: status.status,
          status_reason: status.reason,
          running: state.inFlight !== null,
          last_run_at: formatTimestamp(state.lastRunAt),
          last_success_at: formatTimestamp(state.lastSuccessAt),
          last_failure_at: formatTimestamp(state.lastFailureAt),
          last_duration_ms: state.lastDurationMs,
          last_error: state.lastError,
          error_count: state.errorCount,
          lag_seconds: lagSeconds,
          observed_lag_seconds: lagSeconds,
          next_run_at: state.nextEligibleAt ? state.nextEligibleAt.toISOString() : null,
          next_scheduled_at: formatTimestamp(nextScheduledAt),
          next_retry_at: nextRetryAt,
          retry_attempt_count: state.errorCount,
          backoff: buildBackoffDiagnostic(state, snapshotTime),
          stale_run: staleRun,
          run_count: state.runCount,
          success_count: state.successCount,
          skipped_count: state.skippedCount,
          rows_written: state.rowsWritten,
          rows_pruned: state.rowsPruned,
          partial_failure_count: state.partialFailureCount,
          partial_failure_samples: state.partialFailureSamples,
        };
      });
    },
    isStarted() {
      return started;
    },
    registeredJobNames() {
      return [...jobs.keys()];
    },
  };
}
