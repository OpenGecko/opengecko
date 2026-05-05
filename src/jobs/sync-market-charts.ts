import { createDatabase, initializeDatabase } from '../db/client';
import { createLogger } from '../lib/logger';
import {
  parseMarketChartTargetConfig,
  syncMarketCharts,
} from '../services/market-chart-sync';
import {
  recordOptionalProviderJobRunFailure,
  recordOptionalProviderJobRunRunning,
  recordOptionalProviderJobRunSuccess,
} from '../services/optional-provider-jobs';

export async function runMarketChartSyncJob(env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger({ level: env.LOG_LEVEL === 'silent' ? 'silent' : 'info', pretty: false });
  const startedAt = new Date();
  const database = createDatabase(env.DATABASE_URL ?? './data/opengecko.db');
  let targetsAttempted = 0;

  try {
    initializeDatabase(database);
    const targets = parseMarketChartTargetConfig(env.MARKET_CHART_TARGETS);
    targetsAttempted = targets.length;
    recordOptionalProviderJobRunRunning(database, 'market_charts', startedAt, targetsAttempted);

    if (targets.length === 0) {
      logger.info('No market chart targets configured; set MARKET_CHART_TARGETS to run the optional sync job');
      recordOptionalProviderJobRunSuccess(database, 'market_charts', {
        startedAt,
        finishedAt: new Date(),
        targetsAttempted,
        rowsWritten: 0,
      });
      return;
    }

    const result = await syncMarketCharts(database, {
      targets,
      providerBaseUrl: env.MARKET_CHART_BASE_URL,
    });
    recordOptionalProviderJobRunSuccess(database, 'market_charts', {
      startedAt,
      finishedAt: new Date(),
      targetsAttempted: result.targets_attempted,
      rowsWritten: result.points_written,
    });
    logger.info(result, 'market chart sync complete');
  } catch (error) {
    recordOptionalProviderJobRunFailure(database, 'market_charts', {
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
  void runMarketChartSyncJob();
}
