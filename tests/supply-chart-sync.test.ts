import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { supplyChartPoints } from '../src/db/schema';
import { runSupplyChartSyncJob } from '../src/jobs/sync-supply-charts';
import {
  createHttpSupplyChartFetcher,
  parseSupplyChartTargetConfig,
  syncSupplyCharts,
} from '../src/services/supply-chart-sync';
import type { RawSupplyChartReplay } from '../src/services/supply-chart-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/supply-charts/bitcoin-supply.json'),
    'utf8',
  )) as RawSupplyChartReplay;
}

describe('supply chart sync', () => {
  it('parses optional provider coin mappings from environment syntax', () => {
    expect(parseSupplyChartTargetConfig(undefined)).toEqual([]);
    expect(parseSupplyChartTargetConfig('   ')).toEqual([]);
    expect(parseSupplyChartTargetConfig('mock.supply=Bitcoin, ethereum')).toEqual([
      {
        provider: 'mock.supply',
        coinId: 'bitcoin',
      },
      {
        provider: 'custom',
        coinId: 'ethereum',
      },
    ]);
    expect(() => parseSupplyChartTargetConfig('mock.supply=')).toThrow(
      'Invalid supply chart target config entry',
    );
  });

  it('exits without opening a database when no supply chart targets are configured', async () => {
    await expect(runSupplyChartSyncJob({
      LOG_LEVEL: 'silent',
      SUPPLY_CHART_TARGETS: '',
    })).resolves.toBeUndefined();
  });

  it('builds a provider-facing HTTP fetcher with stable target URL and defaults', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      captured_at: '2026-05-05T00:14:00.000Z',
      points: [{
        timestamp: '1774051200',
        circulating_supply: '19815000',
        total_supply: '21000000',
      }],
    }), { status: 200 }));
    const fetcher = createHttpSupplyChartFetcher('https://supply.example/', fetchImpl as unknown as typeof fetch);
    const response = await fetcher({
      provider: 'mock.supply',
      coinId: 'bitcoin',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://supply.example/providers/mock.supply/coins/bitcoin/supply_chart',
      expect.objectContaining({
        headers: { accept: 'application/json' },
      }),
    );
    expect(response).toMatchObject({
      provider: 'mock.supply',
      coin_id: 'bitcoin',
      points: [expect.objectContaining({ circulating_supply: '19815000' })],
    });
  });

  it('covers optional provider fetcher failure and no-data branches', async () => {
    expect(() => createHttpSupplyChartFetcher(undefined)).toThrow('SUPPLY_CHART_BASE_URL is required');

    const notFoundFetcher = createHttpSupplyChartFetcher(
      'https://supply.example',
      vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    );
    await expect(notFoundFetcher({
      provider: 'mock.supply',
      coinId: 'bitcoin',
    })).resolves.toBeNull();

    const failedFetcher = createHttpSupplyChartFetcher(
      'https://supply.example',
      vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(failedFetcher({
      provider: 'mock.supply',
      coinId: 'bitcoin',
    })).rejects.toThrow('Supply chart provider request failed with status 500');

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      await expect(syncSupplyCharts(app.db, {
        targets: [{
          provider: 'mock.supply',
          coinId: 'bitcoin',
        }],
        fetcher: vi.fn(async () => null),
        now: new Date('2026-05-05T00:15:00.000Z'),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        points_fetched: 0,
        points_written: 0,
        results: [
          expect.objectContaining({
            provider: 'mock.supply',
            coin_id: 'bitcoin',
          }),
        ],
      });

      await expect(syncSupplyCharts(app.db, {
        targets: [{
          provider: 'empty.supply',
          coinId: 'bitcoin',
        }],
        fetcher: vi.fn(async () => ({
          provider: 'empty.supply',
          captured_at: '2026-05-05T00:16:00.000Z',
          coin_id: 'bitcoin',
          points: [],
        })),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        points_fetched: 0,
        points_written: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('syncs mocked provider output into live source-attributed rows without changing chart envelope shape', async () => {
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

      const result = await syncSupplyCharts(app.db, {
        targets: [{
          provider: 'mock.supply',
          coinId: fixture.coin_id,
        }],
        now: new Date('2026-05-05T00:17:00.000Z'),
        fetcher: vi.fn(async () => fixture),
      });

      expect(result).toMatchObject({
        targets_attempted: 1,
        points_fetched: 3,
        points_written: 6,
        source_fetched_at: '2026-05-05T00:17:00.000Z',
      });
      expect(app.db.db.select().from(supplyChartPoints)
        .where(eq(supplyChartPoints.coinId, 'bitcoin'))
        .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          supplyType: 'circulating',
          sourceKind: 'live',
          sourceProvider: 'mock.supply',
        }),
        expect.objectContaining({
          supplyType: 'total',
          sourceKind: 'live',
          sourceProvider: 'mock.supply',
        }),
      ]));

      const circulatingResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/circulating_supply_chart?days=30',
      });
      const totalResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/total_supply_chart?days=30',
      });

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
          source: 'live',
          source_providers: ['mock.supply'],
        },
      });
      expect(totalResponse.json()).toMatchObject({
        data: [
          [1773792000 * 1_000, 21000000],
          [1773878400 * 1_000, 21000000],
          [1773964800 * 1_000, 21000000],
        ],
        meta: {
          fixture: false,
          supply_type: 'total',
          source: 'live',
        },
      });
    } finally {
      await app.close();
    }
  });
});
