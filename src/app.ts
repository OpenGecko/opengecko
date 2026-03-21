import Fastify, { type FastifyInstance } from 'fastify';

import { mergeConfig, type AppConfig } from './config/env';
import { createDatabase, initializeDatabase } from './db/client';
import { registerErrorHandler } from './http/errors';
import { registerAssetPlatformRoutes } from './modules/assets';
import { registerCoinRoutes } from './modules/coins';
import { registerExchangeRoutes } from './modules/exchanges';
import { registerGlobalRoutes } from './modules/global';
import { registerHealthRoutes } from './modules/health';
import { registerOnchainRoutes } from './modules/onchain';
import { registerSearchRoutes } from './modules/search';
import { registerSimpleRoutes } from './modules/simple';
import { registerTreasuryRoutes } from './modules/treasury';
import { createMarketRuntime } from './services/market-runtime';

export type BuildAppOptions = {
  config?: Partial<AppConfig>;
  startBackgroundJobs?: boolean;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = mergeConfig(options.config);
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
  });
  const database = createDatabase(config.databaseUrl);
  const shouldStartBackgroundJobs = options.startBackgroundJobs ?? false;
  const runtime = shouldStartBackgroundJobs ? createMarketRuntime(database, config, app.log) : null;

  initializeDatabase(database);
  registerErrorHandler(app);
  registerHealthRoutes(app);
  registerSimpleRoutes(app, database, config.marketFreshnessThresholdSeconds);
  registerAssetPlatformRoutes(app, database);
  registerCoinRoutes(app, database, config.marketFreshnessThresholdSeconds);
  registerExchangeRoutes(app, database, config.marketFreshnessThresholdSeconds);
  registerTreasuryRoutes(app, database);
  registerOnchainRoutes(app, database);
  registerSearchRoutes(app, database);
  registerGlobalRoutes(app, database, config.marketFreshnessThresholdSeconds);

  if (runtime) {
    app.addHook('onReady', async () => {
      await runtime.start();
    });
  }

  app.addHook('onClose', async () => {
    if (runtime) {
      await runtime.stop();
    }

    database.client.close();
  });

  return app;
}
