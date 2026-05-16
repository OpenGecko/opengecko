import { getEndpointFreshnessBudget } from '../services/freshness-budgets';
import { COINS_MARKETS_CACHE_TTL_MS } from './coins/market-data';

export type RouteHttpCachePolicy = {
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds: number;
};

export type RouteCachePolicyMetadata = {
  ttlMs: number;
  ttlSeconds: number;
  httpCache: RouteHttpCachePolicy;
};

export const SIMPLE_PRICE_CACHE_TTL_MS = 5_000;

function secondsFromMs(milliseconds: number) {
  return milliseconds / 1_000;
}

function buildRouteCachePolicyMetadata(options: {
  ttlMs: number;
  freshnessBudgetId: string;
}) {
  const ttlSeconds = secondsFromMs(options.ttlMs);
  const freshnessBudget = getEndpointFreshnessBudget(options.freshnessBudgetId);
  const httpCacheSeconds = Math.min(
    ttlSeconds,
    freshnessBudget?.target_freshness_seconds ?? ttlSeconds,
  );

  return {
    ttlMs: options.ttlMs,
    ttlSeconds,
    httpCache: {
      maxAgeSeconds: httpCacheSeconds,
      staleWhileRevalidateSeconds: httpCacheSeconds,
    },
  } satisfies RouteCachePolicyMetadata;
}

export const COINS_MARKETS_ROUTE_CACHE_POLICY = buildRouteCachePolicyMetadata({
  ttlMs: COINS_MARKETS_CACHE_TTL_MS,
  freshnessBudgetId: 'coins_markets',
});

export const SIMPLE_PRICE_ROUTE_CACHE_POLICY = buildRouteCachePolicyMetadata({
  ttlMs: SIMPLE_PRICE_CACHE_TTL_MS,
  freshnessBudgetId: 'simple',
});
