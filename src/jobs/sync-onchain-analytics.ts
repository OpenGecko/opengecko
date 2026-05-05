import { createDatabase, initializeDatabase } from '../db/client';
import { createLogger } from '../lib/logger';
import {
  parseOnchainAnalyticsTargetConfig,
  syncOnchainAnalytics,
} from '../services/onchain-analytics-sync';
import {
  recordOptionalProviderJobRunFailure,
  recordOptionalProviderJobRunRunning,
  recordOptionalProviderJobRunSuccess,
} from '../services/optional-provider-jobs';

export async function runOnchainAnalyticsSyncJob(env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger({ level: env.LOG_LEVEL === 'silent' ? 'silent' : 'info', pretty: false });
  const startedAt = new Date();
  const database = createDatabase(env.DATABASE_URL ?? './data/opengecko.db');
  let targetsAttempted = 0;

  try {
    initializeDatabase(database);
    const targets = parseOnchainAnalyticsTargetConfig(env.ONCHAIN_ANALYTICS_TARGETS);
    targetsAttempted = targets.length;
    recordOptionalProviderJobRunRunning(database, 'onchain_analytics', startedAt, targetsAttempted);

    if (targets.length === 0) {
      logger.info('No onchain analytics targets configured; set ONCHAIN_ANALYTICS_TARGETS to run the optional sync job');
      recordOptionalProviderJobRunSuccess(database, 'onchain_analytics', {
        startedAt,
        finishedAt: new Date(),
        targetsAttempted,
        rowsWritten: 0,
      });
      return;
    }

    const result = await syncOnchainAnalytics(database, {
      targets,
      providerBaseUrl: env.ONCHAIN_ANALYTICS_BASE_URL,
    });
    recordOptionalProviderJobRunSuccess(database, 'onchain_analytics', {
      startedAt,
      finishedAt: new Date(),
      targetsAttempted: result.targets_attempted,
      rowsWritten: result.holders_written + result.traders_written + result.holder_counts_written,
    });
    logger.info(result, 'onchain analytics sync complete');
  } catch (error) {
    recordOptionalProviderJobRunFailure(database, 'onchain_analytics', {
      startedAt,
      finishedAt: new Date(),
      targetsAttempted,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    database.client.close();
  }
}

if (require.main === module) {
  void runOnchainAnalyticsSyncJob();
}
