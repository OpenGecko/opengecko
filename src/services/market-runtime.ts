import type { FastifyBaseLogger } from 'fastify';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { refreshCurrencyApiRatesOnce } from './currency-rates';
import { runInitialMarketSync } from './initial-sync';
import { createUnifiedScheduler, type UnifiedScheduler } from './job-scheduler';
import { runMarketRefreshOnce } from './market-refresh';
import {
  bumpMarketDataRevision,
  completeInitialMarketSync,
  enableStaleLiveFallback,
  markMarketRuntimeListenerBound,
  markMarketRuntimeListenerStopped,
  recordInitialSyncFailure,
  recordMarketRefreshFailure,
  recordMarketRefreshSuccess,
  type MarketDataRuntimeState,
} from './market-runtime-state';
import type { MetricsRegistry } from './metrics';
import { createOhlcvRuntime } from './ohlcv-runtime';
import {
  createOptionalProviderJobRegistry,
  type OptionalProviderJobRegistry,
} from './optional-provider-jobs';
import {
  createConfiguredOptionalProviderSyncJobs,
  createOptionalProviderSyncScheduler,
} from './optional-provider-scheduler';
import { runSearchRebuildOnce } from './search-rebuild';
import { runStartupPrewarm } from './startup-prewarm';
import type { StartupProgressReporter } from './startup-progress';
import { registerTier1SchedulerJobs } from './tier1-jobs';

type RuntimeLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug' | 'child'>;
type JobRunner = () => Promise<void>;
type RuntimeConfig = Pick<AppConfig,
  | 'ccxtExchanges'
  | 'currencyRefreshIntervalSeconds'
  | 'marketRefreshIntervalSeconds'
  | 'searchRebuildIntervalSeconds'
  | 'ohlcvRefreshIntervalSeconds'
  | 'defillamaPoolSweepIntervalSeconds'
  | 'defillamaTokenSweepIntervalSeconds'
  | 'subsquidTradeSweepIntervalSeconds'
  | 'coinCatalogRescanIntervalSeconds'
  | 'exchangeMetadataRescanIntervalSeconds'
  | 'globalAggregatorIntervalSeconds'
  | 'categoryAggregatorIntervalSeconds'
  | 'marketFreshnessThresholdSeconds'
  | 'providerFanoutConcurrency'
  | 'startupPrewarmBudgetMs'
  | 'disableRemoteCurrencyRefresh'
  | 'schedulerDisabled'
  | 'marketRefreshDisabled'
  | 'currencyRatesDisabled'
  | 'searchRebuildDisabled'
  | 'ohlcvTickDisabled'
  | 'cacheEvictionDisabled'
  | 'defillamaPoolSweepDisabled'
  | 'defillamaTokenSweepDisabled'
  | 'subsquidTradeSweepDisabled'
  | 'coinCatalogRescanDisabled'
  | 'exchangeMetadataRescanDisabled'
  | 'globalAggregatorDisabled'
  | 'categoryAggregatorDisabled'
  | 'optionalProviderSyncEnabled'
  | 'optionalProviderSyncIntervalSeconds'
  | 'coinHistoryTargets'
  | 'exchangeVolumeTargets'
  | 'marketChartTargets'
  | 'onchainAnalyticsTargets'
  | 'onchainTradeTargets'
  | 'supplyChartTargets'
>;

function formatRfc3339Timestamp() {
  return new Date().toISOString().replace('.000Z', 'Z');
}

function shouldDeferListenerBoundRefreshAfterBootstrap(state: MarketDataRuntimeState) {
  return !state.initialSyncCompletedWithoutUsableLiveSnapshots && !state.allowStaleLiveService;
}

export type MarketRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  whenReady: () => Promise<void>;
  markListenerBound: () => void;
  scheduler: UnifiedScheduler;
};

export function createMarketRuntimeDiagnosticsScheduler(
  config: RuntimeConfig,
  logger: RuntimeLogger,
  metrics: MetricsRegistry,
  database: AppDatabase | null = null,
) {
  const scheduler = createUnifiedScheduler({
    logger,
    metrics,
    disabled: config.schedulerDisabled ?? false,
  });
  const jobs = [
    {
      name: 'currency-rates',
      intervalSeconds: config.currencyRefreshIntervalSeconds,
      disabled: Boolean(config.currencyRatesDisabled || config.disableRemoteCurrencyRefresh),
    },
    {
      name: 'market-refresh',
      intervalSeconds: config.marketRefreshIntervalSeconds,
      disabled: Boolean(config.marketRefreshDisabled),
    },
    {
      name: 'search-rebuild',
      intervalSeconds: config.searchRebuildIntervalSeconds,
      disabled: Boolean(config.searchRebuildDisabled),
    },
    {
      name: 'ohlcv-tick',
      intervalSeconds: config.ohlcvRefreshIntervalSeconds ?? 60,
      disabled: Boolean(config.ohlcvTickDisabled),
    },
    {
      name: 'cache-eviction',
      intervalSeconds: 60,
      disabled: Boolean(config.cacheEvictionDisabled),
    },
  ];

  for (const job of jobs) {
    scheduler.register({
      ...job,
      run: async () => undefined,
    });
  }
  registerTier1SchedulerJobs(scheduler, database, config);

  return scheduler;
}

