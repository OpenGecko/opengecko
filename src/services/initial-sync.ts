import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { coinTickers, exchanges, marketSnapshots } from '../db/schema';
import type { Logger } from 'pino';
import { createLogger } from '../lib/logger';
import { fetchExchangeMarkets, isValidExchangeId, type ExchangeId } from '../providers/ccxt';
import { syncCoinCatalogFromExchanges } from './coin-catalog-sync';
import { syncChainCatalogFromExchanges } from './chain-catalog-sync';
import { SEEDED_EXCHANGE_TIMESTAMP_MS } from './diagnostics-policy';
import { runMarketRefreshOnce, STARTUP_TICKER_FETCH_BUDGET_MS } from './market-refresh';
import { clearProviderFailureCooldown, recordInitialSyncSnapshotAvailability, type MarketDataRuntimeState } from './market-runtime-state';
import { createProviderBreakerState, recordProviderFailure, recordProviderSuccess } from './provider-breaker';
import { runBudgetedProviderFanout } from './provider-readiness-coordinator';

function didInitialSyncProduceUsableLiveSnapshots(result: InitialSyncResult) {
  return result.snapshotsCreated > 0;
}

const STARTUP_EXCHANGE_METADATA_BUDGET_MS = 3_000;
const PRIORITIZED_STARTUP_TICKER_RESCUE_EXCHANGES = ['coinbase', 'kraken', 'okx', 'gate', 'binance', 'bybit'] as const;

const EXCHANGE_METADATA_OVERRIDES: Record<string, Partial<typeof exchanges.$inferInsert>> = {
  binance: {
    name: 'Binance',
    yearEstablished: 2017,
    country: 'Cayman Islands',
    url: 'https://www.binance.com/',
    imageUrl: 'https://coin-images.coingecko.com/markets/images/52/small/binance.jpg?1706864274',
    description: 'One of the world’s largest cryptocurrency exchanges by trading volume, offering a wide range of services including spot, futures, and staking options.',
    hasTradingIncentive: false,
    trustScore: 10,
    trustScoreRank: 1,
    facebookUrl: 'https://www.facebook.com/binanceexchange',
    redditUrl: 'https://www.reddit.com/r/binance/',
    telegramUrl: '',
    slackUrl: '',
    otherUrlJson: JSON.stringify([
      'https://medium.com/binanceexchange',
      'https://steemit.com/@binanceexchange',
    ]),
    twitterHandle: 'binance',
    centralised: true,
    publicNotice: '',
    alertNotice: '',
  },
  coinbase: {
    name: 'Coinbase Exchange',
    url: 'https://www.coinbase.com/',
  },
  gdax: {
    name: 'Coinbase Exchange',
    url: 'https://www.coinbase.com/',
  },
  okx: {
    id: 'okex',
    name: 'OKX',
    url: 'https://www.okx.com',
  },
  bybit: {
    id: 'bybit_spot',
    name: 'Bybit',
    url: 'https://www.bybit.com',
  },
};

function getExchangeInsertValues(exchangeId: ExchangeId, updatedAt: Date): typeof exchanges.$inferInsert {
  const override = EXCHANGE_METADATA_OVERRIDES[exchangeId] ?? {};

  return {
    id: override.id ?? exchangeId,
    name: override.name ?? exchangeId.charAt(0).toUpperCase() + exchangeId.slice(1),
    yearEstablished: override.yearEstablished ?? null,
    country: override.country ?? null,
    description: override.description ?? '',
    url: override.url ?? `https://www.${exchangeId}.com`,
    imageUrl: override.imageUrl ?? null,
    hasTradingIncentive: override.hasTradingIncentive ?? false,
    trustScore: override.trustScore ?? null,
    trustScoreRank: override.trustScoreRank ?? null,
    tradeVolume24hBtc: override.tradeVolume24hBtc ?? null,
    tradeVolume24hBtcNormalized: override.tradeVolume24hBtcNormalized ?? null,
    facebookUrl: override.facebookUrl ?? null,
    redditUrl: override.redditUrl ?? null,
    telegramUrl: override.telegramUrl ?? null,
    slackUrl: override.slackUrl ?? null,
    otherUrlJson: override.otherUrlJson ?? '[]',
    twitterHandle: override.twitterHandle ?? null,
    centralised: override.centralised ?? true,
    publicNotice: override.publicNotice ?? null,
    alertNotice: override.alertNotice ?? null,
    updatedAt,
  };
}

function shouldEmitStartupLogger(progress?: InitialSyncProgressHandlers) {
  return progress === undefined;
}

