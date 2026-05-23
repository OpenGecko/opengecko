import { and, eq, isNull, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import type { AppDatabase } from '../db/client';
import { buildSqliteDatabaseDiagnostics } from '../db/runtime';
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
import { buildGlobalPublicRouteData } from './global';
import { isLiveSourceKind, isSeededExchangeTimestamp } from '../services/diagnostics-policy';
import { buildExchangeVolumeProviderDiagnostics } from '../services/exchange-volume-diagnostics';
import { buildFreshnessBudgetDiagnostics } from '../services/freshness-budgets';
import { buildMarketChartProviderDiagnostics } from '../services/market-chart-diagnostics';
import { buildOnchainAnalyticsProviderDiagnostics } from '../services/onchain-analytics-diagnostics';
import { buildOnchainTradeProviderDiagnostics } from '../services/onchain-trade-diagnostics';
import { sanitizeNullableDiagnosticText } from '../services/diagnostic-sanitizer';
import { SCHEDULER_JOB_STATUS_VALUES } from '../services/job-scheduler';
import { runProviderFanoutValidationTrigger } from '../services/provider-fanout-validation-trigger';
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
  getProviderAttemptDiagnosticsState,
  resetProviderFaultControls,
  recordValidationRuntimeOverride,
  setProviderFaultControl,
  type ProviderAttemptFamily,
  type ProviderFaultControlMode,
} from '../services/market-runtime-state';
import {
  COINS_MARKETS_ROUTE_CACHE_POLICY,
  SIMPLE_PRICE_ROUTE_CACHE_POLICY,
} from './route-cache-policies';

const STALE_DATA_FALLBACK_DISCLOSURE_SURFACES = [
  '/diagnostics/freshness_budgets',
  '/diagnostics/data_quality',
  '/diagnostics/coverage_matrix',
] as const;

const SCHEDULER_REFRESH_JOB_BY_FAMILY: Record<string, string> = {
  simple: 'market-refresh',
  coins_markets: 'market-refresh',
  coin_detail: 'market-refresh',
  global: 'global-aggregator',
  exchanges: 'exchange-metadata-rescan',
  historical_charts: 'ohlcv-tick',
  stable_catalog: 'coin-catalog-rescan',
  onchain: 'defillama-pool-sweep',
  derivatives: 'derivatives-refresh',
  supply_charts: 'supply-aggregator',
  treasury: 'treasury-sweep',
};

function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort();
}

