import { createLogger } from '../lib/logger';

import { loadConfig } from '../config/env';
import { createDatabase, initializeDatabase } from '../db/client';
import { createOhlcvRuntime } from '../services/ohlcv-runtime';

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

  (overrides.initializeDatabase ?? initializeDatabase)(database);

  const runtime = (overrides.createOhlcvRuntime ?? createOhlcvRuntime)(database, {
    ccxtExchanges: config.ccxtExchanges,
  }, logger);

  await runtime.start();

  return runtime;
}

if (process.argv[1] && process.argv[1].endsWith('run-ohlcv-worker.ts')) {
  void runOhlcvWorkerJob();
}
