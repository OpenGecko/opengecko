import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

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
  {
    id: 'coins_markets_bitcoin_usd',
    label: 'Coins markets BTC/USD',
    endpoint: '/coins/markets?vs_currency=usd&ids=bitcoin',
    cacheSurface: 'coins_markets',
  },
];

function normalizePrewarmQueryValue(value: string) {
  return value.trim().toLowerCase();
}

function normalizePrewarmQueryValues(values: string[]) {
  return [...new Set(values.map(normalizePrewarmQueryValue).filter((value) => value.length > 0))].sort();
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
  | { status: 'timeout' };

async function runPrewarmTargetWithinBudget(
  app: FastifyInstance,
  endpoint: string,
  remainingBudgetMs: number,
): Promise<StartupPrewarmOutcome> {
  const result = await raceWithBudget<LightMyRequestResponse>(
    app.inject({
      method: 'GET',
      url: endpoint,
    }),
    remainingBudgetMs,
  );

  if (isBudgetTimeoutResult(result)) {
    return result;
  }

  return isSuccessfulPrewarmResponse(result)
    ? { status: 'completed' }
    : { status: 'failed', statusCode: result.statusCode };
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
    targets,
    completedAt: null,
    totalDurationMs: null,
    targetResults: [],
  };

  for (const target of targets) {
    const elapsedMs = Date.now() - startedAt;
    const remainingBudgetMs = budgetMs - elapsedMs;
    const targetStartedAt = Date.now();
    const outcome = await runPrewarmTargetWithinBudget(app, target.endpoint, remainingBudgetMs);
    const durationMs = Date.now() - targetStartedAt;

    runtimeState.startupPrewarm.targetResults.push({
      ...target,
      status: outcome.status,
      durationMs,
      cacheSurface: target.cacheSurface,
      warmCacheRevision: outcome.status === 'completed' ? runtimeState.hotDataRevision : null,
      firstObservedRequest: null,
    });
    metrics.recordStartupPrewarmTarget(target.id, outcome.status, durationMs);

    if (outcome.status === 'timeout') {
      runtimeState.startupPrewarm.readyWithinBudget = false;
      break;
    }
  }

  runtimeState.startupPrewarm.completedAt = Date.now();
  runtimeState.startupPrewarm.totalDurationMs = runtimeState.startupPrewarm.completedAt - startedAt;
  runtimeState.startupPrewarm.readyWithinBudget = runtimeState.startupPrewarm.totalDurationMs <= budgetMs;
}
