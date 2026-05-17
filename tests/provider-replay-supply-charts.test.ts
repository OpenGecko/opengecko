import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { supplyChartPoints } from '../src/db/schema';
import {
  ingestSupplyChartReplay,
  normalizeSupplyChartReplay,
  type RawSupplyChartReplay,
} from '../src/services/supply-chart-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/supply-charts/bitcoin-supply.json'),
    'utf8',
  )) as RawSupplyChartReplay;
}

describe('supply chart provider replay fixtures', () => {
  it('replays source-attributed circulating and total supply rows into public chart routes', async () => {
    const fixture = loadFixture();
    const normalized = normalizeSupplyChartReplay(fixture);

    expect(normalized).toMatchObject({
      coinId: 'bitcoin',
      capturedAt: new Date('2026-05-05T00:12:00.000Z'),
      points: expect.arrayContaining([
        expect.objectContaining({
          supplyType: 'circulating',
          timestamp: new Date(1773792000 * 1_000),
          value: 19812000.5,
        }),
        expect.objectContaining({
          supplyType: 'total',
          timestamp: new Date(1773792000 * 1_000),
          value: 21000000,
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

      expect(ingestSupplyChartReplay(app.db, fixture)).toEqual({
        coin_id: 'bitcoin',
        points_written: 6,
        source_kind: 'replay',
        source_provider: 'supply-replay',
        source_fetched_at: '2026-05-05T00:12:00.000Z',
      });
      expect(ingestSupplyChartReplay(app.db, fixture)).toMatchObject({
        points_written: 6,
      });
      expect(app.db.db.select().from(supplyChartPoints)
        .where(eq(supplyChartPoints.coinId, 'bitcoin'))
        .all()).toHaveLength(6);

      const circulatingResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/circulating_supply_chart?days=30',
      });
      const totalResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/total_supply_chart?days=30',
      });
      const rangeResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/circulating_supply_chart/range?from=1773792000&to=1773964800',
      });
      const coverageMatrixResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/coverage_matrix',
      });

      expect(circulatingResponse.statusCode).toBe(200);
      expect(circulatingResponse.json()).toMatchObject({
        data: [
          [1773792000 * 1_000, 19812000.5],
          [1773878400 * 1_000, 19813000.75],
          [1773964800 * 1_000, 19814000.25],
        ],
        meta: {
          fixture: false,
          coin_id: 'bitcoin',
          supply_type: 'circulating',
          source: 'replay',
          source_mode: 'replay',
          source_providers: ['supply-replay'],
          point_count: 3,
          latest_source_fetched_at: '2026-05-05T00:12:00.000Z',
        },
      });
      expect(totalResponse.statusCode).toBe(200);
      expect(totalResponse.json()).toMatchObject({
        data: [
          [1773792000 * 1_000, 21000000],
          [1773878400 * 1_000, 21000000],
          [1773964800 * 1_000, 21000000],
        ],
        meta: {
          fixture: false,
          supply_type: 'total',
          source: 'replay',
          source_mode: 'replay',
          point_count: 3,
          latest_source_fetched_at: '2026-05-05T00:12:00.000Z',
        },
      });
      expect(rangeResponse.statusCode).toBe(200);
      expect(rangeResponse.json().data).toEqual([
        [1773792000 * 1_000, 19812000.5],
        [1773964800 * 1_000, 19814000.25],
      ]);
      expect(rangeResponse.json().data.every(([timestamp]: [number, number]) => (
        timestamp >= 1773792000 * 1_000 && timestamp <= 1773964800 * 1_000
      ))).toBe(true);
      expect(coverageMatrixResponse.statusCode).toBe(200);
      expect(coverageMatrixResponse.json().data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'supply_charts',
          ownership_class: 'hybrid',
          last_successful_refresh_at: '2026-05-05T00:12:00.000Z',
          evidence: expect.objectContaining({
            notes: expect.stringContaining('source-attributed replay/live supply rows'),
          }),
        }),
      ]));
    } finally {
      await app.close();
    }
  });
});
