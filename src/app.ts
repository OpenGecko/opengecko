import type { FastifyInstance } from 'fastify';

import { mergeConfig, type AppConfig } from './config/env';
import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData } from './db/client';
import { closeExchangePool } from './providers/ccxt';
import { rebuildPersistentSqliteDatabase, resolveBootstrapSnapshotAccessMode } from './services/bootstrap';
import { createMarketRuntime, type MarketRuntime } from './services/market-runtime';
import { createMarketDataRuntimeState } from './services/market-runtime-state';
import { createMetricsRegistry, type MetricsRegistry } from './services/metrics';
import { createFastifyApp } from './app/fastify';
import { registerAppRoutes } from './app/routes';
import {
  canonicalizePersistedCoinNames,
  recordStartupPrewarmObservation,
  runBootstrapReadinessFlow,
} from './app/startup';
import type { AppLifecycleState, BuildAppOptions } from './app/types';

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
  const app = createFastifyApp(config, options);
  options.startupProgress?.begin('connect_database');
  if (config.rebuildCanonicalDbOnStart) {
    rebuildPersistentSqliteDatabase(config.databaseUrl);
  }
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

  registerAppRoutes(app, {
    database,
    config,
    marketDataRuntimeState,
    metrics,
  });

  if (runtime) {
    void runtime.start();
  } else {
    app.addHook('onReady', async () => {
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
    });
  }

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

  if (runtime) {
    app.addHook('onListen', async () => {
      runtime.markListenerBound();
      await runtime.whenReady();
      seedStaticReferenceData(database, { includeSeededExchanges: true });
      rebuildSearchIndex(database);
    });
  }

  return app;
}
