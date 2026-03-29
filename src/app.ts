import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { mergeConfig, type AppConfig } from './config/env';
import { createDatabase, migrateDatabase, seedStaticReferenceData, rebuildSearchIndex } from './db/client';
import { registerErrorHandler } from './http/errors';
import { formatHttpCompactPLog } from './http/http-log-style';
import { registerTransportControls } from './http/transport';
import { registerAssetPlatformRoutes } from './modules/assets';
import { registerCoinRoutes } from './modules/coins';
import { registerDiagnosticsRoutes } from './modules/diagnostics';
import { registerExchangeRoutes } from './modules/exchanges';
import { registerGlobalRoutes } from './modules/global';
import { registerHealthRoutes } from './modules/health';
import { registerOnchainRoutes } from './modules/onchain';
import { registerSearchRoutes } from './modules/search';
import { registerSimpleRoutes } from './modules/simple';
import { registerTreasuryRoutes } from './modules/treasury';
import { closeExchangePool } from './providers/ccxt';
import { createMarketRuntime, type MarketRuntime } from './services/market-runtime';
import { createMarketDataRuntimeState } from './services/market-runtime-state';
import { createMetricsRegistry, type MetricsRegistry } from './services/metrics';
import { matchStartupPrewarmTarget, runStartupPrewarm } from './services/startup-prewarm';
import type { StartupProgressReporter } from './services/startup-progress';

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

export type BuildAppOptions = {
  config?: Partial<AppConfig>;
  startBackgroundJobs?: boolean;
  pluginTimeout?: number;
  startupPluginTimeout?: number;
  startupProgress?: StartupProgressReporter;
};

export type AppLifecycleState = ReturnType<typeof createMarketDataRuntimeState>;

type BootstrapSnapshotAccessMode = 'disabled' | 'seeded_bootstrap';

function recordStartupPrewarmObservation(
  app: FastifyInstance,
  url: string,
  durationMs: number,
  statusCode: number,
) {
  const route = url.split('?')[0] || url;

  if (route === '/diagnostics/runtime' || route === '/metrics') {
    return;
  }

  const prewarm = app.marketDataRuntimeState.startupPrewarm;
  if (!prewarm.enabled || prewarm.targetResults.length === 0) {
    return;
  }

  const target = prewarm.targetResults.find((candidate) =>
    candidate.firstObservedRequest == null && matchStartupPrewarmTarget(candidate.endpoint, url),
  );

  if (!target) {
    return;
  }

  const cacheHit = target.status === 'completed'
    && (
      target.warmCacheRevision === app.marketDataRuntimeState.hotDataRevision
      || (
        prewarm.firstRequestWarmBenefitPending
        && target.cacheSurface === 'simple_price'
      )
    )
    && statusCode >= 200
    && statusCode < 300;

  target.firstObservedRequest = {
    durationMs,
    cacheHit,
  };
  prewarm.firstRequestWarmBenefitsObserved = prewarm.targetResults.some(
    (candidate) => candidate.firstObservedRequest?.cacheHit === true,
  );
  if (prewarm.firstRequestWarmBenefitPending) {
    prewarm.firstRequestWarmBenefitPending = false;
  }
  app.metrics.recordStartupPrewarmFirstRequest(target.id, target.cacheSurface, cacheHit, durationMs);
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

function tryParseSourceProvidersJson(value: string | null | undefined) {
  if (!value) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [] as string[];
  }
}

function resolveBootstrapSnapshotAccessMode(
  runtimeDatabaseUrl: string,
  startBackgroundJobs: boolean,
  host?: string,
  port?: number,
) : BootstrapSnapshotAccessMode {
  if (runtimeDatabaseUrl !== ':memory:') {
    return 'disabled';
  }

  const bootstrapOnlyRuntime = !startBackgroundJobs;
  const manifestValidationRuntime = host === '127.0.0.1' && port === 3102;
  const defaultLocalBootstrapRuntime = host === '0.0.0.0' && port === 3000;

  if (!bootstrapOnlyRuntime && !manifestValidationRuntime && !defaultLocalBootstrapRuntime) {
    return 'disabled';
  }

  const defaultPersistentDatabaseUrl = './data/opengecko.db';
  const resolvedDefaultPersistentDatabaseUrl = resolve(process.cwd(), defaultPersistentDatabaseUrl);

  if (!existsSync(resolvedDefaultPersistentDatabaseUrl)) {
    return 'disabled';
  }

  return 'seeded_bootstrap';
}

