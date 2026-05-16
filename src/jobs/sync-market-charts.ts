import { createDatabase, initializeDatabase } from '../db/client';
import { createLogger } from '../lib/logger';
import { loadDefaultCoverageTargets } from '../services/coverage-targets';
import {
  parseMarketChartTargetConfig,
  syncMarketCharts,
  syncMarketChartsFromCoveragePlan,
} from '../services/market-chart-sync';
import {
  recordOptionalProviderJobRunFailure,
  recordOptionalProviderJobRunRunning,
  recordOptionalProviderJobRunSuccess,
} from '../services/optional-provider-jobs';

function shouldUseCoveragePlan(env: NodeJS.ProcessEnv) {
  return env.MARKET_CHART_USE_COVERAGE_PLAN === 'true' || env.MARKET_CHART_USE_COVERAGE_PLAN === '1';
}

export async function runMarketChartSyncJob(env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger({ level: env.LOG_LEVEL === 'silent' ? 'silent' : 'info', pretty: false });
  const startedAt = new Date();
  const database = createDatabase(env.DATABASE_URL ?? './data/opengecko.db');
  let targetsAttempted = 0;

  try {
    initializeDatabase(database);
    const useCoveragePlan = shouldUseCoveragePlan(env);
    const targets = parseMarketChartTargetConfig(env.MARKET_CHART_TARGETS);

    if (!useCoveragePlan) {
      targetsAttempted = targets.length;
      recordOptionalProviderJobRunRunning(database, 'market_charts', startedAt, targetsAttempted);

      if (targets.length === 0) {
        logger.info('No market chart targets configured; set MARKET_CHART_TARGETS or MARKET_CHART_USE_COVERAGE_PLAN=true to run the optional sync job');
        recordOptionalProviderJobRunSuccess(database, 'market_charts', {
          startedAt,
          finishedAt: new Date(),
          targetsAttempted,
          rowsWritten: 0,
        });
        return;
      }
    } else {
      const configuredCoverageTargets = loadDefaultCoverageTargets().filter(
        (target) => target.enabled && target.family === 'market_charts',
      );
      targetsAttempted = configuredCoverageTargets.length;
      recordOptionalProviderJobRunRunning(database, 'market_charts', startedAt, targetsAttempted);
    }

    const result = useCoveragePlan
      ? await syncMarketChartsFromCoveragePlan(database, {
        coverageTargets: loadDefaultCoverageTargets(),
        providerBaseUrl: env.MARKET_CHART_BASE_URL,
      })
      : await syncMarketCharts(database, {
        targets,
        providerBaseUrl: env.MARKET_CHART_BASE_URL,
      });
    const firstFailedTarget = result.results.find((targetResult) => targetResult.status === 'failed');
    recordOptionalProviderJobRunSuccess(database, 'market_charts', {
      startedAt,
      finishedAt: new Date(),
      targetsAttempted: result.targets_attempted,
      rowsWritten: result.points_written,
      partialFailureReason: result.targets_failed > 0
        ? `${result.targets_failed} market chart target(s) failed; first failure: ${firstFailedTarget?.error ?? 'unknown failure'}`
        : null,
      partialFailureSamples: result.results
        .filter((targetResult) => targetResult.status === 'failed')
        .slice(0, 5)
        .map((targetResult) => ({
          provider: targetResult.provider,
          coin_id: targetResult.coin_id,
          vs_currency: targetResult.vs_currency,
          interval: targetResult.interval,
          error: targetResult.error ?? 'unknown failure',
        })),
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
