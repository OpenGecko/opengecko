import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockedFetchExchangeDerivativeTickers = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/ccxt', () => ({
  closeExchangePool: vi.fn(async () => undefined),
  fetchExchangeDerivativeTickers: mockedFetchExchangeDerivativeTickers,
}));

import { buildApp } from '../src/app';
import { createDatabase, initializeDatabase } from '../src/db/client';
import { derivativeTickers } from '../src/db/schema';
import { runDerivativeSyncJob } from '../src/jobs/sync-derivatives';
import { syncDerivativeTickers } from '../src/services/derivatives-sync';
import { buildDerivativesProviderDiagnostics, parseDerivativeVenueConfig, resetDerivativesVenueRefreshStateForTests } from '../src/services/derivatives-venues';

describe('derivatives sync job config', () => {
  afterEach(() => {
    resetDerivativesVenueRefreshStateForTests();
  });

  it('parses optional venue mappings from environment syntax', () => {
    expect(parseDerivativeVenueConfig(undefined)).toEqual([]);
    expect(parseDerivativeVenueConfig('   ')).toEqual([]);
    expect(parseDerivativeVenueConfig('binance_futures=binanceusdm, bybit')).toEqual([
      {
        exchangeId: 'binance_futures',
        providerExchangeId: 'binanceusdm',
      },
      {
        exchangeId: 'bybit',
        providerExchangeId: 'bybit',
      },
    ]);
  });

  it('exits without opening a database when no derivatives venues are configured', async () => {
    await expect(runDerivativeSyncJob({
      LOG_LEVEL: 'silent',
      DERIVATIVES_CCXT_EXCHANGES: '',
    })).resolves.toBeUndefined();
  });

  it('uses the CCXT derivative fetcher by default for configured venues', async () => {
    mockedFetchExchangeDerivativeTickers.mockReset();
    mockedFetchExchangeDerivativeTickers.mockResolvedValue([{
      exchangeId: 'binance_futures',
      symbol: 'BTC/USDT:USDT',
      market: 'BTCUSDT',
      base: 'BTC',
      quote: 'USDT',
      markPrice: 64000.25,
      contractType: 'perpetual',
      timestamp: 1777939200000,
    }]);

    const database = createDatabase(':memory:');

    try {
      initializeDatabase(database);
      const result = await syncDerivativeTickers(database, {
        venues: [{ exchangeId: 'binance_futures', providerExchangeId: 'binanceusdm' }],
        now: new Date('2026-05-05T00:00:00.000Z'),
      });

      expect(mockedFetchExchangeDerivativeTickers).toHaveBeenCalledWith('binanceusdm', 'binance_futures', undefined);
      expect(result.tickers_written).toBe(1);
      expect(database.db.select().from(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, 'binance_futures'))
        .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbol: 'BTC/USDT:USDT',
          sourceKind: 'live',
          sourceProvider: 'ccxt.binanceusdm',
        }),
      ]));
    } finally {
      database.client.close();
    }
  });

  it('isolates per-venue CCXT failures while writing successful venue rows and diagnostics', async () => {
    const database = createDatabase(':memory:');

    try {
      initializeDatabase(database);
      const result = await syncDerivativeTickers(database, {
        venues: [
          { exchangeId: 'bybit', providerExchangeId: 'bybit' },
          { exchangeId: 'okx', providerExchangeId: 'okx' },
          { exchangeId: 'bitget', providerExchangeId: 'bitget' },
        ],
        now: new Date('2026-05-05T00:10:00.000Z'),
        fetcher: async (providerExchangeId, exchangeId) => {
          if (providerExchangeId === 'okx') {
            throw new Error('okx fetchTickers request timed out with token=secret');
          }

          if (providerExchangeId === 'bitget') {
            return [];
          }

          return [{
            exchangeId,
            symbol: 'BTC/USDT:USDT',
            market: 'BTCUSDT',
            base: 'BTC',
            quote: 'USDT',
            markPrice: 91_000,
            contractType: 'perpetual',
            tradeVolume24hBtc: 700,
            openInterestBtc: 300,
            timestamp: 1777939800000,
          }];
        },
      });

      expect(result).toMatchObject({
        venues_attempted: 3,
        tickers_fetched: 1,
        tickers_written: 1,
        rowsWritten: 1,
        partialFailures: [
          { target: 'okx', reason: expect.stringContaining('timed out') },
          { target: 'bitget', reason: 'ccxt.bitget returned no derivative tickers' },
        ],
      });
      expect(database.db.select().from(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, 'bybit'))
        .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbol: 'BTC/USDT:USDT',
          sourceKind: 'live',
          sourceProvider: 'ccxt.bybit',
        }),
      ]));
      expect(buildDerivativesProviderDiagnostics(database, 'bybit,okx,bitget')).toMatchObject({
        exchanges: expect.arrayContaining([
          expect.objectContaining({
            exchange_id: 'bybit',
            status: 'source_backed',
            last_refresh_success_at: '2026-05-05T00:10:00.000Z',
          }),
          expect.objectContaining({
            exchange_id: 'okx',
            status: 'errored',
            last_refresh_error: expect.stringContaining('timed out'),
          }),
          expect.objectContaining({
            exchange_id: 'bitget',
            status: 'unsupported_or_empty',
          }),
        ]),
        gaps: expect.objectContaining({
          configured_without_source_rows: expect.arrayContaining(['okx', 'bitget']),
          errored_exchanges: ['okx'],
        }),
      });
      const okxDiagnostic = buildDerivativesProviderDiagnostics(database, 'bybit,okx,bitget').exchanges
        .find((exchange) => exchange.exchange_id === 'okx');
      expect(okxDiagnostic?.last_refresh_error).not.toContain('secret');
    } finally {
      database.client.close();
    }
  });

  it('invokes append-table retention from the scheduled derivatives refresh after successful writes', async () => {
    mockedFetchExchangeDerivativeTickers.mockReset();
    mockedFetchExchangeDerivativeTickers.mockResolvedValue([{
      exchangeId: 'binance_futures',
      symbol: 'BTC/USDT:USDT',
      market: 'BTCUSDT',
      base: 'BTC',
      quote: 'USDT',
      markPrice: 95_000,
      contractType: 'perpetual',
      timestamp: 1777939200000,
    }]);

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
        derivativesCcxtExchanges: 'binance_futures=binanceusdm',
      },
      startBackgroundJobs: false,
      exposeSchedulerDiagnostics: true,
    });

    try {
      await app.ready();
      app.db.db.insert(derivativeTickers).values({
        exchangeId: 'binance_futures',
        symbol: 'OLD/USDT:USDT',
        market: 'OLDUSDT',
        price: 1,
        contractType: 'perpetual',
        sourceKind: 'live',
        sourceProvider: 'ccxt.old',
        sourceFetchedAt: new Date('2024-01-01T00:00:00.000Z'),
      }).run();

      await app.scheduler?.runNow('derivatives-refresh');

      expect(app.db.db.select().from(derivativeTickers)
        .where(eq(derivativeTickers.symbol, 'OLD/USDT:USDT'))
        .all()).toHaveLength(0);
      expect(app.db.db.select().from(derivativeTickers)
        .where(eq(derivativeTickers.symbol, 'BTC/USDT:USDT'))
        .all()).toHaveLength(1);

      const jobsResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/jobs',
      });
      const derivativesJob = jobsResponse.json().data.jobs.find((job: { name: string }) => job.name === 'derivatives-refresh');
      expect(derivativesJob).toMatchObject({
        name: 'derivatives-refresh',
        rows_written: 1,
        rows_pruned: 1,
      });
    } finally {
      await app.close();
    }
  });
});
