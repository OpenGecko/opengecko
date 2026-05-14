import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MarketChartInterval } from './market-chart-ingestion';
import type { MarketChartSyncTarget } from './market-chart-sync';

const SUPPORTED_FAMILIES = ['market_charts', 'ohlcv'] as const;
const SUPPORTED_ENTITY_TYPES = ['coin'] as const;
const SUPPORTED_INTERVALS = ['1d', '1h', '1m'] as const;
const SUPPORTED_TIERS = ['S', 'A', 'B', 'long_tail'] as const;

type SupportedFamily = typeof SUPPORTED_FAMILIES[number];
type SupportedEntityType = typeof SUPPORTED_ENTITY_TYPES[number];
type SupportedInterval = typeof SUPPORTED_INTERVALS[number];
type SupportedTier = typeof SUPPORTED_TIERS[number];

export type CoverageTargetManifestRow = {
  family: string;
  provider: string;
  entity_type: string;
  entity_id: string;
  interval: string;
  vs_currency: string;
  tier: string;
  target_history_days: number;
  freshness_slo_seconds: number;
  production_freshness_slo_seconds: number;
  enabled: boolean;
  priority: number;
};

export type CoverageTargetManifest = {
  version: number;
  targets: CoverageTargetManifestRow[];
};

export type CoverageTarget = {
  family: SupportedFamily;
  provider: string;
  entityType: SupportedEntityType;
  entityId: string;
  interval: SupportedInterval;
  vsCurrency: string;
  tier: SupportedTier;
  targetHistoryDays: number;
  freshnessSloSeconds: number;
  productionFreshnessSloSeconds: number;
  enabled: boolean;
  priority: number;
};

function assertSupported<T extends string>(value: string, supported: readonly T[], message: string): asserts value is T {
  if (!supported.includes(value as T)) {
    throw new Error(`${message}: ${value}`);
  }
}

function normalizeRequiredText(value: string, field: string) {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    throw new Error(`${field} is required`);
  }

  return normalized;
}

function assertPositiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

export function parseCoverageTargetManifest(manifest: CoverageTargetManifest): CoverageTarget[] {
  if (manifest.version !== 1) {
    throw new Error(`Unsupported coverage target manifest version: ${manifest.version}`);
  }

  const enabledKeys = new Set<string>();

  return manifest.targets.map((row) => {
    const family = normalizeRequiredText(row.family, 'family');
    const provider = normalizeRequiredText(row.provider, 'provider');
    const entityType = normalizeRequiredText(row.entity_type, 'entity_type');
    const entityId = normalizeRequiredText(row.entity_id, 'entity_id');
    const interval = normalizeRequiredText(row.interval, 'interval');
    const vsCurrency = normalizeRequiredText(row.vs_currency, 'vs_currency');
    const tier = row.tier.trim();

    assertSupported(family, SUPPORTED_FAMILIES, 'Unsupported coverage target family');
    assertSupported(entityType, SUPPORTED_ENTITY_TYPES, 'Unsupported coverage target entity_type');
    assertSupported(interval, SUPPORTED_INTERVALS, 'Unsupported coverage target interval');
    assertSupported(tier, SUPPORTED_TIERS, 'Unsupported coverage target tier');
    assertPositiveInteger(row.target_history_days, 'target_history_days');
    assertPositiveInteger(row.freshness_slo_seconds, 'freshness_slo_seconds');
    assertPositiveInteger(row.production_freshness_slo_seconds, 'production_freshness_slo_seconds');
    assertPositiveInteger(row.priority, 'priority');

    if (row.enabled) {
      const key = [family, provider, entityType, entityId, interval, vsCurrency].join(':');

      if (enabledKeys.has(key)) {
        throw new Error(`Duplicate enabled coverage target: ${key}`);
      }

      enabledKeys.add(key);
    }

    return {
      family,
      provider,
      entityType,
      entityId,
      interval,
      vsCurrency,
      tier,
      targetHistoryDays: row.target_history_days,
      freshnessSloSeconds: row.freshness_slo_seconds,
      productionFreshnessSloSeconds: row.production_freshness_slo_seconds,
      enabled: row.enabled,
      priority: row.priority,
    };
  });
}

export function coverageTargetsToMarketChartTargets(targets: CoverageTarget[]): MarketChartSyncTarget[] {
  return targets
    .filter((target) => target.enabled && target.family === 'market_charts')
    .map((target) => ({
      provider: target.provider,
      coinId: target.entityId,
      interval: target.interval as MarketChartInterval,
      vsCurrency: target.vsCurrency,
    }));
}

export function loadDefaultCoverageTargets(): CoverageTarget[] {
  const manifestPath = join(process.cwd(), 'docs/reference/default-coverage-targets.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CoverageTargetManifest;

  return parseCoverageTargetManifest(manifest);
}
