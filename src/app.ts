import Fastify, { type FastifyInstance } from 'fastify';

import { mergeConfig, type AppConfig } from './config/env';
import { createDatabase, migrateDatabase, seedStaticReferenceData, rebuildSearchIndex } from './db/client';
import { registerErrorHandler } from './http/errors';
import { formatHttpCompactPLog } from './http/http-log-style';
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
import type { StartupProgressReporter } from './services/startup-progress';

declare module 'fastify' {
  interface FastifyInstance {
    marketDataRuntimeState: AppLifecycleState;
    marketRuntime: MarketRuntime | null;
  }
}

export type BuildAppOptions = {
  config?: Partial<AppConfig>;
  startBackgroundJobs?: boolean;
  pluginTimeout?: number;
  startupProgress?: StartupProgressReporter;
};

export type AppLifecycleState = ReturnType<typeof createMarketDataRuntimeState>;

export function getDatabaseStartupLogContext(database: { runtime: 'bun' | 'node'; url: string }) {
  return {
    runtime: database.runtime,
    driver: database.runtime === 'bun' ? 'bun:sqlite' : 'better-sqlite3',
    databaseUrl: database.url,
  };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = mergeConfig(options.config);
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
              translateTime: 'HH:MM:ss.L',
              ignore: useEmojiCompactHttpLogs ? 'pid,hostname,req,res,responseTime' : 'pid,hostname',
            },
          },
        } : {}),
      };

  const app = Fastify({
    logger: loggerOpts,
    ...(useEmojiCompactHttpLogs ? { disableRequestLogging: true } : {}),
    ...(options.pluginTimeout ? { pluginTimeout: options.pluginTimeout } : {}),
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
  app.log.info(getDatabaseStartupLogContext(database), 'database initialized');
  const shouldStartBackgroundJobs = options.startBackgroundJobs ?? false;
  const marketDataRuntimeState = createMarketDataRuntimeState();
  const runtime = shouldStartBackgroundJobs
    ? createMarketRuntime(database, config, app.log, marketDataRuntimeState, {}, options.startupProgress)
    : null;

  migrateDatabase(database);
  options.startupProgress?.complete('connect_database');

  registerErrorHandler(app);
  registerHealthRoutes(app);
  registerDiagnosticsRoutes(app, database);
  registerSimpleRoutes(app, database, config.marketFreshnessThresholdSeconds, marketDataRuntimeState);
  registerAssetPlatformRoutes(app, database);
  registerCoinRoutes(app, database, config.marketFreshnessThresholdSeconds, marketDataRuntimeState);
  registerExchangeRoutes(app, database, config.marketFreshnessThresholdSeconds, marketDataRuntimeState);
  registerTreasuryRoutes(app, database);
  registerOnchainRoutes(app, database);
  registerSearchRoutes(app, database);
  registerGlobalRoutes(app, database, config.marketFreshnessThresholdSeconds, marketDataRuntimeState);

  app.addHook('onReady', async () => {
    // Always run initial market sync (live data from CCXT)
    if (runtime) {
      await runtime.start();
      await runtime.whenReady();
      seedStaticReferenceData(database);
      rebuildSearchIndex(database);
    } else {
      const { runInitialMarketSync } = await import('./services/initial-sync');
      await runInitialMarketSync(database, config, undefined, {
        onStepChange: (stepId) => {
          options.startupProgress?.begin(stepId);
        },
        onOhlcvBackfillProgress: (current, total) => {
          options.startupProgress?.updateOhlcvProgress(current, total);
        },
      });
      marketDataRuntimeState.initialSyncCompleted = true;

      // Seed static reference data (treasury, derivatives, onchain) after coins exist
      options.startupProgress?.begin('seed_reference_data');
      seedStaticReferenceData(database);
      options.startupProgress?.complete('seed_reference_data');
      options.startupProgress?.begin('rebuild_search_index');
      rebuildSearchIndex(database);
      options.startupProgress?.complete('rebuild_search_index');
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

  return app;
}
