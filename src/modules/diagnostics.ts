import { and, eq, isNull, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import type { AppDatabase } from '../db/client';
import { assetPlatforms, coins, marketSnapshots } from '../db/schema';
import { sendCacheableJson } from '../http/cache';
import { resolveCanonicalPlatform } from '../lib/platform-id';
import { buildDerivativesProviderDiagnostics } from '../services/derivatives-venues';
import { buildCoinHistoryProviderDiagnostics } from '../services/coin-history-diagnostics';
import type { ChartResponseSourceDiagnostics } from '../services/chart-response-source-diagnostics';
import { buildCoverageMatrix } from '../services/coverage-matrix';
import { buildExchangeVolumeProviderDiagnostics } from '../services/exchange-volume-diagnostics';
import { getEndpointFreshnessBudgets } from '../services/freshness-budgets';
import { buildMarketChartProviderDiagnostics } from '../services/market-chart-diagnostics';
import { buildOnchainAnalyticsProviderDiagnostics } from '../services/onchain-analytics-diagnostics';
import { buildOnchainTradeProviderDiagnostics } from '../services/onchain-trade-diagnostics';
import { sanitizeNullableDiagnosticText } from '../services/diagnostic-sanitizer';
import {
  buildOptionalProviderJobDiagnostics,
  type OptionalProviderJobRegistry,
} from '../services/optional-provider-jobs';
import { summarizeOhlcvSyncStatus } from '../services/ohlcv-runtime';
import { buildRuntimeDiagnostics } from '../services/runtime-diagnostics';
import { buildSupplyChartProviderDiagnostics } from '../services/supply-chart-diagnostics';
import {
  recordForcedProviderFailure,
  recordValidationRuntimeOverride,
} from '../services/market-runtime-state';
import type { AppConfig } from '../config/env';

function getActiveRuntimeDiagnosticProviderIds(config: AppConfig) {
  const providerIds = [...config.ccxtExchanges];

  if (!config.defillamaPoolSweepDisabled || !config.defillamaTokenSweepDisabled) {
    providerIds.push('defillama');
  }

  if (!config.subsquidTradeSweepDisabled) {
    providerIds.push('subsquid');
  }

  if (!config.currencyRatesDisabled && !config.disableRemoteCurrencyRefresh) {
    providerIds.push('currency-api');
  }

  return [...new Set(providerIds)].sort((left, right) => left.localeCompare(right));
}

export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  metrics: {
    renderPrometheus: () => string;
  },
  transport: {
    requestTimeoutMs: number;
    responseCompressionThresholdBytes: number;
  },
  derivatives: {
    ccxtExchanges: string;
    refreshDisabled: boolean;
  },
  coinHistory: {
    targets: string;
  },
  exchangeVolumes: {
    targets: string;
  },
  marketCharts: {
    targets: string;
  },
  onchainAnalytics: {
    targets: string;
  },
  onchainTrades: {
    targets: string;
  },
  supplyCharts: {
    targets: string;
  },
  optionalProviderJobs: OptionalProviderJobRegistry,
  chartResponseSources: ChartResponseSourceDiagnostics,
) {
  const stableDiagnosticsCachePolicy = {
    maxAgeSeconds: 300,
    staleWhileRevalidateSeconds: 300,
  };
  const dynamicDiagnosticsCachePolicy = {
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 60,
  };

  app.get('/diagnostics/chain_coverage', async (request, reply) => {
    const platformRows = database.db.select().from(assetPlatforms).all();
    const totalPlatforms = platformRows.length;

    const platformsWithChainId = platformRows.filter((platform) => platform.chainIdentifier !== null).length;

    const confidenceCounts = platformRows.reduce<Record<string, number>>((counts, platform) => {
      const confidence = resolveCanonicalPlatform(platform.id, {
        networkName: platform.name,
        chainIdentifier: platform.chainIdentifier,
      }).confidence;
      counts[confidence] = (counts[confidence] ?? 0) + 1;
      return counts;
    }, { exact: 0, heuristic: 0, unresolved: 0 });

    const contractMappedCoins = database.db
      .select()
      .from(coins)
      .where(and(eq(coins.status, 'active'), not(isNull(coins.platformsJson)), not(eq(coins.platformsJson, '{}'))))
      .all().length;

    const activeCoins = database.db
      .select()
      .from(coins)
      .where(eq(coins.status, 'active'))
      .all().length;

    return sendCacheableJson(request, reply, {
      data: {
        platform_counts: {
          total: totalPlatforms,
          with_chain_identifier: platformsWithChainId,
          without_chain_identifier: Math.max(totalPlatforms - platformsWithChainId, 0),
        },
        confidence: {
          exact: confidenceCounts.exact ?? 0,
          heuristic: confidenceCounts.heuristic ?? 0,
          unresolved: confidenceCounts.unresolved ?? 0,
        },
        contract_mapping: {
          active_coins: activeCoins,
          coins_with_platform_mappings: contractMappedCoins,
          coins_without_platform_mappings: Math.max(activeCoins - contractMappedCoins, 0),
        },
      },
    }, stableDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/ohlcv_sync', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: summarizeOhlcvSyncStatus(database, new Date()),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/freshness_budgets', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: {
        budgets: getEndpointFreshnessBudgets(),
      },
    }, stableDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/coverage_matrix', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildCoverageMatrix(database),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/derivatives', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildDerivativesProviderDiagnostics(database, derivatives.ccxtExchanges, {
        refreshDisabled: derivatives.refreshDisabled,
      }),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/coin_history', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildCoinHistoryProviderDiagnostics(database, coinHistory.targets),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/exchange_volumes', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildExchangeVolumeProviderDiagnostics(database, exchangeVolumes.targets),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/market_charts', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildMarketChartProviderDiagnostics(
        database,
        marketCharts.targets,
        new Date(),
        chartResponseSources.snapshot(),
        chartResponseSources.recentEvents(),
      ),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/onchain_analytics', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildOnchainAnalyticsProviderDiagnostics(database, onchainAnalytics.targets),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/onchain_trades', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildOnchainTradeProviderDiagnostics(database, onchainTrades.targets),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/supply_charts', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildSupplyChartProviderDiagnostics(database, supplyCharts.targets),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/jobs', async (request, reply) => {
    const optionalProviderDiagnostics = buildOptionalProviderJobDiagnostics(app.appConfig, optionalProviderJobs, database);
    const schedulerJobs = app.scheduler?.diagnostics() ?? [];

    return sendCacheableJson(request, reply, {
      data: app.scheduler ? {
        scheduler: {
          enabled: !app.appConfig.schedulerDisabled,
          started: app.scheduler?.isStarted() ?? false,
          job_count: schedulerJobs.length,
        },
        jobs: schedulerJobs,
        optional_provider_jobs: optionalProviderDiagnostics,
      } : optionalProviderDiagnostics,
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/runtime', async () => {
    const latestUsdSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(eq(marketSnapshots.vsCurrency, 'usd'))
      .orderBy(marketSnapshots.lastUpdated)
      .all()
      .at(-1) ?? null;

    return {
      data: {
        ...buildRuntimeDiagnostics(
          app.marketDataRuntimeState,
          latestUsdSnapshot,
          marketFreshnessThresholdSeconds,
          Date.now(),
          getActiveRuntimeDiagnosticProviderIds(app.appConfig),
        ),
        transport: {
          request_timeout_ms: transport.requestTimeoutMs,
          compression: {
            threshold_bytes: transport.responseCompressionThresholdBytes,
          },
        },
        startup_prewarm: app.marketDataRuntimeState.startupPrewarm,
      },
    };
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(metrics.renderPrometheus());
  });

  app.post('/diagnostics/runtime/provider_failure', async (request, reply) => {
    const boundAddress = app.server.address();
    const boundPort = typeof boundAddress === 'object' && boundAddress !== null
      ? (boundAddress as AddressInfo).port
      : null;
    const configuredPort = app.appConfig.port;
    const validationModeEnabled = boundPort === 3102 || configuredPort === 3102;
    if (!validationModeEnabled) {
      reply.code(404);
      return {
        error: 'not_found',
        message: 'Route not found',
      };
    }

    const body = (request.body ?? {}) as {
      active?: boolean;
      reason?: string | null;
    };
    const active = body.active === true;
    const reason = active
      ? sanitizeNullableDiagnosticText(typeof body.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim()
        : 'forced provider failure active')
      : null;

    recordForcedProviderFailure(app.marketDataRuntimeState, { active, reason });

    return {
      data: {
        active,
        reason,
      },
    };
  });

  app.post('/diagnostics/runtime/degraded_state', async (request, reply) => {
    const boundAddress = app.server.address();
    const boundPort = typeof boundAddress === 'object' && boundAddress !== null
      ? (boundAddress as AddressInfo).port
      : null;
    const configuredPort = app.appConfig.port;
    const validationModeEnabled = boundPort === 3102 || configuredPort === 3102;
    if (!validationModeEnabled) {
      reply.code(404);
      return {
        error: 'not_found',
        message: 'Route not found',
      };
    }

    const body = (request.body ?? {}) as {
      mode?: 'off' | 'stale_disallowed' | 'stale_allowed' | 'degraded_seeded_bootstrap' | 'seeded_bootstrap' | 'zero_live_completed_boot';
      reason?: string | null;
    };
    const mode = body.mode ?? 'off';
    const allowedModes = new Set(['off', 'stale_disallowed', 'stale_allowed', 'degraded_seeded_bootstrap', 'seeded_bootstrap', 'zero_live_completed_boot']);

    if (!allowedModes.has(mode)) {
      reply.code(400);
      return {
        error: 'invalid_parameter',
        message: 'mode must be one of off, stale_disallowed, stale_allowed, degraded_seeded_bootstrap, seeded_bootstrap, zero_live_completed_boot.',
      };
    }

    const reason = mode === 'off'
      ? null
      : sanitizeNullableDiagnosticText(typeof body.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim()
        : 'validation degraded state override');

    const snapshotTimestampOverride = mode === 'stale_disallowed' || mode === 'stale_allowed'
      ? new Date(0).toISOString()
      : mode === 'degraded_seeded_bootstrap' || mode === 'seeded_bootstrap' || mode === 'zero_live_completed_boot'
        ? new Date().toISOString()
        : null;
    const snapshotSourceCountOverride = mode === 'degraded_seeded_bootstrap'
      ? 0
      : mode === 'seeded_bootstrap'
        ? 1
      : mode === 'zero_live_completed_boot'
        ? 0
      : mode === 'stale_disallowed' || mode === 'stale_allowed'
        ? 1
        : null;

    recordValidationRuntimeOverride(app.marketDataRuntimeState, {
      mode,
      reason,
      snapshotTimestampOverride,
      snapshotSourceCountOverride,
    });

    return {
      data: {
        mode,
        reason,
        cache_revision: app.marketDataRuntimeState.hotDataRevision,
      },
    };
  });
}
