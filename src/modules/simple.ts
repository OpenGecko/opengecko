import type { FastifyInstance } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { supplyChartPoints, type MarketSnapshotRow } from '../db/schema';
import { sendCacheableJson } from '../http/cache';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePrecision } from '../http/params';
import { buildExchangeRatesPayload, getConversionRate } from '../lib/conversion';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import { createResponseCache, type ResponseCache } from '../services/response-cache';
import { getSupportedVsCurrencies } from '../services/currency-rates';
import { getCoinByContract, getMarketRows, resolveCoinPlatformContract } from './catalog';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, type SnapshotAccessPolicy, getUsableSnapshot } from './market-freshness';
import {
  SIMPLE_PRICE_CACHE_TTL_MS,
  SIMPLE_PRICE_ROUTE_CACHE_POLICY,
} from './route-cache-policies';

export type SimplePriceResponse = Record<string, Record<string, number | null>>;
export type SimplePriceCache = ResponseCache<SimplePriceResponse>;

export type SimplePriceAvailabilityFailure = {
  statusCode: number;
  error: string;
  message: string;
};

export type SimplePriceRequestQuery = z.infer<typeof simplePriceQuerySchema>;
export type WarmSimplePriceCacheOptions = {
  app?: Pick<FastifyInstance, 'metrics'>;
};

const SIMPLE_PRICE_CACHE_MAX_ENTRIES = 1_000;
const SIMPLE_HTTP_CACHE_POLICY = SIMPLE_PRICE_ROUTE_CACHE_POLICY.httpCache;

const simplePriceQuerySchema = z.object({
  ids: z.string().optional(),
  names: z.string().optional(),
  symbols: z.string().optional(),
  vs_currencies: z.string(),
  include_market_cap: z.enum(['true', 'false']).optional(),
  include_24hr_vol: z.enum(['true', 'false']).optional(),
  include_24hr_change: z.enum(['true', 'false']).optional(),
  include_last_updated_at: z.enum(['true', 'false']).optional(),
  precision: z.string().optional(),
});

const simpleTokenPriceQuerySchema = z.object({
  contract_addresses: z.string(),
  vs_currencies: z.string(),
  include_market_cap: z.enum(['true', 'false']).optional(),
  include_24hr_vol: z.enum(['true', 'false']).optional(),
  include_24hr_change: z.enum(['true', 'false']).optional(),
  include_last_updated_at: z.enum(['true', 'false']).optional(),
  precision: z.string().optional(),
});

