import type { FastifyInstance } from 'fastify';

import { rebuildSearchIndex, seedStaticReferenceData } from '../db/client';
import { buildCoinName } from '../lib/coin-id';
import {
  finalizeBootstrapState,
  resolveSeededBootstrapContext,
} from '../services/bootstrap';
import { matchStartupPrewarmTarget, runStartupPrewarm } from '../services/startup-prewarm';
import type { MetricsRegistry } from '../services/metrics';
import type {
  AppLifecycleState,
  BuildAppOptions,
  Database,
  InitialSyncCallbacks,
  InitialSyncResult,
} from './types';
import type { AppConfig } from '../config/env';

export function recordStartupPrewarmObservation(
  app: FastifyInstance,
  url: string,
  durationMs: number,
  statusCode: number,
) {
  const route = url.split('?')[0] || url;

  if (route === '/diagnostics/runtime' || route === '/metrics') {
    return;
  }

  const prewarm = app.marketDataRuntimeState.startupPrewarm;
  if (!prewarm.enabled || prewarm.targetResults.length === 0) {
    return;
  }

  const target = prewarm.targetResults.find((candidate) =>
    candidate.firstObservedRequest == null && matchStartupPrewarmTarget(candidate.endpoint, url),
  );

  if (!target) {
    return;
  }

  const cacheHit = target.status === 'completed'
    && (
      target.warmCacheRevision === app.marketDataRuntimeState.hotDataRevision
      || (
        prewarm.firstRequestWarmBenefitPending
        && target.cacheSurface === 'simple_price'
      )
    )
    && statusCode >= 200
    && statusCode < 300;

  target.firstObservedRequest = {
    durationMs,
    cacheHit,
  };
  prewarm.firstRequestWarmBenefitsObserved = prewarm.targetResults.some(
    (candidate) => candidate.firstObservedRequest?.cacheHit === true,
  );
  if (prewarm.firstRequestWarmBenefitPending) {
    prewarm.firstRequestWarmBenefitPending = false;
  }
  app.metrics.recordStartupPrewarmFirstRequest(target.id, target.cacheSurface, cacheHit, durationMs);
}

export function createInitialSyncCallbacks(options: BuildAppOptions): InitialSyncCallbacks {
  return {
    onStepChange: (stepId) => {
      options.startupProgress?.begin(stepId);
    },
    onOhlcvBackfillProgress: (current, total) => {
      options.startupProgress?.updateOhlcvProgress(current, total);
    },
    onExchangeResult: (exchangeId, status, message) => {
      options.startupProgress?.reportExchangeResult(exchangeId, status, message);
    },
    onCatalogResult: (id, category, count, durationMs) => {
      options.startupProgress?.reportCatalogResult(id, category, count, durationMs);
    },
    onStatusDetail: (message) => {
      options.startupProgress?.reportStatus(message);
    },
    onTickerFetchStart: (exchangeId) => {
      options.startupProgress?.reportStatus(`Fetching tickers: ${exchangeId}`);
    },
    onTickerFetchComplete: (exchangeId, durationMs) => {
      options.startupProgress?.reportStatus(`Completed tickers: ${exchangeId} (${(durationMs / 1000).toFixed(1)}s)`);
    },
    onTickerFetchFailed: (exchangeId, _message, durationMs) => {
      options.startupProgress?.reportStatus(`Failed tickers: ${exchangeId} (${(durationMs / 1000).toFixed(1)}s)`);
    },
    onWaitingExchangeStatus: (exchangeIds) => {
      options.startupProgress?.reportStatus(`Still waiting for ticker responses: ${exchangeIds.join(', ')}`);
    },
  };
}

export async function withStartupTimeout<T>(
  operation: Promise<T>,
  startupTimeoutMs: number | undefined,
  message: string,
) {
  if (!startupTimeoutMs || startupTimeoutMs <= 0) {
    return operation;
  }

  return await Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(message));
      }, startupTimeoutMs);

      operation.finally(() => {
        clearTimeout(timeout);
      });
    }),
  ]);
}

export function canonicalizePersistedCoinNames(database: Database) {
  const rows = database.client.prepare<{ id: string; symbol: string; name: string | null }>(`
    SELECT id, symbol, name
    FROM coins
  `).all();

  const updateCoinName = database.client.prepare(`
    UPDATE coins
    SET name = ?, updated_at = ?
    WHERE id = ?
  `);
  const now = Date.now();

  database.client.exec('BEGIN');
  try {
    for (const row of rows) {
      const canonicalName = buildCoinName(row.symbol, row.name);

      if (canonicalName !== (row.name ?? '')) {
        updateCoinName.run(canonicalName, now, row.id);
      }
    }

    database.client.exec('COMMIT');
  } catch (error) {
    database.client.exec('ROLLBACK');
    throw error;
  }
}

