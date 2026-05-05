import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { marketChartSourcePoints } from '../src/db/schema';
import {
  ingestMarketChartReplay,
  normalizeMarketChartReplay,
  readMarketChartSourceRowsForDays,
  readMarketChartSourceRowsForRange,
  type RawMarketChartReplay,
} from '../src/services/market-chart-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/market-charts/bitcoin-chart.json'),
    'utf8',
  )) as RawMarketChartReplay;
}

describe('market chart provider replay fixtures', () => {
  it('rejects malformed market chart replay payloads explicitly', () => {
    const fixture = loadFixture();

    expect(() => normalizeMarketChartReplay({
      ...fixture,
      coin_id: ' ',
    })).toThrow('Missing market chart field: coin_id');
    expect(() => normalizeMarketChartReplay({
      ...fixture,
      captured_at: 'not-a-date',
    })).toThrow('Invalid market chart captured_at timestamp');
    expect(() => normalizeMarketChartReplay({
      ...fixture,
      interval: 'weekly' as never,
    })).toThrow('Invalid market chart interval');
    expect(() => normalizeMarketChartReplay({
      ...fixture,
      points: [{ ...fixture.points[0]!, price: 'bad' }],
    })).toThrow('Invalid market chart field');
  });

  it('replays source-attributed chart rows into market chart and OHLC routes', async () => {
    const fixture = loadFixture();
    const normalized = normalizeMarketChartReplay(fixture);

    expect(normalized).toMatchObject({
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
      capturedAt: new Date('2026-05-05T01:00:00.000Z'),
      points: expect.arrayContaining([
        expect.objectContaining({
          timestamp: new Date(1773792000 * 1_000),
          price: 84000.25,
          close: 84000.25,
        }),
      ]),
    });

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      expect(ingestMarketChartReplay(app.db, fixture)).toEqual({
        coin_id: 'bitcoin',
        vs_currency: 'usd',
        interval: '1d',
        points_written: 3,
        source_kind: 'replay',
        source_provider: 'market-chart-replay',
        source_fetched_at: '2026-05-05T01:00:00.000Z',
      });
      expect(ingestMarketChartReplay(app.db, fixture)).toMatchObject({
        points_written: 3,
      });
      expect(app.db.db.select().from(marketChartSourcePoints)
        .where(eq(marketChartSourcePoints.coinId, 'bitcoin'))
        .all()).toHaveLength(3);

      const chartResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773792000&to=1773964800',
      });
      const ohlcResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773792000&to=1773964800',
      });
      const coverageMatrixResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/coverage_matrix',
      });

      expect(chartResponse.statusCode).toBe(200);
      expect(chartResponse.json()).toEqual({
        prices: [
          [1773792000 * 1_000, 84000.25],
          [1773878400 * 1_000, 85010.5],
          [1773964800 * 1_000, 86020.75],
        ],
        market_caps: [
          [1773792000 * 1_000, 1660000000000],
          [1773878400 * 1_000, 1680000000000],
          [1773964800 * 1_000, 1700000000000],
        ],
        total_volumes: [
          [1773792000 * 1_000, 32000000000],
          [1773878400 * 1_000, 33000000000],
          [1773964800 * 1_000, 34000000000],
        ],
      });
      expect(ohlcResponse.statusCode).toBe(200);
      expect(ohlcResponse.json()).toEqual([
        [1773792000 * 1_000, 83500, 85000, 83000, 84000.25],
        [1773878400 * 1_000, 84000, 85500, 83800, 85010.5],
        [1773964800 * 1_000, 85000, 86500, 84800, 86020.75],
      ]);
      expect(coverageMatrixResponse.statusCode).toBe(200);
      expect(coverageMatrixResponse.json().data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'historical_charts',
          ownership_class: 'hybrid',
          last_successful_refresh_at: '2026-05-05T01:00:00.000Z',
          evidence: expect.objectContaining({
            notes: expect.stringContaining('source-attributed replay/live rows'),
          }),
        }),
      ]));
    } finally {
      await app.close();
    }
  });

  it('prefers live source chart rows over replay rows at the same timestamp', async () => {
    const fixture = loadFixture();
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      ingestMarketChartReplay(app.db, fixture);
      ingestMarketChartReplay(app.db, {
        ...fixture,
        provider: 'live-chart-provider',
        points: [{
          timestamp: 1773878400,
          price: 90000,
          market_cap: 1800000000000,
          total_volume: 35000000000,
          open: 89000,
          high: 90500,
          low: 88000,
          close: 90000,
        }],
      }, {
        sourceKind: 'live',
        sourceProvider: 'live-chart-provider',
        sourceFetchedAt: new Date('2026-05-05T01:05:00.000Z'),
      });

      const chartResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773878400&to=1773878400',
      });
      const ohlcResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773878400&to=1773878400',
      });

      expect(chartResponse.statusCode).toBe(200);
      expect(chartResponse.json().prices).toEqual([
        [1773878400 * 1_000, 90000],
      ]);
      expect(ohlcResponse.statusCode).toBe(200);
      expect(ohlcResponse.json()).toEqual([
        [1773878400 * 1_000, 89000, 90500, 88000, 90000],
      ]);
    } finally {
      await app.close();
    }
  });

  it('covers source reader edge cases for defaults, max windows, hourly rows, and invalid days', async () => {
    const fixture = loadFixture();
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      expect(readMarketChartSourceRowsForDays(app.db, 'bitcoin', 'usd', '7')).toEqual([]);
      expect(normalizeMarketChartReplay({
        ...fixture,
        vs_currency: undefined,
        interval: undefined,
        points: [{
          timestamp: String(1773792000 * 1_000),
          price: '84000.25',
        }],
      })).toMatchObject({
        vsCurrency: 'usd',
        interval: '1d',
        points: [expect.objectContaining({
          timestamp: new Date(1773792000 * 1_000),
          open: 84000.25,
          high: 84000.25,
          low: 84000.25,
          close: 84000.25,
          marketCap: null,
          totalVolume: null,
        })],
      });

      ingestMarketChartReplay(app.db, fixture);
      ingestMarketChartReplay(app.db, {
        ...fixture,
        provider: 'newer-replay-provider',
        points: [{
          timestamp: 1773878400,
          price: 87000,
        }],
      }, {
        sourceProvider: 'newer-replay-provider',
        sourceFetchedAt: new Date('2026-05-05T01:04:00.000Z'),
      });
      ingestMarketChartReplay(app.db, {
        provider: 'hourly-chart-replay',
        captured_at: '2026-05-05T01:10:00.000Z',
        coin_id: 'bitcoin',
        interval: '1m',
        points: [{
          timestamp: 1773878400,
          price: 88000,
        }],
      });

      expect(readMarketChartSourceRowsForDays(app.db, 'bitcoin', 'usd', 'max').map((row) => row.price)).toEqual([
        84000.25,
        87000,
        86020.75,
      ]);
      expect(readMarketChartSourceRowsForRange(app.db, 'bitcoin', 'usd', {
        from: 1773878400 * 1_000,
        to: 1773878400 * 1_000,
      }).map((row) => row.price)).toEqual([87000]);
      expect(readMarketChartSourceRowsForDays(app.db, 'bitcoin', 'usd', '1', 'hourly').map((row) => row.price)).toEqual([88000]);
      expect(() => readMarketChartSourceRowsForDays(app.db, 'bitcoin', 'usd', 'bad')).toThrow('Invalid days value');
    } finally {
      await app.close();
    }
  });
});
