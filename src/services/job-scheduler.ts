import type { FastifyBaseLogger } from 'fastify';

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
  disabled?: boolean;
  run: SchedulerJobRunner;
  runImmediately?: boolean;
};

export type SchedulerJobDiagnostic = {
  name: string;
  interval_seconds: number;
  disabled: boolean;
  running: boolean;
  last_run_at: string | null;
  last_success_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  error_count: number;
  lag_seconds: number | null;
  next_run_at: string | null;
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
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
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
  stopped: boolean;
};

export type UnifiedScheduler = ReturnType<typeof createUnifiedScheduler>;

const MAX_ERROR_LENGTH = 500;
const SENSITIVE_QUERY_KEYS = [
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'client_secret',
  'database_url',
  'db_url',
  'key',
  'password',
  'pass',
  'secret',
  'signature',
  'token',
];
const SENSITIVE_QUERY_KEY_PATTERN = SENSITIVE_QUERY_KEYS.join('|');
const SENSITIVE_QUERY_ASSIGNMENT = new RegExp(
  `((?:${SENSITIVE_QUERY_KEY_PATTERN})(?:\\[[^\\]]+\\])?\\s*[=:]\\s*)[^&\\s,;'")]+`,
  'gi',
);
const SENSITIVE_LABEL_ASSIGNMENT = new RegExp(
  `((?:${SENSITIVE_QUERY_KEY_PATTERN})(?:\\[[^\\]]+\\])?\\s*[:=]\\s*)[^\\s,;'")]+`,
  'gi',
);
const AUTHORIZATION_HEADER_PATTERN = /\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s,;'")]+/gi;
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;
const UNIX_SENSITIVE_PATH_PATTERN = /(?:\b[A-Z_]*DATABASE_URL=)?(?:file:)?\/(?:home|Users|root|var|tmp|private|data)\/[^\s,;'")]+/g;
const DATABASE_FILE_PATH_PATTERN = /(?:\b[A-Z_]*DATABASE_URL=)?(?:file:)?(?:\.{0,2}\/)?[A-Za-z0-9._/-]*[A-Za-z0-9_-]+\.(?:sqlite|sqlite3|db)(?:\?[^&\s,;'")]+)?/gi;

function formatTimestamp(date: Date | null) {
  return date?.toISOString() ?? null;
}

export function sanitizeSchedulerDiagnosticError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutStack = raw.split(/\r?\n\s*at\s+/)[0] ?? raw;
  const withoutUrls = withoutStack.replace(/https?:\/\/[^\s]+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      parsed.username = parsed.username ? 'redacted' : '';
      parsed.password = parsed.password ? 'redacted' : '';
      parsed.search = parsed.search ? '?redacted' : '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return '[url redacted]';
    }
  });
  const redacted = withoutUrls
    .replace(AUTHORIZATION_HEADER_PATTERN, '$1redacted')
    .replace(BEARER_TOKEN_PATTERN, '$1redacted')
    .replace(SENSITIVE_QUERY_ASSIGNMENT, '$1redacted')
    .replace(SENSITIVE_LABEL_ASSIGNMENT, '$1redacted')
    .replace(UNIX_SENSITIVE_PATH_PATTERN, '[path redacted]')
    .replace(DATABASE_FILE_PATH_PATTERN, '[database path redacted]');

  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH - 3)}...`
    : redacted;
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

function sanitizePartialFailures(failures: SchedulerJobResult['partialFailures']) {
  return (failures ?? [])
    .slice(0, 5)
    .map((failure) => ({
      target: sanitizeSchedulerDiagnosticError(failure.target),
      reason: sanitizeSchedulerDiagnosticError(failure.reason),
    }));
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
      state.lastRunAt = startedAt;
      state.runCount += 1;

      try {
        const result = await state.definition.run();
        const finishedAt = now();
        state.lastDurationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
        state.lastSuccessAt = finishedAt;
        state.lastError = null;
        state.errorCount = 0;
        state.successCount += 1;
        state.rowsWritten = result?.rowsWritten ?? null;
        state.rowsPruned = result?.rowsPruned ?? null;
        state.partialFailureCount = result?.partialFailures?.length ?? 0;
        state.partialFailureSamples = sanitizePartialFailures(result?.partialFailures);
        state.nextEligibleAt = null;
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
        lastRunAt: null,
        lastSuccessAt: null,
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
    async stop() {
      for (const state of jobs.values()) {
        state.stopped = true;
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
      }

      await Promise.all([...jobs.values()].map(async (state) => {
        if (state.inFlight) {
          await state.inFlight;
        }
      }));
      started = false;
    },
    diagnostics(): SchedulerJobDiagnostic[] {
      const snapshotTime = now();
      return [...jobs.values()].map((state) => ({
        name: state.definition.name,
        interval_seconds: state.definition.intervalSeconds,
        disabled: Boolean(options.disabled || state.definition.disabled),
        running: state.inFlight !== null,
        last_run_at: formatTimestamp(state.lastRunAt),
        last_success_at: formatTimestamp(state.lastSuccessAt),
        last_duration_ms: state.lastDurationMs,
        last_error: state.lastError,
        error_count: state.errorCount,
        lag_seconds: computeLagSeconds(state, snapshotTime),
        next_run_at: state.nextEligibleAt ? state.nextEligibleAt.toISOString() : null,
        run_count: state.runCount,
        success_count: state.successCount,
        skipped_count: state.skippedCount,
        rows_written: state.rowsWritten,
        rows_pruned: state.rowsPruned,
        partial_failure_count: state.partialFailureCount,
        partial_failure_samples: state.partialFailureSamples,
      }));
    },
    isStarted() {
      return started;
    },
    registeredJobNames() {
      return [...jobs.keys()];
    },
  };
}
