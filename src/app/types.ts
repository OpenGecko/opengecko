import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/env';
import type { createDatabase } from '../db/client';
import type { MarketRuntime } from '../services/market-runtime';
import { createMarketDataRuntimeState, type MarketDataRuntimeState } from '../services/market-runtime-state';
import type { MetricsRegistry } from '../services/metrics';
import type { StartupProgressReporter } from '../services/startup-progress';

export type BuildAppOptions = {
  config?: Partial<AppConfig>;
  startBackgroundJobs?: boolean;
  pluginTimeout?: number;
  startupPluginTimeout?: number;
  startupProgress?: StartupProgressReporter;
};

export type AppLifecycleState = ReturnType<typeof createMarketDataRuntimeState>;
export type Database = ReturnType<typeof createDatabase>;
export type InitialSyncCallbacks = import('../services/initial-sync').InitialSyncProgressHandlers;
export type InitialSyncResult = {
  coinsDiscovered: number;
  chainsDiscovered: number;
  snapshotsCreated: number;
  tickersWritten: number;
  exchangesSynced: number;
  ohlcvCandlesWritten: number;
};

export type AppRouteDependencies = {
  database: Database;
  config: AppConfig;
  marketDataRuntimeState: MarketDataRuntimeState;
  metrics: MetricsRegistry;
};

export type BuildAppContext = {
  app: FastifyInstance;
  config: AppConfig;
  database: Database;
  marketDataRuntimeState: AppLifecycleState;
  metrics: MetricsRegistry;
  runtime: MarketRuntime | null;
  bootstrapSnapshotAccessMode: 'disabled' | 'seeded_bootstrap';
  bootstrapOnlyValidationRuntime: boolean;
  seedValidationSnapshotMode: boolean;
  shouldStartBackgroundJobs: boolean;
  options: BuildAppOptions;
};
