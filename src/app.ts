import Fastify, { type FastifyInstance } from 'fastify';

import { mergeConfig, type AppConfig } from './config/env';
import { createDatabase, migrateDatabase, seedStaticReferenceData, rebuildSearchIndex } from './db/client';
import { registerErrorHandler } from './http/errors';
import { formatHttpCompactPLog } from './http/http-log-style';
import { registerTransportControls } from './http/transport';
import { registerAssetPlatformRoutes } from './modules/assets';
import { registerCoinRoutes } from './modules/coins';
import { registerDiagnosticsRoutes } from './modules/diagnostics';
import { registerExchangeRoutes } from './modules/exchanges';
import { registerGlobalRoutes } from './modules/global';
import { registerHealthRoutes } from './modules/health';
import { registerOnchainRoutes } from './modules/onchain';
import { registerSearchRoutes } from './modules/search';
import { registerSimpleRoutes } from './modules/simple';
import { registerTreasuryRoutes } from './modules/treasury';
import { buildCoinName } from './lib/coin-id';
import { closeExchangePool } from './providers/ccxt';
import {
  resolveBootstrapSnapshotAccessMode,
  resolveSeededBootstrapContext,
  finalizeBootstrapState,
} from './services/bootstrap';
import { createMarketRuntime, type MarketRuntime } from './services/market-runtime';
import { createMarketDataRuntimeState } from './services/market-runtime-state';
import { createMetricsRegistry, type MetricsRegistry } from './services/metrics';
import { matchStartupPrewarmTarget, runStartupPrewarm } from './services/startup-prewarm';
import type { StartupProgressReporter } from './services/startup-progress';

declare module 'fastify' {
  interface FastifyInstance {
    marketDataRuntimeState: AppLifecycleState;
    marketRuntime: MarketRuntime | null;
    metrics: MetricsRegistry;
    db: ReturnType<typeof createDatabase>;
    appConfig: AppConfig;
    marketFreshnessThresholdSeconds: number;
    simplePriceCache: Map<string, { value: Record<string, Record<string, number | null>>; expiresAt: number; revision: number }>;
  }
}

export type BuildAppOptions = {
  config?: Partial<AppConfig>;
  startBackgroundJobs?: boolean;
  pluginTimeout?: number;
  startupPluginTimeout?: number;
  startupProgress?: StartupProgressReporter;
};

export type AppLifecycleState = ReturnType<typeof createMarketDataRuntimeState>;

type Database = ReturnType<typeof createDatabase>;
type InitialSyncCallbacks = import('./services/initial-sync').InitialSyncProgressHandlers;
type InitialSyncResult = {
  coinsDiscovered: number;
  chainsDiscovered: number;
  snapshotsCreated: number;
  tickersWritten: number;
  exchangesSynced: number;
  ohlcvCandlesWritten: number;
};

function recordStartupPrewarmObservation(
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

export function getDatabaseStartupLogContext(database: { runtime: 'bun' | 'node'; url: string }) {
  return {
    runtime: database.runtime,
    driver: database.runtime === 'bun' ? 'bun:sqlite' : 'better-sqlite3',
    databaseUrl: database.url,
  };
}

function formatRfc3339Timestamp() {
  return new Date().toISOString().replace('.000Z', 'Z');
}

function createLoggerOptions(config: AppConfig) {
  const useEmojiCompactHttpLogs = config.logPretty && config.httpLogStyle === 'emoji_compact_p';
  const logger = config.logLevel === 'silent'
    ? false
    : {
        level: config.logLevel,
        ...(useEmojiCompactHttpLogs ? { timestamp: false } : {}),
        ...(config.logPretty ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l',
              ignore: useEmojiCompactHttpLogs ? 'pid,hostname,req,res,responseTime' : 'pid,hostname',
            },
          },
        } : {}),
      };

  return { logger, useEmojiCompactHttpLogs };
}

function registerAppRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  marketDataRuntimeState: AppLifecycleState,
  metrics: MetricsRegistry,
) {
  registerErrorHandler(app);
  registerTransportControls(app, {
    responseCompressionThresholdBytes: config.responseCompressionThresholdBytes,
  });
  registerHealthRoutes(app);
  registerDiagnosticsRoutes(
    app,
    database,
    config.marketFreshnessThresholdSeconds,
    metrics,
    {
      requestTimeoutMs: config.requestTimeoutMs,
      responseCompressionThresholdBytes: config.responseCompressionThresholdBytes,
    },
  );
  registerSimpleRoutes(app, database, config.marketFreshnessThresholdSeconds, marketDataRuntimeState);
  registerAssetPlatformRoutes(app, database);
  registerCoinRoutes(app, database, config.marketFreshnessThresholdSeconds, marketDataRuntimeState);
  registerExchangeRoutes(app, database, config.marketFreshnessThresholdSeconds, marketDataRuntimeState);
  registerTreasuryRoutes(app, database);
  registerOnchainRoutes(app, database);
  registerSearchRoutes(app, database);
  registerGlobalRoutes(app, database, config.marketFreshnessThresholdSeconds, marketDataRuntimeState);
}

