import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { syncDerivativeTickers } from './derivatives-sync';
import { parseDerivativeVenueConfig } from './derivatives-venues';
import type { UnifiedScheduler } from './job-scheduler';
import { runSupplyAggregator } from './supply-aggregator';
import { runTreasurySweep } from './treasury-sweep';

type Tier23SchedulerConfig = Pick<AppConfig,
  | 'derivativesCcxtExchanges'
  | 'derivativesRefreshIntervalSeconds'
  | 'derivativesRefreshDisabled'
  | 'supplyAggregatorIntervalSeconds'
  | 'supplyAggregatorDisabled'
  | 'treasurySweepIntervalSeconds'
  | 'treasurySweepDisabled'
  | 'treasuryDisclosureReplayPath'
>;

export function registerTier23SchedulerJobs(
  scheduler: UnifiedScheduler,
  database: AppDatabase | null,
  config: Tier23SchedulerConfig,
) {
  scheduler.register({
    name: 'derivatives-refresh',
    intervalSeconds: config.derivativesRefreshIntervalSeconds,
    disabled: Boolean(config.derivativesRefreshDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0, rowsWritten: 0 };
      }

      const venues = parseDerivativeVenueConfig(config.derivativesCcxtExchanges);
      if (venues.length === 0) {
        return { targetsProcessed: 0, rowsWritten: 0 };
      }

      return syncDerivativeTickers(database, { venues });
    },
  });

  scheduler.register({
    name: 'supply-aggregator',
    intervalSeconds: config.supplyAggregatorIntervalSeconds,
    disabled: Boolean(config.supplyAggregatorDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0, rowsWritten: 0 };
      }

      return runSupplyAggregator(database);
    },
  });

  scheduler.register({
    name: 'treasury-sweep',
    intervalSeconds: config.treasurySweepIntervalSeconds,
    disabled: Boolean(config.treasurySweepDisabled),
    run: async () => {
      if (!database) {
        return { targetsProcessed: 0, rowsWritten: 0 };
      }

      return runTreasurySweep(database, {
        replayPath: config.treasuryDisclosureReplayPath,
      });
    },
  });
}
