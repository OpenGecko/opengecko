import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { marketChartSourcePoints } from '../src/db/schema';
import { runMarketChartSyncJob } from '../src/jobs/sync-market-charts';
import {
  createHttpMarketChartFetcher,
  parseMarketChartTargetConfig,
  syncMarketCharts,
  syncMarketChartsFromCoveragePlan,
} from '../src/services/market-chart-sync';
import {
  ingestMarketChartReplay,
  type RawMarketChartReplay,
} from '../src/services/market-chart-ingestion';
import { buildMarketChartProviderDiagnostics } from '../src/services/market-chart-diagnostics';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/market-charts/bitcoin-chart.json'),
    'utf8',
  )) as RawMarketChartReplay;
}

type MarketChartProviderPresetManifest = {
  adapter_contract: {
    example_response_fixture: string;
  };
  presets: Array<{
    id: string;
    provider: string;
    request_examples: Array<{
      target: string;
      path: string;
      response_fixture?: string;
    }>;
  }>;
};

function loadPresetManifest() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'docs/reference/market-chart-provider-presets.json'),
    'utf8',
  )) as MarketChartProviderPresetManifest;
}

function loadDocumentedAdapterFixture(manifest: MarketChartProviderPresetManifest) {
  return JSON.parse(readFileSync(
    join(process.cwd(), manifest.adapter_contract.example_response_fixture),
    'utf8',
  )) as RawMarketChartReplay;
}

function loadRequestExampleFixture(example: { response_fixture?: string }) {
  if (!example.response_fixture) {
    throw new Error('Missing request example response fixture.');
  }

  return JSON.parse(readFileSync(
    join(process.cwd(), example.response_fixture),
    'utf8',
  )) as RawMarketChartReplay;
}

