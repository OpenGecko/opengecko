import type { FastifyInstance } from 'fastify';

import type { AppDatabase } from '../../db/client';
import type { ChartResponseSourceDiagnostics } from '../../services/chart-response-source-diagnostics';
import type { MarketDataRuntimeState } from '../../services/market-runtime-state';
import { registerCoinCategoryRoutes } from './category-routes';
import { registerCoinChartRoutes } from './chart-routes';
import { registerCoinContractRoutes } from './contract-routes';
import { registerCoinDetailRoutes } from './detail-routes';
import { registerCoinListRoutes } from './list-routes';
import type { CoinMarketsCacheEntry } from './market-data';
import { registerCoinMarketRoutes } from './market-routes';
import type { CoinsRouteContext } from './route-context';
import { registerCoinSupplyRoutes } from './supply-routes';

export function registerCoinRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
  chartResponseSources: ChartResponseSourceDiagnostics,
) {
  const coinMarketsCache = new Map<string, CoinMarketsCacheEntry>();
  const context: CoinsRouteContext = {
    app,
    database,
    marketFreshnessThresholdSeconds,
    runtimeState,
    chartResponseSources,
    coinMarketsCache,
  };

  registerCoinListRoutes(context);
  registerCoinMarketRoutes(context);
  registerCoinDetailRoutes(context);
  registerCoinChartRoutes(context);
  registerCoinSupplyRoutes(context);
  registerCoinCategoryRoutes(context);
  registerCoinContractRoutes(context);
}
