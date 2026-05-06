import type { FastifyBaseLogger } from 'fastify';

import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { parseCoinHistoryTargetConfig } from './coin-history-sync';
import { syncCoinHistorySnapshots } from './coin-history-sync';
import { parseExchangeVolumeTargetConfig, syncExchangeVolumes } from './exchange-volume-sync';
import { parseMarketChartTargetConfig, syncMarketCharts } from './market-chart-sync';
import { parseOnchainAnalyticsTargetConfig, syncOnchainAnalytics } from './onchain-analytics-sync';
import { parseOnchainTradeTargetConfig, syncOnchainTrades } from './onchain-trade-sync';
import {
  type OptionalProviderJobPartialFailureSample,
  type OptionalProviderJobId,
  type OptionalProviderJobRegistry,
  recordOptionalProviderJobRunFailure,
  recordOptionalProviderJobRunRunning,
  recordOptionalProviderJobRunSuccess,
} from './optional-provider-jobs';
import { parseSupplyChartTargetConfig, syncSupplyCharts } from './supply-chart-sync';

type SchedulerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export type OptionalProviderScheduledJobResult = {
  targetsAttempted: number;
  rowsWritten: number;
  partialFailureReason?: string | null;
  partialFailureSamples?: OptionalProviderJobPartialFailureSample[] | null;
};

export type OptionalProviderScheduledJob = {
  id: OptionalProviderJobId;
  configuredTargetCount: () => number;
  run: () => Promise<OptionalProviderScheduledJobResult>;
};

export type OptionalProviderSyncScheduler = ReturnType<typeof createOptionalProviderSyncScheduler>;

function formatRfc3339Timestamp() {
  return new Date().toISOString().replace('.000Z', 'Z');
}

export function createConfiguredOptionalProviderSyncJobs(
  database: AppDatabase,
  config: Pick<AppConfig,
    | 'coinHistoryTargets'
    | 'exchangeVolumeTargets'
    | 'marketChartTargets'
    | 'onchainAnalyticsTargets'
    | 'onchainTradeTargets'
    | 'supplyChartTargets'
  >,
  env: NodeJS.ProcessEnv = process.env,
): OptionalProviderScheduledJob[] {
  return [
    {
      id: 'coin_history',
      configuredTargetCount: () => parseCoinHistoryTargetConfig(config.coinHistoryTargets).length,
      run: async () => {
        const targets = parseCoinHistoryTargetConfig(config.coinHistoryTargets);
        if (targets.length === 0) {
          return { targetsAttempted: 0, rowsWritten: 0 };
        }
        const result = await syncCoinHistorySnapshots(database, {
          targets,
          providerBaseUrl: env.COIN_HISTORY_BASE_URL,
        });
        return { targetsAttempted: result.targets_attempted, rowsWritten: result.snapshots_written };
      },
    },
    {
      id: 'exchange_volumes',
      configuredTargetCount: () => parseExchangeVolumeTargetConfig(config.exchangeVolumeTargets).length,
      run: async () => {
        const targets = parseExchangeVolumeTargetConfig(config.exchangeVolumeTargets);
        if (targets.length === 0) {
          return { targetsAttempted: 0, rowsWritten: 0 };
        }
        const result = await syncExchangeVolumes(database, {
          targets,
          providerBaseUrl: env.EXCHANGE_VOLUME_BASE_URL,
        });
        return { targetsAttempted: result.targets_attempted, rowsWritten: result.points_written };
      },
    },
    {
      id: 'market_charts',
      configuredTargetCount: () => parseMarketChartTargetConfig(config.marketChartTargets).length,
      run: async () => {
        const targets = parseMarketChartTargetConfig(config.marketChartTargets);
        if (targets.length === 0) {
          return { targetsAttempted: 0, rowsWritten: 0 };
        }
        const result = await syncMarketCharts(database, {
          targets,
          providerBaseUrl: env.MARKET_CHART_BASE_URL,
        });
        const firstFailedTarget = result.results.find((targetResult) => targetResult.status === 'failed');
        return {
          targetsAttempted: result.targets_attempted,
          rowsWritten: result.points_written,
          partialFailureReason: result.targets_failed > 0
            ? `${result.targets_failed} market chart target(s) failed; first failure: ${firstFailedTarget?.error ?? 'unknown failure'}`
            : null,
          partialFailureSamples: result.results
            .filter((targetResult) => targetResult.status === 'failed')
            .slice(0, 5)
            .map((targetResult) => ({
              provider: targetResult.provider,
              coin_id: targetResult.coin_id,
              vs_currency: targetResult.vs_currency,
              interval: targetResult.interval,
              error: targetResult.error ?? 'unknown failure',
            })),
        };
      },
    },
    {
      id: 'onchain_analytics',
      configuredTargetCount: () => parseOnchainAnalyticsTargetConfig(config.onchainAnalyticsTargets).length,
      run: async () => {
        const targets = parseOnchainAnalyticsTargetConfig(config.onchainAnalyticsTargets);
        if (targets.length === 0) {
          return { targetsAttempted: 0, rowsWritten: 0 };
        }
        const result = await syncOnchainAnalytics(database, {
          targets,
          providerBaseUrl: env.ONCHAIN_ANALYTICS_BASE_URL,
        });
        return {
          targetsAttempted: result.targets_attempted,
          rowsWritten: result.holders_written + result.traders_written + result.holder_counts_written,
        };
      },
    },
    {
      id: 'onchain_trades',
      configuredTargetCount: () => parseOnchainTradeTargetConfig(config.onchainTradeTargets).length,
      run: async () => {
        const targets = parseOnchainTradeTargetConfig(config.onchainTradeTargets);
        if (targets.length === 0) {
          return { targetsAttempted: 0, rowsWritten: 0 };
        }
        const result = await syncOnchainTrades(database, {
          targets,
          providerBaseUrl: env.ONCHAIN_TRADE_BASE_URL,
        });
        return { targetsAttempted: result.targets_attempted, rowsWritten: result.trades_written };
      },
    },
    {
      id: 'supply_charts',
      configuredTargetCount: () => parseSupplyChartTargetConfig(config.supplyChartTargets).length,
      run: async () => {
        const targets = parseSupplyChartTargetConfig(config.supplyChartTargets);
        if (targets.length === 0) {
          return { targetsAttempted: 0, rowsWritten: 0 };
        }
        const result = await syncSupplyCharts(database, {
          targets,
          providerBaseUrl: env.SUPPLY_CHART_BASE_URL,
        });
        return { targetsAttempted: result.targets_attempted, rowsWritten: result.points_written };
      },
    },
  ];
}

