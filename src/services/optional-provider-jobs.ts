import { eq } from 'drizzle-orm';

import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { optionalProviderJobRuns, type OptionalProviderJobRunRow } from '../db/schema';
import { parseCoinHistoryTargetConfig } from './coin-history-sync';
import { parseExchangeVolumeTargetConfig } from './exchange-volume-sync';
import { parseMarketChartTargetConfig } from './market-chart-sync';
import { parseOnchainAnalyticsTargetConfig } from './onchain-analytics-sync';
import { parseOnchainTradeTargetConfig } from './onchain-trade-sync';
import { parseSupplyChartTargetConfig } from './supply-chart-sync';

export type OptionalProviderJobId =
  | 'coin_history'
  | 'exchange_volumes'
  | 'market_charts'
  | 'onchain_analytics'
  | 'onchain_trades'
  | 'supply_charts';

type OptionalProviderJobDefinition = {
  id: OptionalProviderJobId;
  command: string;
  targetEnv: string;
  providerBaseUrlEnv: string;
  parseTargetCount: (config: AppConfig) => number;
};

export type OptionalProviderJobSuccess = {
  startedAt: Date;
  finishedAt: Date;
  targetsAttempted: number;
  rowsWritten: number;
};

export type OptionalProviderJobFailure = {
  startedAt: Date;
  finishedAt: Date;
  targetsAttempted: number;
  error: string;
};

type OptionalProviderJobRunState =
  | {
    status: 'running';
    startedAt: Date;
    targetsAttempted: number;
  }
  | {
    status: 'succeeded';
    startedAt: Date;
    finishedAt: Date;
    targetsAttempted: number;
    rowsWritten: number;
  }
  | {
    status: 'failed';
    startedAt: Date;
    finishedAt: Date;
    targetsAttempted: number;
    error: string;
  };

export type OptionalProviderJobRegistry = ReturnType<typeof createOptionalProviderJobRegistry>;

const OPTIONAL_PROVIDER_JOB_DEFINITIONS: OptionalProviderJobDefinition[] = [
  {
    id: 'coin_history',
    command: 'bun run coin:history:sync',
    targetEnv: 'COIN_HISTORY_TARGETS',
    providerBaseUrlEnv: 'COIN_HISTORY_BASE_URL',
    parseTargetCount: (config) => parseCoinHistoryTargetConfig(config.coinHistoryTargets).length,
  },
  {
    id: 'exchange_volumes',
    command: 'bun run exchange:volumes:sync',
    targetEnv: 'EXCHANGE_VOLUME_TARGETS',
    providerBaseUrlEnv: 'EXCHANGE_VOLUME_BASE_URL',
    parseTargetCount: (config) => parseExchangeVolumeTargetConfig(config.exchangeVolumeTargets).length,
  },
  {
    id: 'market_charts',
    command: 'bun run market:charts:sync',
    targetEnv: 'MARKET_CHART_TARGETS',
    providerBaseUrlEnv: 'MARKET_CHART_BASE_URL',
    parseTargetCount: (config) => parseMarketChartTargetConfig(config.marketChartTargets).length,
  },
  {
    id: 'onchain_analytics',
    command: 'bun run onchain:analytics:sync',
    targetEnv: 'ONCHAIN_ANALYTICS_TARGETS',
    providerBaseUrlEnv: 'ONCHAIN_ANALYTICS_BASE_URL',
    parseTargetCount: (config) => parseOnchainAnalyticsTargetConfig(config.onchainAnalyticsTargets).length,
  },
  {
    id: 'onchain_trades',
    command: 'bun run onchain:trades:sync',
    targetEnv: 'ONCHAIN_TRADE_TARGETS',
    providerBaseUrlEnv: 'ONCHAIN_TRADE_BASE_URL',
    parseTargetCount: (config) => parseOnchainTradeTargetConfig(config.onchainTradeTargets).length,
  },
  {
    id: 'supply_charts',
    command: 'bun run supply:charts:sync',
    targetEnv: 'SUPPLY_CHART_TARGETS',
    providerBaseUrlEnv: 'SUPPLY_CHART_BASE_URL',
    parseTargetCount: (config) => parseSupplyChartTargetConfig(config.supplyChartTargets).length,
  },
];

function durationMs(startedAt: Date, finishedAt: Date) {
  return Math.max(finishedAt.getTime() - startedAt.getTime(), 0);
}

function upsertOptionalProviderJobRun(
  database: AppDatabase,
  values: typeof optionalProviderJobRuns.$inferInsert,
) {
  database.db
    .insert(optionalProviderJobRuns)
    .values(values)
    .onConflictDoUpdate({
      target: optionalProviderJobRuns.jobId,
      set: {
        status: values.status,
        startedAt: values.startedAt,
        finishedAt: values.finishedAt ?? null,
        targetsAttempted: values.targetsAttempted,
        rowsWritten: values.rowsWritten ?? null,
        failureReason: values.failureReason ?? null,
        updatedAt: values.updatedAt,
      },
    })
    .run();
}

