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
          [1774051200 * 1_000, null],
          [1774137600 * 1_000, null],
        ],
        total_volumes: [
          [1774051200 * 1_000, 34500000000],
          [1774137600 * 1_000, 35200000000],
        ],
      });
      expect(ohlcResponse.statusCode).toBe(200);
      expect(ohlcResponse.json()).toEqual([
        [1774051200 * 1_000, 86000, 87500, 85800, 87000.5],
        [1774137600 * 1_000, 87000.5, 88900, 86650, 88200.75],
      ]);
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
});
