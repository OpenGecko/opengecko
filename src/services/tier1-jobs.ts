import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import type { UnifiedScheduler } from './job-scheduler';
import { selectTier1Targets } from './tier1-target-selection';

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
  let targetSelectionCycleIndex = 0;
  const selectRankedTargets = () => {
    if (!database) {
      return { targets: [] };
    }

    const selection = selectTier1Targets(readRankedCoinUniverse(database), targetSelectionCycleIndex);
    targetSelectionCycleIndex += 1;
    return selection;
  };

  scheduler.register({
    name: 'defillama-pool-sweep',
    intervalSeconds: config.defillamaPoolSweepIntervalSeconds,
    disabled: Boolean(config.defillamaPoolSweepDisabled),
    run: async () => ({ targetsProcessed: selectRankedTargets().targets.length }),
  });
  scheduler.register({
    name: 'defillama-token-sweep',
    intervalSeconds: config.defillamaTokenSweepIntervalSeconds,
    disabled: Boolean(config.defillamaTokenSweepDisabled),
    run: async () => ({ targetsProcessed: selectRankedTargets().targets.length }),
  });
  scheduler.register({
    name: 'subsquid-trade-sweep',
    intervalSeconds: config.subsquidTradeSweepIntervalSeconds,
    disabled: Boolean(config.subsquidTradeSweepDisabled),
    run: async () => ({ targetsProcessed: selectRankedTargets().targets.length }),
  });
  scheduler.register({
    name: 'coin-catalog-rescan',
    intervalSeconds: config.coinCatalogRescanIntervalSeconds,
    disabled: Boolean(config.coinCatalogRescanDisabled),
    run: async () => ({ targetsProcessed: config.ccxtExchanges.length }),
  });
  scheduler.register({
    name: 'exchange-metadata-rescan',
    intervalSeconds: config.exchangeMetadataRescanIntervalSeconds,
    disabled: Boolean(config.exchangeMetadataRescanDisabled),
    run: async () => ({ targetsProcessed: config.ccxtExchanges.length }),
  });
  scheduler.register({
    name: 'global-aggregator',
    intervalSeconds: config.globalAggregatorIntervalSeconds,
    disabled: Boolean(config.globalAggregatorDisabled),
    run: async () => ({ targetsProcessed: 1 }),
  });
  scheduler.register({
    name: 'category-aggregator',
    intervalSeconds: config.categoryAggregatorIntervalSeconds,
    disabled: Boolean(config.categoryAggregatorDisabled),
    run: async () => ({ targetsProcessed: 1 }),
  });
}