function pointNumber(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function pointTimestampSeconds(point: RawMarketChartReplay['points'][number]) {
  return Number(point.timestamp);
}

describe('market chart sync', () => {
  it('parses optional provider coin/interval/currency mappings from environment syntax', () => {
    expect(parseMarketChartTargetConfig(undefined)).toEqual([]);
    expect(parseMarketChartTargetConfig('   ')).toEqual([]);
    expect(parseMarketChartTargetConfig('mock.chart=Bitcoin:1d:usd, ethereum:1m')).toEqual([
      {
        provider: 'mock.chart',
        coinId: 'bitcoin',
        interval: '1d',
        vsCurrency: 'usd',
      },
      {
        provider: 'custom',
        coinId: 'ethereum',
        interval: '1m',
        vsCurrency: 'usd',
      },
    ]);
    expect(() => parseMarketChartTargetConfig('mock.chart=bitcoin:weekly:usd')).toThrow(
      'Invalid market chart target config entry',
    );
    expect(() => parseMarketChartTargetConfig('mock.chart=')).toThrow(
      'Invalid market chart target config entry',
    );
  });

  it('exits without opening a database when no market chart targets are configured', async () => {
    await expect(runMarketChartSyncJob({
      LOG_LEVEL: 'silent',
      MARKET_CHART_TARGETS: '',
    })).resolves.toBeUndefined();
  });

  it('builds a provider-facing HTTP fetcher with stable target URL and defaults', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      captured_at: '2026-05-05T01:20:00.000Z',
      points: [{
        timestamp: '1774051200',
        price: '87000',
      }],
    }), { status: 200 }));
    const fetcher = createHttpMarketChartFetcher('https://charts.example/', fetchImpl as unknown as typeof fetch);
    const response = await fetcher({
      provider: 'mock.chart',
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://charts.example/providers/mock.chart/coins/bitcoin/market_chart?vs_currency=usd&interval=1d',
      expect.objectContaining({
        headers: { accept: 'application/json' },
      }),
    );
    expect(response).toMatchObject({
      provider: 'mock.chart',
      coin_id: 'bitcoin',
      vs_currency: 'usd',
      interval: '1d',
      points: [expect.objectContaining({ price: '87000' })],
    });
  });

  it('covers optional provider fetcher failure and no-data branches', async () => {
    expect(() => createHttpMarketChartFetcher(undefined)).toThrow('MARKET_CHART_BASE_URL is required');

    const notFoundFetcher = createHttpMarketChartFetcher(
      'https://charts.example',
      vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    );
    await expect(notFoundFetcher({
      provider: 'mock.chart',
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
    })).resolves.toBeNull();

    const emptyFetcher = createHttpMarketChartFetcher(
      'https://charts.example',
      vi.fn(async () => new Response(JSON.stringify({ points: [] }), { status: 200 })) as unknown as typeof fetch,
    );
    await expect(emptyFetcher({
      provider: 'mock.chart',
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
    })).resolves.toBeNull();

    const failedFetcher = createHttpMarketChartFetcher(
      'https://charts.example',
      vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(failedFetcher({
      provider: 'mock.chart',
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
    })).rejects.toThrow('Market chart provider request failed with status 500');

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      await expect(syncMarketCharts(app.db, {
        targets: [{
          provider: 'mock.chart',
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          interval: '1d',
        }],
        fetcher: vi.fn(async () => null),
        now: new Date('2026-05-05T01:21:00.000Z'),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        points_fetched: 0,
        points_written: 0,
        results: [
          expect.objectContaining({
            provider: 'mock.chart',
            coin_id: 'bitcoin',
            interval: '1d',
          }),
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('continues broader target batches after a partial provider failure and fails all-failed batches', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const targets = parseMarketChartTargetConfig('mock.chart=bitcoin:1d:usd,mock.chart=solana:1d:usd');
      const result = await syncMarketCharts(app.db, {
        targets,
        now: new Date('2026-05-05T03:00:00.000Z'),
        fetcher: async (target) => {
          if (target.coinId === 'bitcoin') {
            throw new Error('provider timeout for bitcoin');
          }

          return {
            provider: target.provider,
            captured_at: '2026-05-05T03:00:00.000Z',
            coin_id: target.coinId,
            vs_currency: target.vsCurrency,
            interval: target.interval,
            points: [{
              timestamp: 1774137600,
              price: 151.4,
              open: 150.8,
              high: 151.9,
              low: 150.4,
              close: 151.4,
            }],
          };
        },
      });

      expect(result).toMatchObject({
        targets_attempted: 2,
        targets_failed: 1,
        points_fetched: 1,
        points_written: 1,
        results: [
          {
            provider: 'mock.chart',
            coin_id: 'bitcoin',
            vs_currency: 'usd',
            interval: '1d',
            status: 'failed',
            points_fetched: 0,
            points_written: 0,
            error: 'provider timeout for bitcoin',
          },
          {
            provider: 'mock.chart',
            coin_id: 'solana',
            vs_currency: 'usd',
            interval: '1d',
            status: 'synced',
            points_fetched: 1,
            points_written: 1,
          },
        ],
      });
      expect(app.db.db.select().from(marketChartSourcePoints)
        .where(eq(marketChartSourcePoints.coinId, 'solana'))
        .all()).toEqual([
        expect.objectContaining({
          price: 151.4,
          sourceKind: 'live',
          sourceProvider: 'mock.chart',
        }),
      ]);

      await expect(syncMarketCharts(app.db, {
        targets: [targets[0]!],
        now: new Date('2026-05-05T03:01:00.000Z'),
        fetcher: async () => {
          throw new Error('provider still unavailable');
        },
      })).rejects.toThrow('Market chart sync failed for all 1 target(s): provider still unavailable');
    } finally {
      await app.close();
    }
  });

  it('syncs mocked provider output into live source-attributed rows without changing chart or OHLC shape', async () => {
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

      const result = await syncMarketCharts(app.db, {
        targets: [{
          provider: 'mock.chart',
          coinId: fixture.coin_id,
          vsCurrency: fixture.vs_currency ?? 'usd',
          interval: fixture.interval ?? '1d',
        }],
        now: new Date('2026-05-05T01:22:00.000Z'),
        fetcher: vi.fn(async () => ({
          ...fixture,
          provider: 'mock.chart',
          points: [{
            timestamp: 1773878400,
            price: 91000,
            market_cap: 1810000000000,
            total_volume: 36000000000,
            open: 90000,
            high: 91500,
            low: 89500,
            close: 91000,
          }],
        })),
      });

      expect(result).toMatchObject({
        targets_attempted: 1,
        points_fetched: 1,
        points_written: 1,
        source_fetched_at: '2026-05-05T01:22:00.000Z',
      });
      expect(app.db.db.select().from(marketChartSourcePoints)
        .where(eq(marketChartSourcePoints.coinId, 'bitcoin'))
        .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          price: 91000,
          sourceKind: 'live',
          sourceProvider: 'mock.chart',
        }),
      ]));

      const chartResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773878400&to=1773878400',
      });
      const ohlcResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773878400&to=1773878400',
      });

      expect(chartResponse.statusCode).toBe(200);
      expect(chartResponse.json()).toMatchObject({
        prices: [[1773878400 * 1_000, 91000]],
        market_caps: [[1773878400 * 1_000, 1810000000000]],
        total_volumes: [[1773878400 * 1_000, 36000000000]],
      });
      expect(ohlcResponse.statusCode).toBe(200);
      expect(ohlcResponse.json()).toEqual([
        [1773878400 * 1_000, 90000, 91500, 89500, 91000],
      ]);
    } finally {
      await app.close();
    }
  });

  it('maps the documented provider preset response fixture through HTTP fetch and live ingestion', async () => {
    const manifest = loadPresetManifest();
    const binanceDailyPreset = manifest.presets.find((preset) => preset.id === 'ccxt.binance.daily');
    const [target] = parseMarketChartTargetConfig(binanceDailyPreset?.request_examples[0]?.target);
    const adapterFixture = loadDocumentedAdapterFixture(manifest);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(adapterFixture), { status: 200 }));
    const fetcher = createHttpMarketChartFetcher('https://charts.example', fetchImpl as unknown as typeof fetch);
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    expect(binanceDailyPreset).toMatchObject({
      provider: 'ccxt.binance',
    });
    expect(target).toEqual({
      provider: 'ccxt.binance',
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
    });

    try {
      await app.ready();

      const result = await syncMarketCharts(app.db, {
        targets: [target!],
        fetcher,
        now: new Date('2026-05-05T01:31:00.000Z'),
      });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://charts.example/providers/ccxt.binance/coins/bitcoin/market_chart?vs_currency=usd&interval=1d',
        expect.objectContaining({
          headers: { accept: 'application/json' },
        }),
      );
      expect(result).toMatchObject({
        targets_attempted: 1,
        points_fetched: 2,
        points_written: 2,
        source_fetched_at: '2026-05-05T01:31:00.000Z',
        results: [
          {
            provider: 'ccxt.binance',
            coin_id: 'bitcoin',
            vs_currency: 'usd',
            interval: '1d',
            points_fetched: 2,
            points_written: 2,
          },
        ],
      });
      expect(app.db.db.select().from(marketChartSourcePoints)
        .where(eq(marketChartSourcePoints.sourceProvider, 'ccxt.binance'))
        .all()).toEqual([
        expect.objectContaining({
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          interval: '1d',
          price: 87000.5,
          marketCap: null,
          totalVolume: 34500000000,
          open: 86000,
          high: 87500,
          low: 85800,
          close: 87000.5,
          sourceKind: 'live',
        }),
        expect.objectContaining({
          price: 88200.75,
          close: 88200.75,
          sourceKind: 'live',
        }),
      ]);

      const chartResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1774051200&to=1774137600',
      });
      const ohlcResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1774051200&to=1774137600',
      });

      expect(chartResponse.statusCode).toBe(200);
      expect(chartResponse.json()).toEqual({
        prices: [
          [1774051200 * 1_000, 87000.5],
          [1774137600 * 1_000, 88200.75],
        ],
        market_caps: [
          [1774051200 * 1_000, expect.any(Number)],
          [1774137600 * 1_000, expect.any(Number)],
        ],
        total_volumes: [
          [1774051200 * 1_000, 34500000000],
          [1774137600 * 1_000, 35200000000],
        ],
      });
      expect(chartResponse.json().market_caps.every(([, value]: [number, number]) => value > 0)).toBe(true);
      expect(ohlcResponse.statusCode).toBe(200);
      expect(ohlcResponse.json()).toEqual([
        [1774051200 * 1_000, 86000, 87500, 85800, 87000.5],
        [1774137600 * 1_000, 87000.5, 88900, 86650, 88200.75],
      ]);
    } finally {
      await app.close();
    }
  });

  it('syncs every fixture-backed market chart preset example through the offline HTTP adapter contract', async () => {
    const manifest = loadPresetManifest();
    const fixtureBackedExamples = manifest.presets.flatMap((preset) =>
      preset.request_examples
        .filter((example) => example.response_fixture)
        .map((example) => ({
          provider: preset.provider,
          example,
          fixture: loadRequestExampleFixture(example),
        })));
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    expect(fixtureBackedExamples.map(({ example }) => example.target).sort()).toEqual([
      'ccxt.binance=bitcoin:1d:usd',
      'ccxt.binance=solana:1d:usd',
      'intraday.archive=ethereum:1m:usd',
      'intraday.archive=solana:1m:usd',
    ]);

    try {
      await app.ready();

      for (const { provider, example, fixture } of fixtureBackedExamples) {
        const [target] = parseMarketChartTargetConfig(example.target);
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
        const fetcher = createHttpMarketChartFetcher('https://charts.example', fetchImpl as unknown as typeof fetch);

        const result = await syncMarketCharts(app.db, {
          targets: [target!],
          fetcher,
          now: new Date(fixture.captured_at ?? '2026-05-05T02:30:00.000Z'),
        });

        expect(fetchImpl).toHaveBeenCalledWith(
          `https://charts.example${example.path}`,
          expect.objectContaining({
            headers: { accept: 'application/json' },
          }),
        );
        expect(result).toMatchObject({
          targets_attempted: 1,
          points_fetched: fixture.points.length,
          points_written: fixture.points.length,
          results: [
            expect.objectContaining({
              provider,
              coin_id: target!.coinId,
              vs_currency: target!.vsCurrency,
              interval: target!.interval,
            }),
          ],
        });

        const rows = app.db.db.select().from(marketChartSourcePoints).all().filter((row) =>
          row.sourceProvider === provider
          && row.coinId === target!.coinId
          && row.vsCurrency === target!.vsCurrency
          && row.interval === target!.interval);

        expect(rows).toHaveLength(fixture.points.length);
        expect(rows.every((row) => row.sourceKind === 'live')).toBe(true);

        const firstPoint = fixture.points[0]!;
        const timestampSeconds = pointTimestampSeconds(firstPoint);
        const intervalQuery = target!.interval === '1m' ? '&interval=hourly' : '';
        const chartResponse = await app.inject({
          method: 'GET',
          url: `/coins/${target!.coinId}/market_chart/range?vs_currency=${target!.vsCurrency}&from=${timestampSeconds}&to=${timestampSeconds}${intervalQuery}`,
        });
        const ohlcResponse = await app.inject({
          method: 'GET',
          url: `/coins/${target!.coinId}/ohlc/range?vs_currency=${target!.vsCurrency}&from=${timestampSeconds}&to=${timestampSeconds}${intervalQuery}`,
        });

        expect(chartResponse.statusCode).toBe(200);
        const expectedMarketCap = pointNumber(firstPoint.market_cap);
        expect(chartResponse.json()).toEqual({
          prices: [[timestampSeconds * 1_000, pointNumber(firstPoint.price)]],
          market_caps: [[timestampSeconds * 1_000, expectedMarketCap ?? expect.any(Number)]],
          total_volumes: [[timestampSeconds * 1_000, pointNumber(firstPoint.total_volume)]],
        });
        if (expectedMarketCap === null) {
          expect(chartResponse.json().market_caps[0][1]).toBeGreaterThan(0);
        }
        expect(ohlcResponse.statusCode).toBe(200);
        expect(ohlcResponse.json()).toEqual([
          [
            timestampSeconds * 1_000,
            pointNumber(firstPoint.open),
            pointNumber(firstPoint.high),
            pointNumber(firstPoint.low),
            pointNumber(firstPoint.close),
          ],
        ]);
      }
    } finally {
      await app.close();
    }
  });

  it('maps the documented intraday preset fixture through 1m source ingestion and diagnostics', async () => {
    const manifest = loadPresetManifest();
    const intradayPreset = manifest.presets.find((preset) => preset.id === 'intraday.archive');
    const intradayExample = intradayPreset?.request_examples.find((example) =>
      example.target === 'intraday.archive=ethereum:1m:usd');
    const [target] = parseMarketChartTargetConfig(intradayExample?.target);
    const adapterFixture = loadRequestExampleFixture(intradayExample!);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(adapterFixture), { status: 200 }));
    const fetcher = createHttpMarketChartFetcher('https://charts.example', fetchImpl as unknown as typeof fetch);
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        marketChartTargets: intradayExample?.target,
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    expect(intradayPreset).toMatchObject({
      provider: 'intraday.archive',
    });
    expect(target).toEqual({
      provider: 'intraday.archive',
      coinId: 'ethereum',
      vsCurrency: 'usd',
      interval: '1m',
    });

    try {
      await app.ready();

      const result = await syncMarketCharts(app.db, {
        targets: [target!],
        fetcher,
        now: new Date('2026-05-05T02:00:00.000Z'),
      });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://charts.example/providers/intraday.archive/coins/ethereum/market_chart?vs_currency=usd&interval=1m',
        expect.objectContaining({
          headers: { accept: 'application/json' },
        }),
      );
      expect(result).toMatchObject({
        targets_attempted: 1,
        points_fetched: 3,
        points_written: 3,
        results: [
          expect.objectContaining({
            provider: 'intraday.archive',
            coin_id: 'ethereum',
            interval: '1m',
          }),
        ],
      });
      expect(app.db.db.select().from(marketChartSourcePoints)
        .where(eq(marketChartSourcePoints.sourceProvider, 'intraday.archive'))
        .all()).toEqual([
        expect.objectContaining({
          coinId: 'ethereum',
          interval: '1m',
          price: 2850.1,
          sourceKind: 'live',
        }),
        expect.objectContaining({
          price: 2851.25,
          sourceKind: 'live',
        }),
        expect.objectContaining({
          price: 2895.4,
          sourceKind: 'live',
        }),
      ]);

      const chartResponse = await app.inject({
        method: 'GET',
        url: '/coins/ethereum/market_chart/range?vs_currency=usd&from=1774051200&to=1774137600&interval=hourly',
      });
      const ohlcResponse = await app.inject({
        method: 'GET',
        url: '/coins/ethereum/ohlc/range?vs_currency=usd&from=1774051200&to=1774137600&interval=hourly',
      });
      const diagnostics = buildMarketChartProviderDiagnostics(
        app.db,
        intradayExample!.target,
        new Date('2026-05-05T02:10:00.000Z'),
      );

      expect(chartResponse.statusCode).toBe(200);
      expect(chartResponse.json()).toEqual({
        prices: [
          [1774051200 * 1_000, 2850.1],
          [1774137600 * 1_000, 2895.4],
        ],
        market_caps: [
          [1774051200 * 1_000, 343000000000],
          [1774137600 * 1_000, 348000000000],
        ],
        total_volumes: [
          [1774051200 * 1_000, 18000000000],
          [1774137600 * 1_000, 19100000000],
        ],
      });
      expect(ohlcResponse.statusCode).toBe(200);
      expect(ohlcResponse.json()).toEqual([
        [1774051200 * 1_000, 2848.5, 2852, 2847.75, 2850.1],
        [1774137600 * 1_000, 2888, 2898, 2880, 2895.4],
      ]);
      expect(diagnostics.coins).toEqual(expect.arrayContaining([
        expect.objectContaining({
          coin_id: 'ethereum',
          interval: '1m',
          status: 'live_backed',
          coverage: expect.objectContaining({
            freshness_threshold_seconds: 1800,
            freshness: 'fresh',
            source_coverage_days: 1.000694,
            depth_threshold_days: 1,
            depth: 'deep',
          }),
        }),
      ]));
      expect(diagnostics.gaps.stale_source_targets).toEqual([]);
      expect(diagnostics.gaps.shallow_source_targets).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('reports unsupported coverage-plan market chart intervals without fetching them', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const fetcher = vi.fn(async () => {
        throw new Error('unsupported interval should not be fetched');
      });
      const result = await syncMarketChartsFromCoveragePlan(app.db, {
        now: new Date('2026-05-05T03:30:00.000Z'),
        coverageTargets: [
          {
            family: 'market_charts',
            provider: 'intraday.archive',
            entityType: 'coin',
            entityId: 'ethereum',
            interval: '1h',
            vsCurrency: 'usd',
            tier: 'A',
            targetHistoryDays: 30,
            freshnessSloSeconds: 3_600,
            productionFreshnessSloSeconds: 900,
            enabled: true,
            priority: 2,
          },
        ],
        fetcher,
      });

      expect(fetcher).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        tasks_planned: 1,
        targets_attempted: 1,
        targets_failed: 0,
        points_fetched: 0,
        points_written: 0,
        results: [
          expect.objectContaining({
            provider: 'intraday.archive',
            coin_id: 'ethereum',
            vs_currency: 'usd',
            interval: '1h',
            reason: 'missing',
            status: 'unsupported_interval',
            points_fetched: 0,
            points_written: 0,
            error: 'market chart coverage sync does not support interval 1h',
          }),
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('derives provider sync work from coverage backfill planner tasks', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const now = new Date('2026-05-05T03:00:00.000Z');
      const fetchedWindows: Array<{ from: string; to: string; reason: string }> = [];
      const result = await syncMarketChartsFromCoveragePlan(app.db, {
        now,
        coverageTargets: [
          {
            family: 'market_charts',
            provider: 'mock.chart',
            entityType: 'coin',
            entityId: 'bitcoin',
            interval: '1d',
            vsCurrency: 'usd',
            tier: 'S',
            targetHistoryDays: 365,
            freshnessSloSeconds: 86_400,
            productionFreshnessSloSeconds: 3_600,
            enabled: true,
            priority: 1,
          },
        ],
        fetcher: async (task) => {
          fetchedWindows.push({
            from: task.from.toISOString(),
            to: task.to.toISOString(),
            reason: task.reason,
          });

          return {
            provider: task.provider,
            captured_at: now.toISOString(),
            coin_id: task.coinId,
            vs_currency: task.vsCurrency,
            interval: '1d',
            points: [
              {
                timestamp: Math.floor(task.from.getTime() / 1000),
                price: 90_000,
                open: 89_500,
                high: 90_500,
                low: 89_000,
                close: 90_000,
              },
              {
                timestamp: Math.floor(task.to.getTime() / 1000),
                price: 91_000,
                open: 90_000,
                high: 91_500,
                low: 89_900,
                close: 91_000,
              },
            ],
          };
        },
      });

      const sourceRows = app.db.db
        .select()
        .from(marketChartSourcePoints)
        .where(eq(marketChartSourcePoints.coinId, 'bitcoin'))
        .all();

      expect(result).toMatchObject({
        tasks_planned: 1,
        targets_attempted: 1,
        targets_failed: 0,
        points_fetched: 2,
        points_written: 2,
        results: [
          expect.objectContaining({
            coin_id: 'bitcoin',
            reason: 'missing',
            status: 'synced',
          }),
        ],
      });
      expect(fetchedWindows).toEqual([
        {
          from: '2026-04-05T03:00:00.000Z',
          to: '2026-05-05T03:00:00.000Z',
          reason: 'missing',
        },
      ]);
      expect(sourceRows).toHaveLength(2);
      expect(sourceRows.every((row) => row.sourceKind === 'live' && row.sourceProvider === 'mock.chart')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