function toPreciseNumber(value: number | null | undefined, precision: number | 'full') {
  if (value === null || value === undefined) {
    return null;
  }

  if (precision === 'full') {
    return value;
  }

  return +value.toFixed(precision);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getLatestCirculatingSupply(database: AppDatabase, coinId: string) {
  return database.db
    .select()
    .from(supplyChartPoints)
    .where(and(
      eq(supplyChartPoints.coinId, coinId),
      eq(supplyChartPoints.supplyType, 'circulating'),
      gt(supplyChartPoints.value, 0),
    ))
    .all()
    .filter((row) => Number.isFinite(row.value))
    .sort((left, right) => {
      const sourceRankDiff = (right.sourceKind === 'live' ? 1 : 0) - (left.sourceKind === 'live' ? 1 : 0);
      if (sourceRankDiff !== 0) {
        return sourceRankDiff;
      }

      const timestampDiff = right.timestamp.getTime() - left.timestamp.getTime();
      if (timestampDiff !== 0) {
        return timestampDiff;
      }

      return (right.sourceFetchedAt?.getTime() ?? 0) - (left.sourceFetchedAt?.getTime() ?? 0);
    })[0]?.value ?? null;
}

function deriveMarketCap(database: AppDatabase, coinId: string, snapshot: MarketSnapshotRow) {
  if (isPositiveFiniteNumber(snapshot.marketCap)) {
    return snapshot.marketCap;
  }

  const circulatingSupply = getLatestCirculatingSupply(database, coinId);
  if (!isPositiveFiniteNumber(circulatingSupply)) {
    return null;
  }

  return snapshot.price * circulatingSupply;
}

function buildSimplePayload(
  database: AppDatabase,
  coinId: string,
  snapshot: MarketSnapshotRow,
  requestedCurrencies: string[],
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
  options: {
    includeMarketCap: boolean;
    include24hrVol: boolean;
    include24hrChange: boolean;
    includeLastUpdatedAt: boolean;
    precision: number | 'full';
  },
) {
  return Object.fromEntries(
    requestedCurrencies.flatMap((vsCurrency) => {
      const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
      const marketCap = deriveMarketCap(database, coinId, snapshot);
      const entries: Array<[string, number | null]> = [[vsCurrency, toPreciseNumber(snapshot.price * rate, options.precision)]];

      if (options.includeMarketCap) {
        entries.push([`${vsCurrency}_market_cap`, toPreciseNumber(marketCap === null ? null : marketCap * rate, options.precision)]);
      }

      if (options.include24hrVol) {
        entries.push([`${vsCurrency}_24h_vol`, toPreciseNumber((snapshot.totalVolume ?? null) === null ? null : (snapshot.totalVolume ?? 0) * rate, options.precision)]);
      }

      if (options.include24hrChange) {
        entries.push([`${vsCurrency}_24h_change`, toPreciseNumber(snapshot.priceChangePercentage24h, options.precision)]);
      }

      if (options.includeLastUpdatedAt) {
        entries.push(['last_updated_at', Math.floor(snapshot.lastUpdated.getTime() / 1000)]);
      }

      return entries;
    }),
  );
}

function normalizeSelector(values: string[]) {
  return [...new Set(values)].sort();
}

function createSimplePriceCacheKey(query: z.infer<typeof simplePriceQuerySchema>) {
  return JSON.stringify({
    ids: normalizeSelector(parseCsvQuery(query.ids)),
    names: normalizeSelector(parseCsvQuery(query.names)),
    symbols: normalizeSelector(parseCsvQuery(query.symbols)),
    vsCurrencies: normalizeSelector(parseCsvQuery(query.vs_currencies)),
    includeMarketCap: parseBooleanQuery(query.include_market_cap, false),
    include24hrVol: parseBooleanQuery(query.include_24hr_vol, false),
    include24hrChange: parseBooleanQuery(query.include_24hr_change, false),
    includeLastUpdatedAt: parseBooleanQuery(query.include_last_updated_at, false),
    precision: parsePrecision(query.precision),
  });
}

function cloneSimplePriceResponse(value: SimplePriceResponse): SimplePriceResponse {
  return JSON.parse(JSON.stringify(value)) as SimplePriceResponse;
}

export function createSimplePriceCache() {
  return createResponseCache<SimplePriceResponse>({
    ttlMs: SIMPLE_PRICE_CACHE_TTL_MS,
    maxEntries: SIMPLE_PRICE_CACHE_MAX_ENTRIES,
    clone: cloneSimplePriceResponse,
  });
}

export function hasAnyLiveSnapshot(database: AppDatabase) {
  return getMarketRows(database, 'usd', {}).some((row) => (row.snapshot?.sourceCount ?? 0) > 0);
}

export function getSimplePriceAvailabilityFailure(
  database: AppDatabase,
  runtimeState: MarketDataRuntimeState,
  payloadSize: number,
  surface: 'simple/price' | 'simple/token_price',
) {
  if (payloadSize > 0) {
    return null;
  }

  if (
    runtimeState.initialSyncCompleted
    && runtimeState.initialSyncCompletedWithoutUsableLiveSnapshots
    && (
      runtimeState.validationOverride?.mode === 'zero_live_completed_boot'
      || !hasAnyLiveSnapshot(database)
    )
  ) {
    return {
      statusCode: 503,
      error: 'service_unavailable',
      message: `No usable live market snapshots are available for ${surface}.`,
    } satisfies SimplePriceAvailabilityFailure;
  }

  return null;
}

export async function warmSimplePriceCache(
  cache: SimplePriceCache,
  query: SimplePriceRequestQuery,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
  options: WarmSimplePriceCacheOptions = {},
) {
  const cacheKey = createSimplePriceCacheKey(query);
  const now = Date.now();
  const cached = cache.getFresh(cacheKey, runtimeState.hotDataRevision, now);

  if (cached) {
    options.app?.metrics.recordCacheHit('simple_price');
    return cached;
  }

  options.app?.metrics.recordCacheMiss('simple_price');

  return cache.getOrSet(cacheKey, runtimeState.hotDataRevision, () => {
    const requestedCurrencies = parseCsvQuery(query.vs_currencies);
    const precision = parsePrecision(query.precision);
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
    const rows = getMarketRows(database, 'usd', {
      ids: parseCsvQuery(query.ids),
      names: parseCsvQuery(query.names),
      symbols: parseCsvQuery(query.symbols),
    });

    return Object.fromEntries(
      rows
        .map((row) => ({
          coin: row.coin,
          snapshot: getUsableSnapshot(
            getEffectiveSnapshot(row.snapshot, runtimeState),
            marketFreshnessThresholdSeconds,
            snapshotAccessPolicy,
          ),
        }))
        .filter((row) => row.snapshot)
        .map((row) => [
          row.coin.id,
          buildSimplePayload(database, row.coin.id, row.snapshot!, requestedCurrencies, marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
            includeMarketCap: parseBooleanQuery(query.include_market_cap, false),
            include24hrVol: parseBooleanQuery(query.include_24hr_vol, false),
            include24hrChange: parseBooleanQuery(query.include_24hr_change, false),
            includeLastUpdatedAt: parseBooleanQuery(query.include_last_updated_at, false),
            precision,
          }),
        ]),
    );
  }, now);
}

