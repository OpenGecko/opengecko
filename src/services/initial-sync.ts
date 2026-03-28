import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { exchanges } from '../db/schema';
import type { Logger } from 'pino';
import { createLogger } from '../lib/logger';
import { mapWithConcurrency } from '../lib/async';
import { fetchExchangeMarkets, isValidExchangeId, type ExchangeId } from '../providers/ccxt';
import { syncCoinCatalogFromExchanges } from './coin-catalog-sync';
import { syncChainCatalogFromExchanges } from './chain-catalog-sync';
import { runMarketRefreshOnce } from './market-refresh';
import type { MarketDataRuntimeState } from './market-runtime-state';

function didInitialSyncProduceUsableLiveSnapshots(result: InitialSyncResult) {
  return result.snapshotsCreated > 0 && result.tickersWritten > 0;
}

function shouldEmitStartupLogger(progress?: InitialSyncProgressHandlers) {
  return progress === undefined;
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
};

export type ExchangeSyncResult = {
  succeededExchangeIds: ExchangeId[];
  failedExchangeIds: ExchangeId[];
};

export async function syncExchangesFromCCXT(
  database: AppDatabase,
  exchangeIds: ExchangeId[],
  logger: Logger,
  concurrency = exchangeIds.length,
  progress?: Pick<InitialSyncProgressHandlers, 'onExchangeResult'>,
): Promise<ExchangeSyncResult> {
  const results = await mapWithConcurrency(
    exchangeIds,
    concurrency,
    async (exchangeId) => Promise.allSettled([fetchExchangeMarkets(exchangeId)]).then(([result]) => result),
  );

  const now = new Date();
  let succeeded = 0;
  let failed = 0;
  const succeededExchangeIds: ExchangeId[] = [];
  const failedExchangeIds: ExchangeId[] = [];

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
      if (shouldEmitStartupLogger(progress)) {
        exchangeLogger.warn(errorInfo, 'exchange metadata sync failed');
      }
      progress?.onExchangeResult?.(exchangeId, 'failed', errorInfo.message);
      continue;
    }

    const markets = result.value;
    exchangeLogger.debug({ marketCount: markets.length }, 'fetched exchange markets');

    if (markets.length === 0) {
      succeededExchangeIds.push(exchangeId);
      continue;
    }

    succeeded += 1;
    succeededExchangeIds.push(exchangeId);
    database.db
      .insert(exchanges)
      .values({
        id: exchangeId,
        name: exchangeId.charAt(0).toUpperCase() + exchangeId.slice(1),
        description: '',
        url: `https://www.${exchangeId}.com`,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: exchanges.id,
        set: {
          updatedAt: now,
        },
      })
      .run();
    progress?.onExchangeResult?.(exchangeId, 'ok');
  }

  logger.debug({ succeeded, failed }, 'exchange metadata sync complete');
  return { succeededExchangeIds, failedExchangeIds };
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
  const { succeededExchangeIds } = await syncExchangesFromCCXT(
    database,
    exchangeIds,
    syncLogger,
    config.providerFanoutConcurrency,
    progress,
  );
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
  await runMarketRefreshOnce(database, {
    ccxtExchanges: activeExchangeIds,
    providerFanoutConcurrency: config.providerFanoutConcurrency,
  }, syncLogger, runtimeState, undefined, {
    onLongPhaseStatus: (message) => {
      progress?.onStatusDetail?.(message);
    },
    onExchangeFetchStart: (exchangeId) => {
      progress?.onTickerFetchStart?.(exchangeId);
    },
    onExchangeFetchComplete: (exchangeId, durationMs) => {
      progress?.onTickerFetchComplete?.(exchangeId, durationMs);
    },
    onExchangeFetchFailed: (exchangeId, message, durationMs) => {
      progress?.onTickerFetchFailed?.(exchangeId, message, durationMs);
    },
    onWaitingExchangeStatus: (exchangeIds) => {
      progress?.onWaitingExchangeStatus?.(exchangeIds);
    },
    suppressSummaryLogs: !shouldEmitStartupLogger(progress),
  });

  // Step 4: Count live snapshots
  const { marketSnapshots } = await import('../db/schema');
  const snapshotCount = database.db.select().from(marketSnapshots).all().length;

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
    tickersWritten: snapshotCount,
    exchangesSynced: activeExchangeIds.length,
    ohlcvCandlesWritten,
  };

  if (runtimeState) {
    runtimeState.initialSyncCompletedWithoutUsableLiveSnapshots = !didInitialSyncProduceUsableLiveSnapshots(result);
  }

  return result;
}
