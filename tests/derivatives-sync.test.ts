import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

const mockedFetchExchangeDerivativeTickers = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/ccxt', () => ({
  closeExchangePool: vi.fn(async () => undefined),
  fetchExchangeDerivativeTickers: mockedFetchExchangeDerivativeTickers,
}));

import { createDatabase, initializeDatabase } from '../src/db/client';
import { derivativeTickers } from '../src/db/schema';
import { runDerivativeSyncJob } from '../src/jobs/sync-derivatives';
import { syncDerivativeTickers } from '../src/services/derivatives-sync';
import { parseDerivativeVenueConfig } from '../src/services/derivatives-venues';

describe('derivatives sync job config', () => {
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
});
