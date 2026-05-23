import { createLogger } from '../lib/logger';

import { loadConfig } from '../config/env';
import { createDatabase, initializeDatabase } from '../db/client';
import {
  registerSqliteProcessHeartbeat,
  type SqliteProcessHeartbeatRegistration,
} from '../db/sqlite-coordination';
import { createOhlcvRuntime, type OhlcvRuntime } from '../services/ohlcv-runtime';

type RunOhlcvWorkerJobOverrides = {
  loadConfig?: typeof loadConfig;
  createDatabase?: typeof createDatabase;
  initializeDatabase?: typeof initializeDatabase;
  createOhlcvRuntime?: typeof createOhlcvRuntime;
  logger?: ReturnType<typeof createLogger>;
};

export async function runOhlcvWorkerJob(overrides: RunOhlcvWorkerJobOverrides = {}) {
  const config = (overrides.loadConfig ?? loadConfig)();
  const database = (overrides.createDatabase ?? createDatabase)(config.databaseUrl);
  const logger = overrides.logger ?? createLogger({ level: config.logLevel });
  let sqliteProcessHeartbeat: SqliteProcessHeartbeatRegistration | null = null;

  (overrides.initializeDatabase ?? initializeDatabase)(database);
  if (typeof database.client.exec === 'function') {
    sqliteProcessHeartbeat = registerSqliteProcessHeartbeat(database, 'worker');
  }

  const runtime = (overrides.createOhlcvRuntime ?? createOhlcvRuntime)(database, {
    ccxtExchanges: config.ccxtExchanges,
    ohlcvTargetHistoryDays: config.ohlcvTargetHistoryDays,
    ohlcvRetentionDays: config.ohlcvRetentionDays,
  }, logger);

  await runtime.start();

  return {
    ...runtime,
    async stop() {
      try {
        await runtime.stop();
      } finally {
        sqliteProcessHeartbeat?.stop();
        sqliteProcessHeartbeat?.markInactive();
      }
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('run-ohlcv-worker.ts')) {
  void (async () => {
    const runtime: OhlcvRuntime = await runOhlcvWorkerJob();
    let shutdownStarted = false;
    const shutdown = async () => {
      if (shutdownStarted) {
        return;
      }
      shutdownStarted = true;
      await runtime.stop();
      process.exit(0);
    };

    process.once('SIGTERM', () => {
      void shutdown();
    });
    process.once('SIGINT', () => {
      void shutdown();
    });
  })();
}
