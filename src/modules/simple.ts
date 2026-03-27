import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import type { MarketSnapshotRow } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePrecision } from '../http/params';
import { buildExchangeRatesPayload, getConversionRate } from '../lib/conversion';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import { getSupportedVsCurrencies } from '../services/currency-rates';
import { getCoinByContract, getMarketRows, parseJsonObject } from './catalog';
import { getEffectiveSnapshot, getSnapshotAccessPolicy, type SnapshotAccessPolicy, getUsableSnapshot } from './market-freshness';

type SimplePriceResponse = Record<string, Record<string, number | null>>;
type SimplePriceCacheEntry = {
  value: SimplePriceResponse;
  expiresAt: number;
  revision: number;
};

export type SimplePriceRequestQuery = z.infer<typeof simplePriceQuerySchema>;
export type WarmSimplePriceCacheOptions = {
  app?: Pick<FastifyInstance, 'metrics'>;
};

const SIMPLE_PRICE_CACHE_TTL_MS = 5_000;

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

  return Number(value.toFixed(precision));
}

function buildSimplePayload(
  database: AppDatabase,
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
      const entries: Array<[string, number | null]> = [[vsCurrency, toPreciseNumber(snapshot.price * rate, options.precision)]];

      if (options.includeMarketCap) {
        entries.push([`${vsCurrency}_market_cap`, toPreciseNumber((snapshot.marketCap ?? null) === null ? null : (snapshot.marketCap ?? 0) * rate, options.precision)]);
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

export function warmSimplePriceCache(
  cache: Map<string, SimplePriceCacheEntry>,
  query: SimplePriceRequestQuery,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
  options: WarmSimplePriceCacheOptions = {},
) {
  const cacheKey = createSimplePriceCacheKey(query);
  const cached = cache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.revision === runtimeState.hotDataRevision && cached.expiresAt > now) {
    options.app?.metrics.recordCacheHit('simple_price');
    return cloneSimplePriceResponse(cached.value);
  }

  options.app?.metrics.recordCacheMiss('simple_price');

  const requestedCurrencies = parseCsvQuery(query.vs_currencies);
  const precision = parsePrecision(query.precision);
  const snapshotAccessPolicy = getSnapshotAccessPolicy(runtimeState);
  const rows = getMarketRows(database, 'usd', {
    ids: parseCsvQuery(query.ids),
    names: parseCsvQuery(query.names),
    symbols: parseCsvQuery(query.symbols),
  });

  const payload = Object.fromEntries(
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
        buildSimplePayload(database, row.snapshot!, requestedCurrencies, marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
          includeMarketCap: parseBooleanQuery(query.include_market_cap, false),
          include24hrVol: parseBooleanQuery(query.include_24hr_vol, false),
          include24hrChange: parseBooleanQuery(query.include_24hr_change, false),
          includeLastUpdatedAt: parseBooleanQuery(query.include_last_updated_at, false),
          precision,
        }),
      ]),
  );

  cache.set(cacheKey, {
    value: cloneSimplePriceResponse(payload),
    expiresAt: now + SIMPLE_PRICE_CACHE_TTL_MS,
    revision: runtimeState.hotDataRevision,
  });

  return payload;
}

export function registerSimpleRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
) {
  const simplePriceCache = new Map<string, SimplePriceCacheEntry>();
  app.decorate('simplePriceCache', simplePriceCache);

  app.get('/exchange_rates', async () => buildExchangeRatesPayload(
    database,
    marketFreshnessThresholdSeconds,
    getSnapshotAccessPolicy(runtimeState),
  ));

  app.get('/simple/supported_vs_currencies', async () => getSupportedVsCurrencies());

  app.get('/simple/price', async (request) => {
    const query = simplePriceQuerySchema.parse(request.query);

    if (!query.ids && !query.names && !query.symbols) {
      throw new HttpError(400, 'invalid_parameter', 'One of ids, names, or symbols must be provided.');
    }

    const requestedCurrencies = parseCsvQuery(query.vs_currencies);

    if (requestedCurrencies.length === 0) {
      throw new HttpError(400, 'invalid_parameter', 'At least one vs_currency must be provided.');
    }

    return warmSimplePriceCache(
      simplePriceCache,
      query,
      database,
      marketFreshnessThresholdSeconds,
      runtimeState,
      { app },
    );
  });

  app.get('/simple/token_price/:id', async (request) => {
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

    return Object.fromEntries(
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

        const platforms = parseJsonObject<Record<string, string>>(coin.platformsJson);
        const normalizedAddress = platforms[params.id]?.toLowerCase() ?? contractAddress;

        return [[
          normalizedAddress,
          buildSimplePayload(database, snapshot, requestedCurrencies, marketFreshnessThresholdSeconds, snapshotAccessPolicy, {
            includeMarketCap: parseBooleanQuery(query.include_market_cap, false),
            include24hrVol: parseBooleanQuery(query.include_24hr_vol, false),
            include24hrChange: parseBooleanQuery(query.include_24hr_change, false),
            includeLastUpdatedAt: parseBooleanQuery(query.include_last_updated_at, false),
            precision,
          }),
        ]];
      }),
    );
  });
}
