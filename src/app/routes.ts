import type { FastifyInstance } from 'fastify';

import { registerErrorHandler } from '../http/errors';
import { registerTransportControls } from '../http/transport';
import { registerAssetPlatformRoutes } from '../modules/assets';
import { registerCoinRoutes } from '../modules/coins';
import { registerDiagnosticsRoutes } from '../modules/diagnostics';
import { registerExchangeRoutes } from '../modules/exchanges';
import { registerGlobalRoutes } from '../modules/global';
import { registerHealthRoutes } from '../modules/health';
import { registerOnchainRoutes } from '../modules/onchain';
import { registerSearchRoutes } from '../modules/search';
import { registerSimpleRoutes } from '../modules/simple';
import { registerTreasuryRoutes } from '../modules/treasury';
import type { AppRouteDependencies } from './types';

export function registerAppRoutes(app: FastifyInstance, {
  database,
  config,
  marketDataRuntimeState,
  metrics,
}: AppRouteDependencies) {
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