type MarketRuntimeOverrides = {
  runInitialMarketSync?: (database: AppDatabase, config: Pick<AppConfig, 'ccxtExchanges' | 'marketFreshnessThresholdSeconds'>, logger?: Logger) => Promise<unknown>;
  runCurrencyRefreshOnce?: JobRunner;
  runMarketRefreshOnce?: JobRunner;
  runSearchRebuildOnce?: JobRunner;
  startOhlcvRuntime?: JobRunner;
  stopOhlcvRuntime?: JobRunner;
  runOhlcvTickOnce?: JobRunner;
};

export function createMarketRuntime(
  app: {
    inject: (opts: { method: string; url: string }) => Promise<unknown>;
    simplePriceCache?: {
      deleteExpired: (now?: number) => number;
    };
  },
  database: AppDatabase,
  config: RuntimeConfig,
  logger: RuntimeLogger,
  state: MarketDataRuntimeState,
  metrics: MetricsRegistry,
  overrides: MarketRuntimeOverrides = {},
  startupProgress?: StartupProgressReporter,
  optionalProviderJobs: OptionalProviderJobRegistry = createOptionalProviderJobRegistry(),
): MarketRuntime {
  let listenerBoundDeferredMarketRefreshPending = false;
  let startupTask: Promise<void> | null = null;
  let readinessTask: Promise<void> | null = null;
  let startupSettled = true;
  let stopRequested = false;
  const ohlcvRuntime = createOhlcvRuntime(database, {
    ccxtExchanges: config.ccxtExchanges,
    ohlcvRefreshIntervalSeconds: config.ohlcvRefreshIntervalSeconds,
  }, logger);
  const optionalProviderScheduler = createOptionalProviderSyncScheduler({
    enabled: config.optionalProviderSyncEnabled,
    intervalSeconds: config.optionalProviderSyncIntervalSeconds,
    jobs: createConfiguredOptionalProviderSyncJobs(database, config),
    registry: optionalProviderJobs,
    logger,
    database,
  });
  const scheduler = createUnifiedScheduler({
    logger,
    metrics,
    disabled: config.schedulerDisabled ?? false,
  });
  const ohlcvRefreshIntervalSeconds = config.ohlcvRefreshIntervalSeconds ?? 60;

  async function enableResidualStaleDataIfAvailable() {
    const queryDb = (database as Partial<AppDatabase>).db;
    if (!queryDb || typeof queryDb.select !== 'function') {
      return;
    }

    const { marketSnapshots } = await import('../db/schema');
    try {
      const snapshotCount = queryDb.select().from(marketSnapshots).all().length;
      if (snapshotCount > 0) {
        enableStaleLiveFallback(state);
        if (!startupProgress) {
          logger.warn({ timestamp: formatRfc3339Timestamp() }, 'using residual stale data while bootstrap is still running');
        }
        startupProgress?.reportWarning('Using residual stale data while bootstrap is still running');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('database connection is not open')) {
        return;
      }
      throw error;
    }
  }

  scheduler.register({
    name: 'currency-rates',
    intervalSeconds: config.currencyRefreshIntervalSeconds,
    disabled: Boolean(config.currencyRatesDisabled || config.disableRemoteCurrencyRefresh),
    run: async () => {
      await (overrides.runCurrencyRefreshOnce ?? (() => refreshCurrencyApiRatesOnce()))();
    },
  });
  scheduler.register({
    name: 'market-refresh',
    intervalSeconds: config.marketRefreshIntervalSeconds,
    disabled: Boolean(config.marketRefreshDisabled),
    run: async () => {
      try {
        await (overrides.runMarketRefreshOnce ?? (() => runMarketRefreshOnce(database, config, undefined, state, metrics)))();
        recordMarketRefreshSuccess(state);
      } catch (error) {
        recordMarketRefreshFailure(state, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  });
  scheduler.register({
    name: 'search-rebuild',
    intervalSeconds: config.searchRebuildIntervalSeconds,
    disabled: Boolean(config.searchRebuildDisabled),
    run: async () => {
      await (overrides.runSearchRebuildOnce ?? (() => runSearchRebuildOnce(database)))();
    },
  });
  scheduler.register({
    name: 'ohlcv-tick',
    intervalSeconds: ohlcvRefreshIntervalSeconds,
    disabled: Boolean(config.ohlcvTickDisabled || overrides.startOhlcvRuntime),
    runImmediately: true,
    run: async () => {
      await (overrides.runOhlcvTickOnce ?? (() => ohlcvRuntime.tick()))();
    },
  });
  scheduler.register({
    name: 'cache-eviction',
    intervalSeconds: 60,
    disabled: Boolean(config.cacheEvictionDisabled),
    run: async () => {
      app.simplePriceCache?.deleteExpired();
    },
  });
  registerTier1SchedulerJobs(scheduler, database, config);

  return {
    scheduler,
    async start() {
      if (startupTask) {
        return;
      }

      stopRequested = false;
      startupSettled = false;
      await enableResidualStaleDataIfAvailable();

      startupTask = (async () => {
        try {
          const syncLogger = 'child' in logger ? logger.child({ operation: 'initial_sync' }) as unknown as Logger : undefined;
          const initialSync = overrides.runInitialMarketSync
            ? () => overrides.runInitialMarketSync!(database, config, syncLogger)
            : () => runInitialMarketSync(database, config, syncLogger, {
                onStepChange: (stepId) => {
                  startupProgress?.begin(stepId);
                },
                onOhlcvBackfillProgress: (current, total) => {
                  startupProgress?.updateOhlcvProgress(current, total);
                },
                onExchangeResult: (exchangeId, status, message) => {
                  startupProgress?.reportExchangeResult(exchangeId, status, message);
                },
                onCatalogResult: (id, category, count, durationMs) => {
                  startupProgress?.reportCatalogResult(id, category, count, durationMs);
                },
                onStatusDetail: (message) => {
                  startupProgress?.reportStatus(message);
                },
                onTickerFetchStart: (exchangeId) => {
                  startupProgress?.reportStatus(`Fetching tickers: ${exchangeId}`);
                },
                onTickerFetchComplete: (exchangeId, durationMs) => {
                  startupProgress?.reportStatus(`Completed tickers: ${exchangeId} (${(durationMs / 1000).toFixed(1)}s)`);
                },
                onTickerFetchFailed: (exchangeId, _message, durationMs) => {
                  startupProgress?.reportStatus(`Failed tickers: ${exchangeId} (${(durationMs / 1000).toFixed(1)}s)`);
                },
                onWaitingExchangeStatus: (exchangeIds) => {
                  startupProgress?.reportStatus(`Still waiting for ticker responses: ${exchangeIds.join(', ')}`);
                },
              }, state);

          await initialSync();
          startupProgress?.complete('build_market_snapshots');
          startupProgress?.begin('start_ohlcv_worker');
          if (overrides.startOhlcvRuntime) {
            void overrides.startOhlcvRuntime();
          }
          startupProgress?.complete('start_ohlcv_worker');
          completeInitialMarketSync(state);

          const { seedStaticReferenceData, rebuildSearchIndex } = await import('../db/client');
          startupProgress?.begin('seed_reference_data');
          startupProgress?.reportStatus('Preparing reference data and search index before opening the listener');
          seedStaticReferenceData(database);
          startupProgress?.complete('seed_reference_data');
          startupProgress?.begin('rebuild_search_index');
          rebuildSearchIndex(database);
          startupProgress?.complete('rebuild_search_index');
          startupProgress?.begin('start_http_listener');
          startupProgress?.reportStatus('Waiting for Fastify to bind the HTTP listener');
          readinessTask = Promise.resolve();

          if (!startupProgress) {
            logger.info({ timestamp: formatRfc3339Timestamp() }, 'initial market sync completed successfully');
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          recordInitialSyncFailure(state, reason);
          logger.error({ error: reason }, 'initial market sync failed');
          await enableResidualStaleDataIfAvailable();
          if (state.allowStaleLiveService) {
            enableStaleLiveFallback(state);
          }
          bumpMarketDataRevision(state);
        }

        if (stopRequested) {
          return;
        }

        await scheduler.runNow('currency-rates');
        listenerBoundDeferredMarketRefreshPending = shouldDeferListenerBoundRefreshAfterBootstrap(state);

        if (stopRequested) {
          return;
        }

        scheduler.start();
        optionalProviderScheduler.start();
      })();

      void startupTask.finally(() => {
        startupSettled = true;
      });
    },
    async whenReady() {
      if (readinessTask) {
        await readinessTask;
      } else if (startupTask) {
        await startupTask;
      }
    },
    markListenerBound() {
      const { shouldRunStartupPrewarm } = markMarketRuntimeListenerBound(state);
      if (shouldRunStartupPrewarm) {
        readinessTask = runStartupPrewarm(app as never, state, metrics, config.startupPrewarmBudgetMs);
      }
      if (listenerBoundDeferredMarketRefreshPending && !stopRequested) {
        listenerBoundDeferredMarketRefreshPending = false;
        queueMicrotask(() => {
          if (!stopRequested) {
            void scheduler.runNow('market-refresh');
          }
        });
      }
    },
    async stop() {
      stopRequested = true;
      markMarketRuntimeListenerStopped(state);
      await scheduler.stop();
      await optionalProviderScheduler.stop();

      if (startupTask && startupSettled) {
        await startupTask;
        startupTask = null;
      }

      await (overrides.stopOhlcvRuntime ?? (() => Promise.resolve()))();

      if (startupSettled) {
        startupTask = null;
      }
    },
  };
}
