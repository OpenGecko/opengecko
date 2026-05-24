import type { FastifyInstance } from 'fastify';

import type { AppDatabase } from '../../db/client';
import type { ChartResponseSourceDiagnostics } from '../../services/chart-response-source-diagnostics';
import type { MarketDataRuntimeState } from '../../services/market-runtime-state';
import type { CoinMarketsCacheEntry } from './market-data';

export interface CoinsRouteContext {
  app: FastifyInstance;
  database: AppDatabase;
  marketFreshnessThresholdSeconds: number;
  runtimeState: MarketDataRuntimeState;
  chartResponseSources: ChartResponseSourceDiagnostics;
  coinMarketsCache: Map<string, CoinMarketsCacheEntry>;
}
