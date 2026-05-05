import { createDatabase, initializeDatabase } from '../db/client';
import { createLogger } from '../lib/logger';
import {
  parseCoinHistoryTargetConfig,
  syncCoinHistorySnapshots,
} from '../services/coin-history-sync';
import {
  recordOptionalProviderJobRunFailure,
  recordOptionalProviderJobRunRunning,
  recordOptionalProviderJobRunSuccess,
} from '../services/optional-provider-jobs';

export async function runCoinHistorySyncJob(env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger({ level: env.LOG_LEVEL === 'silent' ? 'silent' : 'info', pretty: false });
  const startedAt = new Date();
  const database = createDatabase(env.DATABASE_URL ?? './data/opengecko.db');
  let targetsAttempted = 0;

  try {
    initializeDatabase(database);
    const targets = parseCoinHistoryTargetConfig(env.COIN_HISTORY_TARGETS);
    targetsAttempted = targets.length;
    recordOptionalProviderJobRunRunning(database, 'coin_history', startedAt, targetsAttempted);

    if (targets.length === 0) {
      logger.info('No coin history targets configured; set COIN_HISTORY_TARGETS to run the optional sync job');
      recordOptionalProviderJobRunSuccess(database, 'coin_history', {
        startedAt,
        finishedAt: new Date(),
        targetsAttempted,
        rowsWritten: 0,
      });
      return;
    }

    const result = await syncCoinHistorySnapshots(database, {
      targets,
      providerBaseUrl: env.COIN_HISTORY_BASE_URL,
    });
    recordOptionalProviderJobRunSuccess(database, 'coin_history', {
      startedAt,
      finishedAt: new Date(),
      targetsAttempted: result.targets_attempted,
      rowsWritten: result.snapshots_written,
    });
    logger.info(result, 'coin history sync complete');
  } catch (error) {
    recordOptionalProviderJobRunFailure(database, 'coin_history', {
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
  void runCoinHistorySyncJob();
}
