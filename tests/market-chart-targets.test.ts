import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { parseMarketChartTargetConfig } from '../src/services/market-chart-sync';

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

function loadManifest() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'docs/reference/market-chart-targets.json'),
    'utf8',
  )) as MarketChartTargetManifest;
}

describe('market chart target manifest', () => {
  it('keeps the documented MARKET_CHART_TARGETS string parseable and aligned with target rows', () => {
    const manifest = loadManifest();
    const parsedTargets = parseMarketChartTargetConfig(manifest.env.MARKET_CHART_TARGETS);

    expect(parsedTargets).toEqual(manifest.targets.map((target) => ({
      provider: target.provider,
      coinId: target.coin_id,
      interval: target.interval,
      vsCurrency: target.vs_currency,
    })));
    expect(new Set(parsedTargets.map((target) =>
      `${target.provider}:${target.coinId}:${target.interval}:${target.vsCurrency}`)).size).toBe(parsedTargets.length);
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
});
