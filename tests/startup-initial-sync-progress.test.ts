import { describe, expect, it, vi } from 'vitest';

import { runInitialMarketSync } from '../src/services/initial-sync';
import * as marketRefreshModule from '../src/services/market-refresh';

vi.mock('../src/services/coin-catalog-sync', () => ({
  syncCoinCatalogFromExchanges: vi.fn().mockResolvedValue({ insertedOrUpdated: 1 }),
}));

vi.mock('../src/services/chain-catalog-sync', () => ({
  syncChainCatalogFromExchanges: vi.fn().mockResolvedValue({ insertedOrUpdated: 0 }),
}));

vi.mock('../src/services/market-refresh', () => ({
  runMarketRefreshOnce: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string => ['binance'].includes(value),
}));

import {
  fetchExchangeMarkets,
  fetchExchangeOHLCV,
  fetchExchangeTickers,
} from '../src/providers/ccxt';

describe('initial sync startup progress', () => {
  it('reports step transitions without blocking OHLCV backfill progress', async () => {
    const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
    const mockedFetchExchangeTickers = fetchExchangeTickers as ReturnType<typeof vi.fn>;
    const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;

    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId: string) => {
      if (exchangeId === 'binance') {
        return [{ exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} }];
      }

      return [];
    });
    mockedFetchExchangeTickers.mockImplementation(async (exchangeId: string) => {
      if (exchangeId === 'binance') {
        return [{
          exchangeId: 'binance',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          last: 90_000,
          bid: null,
          ask: null,
          high: null,
          low: null,
          baseVolume: null,
          quoteVolume: null,
          percentage: null,
          timestamp: Date.now(),
          raw: {} as never,
        }];
      }

      return [];
    });
    mockedFetchExchangeOHLCV.mockResolvedValue([]);

    const transitions: string[] = [];
    const subprogress: Array<{ current: number; total: number }> = [];
    const exchangeResults: Array<{ exchangeId: string; status: 'ok' | 'failed'; message?: string }> = [];
    const catalogResults: Array<{ id: string; category: string; count: number; durationMs: number }> = [];
    let selectCall = 0;
    const database = {
      db: {
        insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => undefined }) }) }),
        select: () => ({
          from: () => {
            selectCall += 1;

            if (selectCall === 1) {
              return { all: () => [{ value: 1 }] };
            }

            if (selectCall === 2) {
              return { limit: () => ({ all: () => [] }) };
            }

            return { all: () => [{ id: 'bitcoin', symbol: 'btc' }] };
          },
        }),
      },
    } as never;

    await runInitialMarketSync(
      database,
      { ccxtExchanges: ['binance'], marketFreshnessThresholdSeconds: 300, providerFanoutConcurrency: 2 },
      undefined,
      {
        onStepChange: (stepId: string) => {
          transitions.push(stepId);
        },
        onOhlcvBackfillProgress: (current: number, total: number) => {
          subprogress.push({ current, total });
        },
        onExchangeResult: (exchangeId, status, message) => {
          exchangeResults.push({ exchangeId, status, message });
        },
        onCatalogResult: (id, category, count, durationMs) => {
          catalogResults.push({ id, category, count, durationMs });
        },
      },
    );

    expect(transitions).toEqual([
      'sync_exchange_metadata',
      'sync_coin_catalog',
      'sync_chain_catalog',
      'build_market_snapshots',
      'start_ohlcv_worker',
    ]);
    expect(subprogress).toEqual([]);
    expect(exchangeResults).toEqual([
      { exchangeId: 'binance', status: 'ok', message: undefined },
    ]);
    expect(catalogResults).toHaveLength(2);
    expect(catalogResults[0]).toMatchObject({ id: 'cat_01', category: 'Coin Catalog', count: 1 });
    expect(catalogResults[1]).toMatchObject({ id: 'cat_02', category: 'Chain Catalog', count: 0 });
    expect(catalogResults.every((result) => result.durationMs >= 0)).toBe(true);
  });

  it('forwards long-running market snapshot status details', async () => {
    const statusDetails: string[] = [];
    const runMarketRefreshOnceSpy = vi.spyOn(marketRefreshModule, 'runMarketRefreshOnce')
      .mockImplementation(async (_database, _config, _logger, _runtimeState, _metrics, progress) => {
        progress?.onLongPhaseStatus?.('Still working: fetching tickers from 1 exchanges');
      });

    const database = {
      db: {
        insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => undefined }) }) }),
        select: () => ({
          from: () => ({ all: () => [{ value: 1 }] }),
        }),
      },
    } as never;

    try {
      await runInitialMarketSync(
        database,
        { ccxtExchanges: ['binance'], marketFreshnessThresholdSeconds: 300, providerFanoutConcurrency: 2 },
        undefined,
        {
          onStatusDetail: (message) => {
            statusDetails.push(message);
          },
        },
      );
    } finally {
      runMarketRefreshOnceSpy.mockRestore();
    }

    expect(statusDetails).toEqual(['Still working: fetching tickers from 1 exchanges']);
  });

  it('forwards per-exchange ticker fetch lifecycle details', async () => {
    const tickerEvents: string[] = [];
    const runMarketRefreshOnceSpy = vi.spyOn(marketRefreshModule, 'runMarketRefreshOnce')
      .mockImplementation(async (_database, _config, _logger, _runtimeState, _metrics, progress) => {
        progress?.onExchangeFetchStart?.('binance');
        progress?.onExchangeFetchComplete?.('binance', 1200);
        progress?.onExchangeFetchStart?.('kraken');
        progress?.onExchangeFetchFailed?.('kraken', 'timeout', 2300);
      });

    const database = {
      db: {
        insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => undefined }) }) }),
        select: () => ({
          from: () => ({ all: () => [{ value: 1 }] }),
        }),
      },
    } as never;

    try {
      await runInitialMarketSync(
        database,
        { ccxtExchanges: ['binance'], marketFreshnessThresholdSeconds: 300, providerFanoutConcurrency: 2 },
        undefined,
        {
          onTickerFetchStart: (exchangeId) => {
            tickerEvents.push(`start:${exchangeId}`);
          },
          onTickerFetchComplete: (exchangeId, durationMs) => {
            tickerEvents.push(`complete:${exchangeId}:${durationMs}`);
          },
          onTickerFetchFailed: (exchangeId, message, durationMs) => {
            tickerEvents.push(`failed:${exchangeId}:${message}:${durationMs}`);
          },
        },
      );
    } finally {
      runMarketRefreshOnceSpy.mockRestore();
    }

    expect(tickerEvents).toEqual([
      'start:binance',
      'complete:binance:1200',
      'start:kraken',
      'failed:kraken:timeout:2300',
    ]);
  });

  it('forwards waiting exchange status details', async () => {
    const waitingStatus: string[][] = [];
    const runMarketRefreshOnceSpy = vi.spyOn(marketRefreshModule, 'runMarketRefreshOnce')
      .mockImplementation(async (_database, _config, _logger, _runtimeState, _metrics, progress) => {
        progress?.onWaitingExchangeStatus?.(['kraken']);
      });

    const database = {
      db: {
        insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => undefined }) }) }),
        select: () => ({
          from: () => ({ all: () => [{ value: 1 }] }),
        }),
      },
    } as never;

    try {
      await runInitialMarketSync(
        database,
        { ccxtExchanges: ['binance'], marketFreshnessThresholdSeconds: 300, providerFanoutConcurrency: 2 },
        undefined,
        {
          onWaitingExchangeStatus: (exchangeIds) => {
            waitingStatus.push(exchangeIds);
          },
        },
      );
    } finally {
      runMarketRefreshOnceSpy.mockRestore();
    }

    expect(waitingStatus).toEqual([['kraken']]);
  });
});
