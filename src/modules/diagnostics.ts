import { and, eq, isNull, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

import type { AppDatabase } from '../db/client';
import { assetPlatforms, coins, marketSnapshots } from '../db/schema';
import { summarizeOhlcvSyncStatus } from '../services/ohlcv-runtime';
import { buildRuntimeDiagnostics } from '../services/runtime-diagnostics';

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
) {
  app.get('/diagnostics/chain_coverage', async () => {
    const totalPlatforms = database.db.select().from(assetPlatforms).all().length;

    const platformsWithChainId = database.db
      .select()
      .from(assetPlatforms)
      .where(not(isNull(assetPlatforms.chainIdentifier)))
      .all().length;

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

    return {
      data: {
        platform_counts: {
          total: totalPlatforms,
          with_chain_identifier: platformsWithChainId,
          without_chain_identifier: Math.max(totalPlatforms - platformsWithChainId, 0),
        },
        contract_mapping: {
          active_coins: activeCoins,
          coins_with_platform_mappings: contractMappedCoins,
          coins_without_platform_mappings: Math.max(activeCoins - contractMappedCoins, 0),
        },
      },
    };
  });

  app.get('/diagnostics/ohlcv_sync', async () => {
    return {
      data: summarizeOhlcvSyncStatus(database, new Date()),
    };
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
        ...buildRuntimeDiagnostics(app.marketDataRuntimeState, latestUsdSnapshot, marketFreshnessThresholdSeconds),
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
      ? (typeof body.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim()
        : 'forced provider failure active')
      : null;

    app.marketDataRuntimeState.forcedProviderFailure = {
      active,
      reason,
    };

    if (!active) {
      app.marketDataRuntimeState.providerFailureCooldownUntil = null;
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
      mode?: 'off' | 'stale_disallowed' | 'stale_allowed' | 'degraded_seeded_bootstrap';
      reason?: string | null;
    };
    const mode = body.mode ?? 'off';
    const allowedModes = new Set(['off', 'stale_disallowed', 'stale_allowed', 'degraded_seeded_bootstrap']);

    if (!allowedModes.has(mode)) {
      reply.code(400);
      return {
        error: 'invalid_parameter',
        message: 'mode must be one of off, stale_disallowed, stale_allowed, degraded_seeded_bootstrap.',
      };
    }

    const reason = mode === 'off'
      ? null
      : (typeof body.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim()
        : 'validation degraded state override');

    const snapshotTimestampOverride = mode === 'stale_disallowed' || mode === 'stale_allowed'
      ? new Date(0).toISOString()
      : mode === 'degraded_seeded_bootstrap'
        ? new Date().toISOString()
        : null;
    const snapshotSourceCountOverride = mode === 'degraded_seeded_bootstrap'
      ? 0
      : mode === 'stale_disallowed' || mode === 'stale_allowed'
        ? 1
        : null;

    app.marketDataRuntimeState.validationOverride = {
      mode,
      reason,
      snapshotTimestampOverride,
      snapshotSourceCountOverride,
    };
    app.marketDataRuntimeState.hotDataRevision += 1;

    return {
      data: {
        mode,
        reason,
        cache_revision: app.marketDataRuntimeState.hotDataRevision,
      },
    };
  });
}
