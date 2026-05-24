import { getEndpointFreshnessBudget } from '../../services/freshness-budgets';
import { COINS_MARKETS_ROUTE_CACHE_POLICY } from '../route-cache-policies';

export const COINS_MARKETS_HTTP_CACHE_POLICY = COINS_MARKETS_ROUTE_CACHE_POLICY.httpCache;

const COIN_DETAIL_FRESHNESS_BUDGET = getEndpointFreshnessBudget('coin_detail');
const COIN_DETAIL_HTTP_CACHE_MAX_AGE_SECONDS = Math.min(
  60,
  COIN_DETAIL_FRESHNESS_BUDGET?.target_freshness_seconds ?? 60,
);

export const COIN_DETAIL_HTTP_CACHE_POLICY = {
  maxAgeSeconds: COIN_DETAIL_HTTP_CACHE_MAX_AGE_SECONDS,
  staleWhileRevalidateSeconds: COIN_DETAIL_HTTP_CACHE_MAX_AGE_SECONDS,
};

export const HISTORICAL_CHART_HTTP_CACHE_POLICY = {
  maxAgeSeconds: 60,
  staleWhileRevalidateSeconds: 60,
};

export const COIN_AUXILIARY_HTTP_CACHE_POLICY = {
  maxAgeSeconds: 60,
  staleWhileRevalidateSeconds: 60,
};
