import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { warmSimplePriceCache } from '../modules/simple';

import type { MetricsRegistry } from './metrics';
import type { MarketDataRuntimeState } from './market-runtime-state';

export type StartupPrewarmTarget = {
  id: string;
  label: string;
  endpoint: string;
  cacheSurface: 'simple_price' | 'coins_markets';
};

export const STARTUP_PREWARM_TARGETS: StartupPrewarmTarget[] = [
  {
    id: 'simple_price_bitcoin_usd',
    label: 'Simple price BTC/USD',
    endpoint: '/simple/price?ids=bitcoin&vs_currencies=usd',
    cacheSurface: 'simple_price',
  },
];

function normalizePrewarmQueryValue(value: string) {
  return value.trim().toLowerCase();
}

function normalizePrewarmQueryValues(values: string[]) {
  return values
    .map(normalizePrewarmQueryValue)
    .filter((value) => value.length > 0)
    .sort();
}

function normalizePrewarmUrl(url: string) {
  const parsed = new URL(url, 'http://opengecko.local');
  const queryMap = new Map<string, string[]>();

  for (const [key, value] of parsed.searchParams.entries()) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValues = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const existing = queryMap.get(normalizedKey) ?? [];
    existing.push(...normalizedValues);
    queryMap.set(normalizedKey, existing);
  }

  return {
    pathname: parsed.pathname,
    query: [...queryMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, normalizePrewarmQueryValues(values)] as const),
  };
}

export function matchStartupPrewarmTarget(targetUrl: string, requestUrl: string) {
  const normalizedTarget = normalizePrewarmUrl(targetUrl);
  const normalizedRequest = normalizePrewarmUrl(requestUrl);

  if (normalizedTarget.pathname !== normalizedRequest.pathname) {
    return false;
  }

  if (normalizedTarget.query.length !== normalizedRequest.query.length) {
    return false;
  }

  return normalizedTarget.query.every(([targetKey, targetValues], index) => {
    const requestEntry = normalizedRequest.query[index];

    if (!requestEntry || requestEntry[0] !== targetKey || requestEntry[1].length !== targetValues.length) {
      return false;
    }

    return targetValues.every((value, valueIndex) => requestEntry[1][valueIndex] === value);
  });
}

async function raceWithBudget<T>(promise: Promise<T>, remainingBudgetMs: number) {
  if (remainingBudgetMs <= 0) {
    return { status: 'timeout' as const };
  }

  return await Promise.race([
    promise,
    new Promise<{ status: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ status: 'timeout' }), remainingBudgetMs);
    }),
  ]);
}

function isBudgetTimeoutResult<T>(result: T | { status: 'timeout' }): result is { status: 'timeout' } {
  return typeof result === 'object' && result !== null && 'status' in result && result.status === 'timeout';
}

function isSuccessfulPrewarmResponse(response: LightMyRequestResponse) {
  return response.statusCode >= 200 && response.statusCode < 300;
}

type StartupPrewarmOutcome =
  | { status: 'completed' }
  | { status: 'failed'; statusCode: number }
  | { status: 'timeout' }
  | { status: 'skipped_budget' };

function parseSimplePricePrewarmQuery(endpoint: string) {
  const parsed = new URL(endpoint, 'http://opengecko.local');
  const booleanQueryValue = (key: string): 'true' | 'false' | undefined => {
    const value = parsed.searchParams.get(key);

    return value === 'true' || value === 'false' ? value : undefined;
  };

  return {
    ids: parsed.searchParams.get('ids') ?? undefined,
    names: parsed.searchParams.get('names') ?? undefined,
    symbols: parsed.searchParams.get('symbols') ?? undefined,
    vs_currencies: parsed.searchParams.get('vs_currencies') ?? '',
    include_market_cap: booleanQueryValue('include_market_cap'),
    include_24hr_vol: booleanQueryValue('include_24hr_vol'),
    include_24hr_change: booleanQueryValue('include_24hr_change'),
    include_last_updated_at: booleanQueryValue('include_last_updated_at'),
    precision: parsed.searchParams.get('precision') ?? undefined,
  };
}

async function runDirectSimplePricePrewarmWithinBudget(
  app: FastifyInstance,
  endpoint: string,
  remainingBudgetMs: number,
): Promise<StartupPrewarmOutcome> {
  if (!('simplePriceCache' in app) || !app.simplePriceCache) {
    return runPrewarmInjectWithinBudget(app, endpoint, remainingBudgetMs);
  }

  const prewarmStartedAt = Date.now();
  const warmPromise = Promise.resolve().then(() => warmSimplePriceCache(
    app.simplePriceCache,
    parseSimplePricePrewarmQuery(endpoint),
    app.db,
    app.marketFreshnessThresholdSeconds,
    app.marketDataRuntimeState,
  ));
  const result = await raceWithBudget(warmPromise, remainingBudgetMs);

  if (isBudgetTimeoutResult(result)) {
    return result;
  }

  const totalDurationMs = Date.now() - prewarmStartedAt;
  if (totalDurationMs >= remainingBudgetMs) {
    return { status: 'timeout' };
  }

  return { status: 'completed' };
}

