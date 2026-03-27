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

export type InitialSyncProgressHandlers = {
  onStepChange?: (stepId: 'sync_exchange_metadata' | 'sync_coin_catalog' | 'sync_chain_catalog' | 'build_market_snapshots' | 'start_ohlcv_worker') => void;
  onOhlcvBackfillProgress?: (current: number, total: number) => void;
};

export async function syncExchangesFromCCXT(
  database: AppDatabase,
  exchangeIds: ExchangeId[],
  logger: Logger,
  concurrency = exchangeIds.length,
) {
  const results = await mapWithConcurrency(
    exchangeIds,
    concurrency,
    async (exchangeId) => Promise.allSettled([fetchExchangeMarkets(exchangeId)]).then(([result]) => result),
  );

  const now = new Date();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < exchangeIds.length; i++) {
    const exchangeId = exchangeIds[i];
    const result = results[i];
    const exchangeLogger = logger.child({ exchange: exchangeId });

    if (result.status === 'rejected') {
      failed += 1;
      const errorInfo = result.reason instanceof Error
        ? { message: result.reason.message }
        : { message: String(result.reason) };
      exchangeLogger.warn(errorInfo, 'exchange metadata sync failed');
      continue;
    }

    const markets = result.value;
    exchangeLogger.debug({ marketCount: markets.length }, 'fetched exchange markets');

    if (markets.length === 0) {
      continue;
    }

    succeeded += 1;
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
  }

  logger.debug({ succeeded, failed }, 'exchange metadata sync complete');
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

  syncLogger.info({ exchanges: exchangeIds }, 'starting initial market sync');

  // Step 1: Sync exchanges first (required for coin_tickers FK)
  progress?.onStepChange?.('sync_exchange_metadata');
  syncLogger.debug('syncing exchange metadata');
  await syncExchangesFromCCXT(database, exchangeIds, syncLogger, config.providerFanoutConcurrency);

  // Step 2: Discover coins from all exchanges
  progress?.onStepChange?.('sync_coin_catalog');
  syncLogger.debug('discovering coins from exchanges');
  const { insertedOrUpdated: coinsDiscovered } = await syncCoinCatalogFromExchanges(
    database,
    exchangeIds,
    syncLogger,
    config.providerFanoutConcurrency,
  );
  syncLogger.info({ coinsDiscovered }, 'coin catalog sync complete');

  // Step 2.5: Discover chains/networks from all exchanges
  progress?.onStepChange?.('sync_chain_catalog');
  syncLogger.debug('discovering chains from exchanges');
  const { insertedOrUpdated: chainsDiscovered } = await syncChainCatalogFromExchanges(
    database,
    exchangeIds,
    syncLogger,
    config.providerFanoutConcurrency,
  );
  syncLogger.info({ chainsDiscovered }, 'chain catalog sync complete');

  // Step 3: Fetch tickers and build market snapshots + coin tickers
  progress?.onStepChange?.('build_market_snapshots');
  syncLogger.debug('running market refresh');
  await runMarketRefreshOnce(database, {
    ccxtExchanges: exchangeIds,
    providerFanoutConcurrency: config.providerFanoutConcurrency,
  }, syncLogger, runtimeState);

  // Step 4: Count live snapshots
  const { marketSnapshots } = await import('../db/schema');
  const snapshotCount = database.db.select().from(marketSnapshots).all().length;

  progress?.onStepChange?.('start_ohlcv_worker');
  const ohlcvCandlesWritten = 0;

  const durationMs = Date.now() - startTime;
  syncLogger.info({
    coinsDiscovered,
    chainsDiscovered,
    snapshotsCreated: snapshotCount,
    ohlcvCandlesWritten,
    exchangesSynced: exchangeIds.length,
    durationMs,
  }, 'initial market sync complete');

  return {
    coinsDiscovered,
    chainsDiscovered,
    snapshotsCreated: snapshotCount,
    tickersWritten: snapshotCount,
    exchangesSynced: exchangeIds.length,
    ohlcvCandlesWritten,
  };
}
