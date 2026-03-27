import type { FastifyBaseLogger } from 'fastify';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { refreshCurrencyApiRatesOnce } from './currency-rates';
import type { MarketDataRuntimeState } from './market-runtime-state';
import { runInitialMarketSync } from './initial-sync';
import { runMarketRefreshOnce } from './market-refresh';
import type { MetricsRegistry } from './metrics';
import { createOhlcvRuntime } from './ohlcv-runtime';
import { runSearchRebuildOnce } from './search-rebuild';
import { runStartupPrewarm } from './startup-prewarm';
import type { StartupProgressReporter } from './startup-progress';

type RuntimeLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug' | 'child'>;

type JobRunner = () => Promise<void>;

function bumpHotDataRevision(state: MarketDataRuntimeState) {
  state.hotDataRevision += 1;
}

function finalizeStartupHotDataRevision(state: MarketDataRuntimeState) {
  bumpHotDataRevision(state);
}

function clearRecoveredDegradedState(state: MarketDataRuntimeState) {
  state.syncFailureReason = null;
  state.allowStaleLiveService = false;
  state.providerFailureCooldownUntil = null;
}

function enableFallbackFromExistingSnapshots(state: MarketDataRuntimeState) {
  state.allowStaleLiveService = true;
}

function createSerializedJob(name: string, logger: RuntimeLogger, state: MarketDataRuntimeState, runner: JobRunner) {
  let inFlight: Promise<void> | null = null;

  return {
    run: async () => {
      if (inFlight) {
        logger.warn({ job: name }, 'background job skipped because the previous run is still active');
        return inFlight;
      }

      inFlight = (async () => {
        try {
          await runner();
          if (name === 'market_refresh') {
            clearRecoveredDegradedState(state);
            bumpHotDataRevision(state);
          }
          logger.info(`background job completed job=${name}`);
        } catch (error) {
          if (name === 'market_refresh') {
            state.syncFailureReason = error instanceof Error ? error.message : String(error);
            state.allowStaleLiveService = true;
          }
          const errorInfo = error instanceof Error
            ? { message: error.message, stack: error.stack, name: error.name }
            : { message: String(error) };
          logger.error({ job: name, ...errorInfo }, 'background job failed');
        } finally {
          inFlight = null;
        }
      })();

      return inFlight;
    },
    waitForIdle: async () => {
      if (inFlight) {
        await inFlight;
      }
    },
  };
}

export type MarketRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  whenReady: () => Promise<void>;
  markListenerBound: () => void;
};

type MarketRuntimeOverrides = {
  runInitialMarketSync?: (database: AppDatabase, config: Pick<AppConfig, 'ccxtExchanges' | 'marketFreshnessThresholdSeconds'>, logger?: Logger) => Promise<unknown>;
  runCurrencyRefreshOnce?: JobRunner;
  runMarketRefreshOnce?: JobRunner;
  runSearchRebuildOnce?: JobRunner;
  startOhlcvRuntime?: JobRunner;
  stopOhlcvRuntime?: JobRunner;
};

