import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import type { MarketSnapshotRow } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePrecision } from '../http/params';
import { buildExchangeRatesPayload, getConversionRate, SUPPORTED_VS_CURRENCIES } from '../lib/conversion';
import { getCoinByContract, getMarketRows, parseJsonObject } from './catalog';
import { getUsableSnapshot } from './market-freshness';

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
      const rate = getConversionRate(database, vsCurrency, marketFreshnessThresholdSeconds);
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

export function registerSimpleRoutes(app: FastifyInstance, database: AppDatabase, marketFreshnessThresholdSeconds: number) {
  app.get('/exchange_rates', async () => buildExchangeRatesPayload(database, marketFreshnessThresholdSeconds));

  app.get('/simple/supported_vs_currencies', async () => [...SUPPORTED_VS_CURRENCIES]);

  app.get('/simple/price', async (request) => {
    const query = simplePriceQuerySchema.parse(request.query);

    if (!query.ids && !query.names && !query.symbols) {
      throw new HttpError(400, 'invalid_parameter', 'One of ids, names, or symbols must be provided.');
    }

    const requestedCurrencies = parseCsvQuery(query.vs_currencies);

    if (requestedCurrencies.length === 0) {
      throw new HttpError(400, 'invalid_parameter', 'At least one vs_currency must be provided.');
    }

    const precision = parsePrecision(query.precision);
    const rows = getMarketRows(database, 'usd', {
      ids: parseCsvQuery(query.ids),
      names: parseCsvQuery(query.names),
      symbols: parseCsvQuery(query.symbols),
    });

    return Object.fromEntries(
      rows
        .map((row) => ({
          coin: row.coin,
          snapshot: getUsableSnapshot(row.snapshot, marketFreshnessThresholdSeconds),
        }))
        .filter((row) => row.snapshot)
        .map((row) => [
          row.coin.id,
          buildSimplePayload(database, row.snapshot!, requestedCurrencies, marketFreshnessThresholdSeconds, {
            includeMarketCap: parseBooleanQuery(query.include_market_cap, false),
            include24hrVol: parseBooleanQuery(query.include_24hr_vol, false),
            include24hrChange: parseBooleanQuery(query.include_24hr_change, false),
            includeLastUpdatedAt: parseBooleanQuery(query.include_last_updated_at, false),
            precision,
          }),
        ]),
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

    return Object.fromEntries(
      contractAddresses.flatMap((contractAddress) => {
        const coin = getCoinByContract(database, params.id, contractAddress);

        if (!coin) {
          return [];
        }

        const snapshot = getUsableSnapshot(
          getMarketRows(database, 'usd', { ids: [coin.id] })[0]?.snapshot ?? null,
          marketFreshnessThresholdSeconds,
        );

        if (!snapshot) {
          return [];
        }

        const platforms = parseJsonObject<Record<string, string>>(coin.platformsJson);
        const normalizedAddress = platforms[params.id]?.toLowerCase() ?? contractAddress;

        return [[
          normalizedAddress,
          buildSimplePayload(database, snapshot, requestedCurrencies, marketFreshnessThresholdSeconds, {
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
