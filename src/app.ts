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
import { closeExchangePool } from './providers/ccxt';
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

function tryParseSourceProvidersJson(value: string | null | undefined) {
  if (!value) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [] as string[];
  }
}

function seedValidationSnapshotsFromPersistentStore(
  runtimeDatabase: ReturnType<typeof createDatabase>,
  persistentDatabaseUrl: string,
  runtimeState: AppLifecycleState,
) {
  if (persistentDatabaseUrl === ':memory:' || persistentDatabaseUrl === runtimeDatabase.url) {
    return null;
  }

  const persistentDatabase = createDatabase(persistentDatabaseUrl);

  try {
    const sourceRows = persistentDatabase.client.prepare<{
      coin_id: string;
      symbol: string;
      name: string;
      api_symbol: string;
      platforms_json: string;
      updated_at: number;
      price: number;
      market_cap: number | null;
      total_volume: number | null;
      market_cap_rank: number | null;
      fully_diluted_valuation: number | null;
      circulating_supply: number | null;
      total_supply: number | null;
      max_supply: number | null;
      ath: number | null;
      ath_change_percentage: number | null;
      ath_date: number | null;
      atl: number | null;
      atl_change_percentage: number | null;
      atl_date: number | null;
      price_change_24h: number | null;
      price_change_percentage_24h: number | null;
      source_providers_json: string;
      source_count: number;
      updated_snapshot_at: number;
      last_updated: number;
    }>(`
      SELECT
        ms.coin_id,
        c.symbol,
        c.name,
        c.api_symbol,
        c.platforms_json,
        c.updated_at,
        ms.price,
        ms.market_cap,
        ms.total_volume,
        ms.market_cap_rank,
        ms.fully_diluted_valuation,
        ms.circulating_supply,
        ms.total_supply,
        ms.max_supply,
        ms.ath,
        ms.ath_change_percentage,
        ms.ath_date,
        ms.atl,
        ms.atl_change_percentage,
        ms.atl_date,
        ms.price_change_24h,
        ms.price_change_percentage_24h,
        ms.source_providers_json,
        ms.source_count,
        ms.updated_at AS updated_snapshot_at,
        ms.last_updated
      FROM market_snapshots ms
      INNER JOIN coins c ON c.id = ms.coin_id
      WHERE ms.vs_currency = 'usd'
        AND ms.source_count > 0
      ORDER BY ms.coin_id
    `).all();

    if (sourceRows.length === 0) {
      return {
        importedRows: 0,
        latestSnapshotTimestamp: null as string | null,
        latestSourceCount: null as number | null,
      };
    }

    const now = new Date();
    const insertCoin = runtimeDatabase.client.prepare(`
      INSERT INTO coins (
        id, symbol, name, api_symbol, hashing_algorithm, block_time_in_minutes,
        categories_json, description_json, links_json, image_thumb_url, image_small_url,
        image_large_url, market_cap_rank, genesis_date, platforms_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, '[]', '{}', '{}', NULL, NULL, NULL, NULL, NULL, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol,
        name = excluded.name,
        api_symbol = excluded.api_symbol,
        platforms_json = excluded.platforms_json,
        updated_at = excluded.updated_at
    `);
    const insertSnapshot = runtimeDatabase.client.prepare(`
      INSERT INTO market_snapshots (
        coin_id, vs_currency, price, market_cap, total_volume, market_cap_rank,
        fully_diluted_valuation, circulating_supply, total_supply, max_supply, ath,
        ath_change_percentage, ath_date, atl, atl_change_percentage, atl_date,
        price_change_24h, price_change_percentage_24h, source_providers_json, source_count,
        updated_at, last_updated
      ) VALUES (?, 'usd', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coin_id, vs_currency) DO UPDATE SET
        price = excluded.price,
        market_cap = excluded.market_cap,
        total_volume = excluded.total_volume,
        market_cap_rank = excluded.market_cap_rank,
        fully_diluted_valuation = excluded.fully_diluted_valuation,
        circulating_supply = excluded.circulating_supply,
        total_supply = excluded.total_supply,
        max_supply = excluded.max_supply,
        ath = excluded.ath,
        ath_change_percentage = excluded.ath_change_percentage,
        ath_date = excluded.ath_date,
        atl = excluded.atl,
        atl_change_percentage = excluded.atl_change_percentage,
        atl_date = excluded.atl_date,
        price_change_24h = excluded.price_change_24h,
        price_change_percentage_24h = excluded.price_change_percentage_24h,
        source_providers_json = excluded.source_providers_json,
        source_count = excluded.source_count,
        updated_at = excluded.updated_at,
        last_updated = excluded.last_updated
    `);

    let latestSnapshotTimestamp: string | null = null;
    let latestSourceCount: number | null = null;

    runtimeDatabase.client.exec('BEGIN');
    try {
      for (const row of sourceRows) {
        insertCoin.run(
          row.coin_id,
          row.symbol,
          row.name,
          row.api_symbol,
          row.platforms_json,
          row.updated_at,
          row.updated_at,
        );
        insertSnapshot.run(
          row.coin_id,
          row.price,
          row.market_cap,
          row.total_volume,
          row.market_cap_rank,
          row.fully_diluted_valuation,
          row.circulating_supply,
          row.total_supply,
          row.max_supply,
          row.ath,
          row.ath_change_percentage,
          row.ath_date,
          row.atl,
          row.atl_change_percentage,
          row.atl_date,
          row.price_change_24h,
          row.price_change_percentage_24h,
          JSON.stringify(tryParseSourceProvidersJson(row.source_providers_json)),
          row.source_count,
          row.updated_snapshot_at,
          row.last_updated,
        );

        const lastUpdatedIso = new Date(row.last_updated).toISOString();
        if (latestSnapshotTimestamp === null || lastUpdatedIso > latestSnapshotTimestamp) {
          latestSnapshotTimestamp = lastUpdatedIso;
          latestSourceCount = row.source_count;
        }
      }
      runtimeDatabase.client.exec('COMMIT');
    } catch (error) {
      runtimeDatabase.client.exec('ROLLBACK');
      throw error;
    }

    runtimeState.validationOverride = {
      mode: 'degraded_seeded_bootstrap',
      reason: 'validation runtime seeded from persistent live snapshots',
      snapshotTimestampOverride: latestSnapshotTimestamp,
      snapshotSourceCountOverride: latestSourceCount,
    };

    return {
      importedRows: sourceRows.length,
      latestSnapshotTimestamp,
      latestSourceCount,
    };
  } finally {
    persistentDatabase.client.close();
  }
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = mergeConfig(options.config);
  const bootstrapOnlyValidationRuntime = !options.startBackgroundJobs
    && config.host === '127.0.0.1'
    && config.port === 3102;
  const suppressBuiltInLogsUntilReady = options.startupProgress != null;
  const useEmojiCompactHttpLogs = config.logPretty && config.httpLogStyle === 'emoji_compact_p';
  const loggerOpts = config.logLevel === 'silent'
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
  const shouldStartBackgroundJobs = options.startBackgroundJobs ?? false;
  const marketDataRuntimeState = createMarketDataRuntimeState();
  const metrics = createMetricsRegistry();
  const runtime = shouldStartBackgroundJobs
    ? createMarketRuntime(app, database, config, app.log, marketDataRuntimeState, metrics, {}, options.startupProgress)
    : null;

  migrateDatabase(database);
  options.startupProgress?.complete('connect_database');

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

  app.addHook('onReady', async () => {
    const startupTimeoutMs = options.startupPluginTimeout ?? options.pluginTimeout;
    const withStartupTimeout = async <T>(operation: Promise<T>, message: string) => {
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
    };
    const shouldEnforceInitialSyncTimeout = !runtime;

    // Always run initial market sync (live data from CCXT)
    if (runtime) {
      await runtime.start();
      await runtime.whenReady();
      seedStaticReferenceData(database);
      rebuildSearchIndex(database);
    } else {
      if (bootstrapOnlyValidationRuntime && config.databaseUrl === ':memory:') {
        seedValidationSnapshotsFromPersistentStore(
          database,
          './data/opengecko.db',
          marketDataRuntimeState,
        );
      }
      const { runInitialMarketSync } = await import('./services/initial-sync');
      const hotDataWasVisible =
        marketDataRuntimeState.initialSyncCompleted
        || marketDataRuntimeState.allowStaleLiveService
        || marketDataRuntimeState.syncFailureReason !== null;
      const syncOperation = runInitialMarketSync(database, config, undefined, {
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
      }, marketDataRuntimeState);
      await (shouldEnforceInitialSyncTimeout
        ? withStartupTimeout(
            syncOperation,
            `Startup initial sync exceeded ${startupTimeoutMs}ms before listener bind`,
          )
        : syncOperation);
      const newlyExposedHotData = !hotDataWasVisible;
      marketDataRuntimeState.initialSyncCompleted = true;
      marketDataRuntimeState.allowStaleLiveService = bootstrapOnlyValidationRuntime
        && marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots;
      marketDataRuntimeState.syncFailureReason = null;

      if (
        !marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots
        && (newlyExposedHotData || marketDataRuntimeState.hotDataRevision > 0)
      ) {
        marketDataRuntimeState.hotDataRevision += 1;
      }

      // Seed static reference data (treasury, derivatives, onchain) after coins exist
      options.startupProgress?.begin('seed_reference_data');
      seedStaticReferenceData(database);
      options.startupProgress?.complete('seed_reference_data');
      options.startupProgress?.begin('rebuild_search_index');
      rebuildSearchIndex(database);
      options.startupProgress?.complete('rebuild_search_index');
      await runStartupPrewarm(app, marketDataRuntimeState, metrics, config.startupPrewarmBudgetMs);
      options.startupProgress?.begin('start_http_listener');
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
