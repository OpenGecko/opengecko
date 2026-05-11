import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { marketSnapshots, supplyChartPoints } from '../src/db/schema';
import { runSupplyChartSyncJob } from '../src/jobs/sync-supply-charts';
import { runSupplyAggregator } from '../src/services/supply-aggregator';
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

  it('aggregates current market snapshot supply into bounded live chart rows and diagnostics', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      app.db.db
        .insert(marketSnapshots)
        .values({
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          price: 85_000,
          marketCap: 1_684_000_000_000,
          totalVolume: 42_000_000_000,
          marketCapRank: 1,
          fullyDilutedValuation: 1_785_000_000_000,
          circulatingSupply: 19_812_345,
          totalSupply: 21_000_000,
          maxSupply: 21_000_000,
          ath: null,
          athChangePercentage: null,
          athDate: null,
          atl: null,
          atlChangePercentage: null,
          atlDate: null,
          priceChange24h: 1_500,
          priceChangePercentage24h: 1.8,
          sourceProvidersJson: JSON.stringify(['mock.exchange']),
          sourceCount: 1,
          updatedAt: new Date('2026-05-06T00:00:00.000Z'),
          lastUpdated: new Date('2026-05-06T00:00:00.000Z'),
        })
        .onConflictDoUpdate({
          target: [marketSnapshots.coinId, marketSnapshots.vsCurrency],
          set: {
            circulatingSupply: 19_812_345,
            totalSupply: 21_000_000,
            lastUpdated: new Date('2026-05-06T00:00:00.000Z'),
          },
        })
        .run();

      expect(runSupplyAggregator(app.db, new Date('2026-05-06T00:01:00.000Z'))).toEqual({
        targetsProcessed: 1,
        rowsWritten: 2,
      });

      const circulatingResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/circulating_supply_chart?days=30',
      });
      const totalRangeResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/total_supply_chart/range?from=1778025600&to=1778112000',
      });
      const diagnosticsResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/supply_charts',
      });

      expect(circulatingResponse.statusCode).toBe(200);
      expect(circulatingResponse.json()).toMatchObject({
        data: [[1778025600 * 1_000, 19_812_345]],
        meta: {
          fixture: false,
          coin_id: 'bitcoin',
          supply_type: 'circulating',
          source: 'live',
          source_providers: ['market-snapshot-aggregator'],
        },
      });
      expect(totalRangeResponse.statusCode).toBe(200);
      expect(totalRangeResponse.json()).toMatchObject({
        data: [[1778025600 * 1_000, 21_000_000]],
        meta: {
          fixture: false,
          coin_id: 'bitcoin',
          supply_type: 'total',
          source: 'live',
        },
      });
      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data.coins).toEqual(expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'bitcoin',
          status: 'live_backed',
          source_providers: ['market-snapshot-aggregator'],
          row_counts: {
            circulating: { total: 1, live: 1, replay: 0 },
            total: { total: 1, live: 1, replay: 0 },
          },
          latest_source_fetched_at: '2026-05-06T00:01:00.000Z',
        }),
      ]));
    } finally {
      await app.close();
    }
  });
});
