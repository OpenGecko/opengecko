import type { FastifyInstance } from 'fastify';

import type { AppDatabase } from '../../db/client';
import { registerOnchainAnalyticsRoutes } from './analytics-routes';
import { registerOnchainNetworkRoutes } from './network-routes';
import { registerOnchainOhlcvRoutes } from './ohlcv-routes';
import { registerOnchainPoolRoutes } from './pool-routes';
import { registerOnchainTokenRoutes } from './token-routes';
import { registerOnchainTradeRoutes } from './trade-routes';

export { ONCHAIN_FIXTURE_VERSION } from './meta';

export function registerOnchainRoutes(app: FastifyInstance, database: AppDatabase) {
  registerOnchainNetworkRoutes(app, database);
  registerOnchainPoolRoutes(app, database);
  registerOnchainTokenRoutes(app, database);
  registerOnchainAnalyticsRoutes(app, database);
  registerOnchainTradeRoutes(app, database);
  registerOnchainOhlcvRoutes(app, database);
}