function createInitialSyncCallbacks(options: BuildAppOptions): InitialSyncCallbacks {
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

async function withStartupTimeout<T>(
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

function canonicalizePersistedCoinNames(database: Database) {
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

function updateValidationOverrideAfterBootstrapSync(
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

async function runBootstrapReadinessFlow(
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
  const { runInitialMarketSync } = await import('./services/initial-sync');
  const startupTimeoutMs = options.startupPluginTimeout ?? options.pluginTimeout;
  const { persistentSnapshotDatabaseUrl, seededBootstrapPreserved } = resolveSeededBootstrapContext(
    database,
    config,
    marketDataRuntimeState,
    bootstrapSnapshotAccessMode,
    bootstrapOnlyValidationRuntime,
  );
  const shouldRunBootstrapInitialSync = !seededBootstrapPreserved;
  const syncOperation: Promise<InitialSyncResult> = shouldRunBootstrapInitialSync
    ? runInitialMarketSync(
        database,
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
    seedStaticReferenceData(database, { includeSeededExchanges: true });
  }
  options.startupProgress?.complete('seed_reference_data');
  options.startupProgress?.begin('rebuild_search_index');
  rebuildSearchIndex(database);
  options.startupProgress?.complete('rebuild_search_index');
  await runStartupPrewarm(app, marketDataRuntimeState, metrics, config.startupPrewarmBudgetMs);
  options.startupProgress?.begin('start_http_listener');
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = mergeConfig(options.config);
  const shouldStartBackgroundJobs = options.startBackgroundJobs ?? false;
  const bootstrapSnapshotAccessMode = resolveBootstrapSnapshotAccessMode(
    config.databaseUrl,
    shouldStartBackgroundJobs,
    config.host,
    config.port,
  );
  const bootstrapOnlyValidationRuntime = !shouldStartBackgroundJobs
    && config.host === '127.0.0.1'
    && config.port === 3102;
  const seedValidationSnapshotMode = bootstrapSnapshotAccessMode === 'seeded_bootstrap'
    && bootstrapOnlyValidationRuntime;
  const suppressBuiltInLogsUntilReady = options.startupProgress != null;
  const { logger: loggerOpts, useEmojiCompactHttpLogs } = createLoggerOptions(config);

  const app = Fastify({
    logger: loggerOpts,
    ...(useEmojiCompactHttpLogs ? { disableRequestLogging: true } : {}),
    ...(options.pluginTimeout !== undefined ? { pluginTimeout: options.pluginTimeout } : {}),
    connectionTimeout: config.requestTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    ...(suppressBuiltInLogsUntilReady ? { disableStartupMessages: true } : {}),
  });

  if (useEmojiCompactHttpLogs) {
    app.addHook('onResponse', (request, reply, done) => {
      const message = formatHttpCompactPLog({
        timestamp: new Date(),
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
        reqId: request.id,
        slowThresholdMs: 1000,
      });

      app.log.info(message);
      done();
    });
  }
  options.startupProgress?.begin('connect_database');
  const database = createDatabase(config.databaseUrl);
  if (!options.startupProgress) {
    app.log.info({ timestamp: formatRfc3339Timestamp(), ...getDatabaseStartupLogContext(database) }, 'database initialized');
  }
  const marketDataRuntimeState = createMarketDataRuntimeState();
  const metrics = createMetricsRegistry();
  const runtime = shouldStartBackgroundJobs
    ? createMarketRuntime(app, database, config, app.log, marketDataRuntimeState, metrics, {}, options.startupProgress)
    : null;

  migrateDatabase(database);
  canonicalizePersistedCoinNames(database);
  options.startupProgress?.complete('connect_database');

  registerAppRoutes(app, database, config, marketDataRuntimeState, metrics);

  app.addHook('onReady', async () => {
    if (runtime) {
      await runtime.start();
      await runtime.whenReady();
      seedStaticReferenceData(database, { includeSeededExchanges: true });
      rebuildSearchIndex(database);
    } else {
      await runBootstrapReadinessFlow(
        app,
        database,
        config,
        marketDataRuntimeState,
        metrics,
        options,
        bootstrapSnapshotAccessMode,
        bootstrapOnlyValidationRuntime,
        seedValidationSnapshotMode,
      );
    }
  });

  app.addHook('onClose', async () => {
    if (runtime) {
      await runtime.stop();
    }

    await closeExchangePool();
    database.client.close();
  });

  app.decorate('marketDataRuntimeState', marketDataRuntimeState);
  app.decorate('marketRuntime', runtime);
  app.decorate('metrics', metrics);
  app.decorate('db', database);
  app.decorate('appConfig', config);
  app.decorate('marketFreshnessThresholdSeconds', config.marketFreshnessThresholdSeconds);

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url || request.url.split('?')[0] || 'unknown';
    recordStartupPrewarmObservation(app, request.url, reply.elapsedTime, reply.statusCode);
    app.metrics.recordRequest(route, request.method, reply.statusCode, reply.elapsedTime);
    done();
  });

  return app;
}
