import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { createLogger } from '../lib/logger';
import type { UnifiedScheduler } from './job-scheduler';
import {
  runCategoryAggregator,
  runCoinCatalogRescan,
  runExchangeMetadataRescan,
  runGlobalAggregator,
} from './tier1-catalog-aggregators';
import {
  runDefillamaPoolSweep,
  runDefillamaTokenSweep,
  runSubsquidTradeSweep,
} from './tier1-onchain-sweepers';
import { selectTier1TargetsForJob } from './tier1-target-selection';

export const TIER1_SCHEDULER_JOB_NAMES = [
  'defillama-pool-sweep',
  'defillama-token-sweep',
  'subsquid-trade-sweep',
  'coin-catalog-rescan',
  'exchange-metadata-rescan',
  'global-aggregator',
  'category-aggregator',
] as const;

type Tier1SchedulerConfig = Pick<AppConfig,
  | 'ccxtExchanges'
  | 'providerFanoutConcurrency'
  | 'defillamaPoolSweepIntervalSeconds'
  | 'defillamaTokenSweepIntervalSeconds'
  | 'subsquidTradeSweepIntervalSeconds'
  | 'coinCatalogRescanIntervalSeconds'
  | 'exchangeMetadataRescanIntervalSeconds'
  | 'globalAggregatorIntervalSeconds'
  | 'categoryAggregatorIntervalSeconds'
  | 'defillamaPoolSweepDisabled'
  | 'defillamaTokenSweepDisabled'
  | 'subsquidTradeSweepDisabled'
  | 'coinCatalogRescanDisabled'
  | 'exchangeMetadataRescanDisabled'
  | 'globalAggregatorDisabled'
  | 'categoryAggregatorDisabled'
>;

function readRankedCoinUniverse(database: AppDatabase) {
  return database.client
    .prepare<{ id: string; rank: number | null }>(`
      SELECT id, market_cap_rank AS rank
      FROM coins
      WHERE status = 'active'
      ORDER BY COALESCE(market_cap_rank, 9223372036854775807), id
    `)
    .all();
}

export function registerTier1SchedulerJobs(
  scheduler: UnifiedScheduler,
  database: AppDatabase | null,
  config: Tier1SchedulerConfig,
) {
  const tier1Logger = createLogger({ level: process.env.LOG_LEVEL === 'silent' ? 'silent' : 'info', pretty: false }).child({ operation: 'tier1_scheduler' });
  const targetSelectionCycleIndexesByJobName = new Map<string, number>();
  const selectRankedTargets = (jobName: string) => {
    if (!database) {
      return { targets: [] };
    }

    return selectTier1TargetsForJob(
      targetSelectionCycleIndexesByJobName,
      jobName,
      readRankedCoinUniverse(database),
    );
  };

  scheduler.register({
    name: 'defillama-pool-sweep',
    intervalSeconds: config.defillamaPoolSweepIntervalSeconds,
    disabled: Boolean(config.defillamaPoolSweepDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0 };
      }
      return runDefillamaPoolSweep(database, { targets: selectRankedTargets('defillama-pool-sweep').targets });
    },
  });
  scheduler.register({
    name: 'defillama-token-sweep',
    intervalSeconds: config.defillamaTokenSweepIntervalSeconds,
    disabled: Boolean(config.defillamaTokenSweepDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0 };
      }
      return runDefillamaTokenSweep(database, { targets: selectRankedTargets('defillama-token-sweep').targets });
    },
  });
  scheduler.register({
    name: 'subsquid-trade-sweep',
    intervalSeconds: config.subsquidTradeSweepIntervalSeconds,
    disabled: Boolean(config.subsquidTradeSweepDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0 };
      }
      return runSubsquidTradeSweep(database, { targets: selectRankedTargets('subsquid-trade-sweep').targets });
    },
  });
  scheduler.register({
    name: 'coin-catalog-rescan',
    intervalSeconds: config.coinCatalogRescanIntervalSeconds,
    disabled: Boolean(config.coinCatalogRescanDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0 };
      }
      return runCoinCatalogRescan(database, config.ccxtExchanges, tier1Logger, config.providerFanoutConcurrency);
    },
  });
  scheduler.register({
    name: 'exchange-metadata-rescan',
    intervalSeconds: config.exchangeMetadataRescanIntervalSeconds,
    disabled: Boolean(config.exchangeMetadataRescanDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0 };
      }
      return runExchangeMetadataRescan(database, config.ccxtExchanges, tier1Logger, config.providerFanoutConcurrency);
    },
  });
  scheduler.register({
    name: 'global-aggregator',
    intervalSeconds: config.globalAggregatorIntervalSeconds,
    disabled: Boolean(config.globalAggregatorDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0 };
      }
      return runGlobalAggregator(database);
    },
  });
  scheduler.register({
    name: 'category-aggregator',
    intervalSeconds: config.categoryAggregatorIntervalSeconds,
    disabled: Boolean(config.categoryAggregatorDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0 };
      }
      return runCategoryAggregator(database);
    },
  });
}
