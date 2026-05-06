import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import {
  createHttpMarketChartFetcher,
  parseMarketChartTargetConfig,
  syncMarketCharts,
} from '../src/services/market-chart-sync';

type MarketChartTargetManifest = {
  env: {
    MARKET_CHART_TARGETS: string;
  };
  targets: Array<{
    provider: string;
    coin_id: string;
    interval: '1d' | '1m';
    vs_currency: string;
  }>;
};

type MarketChartProviderPresetManifest = {
  adapter_contract: {
    base_url_env: string;
    target_env: string;
    request_path_template: string;
  };
  presets: Array<{
    id: string;
    provider: string;
    market_chart_targets: string;
    request_examples: Array<{
      target: string;
      path: string;
    }>;
  }>;
};

function loadManifest() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'docs/reference/market-chart-targets.json'),
    'utf8',
  )) as MarketChartTargetManifest;
}

function loadProviderPresetManifest() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'docs/reference/market-chart-provider-presets.json'),
    'utf8',
  )) as MarketChartProviderPresetManifest;
}

describe('market chart target manifest', () => {
  it('keeps the documented MARKET_CHART_TARGETS string parseable and aligned with target rows', () => {
    const manifest = loadManifest();
    const parsedTargets = parseMarketChartTargetConfig(manifest.env.MARKET_CHART_TARGETS);
    const seededChartCoinIds = [
      'bitcoin',
      'ethereum',
      'ripple',
      'solana',
      'dogecoin',
      'usd-coin',
      'cardano',
      'chainlink',
    ];

    expect(parsedTargets).toEqual(manifest.targets.map((target) => ({
      provider: target.provider,
      coinId: target.coin_id,
      interval: target.interval,
      vsCurrency: target.vs_currency,
    })));
    expect(new Set(parsedTargets.map((target) =>
      `${target.provider}:${target.coinId}:${target.interval}:${target.vsCurrency}`)).size).toBe(parsedTargets.length);
    expect(parsedTargets.filter((target) => target.interval === '1d').map((target) => target.coinId).sort())
      .toEqual([...seededChartCoinIds].sort());
    expect(parsedTargets.filter((target) => target.interval === '1m').map((target) => target.coinId).sort())
      .toEqual(['bitcoin', 'ethereum', 'solana']);
  });

  it('keeps provider preset examples parseable and aligned with the HTTP adapter URL contract', async () => {
    const manifest = loadProviderPresetManifest();

    expect(manifest.adapter_contract).toMatchObject({
      base_url_env: 'MARKET_CHART_BASE_URL',
      target_env: 'MARKET_CHART_TARGETS',
      request_path_template: '/providers/{provider}/coins/{coin_id}/market_chart?vs_currency={vs_currency}&interval={interval}',
    });

    for (const preset of manifest.presets) {
      const parsedPresetTargets = parseMarketChartTargetConfig(preset.market_chart_targets);
      expect(parsedPresetTargets.length).toBeGreaterThan(0);
      expect(parsedPresetTargets.every((target) => target.provider === preset.provider)).toBe(true);

      for (const example of preset.request_examples) {
        const [target] = parseMarketChartTargetConfig(example.target);
        expect(target).toBeDefined();
        expect(parsedPresetTargets).toEqual(expect.arrayContaining([target]));

        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
          captured_at: '2026-05-06T00:00:00.000Z',
          points: [{
            timestamp: '1778025600',
            price: '90000',
          }],
        }), { status: 200 }));
        const fetcher = createHttpMarketChartFetcher('https://charts.example/', fetchImpl as unknown as typeof fetch);
        await fetcher(target!);

        expect(fetchImpl).toHaveBeenCalledWith(
          `https://charts.example${example.path}`,
          expect.objectContaining({
            headers: { accept: 'application/json' },
          }),
        );
      }
    }
  });

  it('surfaces documented targets as configured-pending diagnostics before source ingestion', async () => {
    const manifest = loadManifest();
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        marketChartTargets: manifest.env.MARKET_CHART_TARGETS,
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/diagnostics/market_charts',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: {
          configured_targets: unknown[];
          coins: Array<{
            coin_id: string;
            vs_currency: string;
            interval: string;
            status: string;
            configured_provider: string | null;
          }>;
          gaps: {
            configured_without_source_rows: string[];
          };
        };
      };

      expect(body.data.configured_targets).toHaveLength(manifest.targets.length);

      for (const target of manifest.targets) {
        const key = `${target.coin_id}:${target.vs_currency}:${target.interval}`;
        expect(body.data.coins).toEqual(expect.arrayContaining([
          expect.objectContaining({
            coin_id: target.coin_id,
            vs_currency: target.vs_currency,
            interval: target.interval,
            status: 'configured_pending',
            configured_provider: target.provider,
          }),
        ]));
        expect(body.data.gaps.configured_without_source_rows).toContain(key);
      }
    } finally {
      await app.close();
    }
  });

  it('flows provider preset IDs through market chart diagnostics before and after source ingestion', async () => {
    const presetManifest = loadProviderPresetManifest();
    const [preset] = presetManifest.presets;
    const [target] = parseMarketChartTargetConfig(preset!.request_examples[0]!.target);
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        marketChartTargets: preset!.request_examples[0]!.target,
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const pendingResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/market_charts',
      });

      expect(pendingResponse.statusCode).toBe(200);
      expect(pendingResponse.json().data).toMatchObject({
        configured_targets: [
          expect.objectContaining({
            provider: target!.provider,
            coin_id: target!.coinId,
            interval: target!.interval,
            source_provider: target!.provider,
          }),
        ],
        coins: expect.arrayContaining([
          expect.objectContaining({
            coin_id: target!.coinId,
            interval: target!.interval,
            status: 'configured_pending',
            configured_provider: target!.provider,
            latest_source_fetched_at: null,
          }),
        ]),
      });

      await syncMarketCharts(app.db, {
        targets: [target!],
        now: new Date('2026-05-06T00:15:00.000Z'),
        fetcher: async () => ({
          provider: target!.provider,
          captured_at: '2026-05-06T00:15:00.000Z',
          coin_id: target!.coinId,
          vs_currency: target!.vsCurrency,
          interval: target!.interval,
          points: [{
            timestamp: 1778025600,
            price: 90000,
            market_cap: 1800000000000,
            total_volume: 42000000000,
            open: 89500,
            high: 90500,
            low: 89000,
            close: 90000,
          }],
        }),
      });

      const liveResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/market_charts',
      });

      expect(liveResponse.statusCode).toBe(200);
      expect(liveResponse.json().data.coins).toEqual(expect.arrayContaining([
        expect.objectContaining({
          coin_id: target!.coinId,
          interval: target!.interval,
          status: 'live_backed',
          configured_provider: target!.provider,
          source_providers: [target!.provider],
          row_counts: {
            total: 1,
            live: 1,
            replay: 0,
          },
          latest_source_fetched_at: '2026-05-06T00:15:00.000Z',
        }),
      ]));
    } finally {
      await app.close();
    }
  });
});
