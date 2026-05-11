import type { AppDatabase } from '../db/client';
import {
  ingestSupplyChartReplay,
  type RawSupplyChartReplay,
} from './supply-chart-ingestion';
import { enforceSnapshotRetention } from './snapshot-retention';

const DEFAULT_TIMEOUT_MS = 15_000;

export type SupplyChartSyncTarget = {
  provider: string;
  coinId: string;
};

export type SupplyChartSyncFetcher = (
  target: SupplyChartSyncTarget,
) => Promise<RawSupplyChartReplay | null>;

export type SupplyChartSyncOptions = {
  targets: SupplyChartSyncTarget[];
  fetcher?: SupplyChartSyncFetcher;
  providerBaseUrl?: string;
  now?: Date;
};

export function parseSupplyChartTargetConfig(value: string | undefined): SupplyChartSyncTarget[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [providerPart, coinPart] = entry.includes('=') ? entry.split('=', 2) : ['custom', entry];
      const provider = providerPart?.trim();
      const coinId = coinPart?.trim().toLowerCase();

      if (!provider || !coinId) {
        throw new Error(`Invalid supply chart target config entry: ${entry}`);
      }

      return {
        provider,
        coinId,
      };
    });
}

export function createHttpSupplyChartFetcher(
  providerBaseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): SupplyChartSyncFetcher {
  const baseUrl = providerBaseUrl?.replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('SUPPLY_CHART_BASE_URL is required when using the default supply chart fetcher');
  }

  return async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const url = `${baseUrl}/providers/${encodeURIComponent(target.provider)}/coins/${encodeURIComponent(target.coinId)}/supply_chart`;

    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Supply chart provider request failed with status ${response.status}`);
      }

      const raw = await response.json() as Partial<RawSupplyChartReplay>;

      return {
        provider: raw.provider ?? target.provider,
        captured_at: raw.captured_at ?? new Date().toISOString(),
        coin_id: raw.coin_id ?? target.coinId,
        points: raw.points ?? [],
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function syncSupplyCharts(database: AppDatabase, options: SupplyChartSyncOptions) {
  const sourceFetchedAt = options.now ?? new Date();
  const fetcher = options.fetcher ?? createHttpSupplyChartFetcher(options.providerBaseUrl);
  const results = [];

  for (const target of options.targets) {
    const raw = await fetcher(target);

    if (!raw) {
      results.push({
        provider: target.provider,
        coin_id: target.coinId,
        points_fetched: 0,
        points_written: 0,
      });
      continue;
    }

    const ingestion = ingestSupplyChartReplay(database, raw, {
      sourceKind: 'live',
      sourceProvider: target.provider,
      sourceFetchedAt,
    });

    results.push({
      provider: target.provider,
      coin_id: ingestion.coin_id,
      points_fetched: raw.points?.length ?? 0,
      points_written: ingestion.points_written,
    });
  }

  const pointsWritten = results.reduce((total, result) => total + result.points_written, 0);
  const retention = pointsWritten > 0
    ? enforceSnapshotRetention(database, { now: sourceFetchedAt })
    : null;

  return {
    targets_attempted: options.targets.length,
    points_fetched: results.reduce((total, result) => total + result.points_fetched, 0),
    points_written: pointsWritten,
    rows_pruned: retention?.totalRowsPruned ?? 0,
    source_fetched_at: sourceFetchedAt.toISOString(),
    results,
  };
}
