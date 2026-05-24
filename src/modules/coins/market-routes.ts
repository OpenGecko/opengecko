import { sendCacheableJson } from '../../http/cache';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt, parsePrecision } from '../../http/params';
import { getConversionRate } from '../../lib/conversion';
import { getSnapshotOwnership } from '../../services/market-snapshots';
import { getMarketRows } from '../catalog';
import { getSnapshotAccessPolicy, getUsableSnapshot } from '../market-freshness';
import {
  buildMarketRow,
  buildMoverRow,
  cloneCoinMarketsResponse,
  COINS_MARKETS_CACHE_TTL_MS,
  createCoinMarketsCacheKey,
  getSeriesChangePercentageForWindow,
  parseMarketRowsRequest,
} from './market-data';
import { COIN_AUXILIARY_HTTP_CACHE_POLICY, COINS_MARKETS_HTTP_CACHE_POLICY } from './http-policies';
import {
  parseMoverDuration,
  parseMoverPriceChangePercentage,
  parseTopCoinsLimit,
} from './helpers';
import { coinMarketsQuerySchema, topGainersLosersQuerySchema } from './query-schemas';
import type { CoinsRouteContext } from './route-context';

function buildMoverMeta(options: {
  rankedUniverse: Array<{ snapshot: ReturnType<typeof getUsableSnapshot> }>;
  durationDays: number;
  requestedWindows: string[];
  topCoinsLimit: number;
  moverCount: number;
}) {
  const snapshots = options.rankedUniverse
    .map((entry) => entry.snapshot)
    .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
  const liveSnapshotCount = snapshots.filter((snapshot) => getSnapshotOwnership(snapshot) === 'live').length;
  const fallbackSnapshotCount = options.rankedUniverse.length - liveSnapshotCount;
  const missingSnapshotCount = options.rankedUniverse.length - snapshots.length;
  const updatedAt = snapshots.reduce<Date | null>((latest, snapshot) =>
    latest === null || snapshot.lastUpdated.getTime() > latest.getTime() ? snapshot.lastUpdated : latest, null);
  const snapshotSource = options.rankedUniverse.length === 0
    ? 'empty'
    : liveSnapshotCount === options.rankedUniverse.length
      ? 'live'
      : liveSnapshotCount > 0
        ? 'mixed'
        : 'fixture';
  const fixture = snapshotSource !== 'live';

  return {
    fixture,
    source: 'market_snapshots',
    snapshot_source: snapshotSource,
    fallback: fixture,
    live_snapshot_count: liveSnapshotCount,
    fallback_snapshot_count: fallbackSnapshotCount,
    missing_snapshot_count: missingSnapshotCount,
    candidate_count: options.rankedUniverse.length,
    mover_count: options.moverCount,
    top_coins: options.topCoinsLimit,
    duration: options.durationDays === 1 ? '24h' : `${options.durationDays}d`,
    price_change_percentage: options.requestedWindows,
    updated_at: updatedAt?.toISOString() ?? null,
    note: fixture
      ? 'Top gainers/losers are computed from current market snapshots with fixture or fallback snapshot rows explicitly marked.'
      : 'Top gainers/losers are computed from current live market snapshots.',
  };
}