async function runPrewarmInjectWithinBudget(
  app: FastifyInstance,
  endpoint: string,
  remainingBudgetMs: number,
): Promise<StartupPrewarmOutcome> {
  const prewarmStartedAt = Date.now();
  const injectPromise = app.inject({
    method: 'GET',
    url: endpoint,
  });

  const result = await raceWithBudget<LightMyRequestResponse>(
    injectPromise,
    remainingBudgetMs,
  );

  if (isBudgetTimeoutResult(result)) {
    return result;
  }

  const totalDurationMs = Date.now() - prewarmStartedAt;
  if (totalDurationMs >= remainingBudgetMs) {
    return { status: 'timeout' };
  }

  return isSuccessfulPrewarmResponse(result)
    ? { status: 'completed' }
    : { status: 'failed', statusCode: result.statusCode };
}

async function runPrewarmTargetWithinBudget(
  app: FastifyInstance,
  cacheSurface: StartupPrewarmTarget['cacheSurface'],
  endpoint: string,
  remainingBudgetMs: number,
): Promise<StartupPrewarmOutcome> {
  if (cacheSurface === 'simple_price') {
    return runDirectSimplePricePrewarmWithinBudget(app, endpoint, remainingBudgetMs);
  }

  return runPrewarmInjectWithinBudget(app, endpoint, remainingBudgetMs);
}

function finalizeStartupPrewarm(
  runtimeState: MarketDataRuntimeState,
  startedAt: number,
  budgetMs: number,
) {
  const wallClockCompletedAt = Date.now();
  runtimeState.startupPrewarm.completedAt = Math.min(wallClockCompletedAt, startedAt + budgetMs);
  runtimeState.startupPrewarm.totalDurationMs = runtimeState.startupPrewarm.completedAt - startedAt;
  runtimeState.startupPrewarm.readyWithinBudget = runtimeState.startupPrewarm.totalDurationMs <= budgetMs;
}

function recordSkippedBudgetTarget(
  runtimeState: MarketDataRuntimeState,
  metrics: MetricsRegistry,
  target: StartupPrewarmTarget,
) {
  runtimeState.startupPrewarm.targetResults.push({
    ...target,
    status: 'skipped_budget',
    durationMs: 0,
    cacheSurface: target.cacheSurface,
    warmCacheRevision: null,
    firstObservedRequest: null,
  });
  metrics.recordStartupPrewarmTarget(target.id, 'timeout', 0);
}

export async function runStartupPrewarm(
  app: FastifyInstance,
  runtimeState: MarketDataRuntimeState,
  metrics: MetricsRegistry,
  budgetMs: number,
) {
  const targets = STARTUP_PREWARM_TARGETS.map((target) => ({ ...target }));
  const startedAt = Date.now();

  runtimeState.startupPrewarm = {
    enabled: true,
    budgetMs,
    readyWithinBudget: true,
    firstRequestWarmBenefitsObserved: false,
    firstRequestWarmBenefitPending: false,
    targets,
    completedAt: null,
    totalDurationMs: null,
    targetResults: [],
  };

  for (const target of targets) {
    const elapsedMs = Date.now() - startedAt;
    const remainingBudgetMs = budgetMs - elapsedMs;
    if (remainingBudgetMs <= 0) {
      recordSkippedBudgetTarget(runtimeState, metrics, target);
      continue;
    }

    const targetStartedAt = Date.now();
    const outcome = await runPrewarmTargetWithinBudget(app, target.cacheSurface, target.endpoint, remainingBudgetMs);
    const durationMs = Date.now() - targetStartedAt;
    const completedWithinBudget = durationMs < remainingBudgetMs;
    const status = outcome.status === 'timeout' && completedWithinBudget ? 'skipped_budget' : outcome.status;

    runtimeState.startupPrewarm.targetResults.push({
      ...target,
      status,
      durationMs,
      cacheSurface: target.cacheSurface,
      warmCacheRevision: status === 'completed' ? runtimeState.hotDataRevision : null,
      firstObservedRequest: null,
    });
    if (status === 'completed') {
      runtimeState.startupPrewarm.firstRequestWarmBenefitPending = true;
    }
    metrics.recordStartupPrewarmTarget(target.id, status === 'skipped_budget' ? 'timeout' : status, durationMs);

    if (status === 'timeout') {
      finalizeStartupPrewarm(runtimeState, startedAt, budgetMs);

      const targetIndex = targets.findIndex((candidate) => candidate.id === target.id);
      for (const trailingTarget of targets.slice(targetIndex + 1)) {
        recordSkippedBudgetTarget(runtimeState, metrics, trailingTarget);
      }
      return;
    }
  }

  finalizeStartupPrewarm(runtimeState, startedAt, budgetMs);
}
