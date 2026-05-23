import { buildApp } from './app';
import { getLastResolvedConfig, loadConfig } from './config/env';
import { detectSqliteRuntime } from './db/client';
import { serializeErrorForLog } from './lib/logger';
import { markMarketRuntimeListenerBound } from './services/market-runtime-state';
import { createStartupProgressTracker } from './services/startup-progress';

function writeProcessLifecycleFallback(event: string, detail: Record<string, unknown>) {
  process.stderr.write(`${JSON.stringify({
    level: 'error',
    timestamp: new Date().toISOString().replace('.000Z', 'Z'),
    event,
    ...detail,
  })}\n`);
}

async function start() {
  const startupProgress = createStartupProgressTracker();
  let app: ReturnType<typeof buildApp> | null = null;
  let shutdownStarted = false;

  const logProcessLifecycle = (event: string, detail: Record<string, unknown>) => {
    if (app) {
      app.log.error({ timestamp: new Date().toISOString().replace('.000Z', 'Z'), event, ...detail }, `server process lifecycle event=${event}`);
      return;
    }

    writeProcessLifecycleFallback(event, detail);
  };

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    logProcessLifecycle('signal', { signal });
    const forceExit = setTimeout(() => {
      writeProcessLifecycleFallback('forced_exit_after_signal', { signal });
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    if (app) {
      await app.close().catch((error: unknown) => {
        writeProcessLifecycleFallback('close_failed_after_signal', {
          signal,
          error: serializeErrorForLog(error),
        });
      });
    }

    process.exit(0);
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('unhandledRejection', (reason) => {
    logProcessLifecycle('unhandled_rejection', {
      error: serializeErrorForLog(reason),
      action: 'logged_and_kept_process_alive',
    });
  });
  process.once('uncaughtException', (error) => {
    logProcessLifecycle('uncaught_exception', {
      error: serializeErrorForLog(error),
      action: 'closing_server_and_exiting',
    });
    void (async () => {
      if (app) {
        await app.close().catch(() => undefined);
      }
      process.exit(1);
    })();
  });
  process.on('exit', (code) => {
    writeProcessLifecycleFallback('exit', { code });
  });

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
      exposeSchedulerDiagnostics: validationBootstrapOnlyMode,
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
    markMarketRuntimeListenerBound(app.marketDataRuntimeState);
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