function rowToRunState(row: OptionalProviderJobRunRow): OptionalProviderJobRunState {
  if (row.status === 'running') {
    return {
      status: 'running',
      startedAt: row.startedAt,
      targetsAttempted: row.targetsAttempted,
    };
  }

  if (row.status === 'succeeded') {
    return {
      status: 'succeeded',
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? row.updatedAt,
      targetsAttempted: row.targetsAttempted,
      rowsWritten: row.rowsWritten ?? 0,
    };
  }

  return {
    status: 'failed',
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? row.updatedAt,
    targetsAttempted: row.targetsAttempted,
    error: row.failureReason ?? 'unknown failure',
  };
}

export function recordOptionalProviderJobRunRunning(
  database: AppDatabase,
  jobId: OptionalProviderJobId,
  startedAt: Date,
  targetsAttempted: number,
) {
  upsertOptionalProviderJobRun(database, {
    jobId,
    status: 'running',
    startedAt,
    finishedAt: null,
    targetsAttempted,
    rowsWritten: null,
    failureReason: null,
    updatedAt: startedAt,
  });
}

export function recordOptionalProviderJobRunSuccess(
  database: AppDatabase,
  jobId: OptionalProviderJobId,
  result: OptionalProviderJobSuccess,
) {
  upsertOptionalProviderJobRun(database, {
    jobId,
    status: 'succeeded',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    targetsAttempted: result.targetsAttempted,
    rowsWritten: result.rowsWritten,
    failureReason: null,
    updatedAt: result.finishedAt,
  });
}

export function recordOptionalProviderJobRunFailure(
  database: AppDatabase,
  jobId: OptionalProviderJobId,
  result: OptionalProviderJobFailure,
) {
  upsertOptionalProviderJobRun(database, {
    jobId,
    status: 'failed',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    targetsAttempted: result.targetsAttempted,
    rowsWritten: null,
    failureReason: result.error,
    updatedAt: result.finishedAt,
  });
}

export function readOptionalProviderJobRunState(
  database: AppDatabase,
  jobId: OptionalProviderJobId,
) {
  const row = database.db
    .select()
    .from(optionalProviderJobRuns)
    .where(eq(optionalProviderJobRuns.jobId, jobId))
    .get();

  return row ? rowToRunState(row) : null;
}

export function createOptionalProviderJobRegistry() {
  const states = new Map<OptionalProviderJobId, OptionalProviderJobRunState>();

  return {
    recordRunning(jobId: OptionalProviderJobId, startedAt: Date, targetsAttempted: number) {
      states.set(jobId, {
        status: 'running',
        startedAt,
        targetsAttempted,
      });
    },
    recordSuccess(jobId: OptionalProviderJobId, result: OptionalProviderJobSuccess) {
      states.set(jobId, {
        status: 'succeeded',
        ...result,
      });
    },
    recordFailure(jobId: OptionalProviderJobId, result: OptionalProviderJobFailure) {
      states.set(jobId, {
        status: 'failed',
        ...result,
      });
    },
    get(jobId: OptionalProviderJobId) {
      return states.get(jobId) ?? null;
    },
  };
}

export function buildOptionalProviderJobDiagnostics(
  config: AppConfig,
  registry: OptionalProviderJobRegistry,
  database?: AppDatabase,
) {
  const jobs = OPTIONAL_PROVIDER_JOB_DEFINITIONS.map((definition) => {
    const configuredTargetCount = definition.parseTargetCount(config);
    const runState = registry.get(definition.id)
      ?? (database ? readOptionalProviderJobRunState(database, definition.id) : null);
    const status = runState?.status
      ?? (configuredTargetCount === 0 ? 'not_configured' : 'configured_pending');
    const startedAt = runState?.startedAt ?? null;
    const finishedAt = runState && runState.status !== 'running' ? runState.finishedAt : null;

    return {
      id: definition.id,
      status,
      command: definition.command,
      target_env: definition.targetEnv,
      provider_base_url_env: definition.providerBaseUrlEnv,
      configured_target_count: configuredTargetCount,
      last_started_at: startedAt?.toISOString() ?? null,
      last_finished_at: finishedAt?.toISOString() ?? null,
      last_duration_ms: startedAt && finishedAt ? durationMs(startedAt, finishedAt) : null,
      last_targets_attempted: runState?.targetsAttempted ?? null,
      last_rows_written: runState?.status === 'succeeded' ? runState.rowsWritten : null,
      last_failure_reason: runState?.status === 'failed' ? runState.error : null,
    };
  });

  return {
    jobs,
    summary: {
      total: jobs.length,
      not_configured: jobs.filter((job) => job.status === 'not_configured').length,
      configured_pending: jobs.filter((job) => job.status === 'configured_pending').length,
      running: jobs.filter((job) => job.status === 'running').length,
      succeeded: jobs.filter((job) => job.status === 'succeeded').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
    },
    notes: 'Optional provider sync jobs can run as standalone commands or through the optional scheduler; this diagnostics view reports configured target counts and last persisted or in-process run outcomes without exposing provider credentials.',
  };
}