function hasLiveTickerRows(database: AppDatabase) {
  try {
    const query = database.db.select().from(coinTickers) as {
      all?: () => Array<{ lastFetchAt?: Date | null }>;
    };

    return typeof query.all === 'function'
      && query.all().some((row) => row.lastFetchAt instanceof Date && row.lastFetchAt.getTime() !== SEEDED_EXCHANGE_TIMESTAMP_MS);
  } catch {
    return false;
  }
}

function countFreshLiveMarketSnapshots(database: AppDatabase, startedAtMs: number) {
  const query = database.db
    .select()
    .from(marketSnapshots) as { all?: () => Array<{ sourceCount: number; updatedAt: Date | null }> };

  if (typeof query.all !== 'function') {
    return 1;
  }

  return query.all()
    .filter((snapshot) =>
      snapshot.sourceCount > 0
      && snapshot.updatedAt instanceof Date
      && snapshot.updatedAt.getTime() >= startedAtMs,
    ).length;
}

function countFreshLiveTickerRows(database: AppDatabase, startedAtMs: number) {
  const query = database.db
    .select()
    .from(coinTickers) as { all?: () => Array<{ lastFetchAt: Date | null }> };

  if (typeof query.all !== 'function') {
    return 1;
  }

  return query.all()
    .filter((ticker) =>
      ticker.lastFetchAt instanceof Date
      && ticker.lastFetchAt.getTime() >= startedAtMs,
    ).length;
}

function selectStartupTickerRescueExchange(exchangeIds: ExchangeId[]) {
  return PRIORITIZED_STARTUP_TICKER_RESCUE_EXCHANGES.find((exchangeId) =>
    exchangeIds.includes(exchangeId),
  ) ?? exchangeIds[0] ?? null;
}

export type InitialSyncProgressHandlers = {
  onStepChange?: (stepId: 'sync_exchange_metadata' | 'sync_coin_catalog' | 'sync_chain_catalog' | 'build_market_snapshots' | 'start_ohlcv_worker') => void;
  onOhlcvBackfillProgress?: (current: number, total: number) => void;
  onExchangeResult?: (exchangeId: string, status: 'ok' | 'failed', message?: string) => void;
  onCatalogResult?: (id: string, category: string, count: number, durationMs: number) => void;
  onStatusDetail?: (message: string) => void;
  onTickerFetchStart?: (exchangeId: string) => void;
  onTickerFetchComplete?: (exchangeId: string, durationMs: number) => void;
  onTickerFetchFailed?: (exchangeId: string, message: string, durationMs: number) => void;
  onWaitingExchangeStatus?: (exchangeIds: string[]) => void;
  startupExchangeMetadataBudgetMs?: number;
  startupTickerFetchBudgetMs?: number;
};

export type ExchangeSyncResult = {
  succeededExchangeIds: ExchangeId[];
  failedExchangeIds: ExchangeId[];
  failures: Array<{ exchangeId: ExchangeId; message: string }>;
};

export async function syncExchangesFromCCXT(
  database: AppDatabase,
  exchangeIds: ExchangeId[],
  logger: Logger,
  concurrency = exchangeIds.length,
  progress?: Pick<InitialSyncProgressHandlers, 'onExchangeResult'>,
  options?: { startupExchangeMetadataBudgetMs?: number },
): Promise<ExchangeSyncResult> {
  const results = await fetchExchangeMarketResults(exchangeIds, concurrency, options?.startupExchangeMetadataBudgetMs);

  const now = new Date();
  let succeeded = 0;
  let failed = 0;
  const succeededExchangeIds: ExchangeId[] = [];
  const failedExchangeIds: ExchangeId[] = [];
  const failures: Array<{ exchangeId: ExchangeId; message: string }> = [];

  for (let i = 0; i < exchangeIds.length; i++) {
    const exchangeId = exchangeIds[i];
    const result = results[i];
    const exchangeLogger = logger.child({ exchange: exchangeId });

    if (result.status === 'rejected') {
      failed += 1;
      failedExchangeIds.push(exchangeId);
      const errorInfo = result.reason instanceof Error
        ? { message: result.reason.message }
        : { message: String(result.reason) };
      failures.push({ exchangeId, message: errorInfo.message });
      if (shouldEmitStartupLogger(progress)) {
        exchangeLogger.warn(errorInfo, 'exchange metadata sync failed');
      }
      progress?.onExchangeResult?.(exchangeId, 'failed', errorInfo.message);
      continue;
    }

    const markets = Array.isArray(result.value) ? result.value : [];
    exchangeLogger.debug({ marketCount: markets.length }, 'fetched exchange markets');

    if (markets.length === 0) {
      succeededExchangeIds.push(exchangeId);
      continue;
    }

    succeeded += 1;
    succeededExchangeIds.push(exchangeId);
    const exchangeInsertValues = getExchangeInsertValues(exchangeId, now);
    database.db
      .insert(exchanges)
      .values(exchangeInsertValues)
      .onConflictDoUpdate({
        target: exchanges.id,
        set: {
          ...exchangeInsertValues,
          updatedAt: now,
        },
      })
      .run();
    progress?.onExchangeResult?.(exchangeId, 'ok');
  }

  logger.debug({ succeeded, failed }, 'exchange metadata sync complete');
  return { succeededExchangeIds, failedExchangeIds, failures };
}