export function createMarketRuntime(
  app: { inject: (opts: { method: string; url: string }) => Promise<unknown> },
  database: AppDatabase,
  config: Pick<AppConfig, 'ccxtExchanges' | 'currencyRefreshIntervalSeconds' | 'marketRefreshIntervalSeconds' | 'searchRebuildIntervalSeconds' | 'marketFreshnessThresholdSeconds' | 'providerFanoutConcurrency' | 'startupPrewarmBudgetMs'>,
  logger: RuntimeLogger,
  state: MarketDataRuntimeState,
  metrics: MetricsRegistry,
  overrides: MarketRuntimeOverrides = {},
  startupProgress?: StartupProgressReporter,
): MarketRuntime {
  let currencyTimer: NodeJS.Timeout | null = null;
  let marketTimer: NodeJS.Timeout | null = null;
  let searchTimer: NodeJS.Timeout | null = null;
  let listenerBoundDeferredMarketRefreshPending = false;
  let startupTask: Promise<void> | null = null;
  let readinessTask: Promise<void> | null = null;
  let startupSettled = true;
  let stopRequested = false;
  const ohlcvRuntime = createOhlcvRuntime(database, { ccxtExchanges: config.ccxtExchanges }, logger);

  async function enableResidualStaleDataIfAvailable() {
    const queryDb = (database as Partial<AppDatabase>).db;
    if (!queryDb || typeof queryDb.select !== 'function') {
      return;
    }

    const { marketSnapshots } = await import('../db/schema');
    const snapshotCount = queryDb.select().from(marketSnapshots).all().length;

    if (snapshotCount > 0) {
      enableFallbackFromExistingSnapshots(state);
      logger.warn('using residual stale data while bootstrap is still running');
    }
  }

  const runCurrencyJob = createSerializedJob('currency_refresh', logger, state, async () => {
    await (overrides.runCurrencyRefreshOnce ?? (() => refreshCurrencyApiRatesOnce()))();
  });
  const runMarketJob = createSerializedJob('market_refresh', logger, state, async () => {
    await (overrides.runMarketRefreshOnce ?? (() => runMarketRefreshOnce(database, config, undefined, state, metrics)))();
  });
  const runSearchJob = createSerializedJob('search_rebuild', logger, state, async () => {
    await (overrides.runSearchRebuildOnce ?? (() => runSearchRebuildOnce(database)))();
  });

  return {
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
              }, state);

          await initialSync();
          startupProgress?.begin('start_ohlcv_worker');
          // Start OHLCV runtime without awaiting — it runs independently
          void (overrides.startOhlcvRuntime ?? (() => ohlcvRuntime.start()))();
          startupProgress?.complete('start_ohlcv_worker');
          state.initialSyncCompleted = true;
          clearRecoveredDegradedState(state);
          bumpHotDataRevision(state);

          const { seedStaticReferenceData, rebuildSearchIndex } = await import('../db/client');
          startupProgress?.begin('seed_reference_data');
          seedStaticReferenceData(database);
          startupProgress?.complete('seed_reference_data');
          startupProgress?.begin('rebuild_search_index');
          rebuildSearchIndex(database);
          startupProgress?.complete('rebuild_search_index');
          finalizeStartupHotDataRevision(state);
          readinessTask = runStartupPrewarm(app as never, state, metrics, config.startupPrewarmBudgetMs);
          await readinessTask;
          startupProgress?.begin('start_http_listener');
          startupProgress?.complete('start_http_listener');

          logger.info('initial market sync completed successfully');
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          state.syncFailureReason = reason;
          logger.error({ error: reason }, 'initial market sync failed');
          await enableResidualStaleDataIfAvailable();
          if (state.allowStaleLiveService) {
            enableFallbackFromExistingSnapshots(state);
          }
          bumpHotDataRevision(state);
        }

        if (stopRequested) {
          return;
        }

        await runCurrencyJob.run();
        listenerBoundDeferredMarketRefreshPending = true;

        if (stopRequested) {
          return;
        }

        currencyTimer = setInterval(() => {
          void runCurrencyJob.run();
        }, config.currencyRefreshIntervalSeconds * 1000);
        marketTimer = setInterval(() => {
          void runMarketJob.run();
        }, config.marketRefreshIntervalSeconds * 1000);
        searchTimer = setInterval(() => {
          void runSearchJob.run();
        }, config.searchRebuildIntervalSeconds * 1000);
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
      state.listenerBound = true;
      if (listenerBoundDeferredMarketRefreshPending && !stopRequested) {
        listenerBoundDeferredMarketRefreshPending = false;
        queueMicrotask(() => {
          if (!stopRequested) {
            void runMarketJob.run();
          }
        });
      }
    },
    async stop() {
      stopRequested = true;
      state.listenerBound = false;

      if (currencyTimer) {
        clearInterval(currencyTimer);
        currencyTimer = null;
      }

      if (marketTimer) {
        clearInterval(marketTimer);
        marketTimer = null;
      }

      if (searchTimer) {
        clearInterval(searchTimer);
        searchTimer = null;
      }

      if (startupTask && startupSettled) {
        await startupTask;
        startupTask = null;
      }

      await Promise.all([runCurrencyJob.waitForIdle(), runMarketJob.waitForIdle(), runSearchJob.waitForIdle()]);
      await (overrides.stopOhlcvRuntime ?? (() => ohlcvRuntime.stop()))();

      if (startupSettled) {
        startupTask = null;
      }
    },
  };
}