export function updateValidationOverrideAfterBootstrapSync(
  config: AppConfig,
  marketDataRuntimeState: AppLifecycleState,
  bootstrapSnapshotAccessMode: 'disabled' | 'seeded_bootstrap',
  bootstrapOnlyValidationRuntime: boolean,
  seedValidationSnapshotMode: boolean,
) {
  if (
    bootstrapOnlyValidationRuntime
    && config.databaseUrl !== ':memory:'
    && !marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots
  ) {
    marketDataRuntimeState.validationOverride = {
      mode: 'stale_allowed',
      reason: 'default runtime exposing seeded/live snapshots after bootstrap sync',
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    };
  }

  if (
    config.databaseUrl === ':memory:'
    && bootstrapSnapshotAccessMode === 'seeded_bootstrap'
    && (seedValidationSnapshotMode || config.port === 3000)
    && (
      marketDataRuntimeState.validationOverride.reason === 'validation runtime seeded from persistent live snapshots'
      || marketDataRuntimeState.validationOverride.reason === 'default runtime seeded from persistent live snapshots'
    )
  ) {
    const seededBootstrapReason = bootstrapOnlyValidationRuntime
      ? 'validation runtime seeded from persistent live snapshots'
      : 'default runtime seeded from persistent live snapshots';
    marketDataRuntimeState.validationOverride = {
      mode: marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots
        ? 'degraded_seeded_bootstrap'
        : 'seeded_bootstrap',
      reason: seededBootstrapReason,
      snapshotTimestampOverride: marketDataRuntimeState.validationOverride.snapshotTimestampOverride,
      snapshotSourceCountOverride: marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots
        ? 0
        : marketDataRuntimeState.validationOverride.snapshotSourceCountOverride,
    };
  }
}

export async function runBootstrapReadinessFlow(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  marketDataRuntimeState: AppLifecycleState,
  metrics: MetricsRegistry,
  options: BuildAppOptions,
  bootstrapSnapshotAccessMode: 'disabled' | 'seeded_bootstrap',
  bootstrapOnlyValidationRuntime: boolean,
  seedValidationSnapshotMode: boolean,
) {
  const { runInitialMarketSync } = await import('../services/initial-sync');
  const startupTimeoutMs = options.startupPluginTimeout ?? options.pluginTimeout;
  const {
    database: bootstrapDatabase,
    persistentSnapshotDatabaseUrl,
    seededBootstrapPreserved,
  } = resolveSeededBootstrapContext(
    database,
    config,
    marketDataRuntimeState,
    bootstrapSnapshotAccessMode,
    bootstrapOnlyValidationRuntime,
  );
  const shouldRunBootstrapInitialSync = !seededBootstrapPreserved;
  const syncOperation: Promise<InitialSyncResult> = shouldRunBootstrapInitialSync
    ? runInitialMarketSync(
        bootstrapDatabase,
        config,
        undefined,
        createInitialSyncCallbacks(options),
        marketDataRuntimeState,
      )
    : Promise.resolve({
        coinsDiscovered: 0,
        chainsDiscovered: 0,
        snapshotsCreated: 0,
        tickersWritten: 0,
        exchangesSynced: 0,
        ohlcvCandlesWritten: 0,
      });

  await withStartupTimeout(
    syncOperation,
    startupTimeoutMs,
    `Startup initial sync exceeded ${startupTimeoutMs}ms before listener bind`,
  );

  updateValidationOverrideAfterBootstrapSync(
    config,
    marketDataRuntimeState,
    bootstrapSnapshotAccessMode,
    bootstrapOnlyValidationRuntime,
    seedValidationSnapshotMode,
  );
  finalizeBootstrapState(marketDataRuntimeState, seededBootstrapPreserved, bootstrapOnlyValidationRuntime);

  options.startupProgress?.begin('seed_reference_data');
  if (!persistentSnapshotDatabaseUrl) {
    seedStaticReferenceData(bootstrapDatabase, { includeSeededExchanges: true });
  }
  options.startupProgress?.complete('seed_reference_data');
  options.startupProgress?.begin('rebuild_search_index');
  rebuildSearchIndex(bootstrapDatabase);
  options.startupProgress?.complete('rebuild_search_index');
  await runStartupPrewarm(app, marketDataRuntimeState, metrics, config.startupPrewarmBudgetMs);
  options.startupProgress?.begin('start_http_listener');
}