async function fetchExchangeMarketResults(
  exchangeIds: ExchangeId[],
  concurrency: number,
  startupExchangeMetadataBudgetMs?: number,
) {
  const buildBudgetError = (exchangeId: string) => {
    const error = new Error(`${exchangeId} startup exchange metadata budget exceeded after ${startupExchangeMetadataBudgetMs}ms`);
    error.name = 'ExchangeMetadataStartupBudgetExceededError';
    return error;
  };

  return await runBudgetedProviderFanout({
    items: exchangeIds,
    concurrency,
    budgetMs: startupExchangeMetadataBudgetMs,
    run: fetchExchangeMarkets,
    buildBudgetError,
  });
}

export type InitialSyncResult = {
  coinsDiscovered: number;
  chainsDiscovered: number;
  snapshotsCreated: number;
  tickersWritten: number;
  exchangesSynced: number;
  ohlcvCandlesWritten: number;
};

export async function runInitialMarketSync(
  database: AppDatabase,
  config: Pick<AppConfig, 'ccxtExchanges' | 'marketFreshnessThresholdSeconds' | 'providerFanoutConcurrency'>,
  logger?: Logger,
  progress?: InitialSyncProgressHandlers,
  runtimeState?: MarketDataRuntimeState,
): Promise<InitialSyncResult> {
  const syncLogger = logger?.child({ operation: 'initial_sync' }) ?? createLogger({ level: 'info' }).child({ operation: 'initial_sync' });
  const startTime = Date.now();
  const exchangeIds = config.ccxtExchanges.filter(isValidExchangeId);

  if (shouldEmitStartupLogger(progress)) {
    syncLogger.info({ exchanges: exchangeIds }, 'starting initial market sync');
  }

  // Step 1: Sync exchanges first (required for coin_tickers FK)
  progress?.onStepChange?.('sync_exchange_metadata');
  syncLogger.debug('syncing exchange metadata');
  const { succeededExchangeIds, failures: exchangeMetadataFailures } = await syncExchangesFromCCXT(
    database,
    exchangeIds,
    syncLogger,
    config.providerFanoutConcurrency,
    progress,
    { startupExchangeMetadataBudgetMs: progress?.startupExchangeMetadataBudgetMs ?? STARTUP_EXCHANGE_METADATA_BUDGET_MS },
  );
  if (runtimeState && exchangeMetadataFailures.length > 0) {
    const providerBreakers = runtimeState.providerBreakers
      ?? (runtimeState.providerBreakers = createProviderBreakerState(exchangeIds));
    for (const failure of exchangeMetadataFailures) {
      recordProviderFailure(providerBreakers, failure.exchangeId, Date.now(), failure.message);
    }

    if (succeededExchangeIds.length === 0) {
      const rescueExchangeId = selectStartupTickerRescueExchange(exchangeIds);
      if (rescueExchangeId) {
        recordProviderSuccess(providerBreakers, rescueExchangeId, Date.now());
      }
    }
  }
  const activeExchangeIds = succeededExchangeIds.length > 0 ? succeededExchangeIds : exchangeIds;

  // Step 2: Discover coins from all exchanges
  progress?.onStepChange?.('sync_coin_catalog');
  syncLogger.debug('discovering coins from exchanges');
  const coinCatalogStartTime = Date.now();
  const { insertedOrUpdated: coinsDiscovered } = await syncCoinCatalogFromExchanges(
    database,
    activeExchangeIds,
    syncLogger,
    config.providerFanoutConcurrency,
    { suppressSummaryLog: !shouldEmitStartupLogger(progress) },
  );
  progress?.onCatalogResult?.('cat_01', 'Coin Catalog', coinsDiscovered, Date.now() - coinCatalogStartTime);
  if (shouldEmitStartupLogger(progress)) {
    syncLogger.info({ coinsDiscovered }, 'coin catalog sync complete');
  }

  // Step 2.5: Discover chains/networks from all exchanges
  progress?.onStepChange?.('sync_chain_catalog');
  syncLogger.debug('discovering chains from exchanges');
  const chainCatalogStartTime = Date.now();
  const { insertedOrUpdated: chainsDiscovered } = await syncChainCatalogFromExchanges(
    database,
    activeExchangeIds,
    syncLogger,
    config.providerFanoutConcurrency,
    { suppressSummaryLog: !shouldEmitStartupLogger(progress) },
  );
  progress?.onCatalogResult?.('cat_02', 'Chain Catalog', chainsDiscovered, Date.now() - chainCatalogStartTime);
  if (shouldEmitStartupLogger(progress)) {
    syncLogger.info({ chainsDiscovered }, 'chain catalog sync complete');
  }

  // Step 3: Fetch tickers and build market snapshots + coin tickers
  progress?.onStepChange?.('build_market_snapshots');
  syncLogger.debug('running market refresh');
  const marketRefreshProgress = {
    onLongPhaseStatus: (message: string) => {
      progress?.onStatusDetail?.(message);
    },
    onExchangeFetchStart: (exchangeId: string) => {
      progress?.onTickerFetchStart?.(exchangeId);
    },
    onExchangeFetchComplete: (exchangeId: string, durationMs: number) => {
      progress?.onTickerFetchComplete?.(exchangeId, durationMs);
    },
    onExchangeFetchFailed: (exchangeId: string, message: string, durationMs: number) => {
      progress?.onTickerFetchFailed?.(exchangeId, message, durationMs);
    },
    onWaitingExchangeStatus: (exchangeIds: string[]) => {
      progress?.onWaitingExchangeStatus?.(exchangeIds);
    },
    startupTickerFetchBudgetMs: progress?.startupTickerFetchBudgetMs ?? STARTUP_TICKER_FETCH_BUDGET_MS,
    suppressSummaryLogs: !shouldEmitStartupLogger(progress),
  };

  let broadMarketRefreshError: unknown = null;
  try {
    await runMarketRefreshOnce(database, {
      ccxtExchanges: activeExchangeIds,
      providerFanoutConcurrency: config.providerFanoutConcurrency,
    }, syncLogger, runtimeState, undefined, marketRefreshProgress);
  } catch (error) {
    broadMarketRefreshError = error;
  }

  if (broadMarketRefreshError && !hasLiveTickerRows(database)) {
    const rescueExchangeId = selectStartupTickerRescueExchange(activeExchangeIds);
    if (rescueExchangeId) {
      if (runtimeState?.providerBreakers) {
        recordProviderSuccess(runtimeState.providerBreakers, rescueExchangeId, Date.now());
        clearProviderFailureCooldown(runtimeState);
      }
      progress?.onStatusDetail?.(`Retrying prioritized ticker bootstrap on ${rescueExchangeId}`);
      await runMarketRefreshOnce(database, {
        ccxtExchanges: [rescueExchangeId],
        providerFanoutConcurrency: 1,
      }, syncLogger, runtimeState, undefined, {
        ...marketRefreshProgress,
        startupTickerFetchBudgetMs: 0,
      });
    } else if (broadMarketRefreshError) {
      throw broadMarketRefreshError;
    }
  }

  if (runtimeState?.exchangeTickerIngestion) {
    const metadataFailedExchangeIds = exchangeMetadataFailures.map((failure) => failure.exchangeId);
    runtimeState.exchangeTickerIngestion = {
      ...runtimeState.exchangeTickerIngestion,
      configured_exchange_ids: exchangeIds,
      promotion_attempted_exchange_ids: exchangeIds,
      failed_exchange_ids: [...new Set([
        ...runtimeState.exchangeTickerIngestion.failed_exchange_ids,
        ...metadataFailedExchangeIds,
      ])],
      unavailable_exchange_ids: [...new Set([
        ...runtimeState.exchangeTickerIngestion.unavailable_exchange_ids,
        ...metadataFailedExchangeIds,
        ...runtimeState.exchangeTickerIngestion.blocked_exchange_ids,
      ])],
    };
  }

  // Step 4: Count only rows refreshed during this initial sync. Residual
  // persisted snapshots are valid stale fallback evidence, but they must not
  // be misclassified as fresh live bootstrap output.
  const snapshotCount = countFreshLiveMarketSnapshots(database, startTime);
  const tickerCount = countFreshLiveTickerRows(database, startTime);

  progress?.onStepChange?.('start_ohlcv_worker');
  const ohlcvCandlesWritten = 0;

  const durationMs = Date.now() - startTime;
  if (shouldEmitStartupLogger(progress)) {
    syncLogger.info({
      coinsDiscovered,
      chainsDiscovered,
      snapshotsCreated: snapshotCount,
      ohlcvCandlesWritten,
      exchangesSynced: activeExchangeIds.length,
      durationMs,
    }, 'initial market sync complete');
  }

  const result = {
    coinsDiscovered,
    chainsDiscovered,
    snapshotsCreated: snapshotCount,
    tickersWritten: tickerCount,
    exchangesSynced: activeExchangeIds.length,
    ohlcvCandlesWritten,
  };

  if (runtimeState) {
    recordInitialSyncSnapshotAvailability(runtimeState, didInitialSyncProduceUsableLiveSnapshots(result));
  }

  return result;
}