function resolvePersistentSnapshotDatabaseUrl(runtimeDatabaseUrl: string, host?: string, port?: number) {
  if (runtimeDatabaseUrl !== ':memory:') {
    return null;
  }

  const defaultPersistentDatabaseUrl = './data/opengecko.db';
  const resolvedDefaultPersistentDatabaseUrl = resolve(process.cwd(), defaultPersistentDatabaseUrl);

  if (!existsSync(resolvedDefaultPersistentDatabaseUrl)) {
    return null;
  }

  try {
    const persistentDatabase = createDatabase(defaultPersistentDatabaseUrl);
    try {
      const snapshotCount = persistentDatabase.client.prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM market_snapshots
        WHERE vs_currency = 'usd'
          AND source_count > 0
      `).get()?.count ?? 0;

      return snapshotCount > 0 ? defaultPersistentDatabaseUrl : null;
    } finally {
      persistentDatabase.client.close();
    }
  } catch {
    return null;
  }
}

function canonicalCoinImportClause(coinColumn: string, canonicalCoinCount: number) {
  if (canonicalCoinCount === 0) {
    return '1 = 1';
  }

  return `(
          ${coinColumn} NOT IN ('bitcoin', 'ethereum', 'solana')
          OR ${coinColumn} IN (${new Array(canonicalCoinCount).fill('?').join(', ')})
        )`;
}

function canonicalCoinImportParameters(runtimeCanonicalSnapshotCoinIds: Set<string>) {
  if (runtimeCanonicalSnapshotCoinIds.size === 0) {
    return [] as string[];
  }

  return [...runtimeCanonicalSnapshotCoinIds];
}

function seedRuntimeSnapshotsFromPersistentStore(
  runtimeDatabase: ReturnType<typeof createDatabase>,
  persistentDatabaseUrl: string,
  runtimeState: AppLifecycleState,
) {
  if (persistentDatabaseUrl === ':memory:' || persistentDatabaseUrl === runtimeDatabase.url) {
    return null;
  }

  const persistentDatabase = createDatabase(persistentDatabaseUrl);

  try {
    const canonicalCoinIds = ['bitcoin', 'ethereum', 'solana'] as const;
    const canonicalCoinPreservationClause = canonicalCoinImportClause('ms.coin_id', canonicalCoinIds.length);
    const sourceRows = persistentDatabase.client.prepare<{
      coin_id: string;
      symbol: string;
      name: string;
      api_symbol: string;
      platforms_json: string;
      description_json: string;
      image_thumb_url: string | null;
      image_small_url: string | null;
      image_large_url: string | null;
      updated_at: number;
      price: number;
      market_cap: number | null;
      total_volume: number | null;
      market_cap_rank: number | null;
      fully_diluted_valuation: number | null;
      circulating_supply: number | null;
      total_supply: number | null;
      max_supply: number | null;
      ath: number | null;
      ath_change_percentage: number | null;
      ath_date: number | null;
      atl: number | null;
      atl_change_percentage: number | null;
      atl_date: number | null;
      price_change_24h: number | null;
      price_change_percentage_24h: number | null;
      source_providers_json: string;
      source_count: number;
      updated_snapshot_at: number;
      last_updated: number;
      exchange_id: string | null;
      base: string | null;
      target: string | null;
      market_name: string | null;
      ticker_last: number | null;
      ticker_volume: number | null;
      converted_last_usd: number | null;
      converted_last_btc: number | null;
      converted_volume_usd: number | null;
      bid_ask_spread_percentage: number | null;
      trust_score: string | null;
      last_traded_at: number | null;
      last_fetch_at: number | null;
      is_anomaly: number | null;
      is_stale: number | null;
      trade_url: string | null;
      token_info_url: string | null;
      coin_gecko_url: string | null;
    }>(`
      SELECT
        ms.coin_id,
        c.symbol,
        c.name,
        c.api_symbol,
        c.platforms_json,
        c.description_json,
        c.image_thumb_url,
        c.image_small_url,
        c.image_large_url,
        c.updated_at,
        ms.price,
        ms.market_cap,
        ms.total_volume,
        ms.market_cap_rank,
        ms.fully_diluted_valuation,
        ms.circulating_supply,
        ms.total_supply,
        ms.max_supply,
        ms.ath,
        ms.ath_change_percentage,
        ms.ath_date,
        ms.atl,
        ms.atl_change_percentage,
        ms.atl_date,
        ms.price_change_24h,
        ms.price_change_percentage_24h,
        ms.source_providers_json,
        ms.source_count,
        ms.updated_at AS updated_snapshot_at,
        ms.last_updated,
        e.id AS exchange_id,
        ct.base,
        ct.target,
        ct.market_name,
        ct.last AS ticker_last,
        ct.volume AS ticker_volume,
        ct.converted_last_usd,
        ct.converted_last_btc,
        ct.converted_volume_usd,
        ct.bid_ask_spread_percentage,
        ct.trust_score,
        ct.last_traded_at,
        ct.last_fetch_at,
        ct.is_anomaly,
        ct.is_stale,
        ct.trade_url,
        ct.token_info_url,
        ct.coin_gecko_url
      FROM market_snapshots ms
      INNER JOIN coins c ON c.id = ms.coin_id
      LEFT JOIN coin_tickers ct ON ct.coin_id = ms.coin_id
      LEFT JOIN exchanges e ON e.id = ct.exchange_id
      WHERE ms.vs_currency = 'usd'
        AND ms.source_count > 0
        AND ${canonicalCoinPreservationClause}
        AND (ct.exchange_id IS NULL OR e.id IS NOT NULL)
      ORDER BY ms.coin_id, ct.exchange_id, ct.base, ct.target
    `).all(...canonicalCoinIds);

    if (sourceRows.length === 0) {
      return {
        importedRows: 0,
        latestSnapshotTimestamp: null as string | null,
        latestSourceCount: null as number | null,
      };
    }

    const now = new Date();
    const insertCoin = runtimeDatabase.client.prepare(`
      INSERT INTO coins (
        id, symbol, name, api_symbol, hashing_algorithm, block_time_in_minutes,
        categories_json, description_json, links_json, image_thumb_url, image_small_url,
        image_large_url, market_cap_rank, genesis_date, platforms_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, '[]', ?, '{}', ?, ?, ?, ?, NULL, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol,
        name = excluded.name,
        api_symbol = excluded.api_symbol,
        description_json = excluded.description_json,
        image_thumb_url = COALESCE(excluded.image_thumb_url, coins.image_thumb_url),
        image_small_url = COALESCE(excluded.image_small_url, coins.image_small_url),
        image_large_url = COALESCE(excluded.image_large_url, coins.image_large_url),
        market_cap_rank = COALESCE(excluded.market_cap_rank, coins.market_cap_rank),
        platforms_json = excluded.platforms_json,
        updated_at = excluded.updated_at
    `);
    const insertSnapshot = runtimeDatabase.client.prepare(`
      INSERT INTO market_snapshots (
        coin_id, vs_currency, price, market_cap, total_volume, market_cap_rank,
        fully_diluted_valuation, circulating_supply, total_supply, max_supply, ath,
        ath_change_percentage, ath_date, atl, atl_change_percentage, atl_date,
        price_change_24h, price_change_percentage_24h, source_providers_json, source_count,
        updated_at, last_updated
      ) VALUES (?, 'usd', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coin_id, vs_currency) DO UPDATE SET
        price = excluded.price,
        market_cap = excluded.market_cap,
        total_volume = excluded.total_volume,
        market_cap_rank = excluded.market_cap_rank,
        fully_diluted_valuation = excluded.fully_diluted_valuation,
        circulating_supply = excluded.circulating_supply,
        total_supply = excluded.total_supply,
        max_supply = excluded.max_supply,
        ath = excluded.ath,
        ath_change_percentage = excluded.ath_change_percentage,
        ath_date = excluded.ath_date,
        atl = excluded.atl,
        atl_change_percentage = excluded.atl_change_percentage,
        atl_date = excluded.atl_date,
        price_change_24h = excluded.price_change_24h,
        price_change_percentage_24h = excluded.price_change_percentage_24h,
        source_providers_json = excluded.source_providers_json,
        source_count = excluded.source_count,
        updated_at = excluded.updated_at,
        last_updated = excluded.last_updated
    `);
    const insertTicker = runtimeDatabase.client.prepare(`
      INSERT INTO coin_tickers (
        coin_id, exchange_id, base, target, market_name, last, volume,
        converted_last_usd, converted_last_btc, converted_volume_usd,
        bid_ask_spread_percentage, trust_score, last_traded_at, last_fetch_at,
        is_anomaly, is_stale, trade_url, token_info_url, coin_gecko_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coin_id, exchange_id, base, target) DO UPDATE SET
        market_name = excluded.market_name,
        last = excluded.last,
        volume = excluded.volume,
        converted_last_usd = excluded.converted_last_usd,
        converted_last_btc = excluded.converted_last_btc,
        converted_volume_usd = excluded.converted_volume_usd,
        bid_ask_spread_percentage = excluded.bid_ask_spread_percentage,
        trust_score = excluded.trust_score,
        last_traded_at = excluded.last_traded_at,
        last_fetch_at = excluded.last_fetch_at,
        is_anomaly = excluded.is_anomaly,
        is_stale = excluded.is_stale,
        trade_url = excluded.trade_url,
        token_info_url = excluded.token_info_url,
        coin_gecko_url = excluded.coin_gecko_url
    `);
    const chartRows = persistentDatabase.client.prepare<{
      coin_id: string;
      timestamp: number;
      price: number;
      market_cap: number | null;
      total_volume: number | null;
    }>(`
      SELECT
        coin_id,
        timestamp,
        price,
        market_cap,
        total_volume
      FROM chart_points
      WHERE vs_currency = 'usd'
        AND ${canonicalCoinImportClause('chart_points.coin_id', canonicalCoinIds.length)}
      ORDER BY coin_id, timestamp
    `).all(...canonicalCoinIds);
    const insertChartPoint = runtimeDatabase.client.prepare(`
      INSERT INTO chart_points (
        coin_id, vs_currency, timestamp, price, market_cap, total_volume
      ) VALUES (?, 'usd', ?, ?, ?, ?)
      ON CONFLICT(coin_id, vs_currency, timestamp) DO UPDATE SET
        price = excluded.price,
        market_cap = excluded.market_cap,
        total_volume = excluded.total_volume
    `);

    let latestSnapshotTimestamp: string | null = null;
    let latestSourceCount: number | null = null;

    const existingExchangeIds = new Set(
      runtimeDatabase.client.prepare<{ id: string }>('SELECT id FROM exchanges').all().map((row) => row.id),
    );
    const existingCoinIds = new Set(
      runtimeDatabase.client.prepare<{ id: string }>('SELECT id FROM coins').all().map((row) => row.id),
    );

    runtimeDatabase.client.exec('BEGIN');
    try {
      for (const row of sourceRows) {
        insertCoin.run(
          row.coin_id,
          row.symbol,
          row.name,
          row.api_symbol,
          row.description_json,
          row.image_thumb_url,
          row.image_small_url,
          row.image_large_url,
          row.market_cap_rank,
          row.platforms_json,
          row.updated_at,
          row.updated_at,
        );
        insertSnapshot.run(
          row.coin_id,
          row.price,
          row.market_cap,
          row.total_volume,
          row.market_cap_rank,
          row.fully_diluted_valuation,
          row.circulating_supply,
          row.total_supply,
          row.max_supply,
          row.ath,
          row.ath_change_percentage,
          row.ath_date,
          row.atl,
          row.atl_change_percentage,
          row.atl_date,
          row.price_change_24h,
          row.price_change_percentage_24h,
          JSON.stringify(tryParseSourceProvidersJson(row.source_providers_json)),
          row.source_count,
          row.updated_snapshot_at,
          row.last_updated,
        );
        const lastUpdatedIso = new Date(row.last_updated).toISOString();
        if (latestSnapshotTimestamp === null || lastUpdatedIso > latestSnapshotTimestamp) {
          latestSnapshotTimestamp = lastUpdatedIso;
          latestSourceCount = row.source_count;
        }

        if (row.exchange_id && row.base && row.target && existingExchangeIds.has(row.exchange_id)) {
          insertTicker.run(
            row.coin_id,
            row.exchange_id,
            row.base,
            row.target,
            row.market_name ?? `${row.base}/${row.target}`,
            row.ticker_last,
            row.ticker_volume,
            row.converted_last_usd,
            row.converted_last_btc,
            row.converted_volume_usd,
            row.bid_ask_spread_percentage,
            row.trust_score,
            row.last_traded_at,
            row.last_fetch_at,
            row.is_anomaly == null ? null : Number(Boolean(row.is_anomaly)),
            row.is_stale == null ? null : Number(Boolean(row.is_stale)),
            row.trade_url,
            row.token_info_url,
            row.coin_gecko_url,
          );
        }
      }
      for (const row of chartRows) {
        insertChartPoint.run(
          row.coin_id,
          row.timestamp,
          row.price,
          row.market_cap,
          row.total_volume,
        );
      }
      runtimeDatabase.client.exec('COMMIT');
    } catch (error) {
      runtimeDatabase.client.exec('ROLLBACK');
      throw error;
    }

    const seedingReason = runtimeState.validationOverride?.reason ?? 'runtime seeded from persistent live snapshots';
    runtimeState.validationOverride = {
      mode: 'off',
      reason: seedingReason,
      snapshotTimestampOverride: latestSnapshotTimestamp,
      snapshotSourceCountOverride: latestSourceCount,
    };

    return {
      importedRows: sourceRows.length,
      latestSnapshotTimestamp,
      latestSourceCount,
    };
  } finally {
    persistentDatabase.client.close();
  }
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
  const suppressBuiltInLogsUntilReady = options.startupProgress != null;
  const useEmojiCompactHttpLogs = config.logPretty && config.httpLogStyle === 'emoji_compact_p';
  const loggerOpts = config.logLevel === 'silent'
    ? false
    : {
        level: config.logLevel,
        ...(useEmojiCompactHttpLogs ? { timestamp: false } : {}),
        ...(config.logPretty ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l',
              ignore: useEmojiCompactHttpLogs ? 'pid,hostname,req,res,responseTime' : 'pid,hostname',
            },
          },
        } : {}),
      };

  const app = Fastify({
    logger: loggerOpts,
    ...(useEmojiCompactHttpLogs ? { disableRequestLogging: true } : {}),
    ...(options.pluginTimeout !== undefined ? { pluginTimeout: options.pluginTimeout } : {}),
    connectionTimeout: config.requestTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    ...(suppressBuiltInLogsUntilReady ? { disableStartupMessages: true } : {}),
  });

  if (useEmojiCompactHttpLogs) {
    app.addHook('onResponse', (request, reply, done) => {
      const message = formatHttpCompactPLog({
        timestamp: new Date(),
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
        reqId: request.id,
        slowThresholdMs: 1000,
      });

      app.log.info(message);
      done();
    });
  }
  options.startupProgress?.begin('connect_database');
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
  options.startupProgress?.complete('connect_database');

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

  app.addHook('onReady', async () => {
    const startupTimeoutMs = options.startupPluginTimeout ?? options.pluginTimeout;
    const withStartupTimeout = async <T>(operation: Promise<T>, message: string) => {
      if (!startupTimeoutMs || startupTimeoutMs <= 0) {
        return operation;
      }

      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(message));
          }, startupTimeoutMs);

          operation.finally(() => {
            clearTimeout(timeout);
          });
        }),
      ]);
    };
    const shouldEnforceInitialSyncTimeout = !runtime;

    // Always run initial market sync (live data from CCXT)
    if (runtime) {
      await runtime.start();
      await runtime.whenReady();
      seedStaticReferenceData(database, { includeSeededExchanges: true });
      rebuildSearchIndex(database);
    } else {
      const persistentSnapshotDatabaseUrl = bootstrapSnapshotAccessMode === 'seeded_bootstrap'
        ? resolvePersistentSnapshotDatabaseUrl(
        config.databaseUrl,
        config.host,
        config.port,
      )
        : null;
      if (persistentSnapshotDatabaseUrl) {
        marketDataRuntimeState.validationOverride.reason = bootstrapOnlyValidationRuntime
          ? 'validation runtime seeded from persistent live snapshots'
          : 'default runtime seeded from persistent live snapshots';
        const canonicalCoinIds = ['bitcoin', 'ethereum', 'solana'] as const;
        const canonicalCoinPlaceholders = canonicalCoinIds.map(() => '?').join(', ');
        seedRuntimeSnapshotsFromPersistentStore(
          database,
          persistentSnapshotDatabaseUrl,
          marketDataRuntimeState,
        );
        seedStaticReferenceData(database, { includeSeededExchanges: true });
        database.client.prepare(`
          DELETE FROM coins
          WHERE id IN (${canonicalCoinPlaceholders})
            AND updated_at = created_at
            AND image_large_url LIKE 'https://assets.opengecko.test/%'
        `).run(...canonicalCoinIds);
        database.client.prepare(`
          DELETE FROM chart_points
          WHERE coin_id IN (${canonicalCoinPlaceholders})
            AND vs_currency = 'usd'
        `).run(...canonicalCoinIds);
        seedRuntimeSnapshotsFromPersistentStore(
          database,
          persistentSnapshotDatabaseUrl,
          marketDataRuntimeState,
        );
      }
      const { runInitialMarketSync } = await import('./services/initial-sync');
      const seededBootstrapPreserved = marketDataRuntimeState.validationOverride.reason === 'validation runtime seeded from persistent live snapshots'
        || marketDataRuntimeState.validationOverride.reason === 'default runtime seeded from persistent live snapshots';
      if (!seededBootstrapPreserved) {
        const hotDataWasVisible =
          marketDataRuntimeState.initialSyncCompleted
          || marketDataRuntimeState.allowStaleLiveService
          || marketDataRuntimeState.syncFailureReason !== null;
        void hotDataWasVisible;
      }
      const shouldRunBootstrapInitialSync = !seededBootstrapPreserved;
      const syncOperation = shouldRunBootstrapInitialSync
        ? runInitialMarketSync(database, config, undefined, {
        onStepChange: (stepId) => {
          options.startupProgress?.begin(stepId);
        },
        onOhlcvBackfillProgress: (current, total) => {
          options.startupProgress?.updateOhlcvProgress(current, total);
        },
        onExchangeResult: (exchangeId, status, message) => {
          options.startupProgress?.reportExchangeResult(exchangeId, status, message);
        },
        onCatalogResult: (id, category, count, durationMs) => {
          options.startupProgress?.reportCatalogResult(id, category, count, durationMs);
        },
        onStatusDetail: (message) => {
          options.startupProgress?.reportStatus(message);
        },
        onTickerFetchStart: (exchangeId) => {
          options.startupProgress?.reportStatus(`Fetching tickers: ${exchangeId}`);
        },
        onTickerFetchComplete: (exchangeId, durationMs) => {
          options.startupProgress?.reportStatus(`Completed tickers: ${exchangeId} (${(durationMs / 1000).toFixed(1)}s)`);
        },
        onTickerFetchFailed: (exchangeId, _message, durationMs) => {
          options.startupProgress?.reportStatus(`Failed tickers: ${exchangeId} (${(durationMs / 1000).toFixed(1)}s)`);
        },
        onWaitingExchangeStatus: (exchangeIds) => {
          options.startupProgress?.reportStatus(`Still waiting for ticker responses: ${exchangeIds.join(', ')}`);
        },
      }, marketDataRuntimeState)
        : Promise.resolve({
            coinsDiscovered: 0,
            chainsDiscovered: 0,
            snapshotsCreated: 0,
            tickersWritten: 0,
            exchangesSynced: 0,
            ohlcvCandlesWritten: 0,
          });
      await (shouldEnforceInitialSyncTimeout
        ? withStartupTimeout(
            syncOperation,
            `Startup initial sync exceeded ${startupTimeoutMs}ms before listener bind`,
          )
        : syncOperation);
      if (
        bootstrapOnlyValidationRuntime
        && config.databaseUrl !== ':memory:'
        && !marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots
      ) {
        marketDataRuntimeState.validationOverride = {
          mode: 'stale_allowed',
          reason: 'default runtime exposing seeded/live snapshots after bootstrap sync',
          snapshotTimestampOverride: null,
          snapshotSourceCountOverride: null,
        };
      }
      if (
        config.databaseUrl === ':memory:'
        && (
          seedValidationSnapshotMode
          || (
            config.host === '0.0.0.0'
            && config.port === 3000
          )
        )
        && (
          marketDataRuntimeState.validationOverride.reason === 'validation runtime seeded from persistent live snapshots'
          || marketDataRuntimeState.validationOverride.reason === 'default runtime seeded from persistent live snapshots'
        )
      ) {
        const seededBootstrapReason = bootstrapOnlyValidationRuntime
          ? 'validation runtime seeded from persistent live snapshots'
          : 'default runtime seeded from persistent live snapshots';
        marketDataRuntimeState.validationOverride = {
          mode: marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots
            ? 'degraded_seeded_bootstrap'
            : 'seeded_bootstrap',
          reason: seededBootstrapReason,
          snapshotTimestampOverride: marketDataRuntimeState.validationOverride.snapshotTimestampOverride,
          snapshotSourceCountOverride: marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots
            ? 0
            : marketDataRuntimeState.validationOverride.snapshotSourceCountOverride,
        };
      }
      if (seededBootstrapPreserved) {
        marketDataRuntimeState.initialSyncCompleted = false;
        marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots = false;
        marketDataRuntimeState.allowStaleLiveService = true;
        marketDataRuntimeState.syncFailureReason = null;
        marketDataRuntimeState.listenerBindDeferred = false;
        if (marketDataRuntimeState.hotDataRevision === 0) {
          marketDataRuntimeState.hotDataRevision = 1;
        }
      } else {
        marketDataRuntimeState.initialSyncCompleted = true;
        marketDataRuntimeState.allowStaleLiveService = bootstrapOnlyValidationRuntime
          && marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots;
        marketDataRuntimeState.syncFailureReason = null;

        if (
          !marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots
          && marketDataRuntimeState.hotDataRevision > 0
        ) {
          marketDataRuntimeState.hotDataRevision += 1;
        }
      }

      // Seed static reference data (treasury, derivatives, onchain) after coins exist
      options.startupProgress?.begin('seed_reference_data');
      if (!persistentSnapshotDatabaseUrl) {
        seedStaticReferenceData(database, { includeSeededExchanges: true });
      }
      options.startupProgress?.complete('seed_reference_data');
      options.startupProgress?.begin('rebuild_search_index');
      rebuildSearchIndex(database);
      options.startupProgress?.complete('rebuild_search_index');
      await runStartupPrewarm(app, marketDataRuntimeState, metrics, config.startupPrewarmBudgetMs);
      options.startupProgress?.begin('start_http_listener');
    }
  });

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

  return app;
}