function buildSchedulerStaleDataFallbackDiagnostics(database: AppDatabase) {
  const freshnessDiagnostics = buildFreshnessBudgetDiagnostics(buildCoverageMatrix(database));
  const affectedFamilies = freshnessDiagnostics.budgets
    .filter((budget) => (
      budget.status === 'stale'
      || budget.status === 'degraded'
      || budget.reason_codes.some((reason) => reason.includes('stale') || reason.includes('fallback'))
    ))
    .map((budget) => ({
      family: budget.family,
      status: budget.status,
      reason_codes: budget.reason_codes,
      last_success_at: budget.last_success_at,
      age_seconds: budget.age_seconds,
      budget_seconds: budget.budget_seconds,
      degraded_after_seconds: budget.budget.degraded_after_seconds,
      public_routes: budget.representative_routes,
      source_state: budget.source_state,
      ownership_class: budget.ownership_class,
      scheduler_correlation: {
        refresh_job: SCHEDULER_REFRESH_JOB_BY_FAMILY[budget.family] ?? null,
        disclosure: 'public route may be serving cached or stale data until the scheduler refresh succeeds',
      },
    }));
  const reasonCodes = uniqueStrings(affectedFamilies.flatMap((family) => family.reason_codes));

  return {
    active: affectedFamilies.length > 0,
    status: affectedFamilies.length > 0 ? 'active' : 'clear',
    generated_at: freshnessDiagnostics.generated_at,
    reason_codes: reasonCodes,
    affected_family_count: affectedFamilies.length,
    affected_families: affectedFamilies,
    disclosure_surfaces: [...STALE_DATA_FALLBACK_DISCLOSURE_SURFACES],
  };
}

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
      data: buildFreshnessBudgetDiagnostics(buildCoverageMatrix(database)),
    }, dynamicDiagnosticsCachePolicy);
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

    const publicGlobalRouteData = buildGlobalPublicRouteData(
      database,
      app.marketDataRuntimeState,
      marketFreshnessThresholdSeconds,
    );

    return sendCacheableJson(request, reply, {
      data: buildDataQualityDiagnostics(
        buildCoverageMatrix(database, now),
        runtimeDiagnostics,
        now,
        database,
        publicGlobalRouteData,
      ),
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
          allowed_job_statuses: [...SCHEDULER_JOB_STATUS_VALUES],
          stale_data_fallback: buildSchedulerStaleDataFallbackDiagnostics(database),
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

    const databaseDiagnostics = buildSqliteDatabaseDiagnostics(database, app.appConfig.databaseUrl);
    const missionValidationPorts = [3100, 3102, 3103];

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
        database: databaseDiagnostics,
        validation_profile: {
          mission_service_ports: missionValidationPorts,
          current_port: app.appConfig.port,
          current_port_approved: missionValidationPorts.includes(app.appConfig.port),
          service_role: app.appConfig.port === 3100
            ? 'api_smoke'
            : app.appConfig.port === 3102
              ? 'validation_control'
              : app.appConfig.port === 3103
                ? 'data_quality_gate'
                : 'non_mission',
          port_3000_required: false,
          service_backed_validation: {
            serial_required: true,
            explicit_database_url: databaseDiagnostics.configured_url,
            database_path_class: databaseDiagnostics.path_class,
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

  app.post('/diagnostics/runtime/provider_fault_control', async (request, reply) => {
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
      provider?: string;
      family?: ProviderAttemptFamily;
      mode?: ProviderFaultControlMode;
      reason?: string | null;
      reset?: boolean;
    };

    if (body.reset === true) {
      resetProviderFaultControls(app.marketDataRuntimeState);
      return {
        data: {
          fault_controls: [],
        },
      };
    }

    const provider = typeof body.provider === 'string' && body.provider.trim().length > 0
      ? normalizeProviderCapabilityId(body.provider.trim())
      : null;
    const family = body.family ?? 'ticker';
    const mode = body.mode ?? 'off';
    const allowedFamilies: ProviderAttemptFamily[] = ['ticker', 'onchain'];
    const allowedModes: ProviderFaultControlMode[] = ['timeout', 'failure', 'canceled', 'blocked_unavailable', 'off'];

    if (provider === null || !allowedFamilies.includes(family) || !allowedModes.includes(mode)) {
      reply.code(400);
      return {
        error: 'bad_request',
        message: 'provider, family, and mode are required provider fault control fields',
        allowed: {
          family: allowedFamilies,
          mode: allowedModes,
        },
      };
    }

    setProviderFaultControl(app.marketDataRuntimeState, {
      provider,
      family,
      mode,
      reason: sanitizeNullableDiagnosticText(body.reason ?? null),
    });

    return {
      data: {
        fault_controls: Object.values(getProviderAttemptDiagnosticsState(app.marketDataRuntimeState).faultControls),
      },
    };
  });

  app.post('/diagnostics/runtime/provider_fanout_validation', async (request, reply) => {
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
      providers?: string[];
      budget_ms?: number;
      concurrency?: number;
      allow_breaker_probe?: boolean;
    };
    const configuredProviders = new Set(app.appConfig.ccxtExchanges.map((exchangeId) => normalizeProviderCapabilityId(exchangeId)));
    const rawProviders = Array.isArray(body.providers) && body.providers.length > 0
      ? body.providers
      : app.appConfig.ccxtExchanges;
    const providers = [...new Set(rawProviders
      .filter((provider): provider is string => typeof provider === 'string' && provider.trim().length > 0)
      .map((provider) => normalizeProviderCapabilityId(provider.trim())))];
    const unknownProviders = providers.filter((provider) => !configuredProviders.has(provider));
    const budgetMs = typeof body.budget_ms === 'number' && Number.isFinite(body.budget_ms)
      ? Math.max(1, Math.floor(body.budget_ms))
      : undefined;
    const concurrency = typeof body.concurrency === 'number' && Number.isFinite(body.concurrency)
      ? Math.max(1, Math.floor(body.concurrency))
      : app.appConfig.providerFanoutConcurrency;

    if (providers.length === 0 || unknownProviders.length > 0) {
      reply.code(400);
      return {
        error: 'bad_request',
        message: 'providers must be configured CCXT exchange providers for ticker validation fanout',
        allowed_providers: [...configuredProviders].sort(),
        unknown_providers: unknownProviders,
      };
    }

    const result = await runProviderFanoutValidationTrigger(app.marketDataRuntimeState, app.metrics, {
      providers,
      concurrency,
      budgetMs,
      allowBreakerProbe: body.allow_breaker_probe === true,
    });

    return {
      data: result,
    };
  });

  app.post('/diagnostics/runtime/scheduler_backoff_validation', async (request, reply) => {
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

    if (!app.scheduler) {
      reply.code(409);
      return {
        error: 'scheduler_unavailable',
        message: 'Scheduler diagnostics are not enabled for this validation runtime.',
      };
    }

    const body = (request.body ?? {}) as {
      reason?: string | null;
    };
    const failureReason = typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim()
      : 'validation scheduler job forced failure';
    const validationJobName = 'validation-scheduler-backoff';

    if (!app.scheduler.registeredJobNames().includes(validationJobName)) {
      app.scheduler.register({
        name: validationJobName,
        intervalSeconds: 60,
        run: async () => {
          throw new Error(failureReason);
        },
      });
    }

    await app.scheduler.runNow(validationJobName);
    const job = app.scheduler.diagnostics().find((diagnostic) => diagnostic.name === validationJobName) ?? null;

    return {
      data: {
        validation_path: {
          route: '/diagnostics/runtime/scheduler_backoff_validation',
          diagnostics_route: '/diagnostics/jobs',
          validation_port: 3102,
          cache_independent: true,
          public_route_read_required: false,
          forced_job_failure: true,
        },
        job,
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
