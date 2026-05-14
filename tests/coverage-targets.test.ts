import { describe, expect, it } from 'vitest';

import { parseMarketChartTargetConfig } from '../src/services/market-chart-sync';
import {
  coverageTargetsToMarketChartTargets,
  loadDefaultCoverageTargets,
  parseCoverageTargetManifest,
  type CoverageTargetManifest,
} from '../src/services/coverage-targets';

const baseManifest = {
  version: 1,
  targets: [
    {
      family: 'market_charts',
      provider: 'custom',
      entity_type: 'coin',
      entity_id: 'bitcoin',
      interval: '1d',
      vs_currency: 'usd',
      tier: 'S',
      target_history_days: 3650,
      freshness_slo_seconds: 900,
      production_freshness_slo_seconds: 300,
      enabled: true,
      priority: 10,
    },
    {
      family: 'ohlcv',
      provider: 'binance',
      entity_type: 'coin',
      entity_id: 'ethereum',
      interval: '1h',
      vs_currency: 'usd',
      tier: 'A',
      target_history_days: 730,
      freshness_slo_seconds: 3600,
      production_freshness_slo_seconds: 900,
      enabled: true,
      priority: 20,
    },
    {
      family: 'market_charts',
      provider: 'custom',
      entity_type: 'coin',
      entity_id: 'dogecoin',
      interval: '1m',
      vs_currency: 'usd',
      tier: 'B',
      target_history_days: 30,
      freshness_slo_seconds: 120,
      production_freshness_slo_seconds: 60,
      enabled: false,
      priority: 100,
    },
  ],
} satisfies CoverageTargetManifest;

describe('coverage target manifest', () => {
  it('parses enabled market chart and OHLCV coverage targets with normalized fields', () => {
    const targets = parseCoverageTargetManifest(baseManifest);

    expect(targets).toEqual([
      expect.objectContaining({
        family: 'market_charts',
        provider: 'custom',
        entityType: 'coin',
        entityId: 'bitcoin',
        interval: '1d',
        vsCurrency: 'usd',
        tier: 'S',
        targetHistoryDays: 3650,
        freshnessSloSeconds: 900,
        productionFreshnessSloSeconds: 300,
        enabled: true,
        priority: 10,
      }),
      expect.objectContaining({
        family: 'ohlcv',
        provider: 'binance',
        entityType: 'coin',
        entityId: 'ethereum',
        interval: '1h',
        vsCurrency: 'usd',
        tier: 'A',
        targetHistoryDays: 730,
        freshnessSloSeconds: 3600,
        productionFreshnessSloSeconds: 900,
        enabled: true,
        priority: 20,
      }),
      expect.objectContaining({
        family: 'market_charts',
        entityId: 'dogecoin',
        interval: '1m',
        enabled: false,
      }),
    ]);
  });

  it('rejects duplicate enabled targets by family/provider/entity/interval/vs_currency', () => {
    const manifest: CoverageTargetManifest = {
      ...baseManifest,
      targets: [
        baseManifest.targets[0],
        { ...baseManifest.targets[0], priority: 11 },
      ],
    };

    expect(() => parseCoverageTargetManifest(manifest)).toThrow(
      'Duplicate enabled coverage target: market_charts:custom:coin:bitcoin:1d:usd',
    );
  });

  it('allows disabled duplicate targets so operators can keep staged alternatives', () => {
    const manifest: CoverageTargetManifest = {
      ...baseManifest,
      targets: [
        baseManifest.targets[0],
        { ...baseManifest.targets[0], enabled: false, priority: 11 },
      ],
    };

    expect(parseCoverageTargetManifest(manifest)).toHaveLength(2);
  });

  it('rejects unsupported families, tiers, intervals, and invalid depth/freshness numbers', () => {
    expect(() => parseCoverageTargetManifest({
      version: 1,
      targets: [{ ...baseManifest.targets[0], family: 'simple' }],
    })).toThrow('Unsupported coverage target family: simple');

    expect(() => parseCoverageTargetManifest({
      version: 1,
      targets: [{ ...baseManifest.targets[0], tier: 'P0' }],
    })).toThrow('Unsupported coverage target tier: P0');

    expect(() => parseCoverageTargetManifest({
      version: 1,
      targets: [{ ...baseManifest.targets[0], interval: '5m' }],
    })).toThrow('Unsupported coverage target interval: 5m');

    expect(() => parseCoverageTargetManifest({
      version: 1,
      targets: [{ ...baseManifest.targets[0], target_history_days: 0 }],
    })).toThrow('target_history_days must be a positive integer');

    expect(() => parseCoverageTargetManifest({
      version: 1,
      targets: [{ ...baseManifest.targets[0], freshness_slo_seconds: -1 }],
    })).toThrow('freshness_slo_seconds must be a positive integer');
  });

  it('derives market chart sync targets from enabled market chart coverage targets only', () => {
    const targets = parseCoverageTargetManifest(baseManifest);

    expect(coverageTargetsToMarketChartTargets(targets)).toEqual([
      {
        provider: 'custom',
        coinId: 'bitcoin',
        interval: '1d',
        vsCurrency: 'usd',
      },
    ]);
  });

  it('loads the default coverage manifest and keeps it aligned with the documented MARKET_CHART_TARGETS env string', () => {
    const marketChartManifest = require('../docs/reference/market-chart-targets.json') as {
      env: { MARKET_CHART_TARGETS: string };
    };

    expect(coverageTargetsToMarketChartTargets(loadDefaultCoverageTargets())).toEqual(
      parseMarketChartTargetConfig(marketChartManifest.env.MARKET_CHART_TARGETS),
    );
  });
});
