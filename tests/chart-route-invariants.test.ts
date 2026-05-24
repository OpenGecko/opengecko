import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { marketChartSourcePoints, ohlcvCandles, ohlcvSyncTargets } from '../src/db/schema';
import { createOhlcvRuntime } from '../src/services/ohlcv-runtime';
import * as candleStore from '../src/services/candle-store';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeOHLCV } from '../src/providers/ccxt';

const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;

describe('chart route invariants', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  it('returns degraded chart and OHLC payloads without provider fetches or candle writes when persisted rows are missing', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    mockedFetchExchangeOHLCV.mockResolvedValue([]);

    try {
      await app.ready();
      mockedFetchExchangeOHLCV.mockClear();
      const upsertSpy = vi.spyOn(candleStore, 'upsertCanonicalOhlcvCandle');
      const recordSpy = vi.spyOn(app.chartResponseSources, 'record');
      app.db.client.prepare("DELETE FROM chart_points WHERE coin_id = 'bitcoin'").run();
      app.db.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();
      app.db.client.prepare("DELETE FROM market_chart_source_points WHERE coin_id = 'bitcoin'").run();

      const responses = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily',
        }),
        app.inject({
          method: 'GET',
          url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773878400&to=1773964800&interval=daily',
        }),
        app.inject({
          method: 'GET',
          url: '/coins/bitcoin/ohlc?vs_currency=usd&days=14&interval=daily',
        }),
        app.inject({
          method: 'GET',
          url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773878400&to=1773964800&interval=daily',
        }),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(200);
      }
      expect(responses[0].json()).toEqual({ prices: [], market_caps: [], total_volumes: [] });
      expect(responses[1].json()).toEqual({ prices: [], market_caps: [], total_volumes: [] });
      expect(responses[2].json()).toEqual([]);
      expect(responses[3].json()).toEqual([]);
      expect(mockedFetchExchangeOHLCV).not.toHaveBeenCalled();
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(app.db.db.select().from(ohlcvCandles).all()
        .filter((row) => row.coinId === 'bitcoin')).toEqual([]);
      expect(recordSpy.mock.calls.map(([, source]) => source)).toEqual(['empty', 'empty', 'empty', 'empty']);
      expect(recordSpy.mock.calls.some(([, source]) => source === 'provider_filled')).toBe(false);
      upsertSpy.mockRestore();
    } finally {
      await app.close();
    }
  });

  it('keeps persisted chart, OHLC, contract, and unknown-coin request paths free of provider and upsert side effects', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    const upsertSpy = vi.spyOn(candleStore, 'upsertCanonicalOhlcvCandle');

    try {
      await app.ready();
      mockedFetchExchangeOHLCV.mockClear();
      const recordSpy = vi.spyOn(app.chartResponseSources, 'record');
      const modes = ['off', 'stale_disallowed', 'degraded_seeded_bootstrap', 'seeded_bootstrap'] as const;

      for (const mode of modes) {
        app.marketDataRuntimeState.validationOverride = {
          mode,
          reason: `${mode} read-purity fixture`,
          snapshotTimestampOverride: null,
          snapshotSourceCountOverride: null,
        };
        app.marketDataRuntimeState.hotDataRevision += 1;

        const responses = await Promise.all([
          app.inject({
            method: 'GET',
            url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily',
          }),
          app.inject({
            method: 'GET',
            url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800&interval=daily',
          }),
          app.inject({
            method: 'GET',
            url: '/coins/bitcoin/ohlc?vs_currency=usd&days=14&interval=daily',
          }),
          app.inject({
            method: 'GET',
            url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773446400&to=1773964800&interval=daily',
          }),
        ]);

        for (const response of responses) {
          expect(response.statusCode).toBe(200);
        }
      }

      const [coinChartResponse, contractChartResponse, coinRangeResponse, contractRangeResponse] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/coins/usd-coin/market_chart?vs_currency=usd&days=7&interval=daily',
        }),
        app.inject({
          method: 'GET',
          url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart?vs_currency=usd&days=7&interval=daily',
        }),
        app.inject({
          method: 'GET',
          url: '/coins/usd-coin/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800&interval=daily',
        }),
        app.inject({
          method: 'GET',
          url: '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800&interval=daily',
        }),
      ]);
      const unknownResponse = await app.inject({
        method: 'GET',
        url: '/coins/not-a-coin/market_chart?vs_currency=usd&days=7',
      });

      expect(contractChartResponse.statusCode).toBe(200);
      expect(contractRangeResponse.statusCode).toBe(200);
      expect(contractChartResponse.json()).toEqual(coinChartResponse.json());
      expect(contractRangeResponse.json()).toEqual(coinRangeResponse.json());
      expect(unknownResponse.statusCode).toBe(404);
      expect(unknownResponse.json()).toMatchObject({
        error: 'not_found',
        message: 'Coin not found: not-a-coin',
      });
      expect(mockedFetchExchangeOHLCV).not.toHaveBeenCalled();
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(recordSpy.mock.calls.some(([, source]) => source === 'provider_filled')).toBe(false);
    } finally {
      upsertSpy.mockRestore();
      await app.close();
    }
  });

  it('preserves chart and OHLC route quality after recovering a stale OHLCV lease', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00.000Z'));

    mockedFetchExchangeOHLCV.mockResolvedValueOnce([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2026-03-20T00:00:00.000Z'),
        open: 90_000,
        high: 92_000,
        low: 89_000,
        close: 91_000,
        volume: 20,
        raw: [],
      },
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
        open: 91_000,
        high: 93_000,
        low: 90_000,
        close: 92_000,
        volume: 30,
        raw: [],
      },
    ]);

    try {
      await app.ready();
      app.db.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();
      app.db.db.insert(ohlcvSyncTargets).values({
        coinId: 'bitcoin',
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        vsCurrency: 'usd',
        interval: '1d',
        priorityTier: 'top100',
        latestSyncedAt: new Date('2026-03-19T00:00:00.000Z'),
        oldestSyncedAt: new Date('2026-03-19T00:00:00.000Z'),
        targetHistoryDays: 30,
        status: 'running',
        lastAttemptAt: new Date('2026-03-20T23:40:00.000Z'),
        lastSuccessAt: new Date('2026-03-19T00:00:00.000Z'),
        lastError: null,
        failureCount: 0,
        nextRetryAt: null,
        lastRequestedAt: null,
        leaseOwner: 'crashed-worker',
        leaseToken: 'crashed-token',
        leaseAcquiredAt: new Date('2026-03-20T23:40:00.000Z'),
        leaseExpiresAt: new Date('2026-03-20T23:55:00.000Z'),
        leaseRecoveryCount: 0,
        lastLeaseRecoveredAt: null,
        lastLeaseRecoveryReason: null,
        createdAt: new Date('2026-03-20T00:00:00.000Z'),
        updatedAt: new Date('2026-03-20T23:40:00.000Z'),
      }).run();

      const runtime = createOhlcvRuntime(app.db, { ccxtExchanges: ['binance'] }, logger, {
        refreshTargets: vi.fn().mockResolvedValue(undefined),
      });
      await runtime.tick(new Date('2026-03-21T00:00:00.000Z'));
      vi.useRealTimers();

      const chartResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773964800&to=1774051200',
      });
      const ohlcResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773964800&to=1774051200',
      });
      const ohlcvDiagnostics = await app.inject({
        method: 'GET',
        url: '/diagnostics/ohlcv_sync',
      });
      const chartDiagnostics = await app.inject({
        method: 'GET',
        url: '/diagnostics/market_charts',
      });

      expect(chartResponse.statusCode).toBe(200);
      expect(chartResponse.json().prices).toEqual([
        [1773964800 * 1_000, 91_000],
        [1774051200 * 1_000, 92_000],
      ]);
      expect(ohlcResponse.statusCode).toBe(200);
      expect(ohlcResponse.json()).toEqual([
        [1773964800 * 1_000, 90_000, 92_000, 89_000, 91_000],
        [1774051200 * 1_000, 91_000, 93_000, 90_000, 92_000],
      ]);
      expect(ohlcvDiagnostics.json().data.leases).toMatchObject({
        recovered_stale_total: 1,
        active: 0,
        stale: 0,
      });
      const bitcoinChartDiagnostics = chartDiagnostics.json().data.coins.find((coin: { coin_id: string }) => coin.coin_id === 'bitcoin');
      expect(bitcoinChartDiagnostics.ohlcv_sync).toMatchObject({
        recovered_stale_total: 1,
        latest_synced_at: '2026-03-21T00:00:00.000Z',
        freshness: 'stale',
      });
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });


  it('filters malformed source-backed chart and OHLC rows without changing public response shapes', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      app.db.db.insert(marketChartSourcePoints).values([
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          interval: '1d',
          timestamp: new Date('2026-03-19T00:00:00.000Z'),
          price: 91_000,
          marketCap: -1,
          totalVolume: -10,
          open: 90_000,
          high: 92_000,
          low: 89_000,
          close: 91_000,
          sourceKind: 'live',
          sourceProvider: 'mock.chart',
          sourceFetchedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          interval: '1d',
          timestamp: new Date('2026-03-20T00:00:00.000Z'),
          price: -1,
          marketCap: 100,
          totalVolume: 100,
          open: 91_000,
          high: 93_000,
          low: 90_000,
          close: 92_000,
          sourceKind: 'live',
          sourceProvider: 'mock.chart',
          sourceFetchedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          interval: '1d',
          timestamp: new Date('2026-03-21T00:00:00.000Z'),
          price: 92_000,
          marketCap: 100,
          totalVolume: 100,
          open: 92_000,
          high: 91_000,
          low: 93_000,
          close: 92_500,
          sourceKind: 'live',
          sourceProvider: 'mock.chart',
          sourceFetchedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
      ]).run();

      const chartResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773878400&to=1774051200',
      });
      const ohlcResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773878400&to=1774051200',
      });

      expect(chartResponse.statusCode).toBe(200);
      expect(chartResponse.json()).toEqual({
        prices: [
          [1773878400 * 1_000, 91_000],
          [1774051200 * 1_000, 92_000],
        ],
        market_caps: [
          [1773878400 * 1_000, expect.any(Number)],
          [1774051200 * 1_000, 100],
        ],
        total_volumes: [
          [1773878400 * 1_000, expect.any(Number)],
          [1774051200 * 1_000, 100],
        ],
      });
      expect(chartResponse.json().market_caps[0][1]).toBeGreaterThan(0);
      expect(chartResponse.json().total_volumes[0][1]).toBeGreaterThan(0);
      expect(ohlcResponse.statusCode).toBe(200);
      expect(ohlcResponse.json()).toEqual([
        [1773878400 * 1_000, 90_000, 92_000, 89_000, 91_000],
        [1773964800 * 1_000, 91_000, 93_000, 90_000, 92_000],
      ]);
    } finally {
      await app.close();
    }
  });

  it('filters malformed canonical OHLCV fallback rows and keeps range responses sorted in-bounds', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      app.db.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();

      app.db.db.insert(ohlcvCandles).values([
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          source: 'canonical',
          interval: '1d',
          timestamp: new Date('2026-03-18T00:00:00.000Z'),
          open: 88_000,
          high: 89_000,
          low: 87_000,
          close: 88_500,
          volume: 10,
          marketCap: 100,
          totalVolume: 10,
        },
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          source: 'canonical',
          interval: '1d',
          timestamp: new Date('2026-03-19T00:00:00.000Z'),
          open: 90_000,
          high: 92_000,
          low: 89_000,
          close: 91_000,
          volume: 20,
          marketCap: 200,
          totalVolume: 20,
        },
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          source: 'canonical',
          interval: '1d',
          timestamp: new Date('2026-03-20T00:00:00.000Z'),
          open: 91_000,
          high: 90_000,
          low: 92_000,
          close: 91_500,
          volume: 30,
          marketCap: 300,
          totalVolume: 30,
        },
      ]).run();

      const chartResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773878400&to=1773964800',
      });
      const ohlcResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773878400&to=1773964800',
      });

      expect(chartResponse.statusCode).toBe(200);
      const chartPrices = chartResponse.json().prices as Array<[number, number | null]>;
      expect(chartPrices.length).toBeGreaterThan(0);
      expect(chartPrices.every(([timestamp, price]) =>
        timestamp >= 1773878400 * 1_000
        && timestamp <= 1773964800 * 1_000
        && (price === null || Number.isFinite(price)))).toBe(true);
      expect(chartPrices.map(([timestamp]) => timestamp)).toEqual(
        [...chartPrices.map(([timestamp]) => timestamp)].sort((left, right) => left - right),
      );
      expect(ohlcResponse.statusCode).toBe(200);
      expect(ohlcResponse.json()).toEqual([
        [1773878400 * 1_000, 90_000, 92_000, 89_000, 91_000],
      ]);
    } finally {
      await app.close();
    }
  });
});