export function registerSimpleRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
) {
  const simplePriceCache = createSimplePriceCache();
  app.decorate('simplePriceCache', simplePriceCache);

  app.get('/exchange_rates', async (request, reply) => sendCacheableJson(
    request,
    reply,
    buildExchangeRatesPayload(
      database,
      marketFreshnessThresholdSeconds,
      getSnapshotAccessPolicy(runtimeState),
    ),
    {
      maxAgeSeconds: 60,
      staleWhileRevalidateSeconds: 60,
    },
  ));

  app.get('/simple/supported_vs_currencies', async (request, reply) => sendCacheableJson(
    request,
    reply,
    getSupportedVsCurrencies(),
    {
      maxAgeSeconds: 3_600,
      staleWhileRevalidateSeconds: 3_600,
    },
  ));

  app.get('/simple/price', async (request, reply) => {
    const query = simplePriceQuerySchema.parse(request.query);

    if (!query.ids && !query.names && !query.symbols) {
      throw new HttpError(400, 'invalid_parameter', 'One of ids, names, or symbols must be provided.');
    }

    const requestedCurrencies = parseCsvQuery(query.vs_currencies);

    if (requestedCurrencies.length === 0) {
      throw new HttpError(400, 'invalid_parameter', 'At least one vs_currency must be provided.');
    }

    const payload = await warmSimplePriceCache(
      simplePriceCache,
      query,
      database,
      marketFreshnessThresholdSeconds,
      runtimeState,
      { app },
    );

    const availabilityFailure = getSimplePriceAvailabilityFailure(
      database,
      runtimeState,
      Object.keys(payload).length,
      'simple/price',
    );

    if (availabilityFailure) {
      throw new HttpError(
        availabilityFailure.statusCode,
        availabilityFailure.error,
        availabilityFailure.message,
      );
    }

    return sendCacheableJson(request, reply, payload, SIMPLE_HTTP_CACHE_POLICY);
  });

  app.get('/simple/token_price/:id', async (request, reply) => {
    const query = simpleTokenPriceQuerySchema.parse(request.query);
    const params = z.object({ id: z.string() }).parse(request.params);
    const requestedCurrencies = parseCsvQuery(query.vs_currencies);
    const contractAddresses = parseCsvQuery(query.contract_addresses);

    if (requestedCurrencies.length === 0) {
      throw new HttpError(400, 'invalid_parameter', 'At least one vs_currency must be provided.');
    }

    if (contractAddresses.length === 0) {
      throw new HttpError(400, 'invalid_parameter', 'At least one contract address must be provided.');
    }

    const precision = parsePrecision(query.precision);
    const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);

    const payload = Object.fromEntries(
      contractAddresses.flatMap((contractAddress) => {
        const coin = getCoinByContract(database, params.id, contractAddress);

        if (!coin) {
          return [];
        }

        const snapshot = getUsableSnapshot(
          getEffectiveSnapshot(getMarketRows(database, 'usd', { ids: [coin.id] })[0]?.snapshot ?? null, runtimeState),
          marketFreshnessThresholdSeconds,
          snapshotAccessPolicy,
        );

        if (!snapshot) {
          return [];
        }

        const normalizedAddress = resolveCoinPlatformContract(database, coin, params.id)?.contractAddress ?? contractAddress.toLowerCase();

        return [[
          normalizedAddress,
          buildSimplePayload(database, coin.id, snapshot, requestedCurrencies, marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
            includeMarketCap: parseBooleanQuery(query.include_market_cap, false),
            include24hrVol: parseBooleanQuery(query.include_24hr_vol, false),
            include24hrChange: parseBooleanQuery(query.include_24hr_change, false),
            includeLastUpdatedAt: parseBooleanQuery(query.include_last_updated_at, false),
            precision,
          }),
        ]];
      }),
    );

    const availabilityFailure = getSimplePriceAvailabilityFailure(
      database,
      runtimeState,
      Object.keys(payload).length,
      'simple/token_price',
    );

    if (availabilityFailure) {
      throw new HttpError(
        availabilityFailure.statusCode,
        availabilityFailure.error,
        availabilityFailure.message,
      );
    }

    return sendCacheableJson(request, reply, payload, SIMPLE_HTTP_CACHE_POLICY);
  });
}
