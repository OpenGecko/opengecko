import { and, eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { marketChartSourcePoints } from '../db/schema';
import {
  ingestMarketChartReplay,
  type MarketChartInterval,
  type RawMarketChartReplay,
} from './market-chart-ingestion';
import type { CoverageTarget } from './coverage-targets';
import { planHistoryBackfillTasks, type HistoryBackfillTask, type ObservedCoverageTargetState } from './history-backfill-planner';
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

export type MarketChartPlannerFetcher = (
  task: HistoryBackfillTask,
) => Promise<RawMarketChartReplay | null>;

export type MarketChartSyncOptions = {
  targets: MarketChartSyncTarget[];
  fetcher?: MarketChartSyncFetcher;
  providerBaseUrl?: string;
  now?: Date;
};

export type MarketChartPlannerSyncOptions = {
  coverageTargets: CoverageTarget[];
  fetcher?: MarketChartPlannerFetcher;
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
  reason?: HistoryBackfillTask['reason'];
  from?: string;
  to?: string;
  error?: string;
};

function isMarketChartInterval(interval: CoverageTarget['interval']): interval is MarketChartInterval {
  return interval === '1d' || interval === '1m';
}

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

function createHttpMarketChartRequest(
  providerBaseUrl: string | undefined,
  input: { provider: string; coinId: string; vsCurrency: string; interval: string; from?: Date; to?: Date },
) {
  const baseUrl = providerBaseUrl?.replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('MARKET_CHART_BASE_URL is required when using the default market chart fetcher');
  }

  const query = new URLSearchParams({
    vs_currency: input.vsCurrency,
    interval: input.interval,
  });

  if (input.from) {
    query.set('from', Math.floor(input.from.getTime() / 1000).toString());
  }

  if (input.to) {
    query.set('to', Math.floor(input.to.getTime() / 1000).toString());
  }

  return `${baseUrl}/providers/${encodeURIComponent(input.provider)}/coins/${encodeURIComponent(input.coinId)}/market_chart?${query.toString()}`;
}

async function fetchMarketChartReplayFromUrl(
  url: string,
  target: { provider: string; coinId: string; vsCurrency: string; interval: MarketChartInterval },
  fetchImpl: typeof fetch,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

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
}

export function createHttpMarketChartFetcher(
  providerBaseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): MarketChartSyncFetcher {
  const baseUrl = providerBaseUrl?.replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('MARKET_CHART_BASE_URL is required when using the default market chart fetcher');
  }

  return async (target) => fetchMarketChartReplayFromUrl(
    createHttpMarketChartRequest(baseUrl, target),
    target,
    fetchImpl,
  );
}

export function createHttpMarketChartPlannerFetcher(
  providerBaseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): MarketChartPlannerFetcher {
  return async (task) => fetchMarketChartReplayFromUrl(
    createHttpMarketChartRequest(providerBaseUrl, {
      provider: task.provider,
      coinId: task.coinId,
      vsCurrency: task.vsCurrency,
      interval: task.interval,
      from: task.from ? new Date(task.from) : undefined,
      to: task.to ? new Date(task.to) : undefined,
    }),
    {
      provider: task.provider,
      coinId: task.coinId,
      vsCurrency: task.vsCurrency,
      interval: isMarketChartInterval(task.interval) ? task.interval : '1m',
    },
    fetchImpl,
  );
}


function buildObservedMarketChartStates(database: AppDatabase, coverageTargets: CoverageTarget[]): ObservedCoverageTargetState[] {
  return coverageTargets
    .filter((target) => target.enabled && target.family === 'market_charts' && isMarketChartInterval(target.interval))
    .map((target) => {
      const rows = database.db
        .select()
        .from(marketChartSourcePoints)
        .where(and(
          eq(marketChartSourcePoints.coinId, target.entityId),
          eq(marketChartSourcePoints.vsCurrency, target.vsCurrency),
          eq(marketChartSourcePoints.interval, target.interval as MarketChartInterval),
          eq(marketChartSourcePoints.sourceKind, 'live'),
          eq(marketChartSourcePoints.sourceProvider, target.provider),
        ))
        .all();

      const timestamps = rows.map((row) => row.timestamp.getTime()).sort((left, right) => left - right);

      return {
        family: target.family,
        provider: target.provider,
        coinId: target.entityId,
        interval: target.interval,
        vsCurrency: target.vsCurrency,
        latestAt: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]!) : null,
        oldestAt: timestamps.length > 0 ? new Date(timestamps[0]!) : null,
        sourceRowCount: rows.length,
      };
    });
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


export async function syncMarketChartsFromCoveragePlan(database: AppDatabase, options: MarketChartPlannerSyncOptions) {
  const sourceFetchedAt = options.now ?? new Date();
  const marketChartTargets = options.coverageTargets.filter(
    (target) => target.enabled && target.family === 'market_charts' && isMarketChartInterval(target.interval),
  );
  const observed = buildObservedMarketChartStates(database, marketChartTargets);
  const tasks = planHistoryBackfillTasks({
    targets: marketChartTargets,
    observed,
    now: sourceFetchedAt,
  }).filter((task) => isMarketChartInterval(task.interval));
  const fetcher = options.fetcher ?? createHttpMarketChartPlannerFetcher(options.providerBaseUrl);
  const results: MarketChartSyncResult[] = [];

  for (const task of tasks) {
    const baseResult = {
      provider: task.provider,
      coin_id: task.coinId,
      vs_currency: task.vsCurrency,
      interval: task.interval as MarketChartInterval,
      reason: task.reason,
      from: task.from.toISOString(),
      to: task.to.toISOString(),
    };

    let raw: RawMarketChartReplay | null;

    try {
      raw = await fetcher(task);
    } catch (error) {
      results.push({
        ...baseResult,
        status: 'failed',
        points_fetched: 0,
        points_written: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!raw) {
      results.push({
        ...baseResult,
        status: 'no_data',
        points_fetched: 0,
        points_written: 0,
      });
      continue;
    }

    const ingestion = ingestMarketChartReplay(database, raw, {
      sourceKind: 'live',
      sourceProvider: task.provider,
      sourceFetchedAt,
    });

    results.push({
      ...baseResult,
      coin_id: ingestion.coin_id,
      vs_currency: ingestion.vs_currency,
      interval: ingestion.interval,
      status: 'synced',
      points_fetched: raw.points?.length ?? 0,
      points_written: ingestion.points_written,
    });
  }

  const failedResults = results.filter((result) => result.status === 'failed');

  if (tasks.length > 0 && failedResults.length === tasks.length) {
    const firstError = failedResults[0]?.error ?? 'provider task failed';
    throw new Error(`Market chart coverage sync failed for all ${tasks.length} task(s): ${firstError}`);
  }

  const pointsWritten = results.reduce((total, result) => total + result.points_written, 0);
  const retention = pointsWritten > 0
    ? enforceSnapshotRetention(database, { now: sourceFetchedAt })
    : null;

  return {
    tasks_planned: tasks.length,
    targets_attempted: tasks.length,
    targets_failed: failedResults.length,
    points_fetched: results.reduce((total, result) => total + result.points_fetched, 0),
    points_written: pointsWritten,
    rows_pruned: retention?.totalRowsPruned ?? 0,
    source_fetched_at: sourceFetchedAt.toISOString(),
    results,
  };
}
