import { createDatabase, initializeDatabase } from '../db/client';
import { createLogger } from '../lib/logger';
import {
  parseExchangeVolumeTargetConfig,
  syncExchangeVolumes,
} from '../services/exchange-volume-sync';
import {
  recordOptionalProviderJobRunFailure,
  recordOptionalProviderJobRunRunning,
  recordOptionalProviderJobRunSuccess,
} from '../services/optional-provider-jobs';

export async function runExchangeVolumeSyncJob(env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger({ level: env.LOG_LEVEL === 'silent' ? 'silent' : 'info', pretty: false });
  const startedAt = new Date();
  const database = createDatabase(env.DATABASE_URL ?? './data/opengecko.db');
  let targetsAttempted = 0;

  try {
    initializeDatabase(database);
    const targets = parseExchangeVolumeTargetConfig(env.EXCHANGE_VOLUME_TARGETS);
    targetsAttempted = targets.length;
    recordOptionalProviderJobRunRunning(database, 'exchange_volumes', startedAt, targetsAttempted);

    if (targets.length === 0) {
      logger.info('No exchange volume targets configured; set EXCHANGE_VOLUME_TARGETS to run the optional sync job');
      recordOptionalProviderJobRunSuccess(database, 'exchange_volumes', {
        startedAt,
        finishedAt: new Date(),
        targetsAttempted,
        rowsWritten: 0,
      });
      return;
    }

    const result = await syncExchangeVolumes(database, {
      targets,
      providerBaseUrl: env.EXCHANGE_VOLUME_BASE_URL,
    });
    recordOptionalProviderJobRunSuccess(database, 'exchange_volumes', {
      startedAt,
      finishedAt: new Date(),
      targetsAttempted: result.targets_attempted,
      rowsWritten: result.points_written,
    });
    logger.info(result, 'exchange volume sync complete');
  } catch (error) {
    recordOptionalProviderJobRunFailure(database, 'exchange_volumes', {
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
  void runExchangeVolumeSyncJob();
}
