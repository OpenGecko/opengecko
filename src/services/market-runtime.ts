import type { FastifyBaseLogger } from 'fastify';

import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { refreshCurrencyApiRatesOnce } from './currency-rates';
import type { MarketDataRuntimeState } from './market-runtime-state';
import { runInitialMarketSync } from './initial-sync';
import { runMarketRefreshOnce } from './market-refresh';
import { runSearchRebuildOnce } from './search-rebuild';

type RuntimeLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

type JobRunner = () => Promise<void>;

function createSerializedJob(name: string, logger: RuntimeLogger, runner: JobRunner) {
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
          logger.info({ job: name }, 'background job completed');
        } catch (error) {
          logger.error({ job: name, error }, 'background job failed');
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
};

type MarketRuntimeOverrides = {
  runInitialMarketSync?: (database: AppDatabase, config: Pick<AppConfig, 'ccxtExchanges' | 'marketFreshnessThresholdSeconds'>) => Promise<unknown>;
  runCurrencyRefreshOnce?: JobRunner;
  runMarketRefreshOnce?: JobRunner;
  runSearchRebuildOnce?: JobRunner;
};

export function createMarketRuntime(
  database: AppDatabase,
  config: Pick<AppConfig, 'ccxtExchanges' | 'currencyRefreshIntervalSeconds' | 'marketRefreshIntervalSeconds' | 'searchRebuildIntervalSeconds' | 'marketFreshnessThresholdSeconds'>,
  logger: RuntimeLogger,
  state: MarketDataRuntimeState,
  overrides: MarketRuntimeOverrides = {},
): MarketRuntime {
  let currencyTimer: NodeJS.Timeout | null = null;
  let marketTimer: NodeJS.Timeout | null = null;
  let searchTimer: NodeJS.Timeout | null = null;

  const runCurrencyJob = createSerializedJob('currency_refresh', logger, async () => {
    await (overrides.runCurrencyRefreshOnce ?? (() => refreshCurrencyApiRatesOnce()))();
  });
  const runMarketJob = createSerializedJob('market_refresh', logger, async () => {
    await (overrides.runMarketRefreshOnce ?? (() => runMarketRefreshOnce(database, config)))();
  });
  const runSearchJob = createSerializedJob('search_rebuild', logger, async () => {
    await (overrides.runSearchRebuildOnce ?? (() => runSearchRebuildOnce(database)))();
  });

  return {
    async start() {
      // Run initial market sync before starting refresh loop
      try {
        const initialSync = overrides.runInitialMarketSync
          ? () => overrides.runInitialMarketSync!(database, config)
          : () => runInitialMarketSync(database, config);

        await initialSync();
        state.initialSyncCompleted = true;
        state.syncFailureReason = null;

        // Seed static reference data (treasury, derivatives, onchain) after coins exist
        const { seedStaticReferenceData, rebuildSearchIndex } = await import('../db/client');
        seedStaticReferenceData(database);
        rebuildSearchIndex(database);

        logger.info('initial market sync completed successfully');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        state.syncFailureReason = reason;
        logger.error({ error: reason }, 'initial market sync failed');

        // Check for residual data from previous runs
        const { count } = await import('drizzle-orm');
        const { marketSnapshots } = await import('../db/schema');
        const [{ value: snapshotCount }] = database.db
          .select({ value: count() })
          .from(marketSnapshots)
          .all();

        if (snapshotCount > 0) {
          state.allowStaleLiveService = true;
          logger.warn('using residual stale data from previous run');
        }
      }

      await runCurrencyJob.run();
      await runMarketJob.run();

      currencyTimer = setInterval(() => {
        void runCurrencyJob.run();
      }, config.currencyRefreshIntervalSeconds * 1000);
      marketTimer = setInterval(() => {
        void runMarketJob.run();
      }, config.marketRefreshIntervalSeconds * 1000);
      searchTimer = setInterval(() => {
        void runSearchJob.run();
      }, config.searchRebuildIntervalSeconds * 1000);
    },
    async stop() {
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

      await Promise.all([runCurrencyJob.waitForIdle(), runMarketJob.waitForIdle(), runSearchJob.waitForIdle()]);
    },
  };
}