export function createOptionalProviderSyncScheduler(options: {
  enabled: boolean;
  intervalSeconds: number;
  jobs: OptionalProviderScheduledJob[];
  registry: OptionalProviderJobRegistry;
  logger: SchedulerLogger;
  database?: AppDatabase;
}) {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  async function runOnce() {
    if (inFlight) {
      options.logger.warn({ timestamp: formatRfc3339Timestamp() }, 'optional provider sync skipped because the previous run is still active');
      return inFlight;
    }

    inFlight = (async () => {
      for (const job of options.jobs) {
        const startedAt = new Date();
        const configuredTargetCount = job.configuredTargetCount();
        options.registry.recordRunning(job.id, startedAt, configuredTargetCount);
        if (options.database) {
          recordOptionalProviderJobRunRunning(options.database, job.id, startedAt, configuredTargetCount);
        }

        try {
          const result = await job.run();
          const outcome = {
            startedAt,
            finishedAt: new Date(),
            targetsAttempted: result.targetsAttempted,
            rowsWritten: result.rowsWritten,
            partialFailureReason: result.partialFailureReason,
            partialFailureSamples: result.partialFailureSamples,
          };
          options.registry.recordSuccess(job.id, outcome);
          if (options.database) {
            recordOptionalProviderJobRunSuccess(options.database, job.id, outcome);
          }
          options.logger.info({ job: job.id, rowsWritten: result.rowsWritten }, 'optional provider sync job completed');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const outcome = {
            startedAt,
            finishedAt: new Date(),
            targetsAttempted: configuredTargetCount,
            error: message,
          };
          options.registry.recordFailure(job.id, outcome);
          if (options.database) {
            recordOptionalProviderJobRunFailure(options.database, job.id, outcome);
          }
          options.logger.error({ job: job.id, error: message }, 'optional provider sync job failed');
        }
      }
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  return {
    start() {
      if (!options.enabled || timer) {
        return;
      }

      timer = setInterval(() => {
        void runOnce();
      }, options.intervalSeconds * 1000);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      if (inFlight) {
        await inFlight;
      }
    },
    runOnce,
    isRunning() {
      return inFlight !== null;
    },
    isScheduled() {
      return timer !== null;
    },
  };
}
