import { buildApp } from './app';
import { getLastResolvedConfig, loadConfig } from './config/env';
import { detectSqliteRuntime } from './db/client';
import { serializeErrorForLog } from './lib/logger';
import { createStartupProgressTracker } from './services/startup-progress';

async function start() {
  const startupProgress = createStartupProgressTracker();
  let app = null;

  try {
    const config = loadConfig();
    startupProgress.start({
      runtime: detectSqliteRuntime(),
      driver: 'better-sqlite3',
      databaseUrl: config.databaseUrl,
    });
    startupProgress.complete('load_config');
    const validationBootstrapOnlyMode = config.host === '127.0.0.1'
      && config.port === 3102
      && config.databaseUrl === ':memory:';
    app = buildApp({
      config,
      startBackgroundJobs: !validationBootstrapOnlyMode,
      pluginTimeout: 0,
      startupPluginTimeout: 110_000,
      startupProgress,
    });

    if (validationBootstrapOnlyMode) {
      await import('./services/currency-rates')
        .then(({ resetCurrencyApiSnapshotForTests }) => {
          resetCurrencyApiSnapshotForTests();
        });
    }

    await app.listen({
      host: config.host,
      port: config.port,
    });
    app.marketDataRuntimeState.listenerBound = true;
    startupProgress.complete('start_http_listener');
    startupProgress.finish(config.port);
    app.log.info({ timestamp: new Date().toISOString().replace('.000Z', 'Z') }, `Server listening at http://127.0.0.1:${config.port}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    startupProgress.failCurrent(message);
    const config = getLastResolvedConfig();

    if (!app && config) {
      app = buildApp({
        config,
        startBackgroundJobs: false,
        pluginTimeout: 0,
      });
    }

    if (app) {
      app.log.error({ error: serializeErrorForLog(error) }, 'server startup failed');
      await app.close().catch(() => undefined);
    } else {
      console.error(JSON.stringify({
        level: 'error',
        message: 'server startup failed',
        error: serializeErrorForLog(error),
      }));
    }
    process.exit(1);
  }
}

void start();