export function registerCoinMarketRoutes({
  app,
  database,
  marketFreshnessThresholdSeconds,
  runtimeState,
  coinMarketsCache,
}: CoinsRouteContext) {
  app.get('/coins/markets', async (request, reply) => {
    const query = coinMarketsQuerySchema.parse(request.query);
    const cacheAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    const cacheKey = JSON.stringify({
      query: createCoinMarketsCacheKey(query),
      accessPolicy: cacheAccessPolicy,
      validationOverride: runtimeState.validationOverride,
    });
    const cached = coinMarketsCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.revision === runtimeState.hotDataRevision && cached.expiresAt > now) {
      app.metrics.recordCacheHit('coins_markets');
      return sendCacheableJson(
        request,
        reply,
        cloneCoinMarketsResponse(cached.value),
        COINS_MARKETS_HTTP_CACHE_POLICY,
      );
    }

    app.metrics.recordCacheMiss('coins_markets');

    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const precision = parsePrecision(query.precision);
    const sparkline = parseBooleanQuery(query.sparkline, false);
    const vsCurrency = query.vs_currency.toLowerCase();
    const priceChangePercentages = parseCsvQuery(query.price_change_percentage).map((value) => value.toLowerCase());
    const { snapshotAccessPolicy, rows } = parseMarketRowsRequest(database, runtimeState, marketFreshnessThresholdSeconds, query);
    const shouldBypassPageSliceForExplicitSelector = [
      query.ids,
      query.names,
      query.symbols,
    ].some((value) => parseCsvQuery(value).length > 0);
    const start = (page - 1) * perPage;

    const pagedRows = shouldBypassPageSliceForExplicitSelector
      ? rows
      : rows.slice(start, start + perPage);

    const payload = pagedRows.map((row) => buildMarketRow(database, row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, runtimeState, {
      sparkline,
      precision,
      priceChangePercentages,
    }));

    coinMarketsCache.set(cacheKey, {
      value: cloneCoinMarketsResponse(payload),
      expiresAt: now + COINS_MARKETS_CACHE_TTL_MS,
      revision: runtimeState.hotDataRevision,
    });

    return sendCacheableJson(request, reply, payload, COINS_MARKETS_HTTP_CACHE_POLICY);
  });

  app.get('/coins/top_gainers_losers', async (request, reply) => {
    const query = topGainersLosersQuerySchema.parse(request.query);
    const vsCurrency = query.vs_currency.toLowerCase();
    const duration = parseMoverDuration(query.duration);
    const requestedWindows = Array.from(new Set([...parseMoverPriceChangePercentage(query.price_change_percentage), duration.days === 1 ? '24h' : `${duration.days}d`]));
    const topCoinsLimit = parseTopCoinsLimit(query.top_coins);
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
    const rankedUniverse = getMarketRows(database, 'usd', { status: 'active' })
      .map((row) => ({
        coin: row.coin,
        snapshot: getUsableSnapshot(row.snapshot, marketFreshnessThresholdSeconds, snapshotAccessPolicy),
      }))
      .sort((left, right) => {
        const leftRank = left.snapshot?.marketCapRank ?? left.coin.marketCapRank ?? Number.MAX_SAFE_INTEGER;
        const rightRank = right.snapshot?.marketCapRank ?? right.coin.marketCapRank ?? Number.MAX_SAFE_INTEGER;

        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }

        return left.coin.id.localeCompare(right.coin.id);
      })
      .slice(0, Math.min(topCoinsLimit, 250));

    const movers = rankedUniverse
      .map((row) => ({
        row,
        change: getSeriesChangePercentageForWindow(
          database,
          row.coin.id,
          vsCurrency,
          marketFreshnessThresholdSeconds,
          snapshotAccessPolicy,
          duration.days,
        ),
      }))
      .filter((entry) => entry.change !== null);

    const topGainers = movers
      .filter((entry) => (entry.change ?? 0) > 0)
      .sort((left, right) => (right.change ?? Number.NEGATIVE_INFINITY) - (left.change ?? Number.NEGATIVE_INFINITY))
      .slice(0, 30)
      .map((entry) => buildMoverRow(database, entry.row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, runtimeState, duration.days, requestedWindows));

    const topLosers = movers
      .filter((entry) => (entry.change ?? 0) < 0)
      .sort((left, right) => (left.change ?? Number.POSITIVE_INFINITY) - (right.change ?? Number.POSITIVE_INFINITY))
      .slice(0, 30)
      .map((entry) => buildMoverRow(database, entry.row, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy, runtimeState, duration.days, requestedWindows));

    return sendCacheableJson(request, reply, {
      top_gainers: topGainers,
      top_losers: topLosers,
      meta: buildMoverMeta({
        rankedUniverse,
        durationDays: duration.days,
        requestedWindows,
        topCoinsLimit,
        moverCount: topGainers.length + topLosers.length,
      }),
    }, COIN_AUXILIARY_HTTP_CACHE_POLICY);
  });
}
