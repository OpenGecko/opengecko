import type { AppDatabase } from '../db/client';
import {
  ingestMarketChartReplay,
  type MarketChartInterval,
  type RawMarketChartReplay,
} from './market-chart-ingestion';
import { enforceSnapshotRetention } from './snapshot-retention';

const DEFAULT_TIMEOUT_MS = 15_000;

export type MarketChartSyncTarget = {
  provider: string;
  coinId: string;
  vsCurrency: string;
  interval: MarketChartInterval;
};

export type MarketChartSyncFetcher = (
  target: MarketChartSyncTarget,
) => Promise<RawMarketChartReplay | null>;

export type MarketChartSyncOptions = {
  targets: MarketChartSyncTarget[];
  fetcher?: MarketChartSyncFetcher;
  providerBaseUrl?: string;
  now?: Date;
};

type MarketChartSyncResult = {
  provider: string;
  coin_id: string;
  vs_currency: string;
  interval: MarketChartInterval;
  status: 'synced' | 'no_data' | 'failed';
  points_fetched: number;
  points_written: number;
  error?: string;
};

function parseSelector(selector: string, entry: string) {
  const [coinPart, intervalPart = '1d', vsCurrencyPart = 'usd'] = selector.split(':', 3);
  const coinId = coinPart?.trim().toLowerCase();
  const interval = intervalPart.trim();
  const vsCurrency = vsCurrencyPart.trim().toLowerCase();

  if (!coinId || (interval !== '1d' && interval !== '1m') || !vsCurrency) {
    throw new Error(`Invalid market chart target config entry: ${entry}`);
  }

  return {
    coinId,
    interval: interval as MarketChartInterval,
    vsCurrency,
  };
}

export function parseMarketChartTargetConfig(value: string | undefined): MarketChartSyncTarget[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [providerPart, selectorPart] = entry.includes('=') ? entry.split('=', 2) : ['custom', entry];
      const provider = providerPart?.trim();
      const selector = selectorPart?.trim();

      if (!provider || !selector) {
        throw new Error(`Invalid market chart target config entry: ${entry}`);
      }

      return {
        provider,
        ...parseSelector(selector, entry),
      };
    });
}

export function createHttpMarketChartFetcher(
  providerBaseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): MarketChartSyncFetcher {
  const baseUrl = providerBaseUrl?.replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('MARKET_CHART_BASE_URL is required when using the default market chart fetcher');
  }

  return async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const query = new URLSearchParams({
      vs_currency: target.vsCurrency,
      interval: target.interval,
    });
    const url = `${baseUrl}/providers/${encodeURIComponent(target.provider)}/coins/${encodeURIComponent(target.coinId)}/market_chart?${query.toString()}`;

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
        throw new Error(`Market chart provider request failed with status ${response.status}`);
      }

      const raw = await response.json() as Partial<RawMarketChartReplay>;

      if (!raw.points || raw.points.length === 0) {
        return null;
      }

      return {
        provider: raw.provider ?? target.provider,
        captured_at: raw.captured_at ?? new Date().toISOString(),
        coin_id: raw.coin_id ?? target.coinId,
        vs_currency: raw.vs_currency ?? target.vsCurrency,
        interval: raw.interval ?? target.interval,
        points: raw.points,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function syncMarketCharts(database: AppDatabase, options: MarketChartSyncOptions) {
  const sourceFetchedAt = options.now ?? new Date();
  const fetcher = options.fetcher ?? createHttpMarketChartFetcher(options.providerBaseUrl);
  const results: MarketChartSyncResult[] = [];

  for (const target of options.targets) {
    let raw: RawMarketChartReplay | null;

    try {
      raw = await fetcher(target);
    } catch (error) {
      results.push({
        provider: target.provider,
        coin_id: target.coinId,
        vs_currency: target.vsCurrency,
        interval: target.interval,
        status: 'failed',
        points_fetched: 0,
        points_written: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!raw) {
      results.push({
        provider: target.provider,
        coin_id: target.coinId,
        vs_currency: target.vsCurrency,
        interval: target.interval,
        status: 'no_data',
        points_fetched: 0,
        points_written: 0,
      });
      continue;
    }

    const ingestion = ingestMarketChartReplay(database, raw, {
      sourceKind: 'live',
      sourceProvider: target.provider,
      sourceFetchedAt,
    });

    results.push({
      provider: target.provider,
      coin_id: ingestion.coin_id,
      vs_currency: ingestion.vs_currency,
      interval: ingestion.interval,
      status: 'synced',
      points_fetched: raw.points?.length ?? 0,
      points_written: ingestion.points_written,
    });
  }

  const failedResults = results.filter((result) => result.status === 'failed');

  if (options.targets.length > 0 && failedResults.length === options.targets.length) {
    const firstError = failedResults[0]?.error ?? 'provider target failed';
    throw new Error(`Market chart sync failed for all ${options.targets.length} target(s): ${firstError}`);
  }

  const pointsWritten = results.reduce((total, result) => total + result.points_written, 0);
  const retention = pointsWritten > 0
    ? enforceSnapshotRetention(database, { now: sourceFetchedAt })
    : null;

  return {
    targets_attempted: options.targets.length,
    targets_failed: failedResults.length,
    points_fetched: results.reduce((total, result) => total + result.points_fetched, 0),
    points_written: pointsWritten,
    rows_pruned: retention?.totalRowsPruned ?? 0,
    source_fetched_at: sourceFetchedAt.toISOString(),
    results,
  };
}
