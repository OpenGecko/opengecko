import { and, eq, isNull, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import type { AppDatabase } from '../db/client';
import {
  assetPlatforms,
  coinTickers,
  coins,
  exchanges,
  marketChartSourcePoints,
  marketSnapshots,
  ohlcvSyncTargets,
} from '../db/schema';
import { sendCacheableJson } from '../http/cache';
import { resolveCanonicalPlatform } from '../lib/platform-id';
import { buildDerivativesProviderDiagnostics } from '../services/derivatives-venues';
import { buildCoinHistoryProviderDiagnostics } from '../services/coin-history-diagnostics';
import type { ChartResponseSourceDiagnostics } from '../services/chart-response-source-diagnostics';
import { buildCoverageMatrix } from '../services/coverage-matrix';
import { buildDataQualityDiagnostics } from '../services/data-quality-diagnostics';
import { isLiveSourceKind, isSeededExchangeTimestamp } from '../services/diagnostics-policy';
import { buildExchangeVolumeProviderDiagnostics } from '../services/exchange-volume-diagnostics';
import { getEndpointFreshnessBudgets } from '../services/freshness-budgets';
import { buildMarketChartProviderDiagnostics } from '../services/market-chart-diagnostics';
import { buildOnchainAnalyticsProviderDiagnostics } from '../services/onchain-analytics-diagnostics';
import { buildOnchainTradeProviderDiagnostics } from '../services/onchain-trade-diagnostics';
import { sanitizeNullableDiagnosticText } from '../services/diagnostic-sanitizer';
import { buildExchangeDiagnostics } from '../services/exchange-diagnostics';
import {
  buildOptionalProviderJobDiagnostics,
  type OptionalProviderJobRegistry,
} from '../services/optional-provider-jobs';
import { summarizeOhlcvSyncStatus } from '../services/ohlcv-runtime';
import {
  buildRuntimeDiagnostics,
  normalizeProviderCapabilityId,
  type ProviderCapabilityEvidence,
  type ProviderCapabilitySurface,
} from '../services/runtime-diagnostics';
import { buildSupplyChartProviderDiagnostics } from '../services/supply-chart-diagnostics';
import {
  recordForcedProviderFailure,
  recordValidationRuntimeOverride,
} from '../services/market-runtime-state';
import {
  COINS_MARKETS_ROUTE_CACHE_POLICY,
  SIMPLE_PRICE_ROUTE_CACHE_POLICY,
} from './route-cache-policies';

function toLatestIso(left: string | null, right: Date | null | undefined) {
  if (!right || Number.isNaN(right.getTime())) {
    return left;
  }

  const rightIso = right.toISOString();
  if (left === null) {
    return rightIso;
  }

  return Date.parse(rightIso) > Date.parse(left) ? rightIso : left;
}

function recordCapabilityEvidence(
  evidence: ProviderCapabilityEvidence,
  surface: ProviderCapabilitySurface,
  providerId: string | null | undefined,
  contributedAt: Date | null | undefined,
) {
  if (!providerId || isSeededExchangeTimestamp(contributedAt)) {
    return;
  }

  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  evidence[surface] ??= {};
  const surfaceEvidence = evidence[surface];
  surfaceEvidence[normalizedProviderId] = toLatestIso(surfaceEvidence[normalizedProviderId] ?? null, contributedAt)
    ?? surfaceEvidence[normalizedProviderId];
}

function buildRuntimeCapabilityEvidence(database: AppDatabase): ProviderCapabilityEvidence {
  const evidence: ProviderCapabilityEvidence = {};

  for (const row of database.db.select().from(coinTickers).all()) {
    recordCapabilityEvidence(evidence, 'ticker', row.exchangeId, row.lastFetchAt ?? row.lastTradedAt);
  }

  for (const row of database.db.select().from(exchanges).all()) {
    if (isSeededExchangeTimestamp(row.updatedAt)) {
      continue;
    }

    recordCapabilityEvidence(evidence, 'exchange', row.id, row.updatedAt);
  }

  for (const row of database.db.select().from(ohlcvSyncTargets).all()) {
    recordCapabilityEvidence(evidence, 'chart', row.exchangeId, row.lastSuccessAt);
  }

  for (const row of database.db.select().from(marketChartSourcePoints).all()) {
    if (!isLiveSourceKind(row.sourceKind)) {
      continue;
    }

    recordCapabilityEvidence(evidence, 'chart', row.sourceProvider, row.sourceFetchedAt ?? row.timestamp);
  }

  return evidence;
}

export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  metrics: {
    renderPrometheus: () => string;
    getCacheEventCounts?: (surface: string) => { hit: number; miss: number };
    recordProviderRefresh?: (outcome: 'forced_failure', exchangeCount: number, failedExchangeCount: number) => void;
    recordProviderForcedFailure?: (provider: string) => void;
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

  app.get('/diagnostics/cache', async (request, reply) => {
    const cacheEvents = (surface: string) => metrics.getCacheEventCounts?.(surface) ?? { hit: 0, miss: 0 };

    return sendCacheableJson(request, reply, {
      data: {
        hot_data_revision: app.marketDataRuntimeState.hotDataRevision,
        freshness: {
          market_snapshot_threshold_seconds: marketFreshnessThresholdSeconds,
        },
        surfaces: {
          coins_markets: {
            ttl_seconds: COINS_MARKETS_ROUTE_CACHE_POLICY.ttlSeconds,
            http_cache: {
              max_age_seconds: COINS_MARKETS_ROUTE_CACHE_POLICY.httpCache.maxAgeSeconds,
              stale_while_revalidate_seconds: COINS_MARKETS_ROUTE_CACHE_POLICY.httpCache.staleWhileRevalidateSeconds,
              validators: ['etag', 'if-none-match'],
            },
            invalidated_by: ['hot_data_revision', 'validation_override', 'snapshot_access_policy'],
            events: cacheEvents('coins_markets'),
            operator_evidence: [
              '/coins/markets cache headers (cache-control, etag, 304)',
              '/diagnostics/runtime hot_paths.cache_revision',
              '/metrics opengecko_cache_events_total{surface="coins_markets",outcome="hit|miss"}',
            ],
          },
          simple_price: {
            ttl_seconds: SIMPLE_PRICE_ROUTE_CACHE_POLICY.ttlSeconds,
            http_cache: {
              max_age_seconds: SIMPLE_PRICE_ROUTE_CACHE_POLICY.httpCache.maxAgeSeconds,
              stale_while_revalidate_seconds: SIMPLE_PRICE_ROUTE_CACHE_POLICY.httpCache.staleWhileRevalidateSeconds,
              validators: ['etag', 'if-none-match'],
            },
            invalidated_by: ['hot_data_revision'],
            events: cacheEvents('simple_price'),
            operator_evidence: [
              '/simple/price cache headers (cache-control, etag, 304)',
              '/diagnostics/runtime hot_paths.cache_revision',
              '/metrics opengecko_cache_events_total{surface="simple_price",outcome="hit|miss"}',
            ],
          },
        },
      },
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/coverage_matrix', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildCoverageMatrix(database),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/coverage', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildCoverageMatrix(database),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/data_quality', async (request, reply) => {
    const latestUsdSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(eq(marketSnapshots.vsCurrency, 'usd'))
      .orderBy(marketSnapshots.lastUpdated)
      .all()
      .at(-1) ?? null;
    const capabilityEvidence = buildRuntimeCapabilityEvidence(database);
    const now = new Date();
    const runtimeDiagnostics = buildRuntimeDiagnostics(
      app.marketDataRuntimeState,
      latestUsdSnapshot,
      marketFreshnessThresholdSeconds,
      now.getTime(),
      capabilityEvidence,
    );

    return sendCacheableJson(request, reply, {
      data: buildDataQualityDiagnostics(buildCoverageMatrix(database, now), runtimeDiagnostics, now, database),
    }, dynamicDiagnosticsCachePolicy);
  });

  app.get('/diagnostics/exchanges', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildExchangeDiagnostics(database, app.marketDataRuntimeState),
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

  const buildOnchainDiagnosticsPayload = () => ({
    analytics: buildOnchainAnalyticsProviderDiagnostics(database, onchainAnalytics.targets),
    trades: buildOnchainTradeProviderDiagnostics(database, onchainTrades.targets),
    equivalence: {
      alias_path: '/diagnostics/onchain',
      specialized_paths: ['/diagnostics/onchain_analytics', '/diagnostics/onchain_trades'],
      note: '/diagnostics/onchain is an aggregate alias for the supported specialized onchain diagnostics surfaces.',
    },
  });

  app.get('/diagnostics/onchain', async (request, reply) => {
    return sendCacheableJson(request, reply, {
      data: buildOnchainDiagnosticsPayload(),
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

  app.get('/diagnostics/runtime', async (request, reply) => {
    const latestUsdSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(eq(marketSnapshots.vsCurrency, 'usd'))
      .orderBy(marketSnapshots.lastUpdated)
      .all()
      .at(-1) ?? null;
    const capabilityEvidence = buildRuntimeCapabilityEvidence(database);

    return sendCacheableJson(request, reply, {
      data: {
        ...buildRuntimeDiagnostics(
          app.marketDataRuntimeState,
          latestUsdSnapshot,
          marketFreshnessThresholdSeconds,
          Date.now(),
          capabilityEvidence,
        ),
        transport: {
          request_timeout_ms: transport.requestTimeoutMs,
          compression: {
            threshold_bytes: transport.responseCompressionThresholdBytes,
          },
        },
        startup_prewarm: app.marketDataRuntimeState.startupPrewarm,
      },
    }, dynamicDiagnosticsCachePolicy);
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
    if (active) {
      const exchangeIds = app.appConfig.ccxtExchanges;
      metrics.recordProviderRefresh?.('forced_failure', exchangeIds.length, exchangeIds.length);
      for (const exchangeId of exchangeIds) {
        metrics.recordProviderForcedFailure?.(exchangeId);
      }
    }

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
