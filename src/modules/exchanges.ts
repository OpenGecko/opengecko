import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { coinTickers, derivativeTickers, derivativesExchanges, exchangeVolumePoints, exchanges, type DerivativeTickerRow, type DerivativesExchangeRow, type ExchangeRow } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt } from '../http/params';
import { getConversionRates } from '../lib/conversion';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import { getCoinById } from './catalog';
import { getSnapshotAccessPolicy } from './market-freshness';

const exchangesListQuerySchema = z.object({
  status: z.enum(['active', 'inactive', 'all']).optional(),
});

const exchangesQuerySchema = z.object({
  per_page: z.string().optional(),
  page: z.string().optional(),
});

const exchangeDetailQuerySchema = z.object({
  dex_pair_format: z.string().optional(),
});

const exchangeVolumeChartQuerySchema = z.object({
  days: z.string(),
});

const exchangeTickersQuerySchema = z.object({
  coin_ids: z.string().optional(),
  include_exchange_logo: z.enum(['true', 'false']).optional(),
  depth: z.enum(['true', 'false']).optional(),
  page: z.string().optional(),
  order: z.string().optional(),
  dex_pair_format: z.string().optional(),
});

const derivativesExchangesQuerySchema = z.object({
  order: z.string().optional(),
  per_page: z.string().optional(),
  page: z.string().optional(),
});

function parseJsonArray<T>(value: string) {
  return JSON.parse(value) as T[];
}

function parseJsonObject<T extends Record<string, string>>(value: string) {
  return JSON.parse(value) as T;
}

function parseDexPairFormat(value: string | undefined) {
  if (!value) {
    return 'symbol';
  }

  const normalized = value.toLowerCase();

  if (normalized === 'symbol' || normalized === 'contract_address') {
    return normalized;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported dex_pair_format value: ${value}`);
}

function buildExchangeSummary(row: ExchangeRow) {
  return {
    id: row.id,
    name: row.name,
    year_established: row.yearEstablished,
    country: row.country,
    description: row.description,
    url: row.url,
    image: row.imageUrl,
    has_trading_incentive: row.hasTradingIncentive,
    trust_score: row.trustScore,
    trust_score_rank: row.trustScoreRank,
    trade_volume_24h_btc: row.tradeVolume24hBtc,
    trade_volume_24h_btc_normalized: row.tradeVolume24hBtcNormalized,
  };
}

function buildExchangeDetail(row: ExchangeRow) {
  return {
    ...buildExchangeSummary(row),
    facebook_url: row.facebookUrl,
    reddit_url: row.redditUrl,
    telegram_url: row.telegramUrl,
    slack_url: row.slackUrl,
    other_url_1: parseJsonArray<string>(row.otherUrlJson)[0] ?? null,
    other_url_2: parseJsonArray<string>(row.otherUrlJson)[1] ?? null,
    twitter_handle: row.twitterHandle,
    centralized: row.centralised,
    public_notice: row.publicNotice,
    alert_notice: row.alertNotice,
    tickers: [],
  };
}

function buildDerivativesExchangeSummary(row: DerivativesExchangeRow) {
  return {
    id: row.id,
    name: row.name,
    open_interest_btc: row.openInterestBtc,
    trade_volume_24h_btc: row.tradeVolume24hBtc,
    number_of_perpetual_pairs: row.numberOfPerpetualPairs,
    number_of_futures_pairs: row.numberOfFuturesPairs,
    year_established: row.yearEstablished,
    country: row.country,
    description: row.description,
    url: row.url,
    image: row.imageUrl,
    centralized: row.centralised,
  };
}

function sortNumber(value: number | null | undefined, fallback: number) {
  return value ?? fallback;
}

function formatTickerAsset(database: AppDatabase, symbol: string, coinId: string | null, dexPairFormat: string) {
  if (dexPairFormat !== 'contract_address' || !coinId) {
    return symbol;
  }

  const coin = getCoinById(database, coinId);

  if (!coin) {
    return symbol;
  }

  return Object.values(parseJsonObject<Record<string, string>>(coin.platformsJson))[0] ?? symbol;
}

type ExchangeTickerRow = {
  coin_tickers: typeof coinTickers.$inferSelect;
  exchanges: ExchangeRow;
};

type DerivativeTickerWithExchangeRow = {
  derivative_tickers: DerivativeTickerRow;
  derivatives_exchanges: DerivativesExchangeRow;
};

function getExchangeTickerRows(database: AppDatabase, exchangeId: string, coinIds?: string[]): ExchangeTickerRow[] {
  const whereCondition = coinIds?.length
    ? and(eq(coinTickers.exchangeId, exchangeId), inArray(coinTickers.coinId, coinIds))
    : eq(coinTickers.exchangeId, exchangeId);

  return database.db
    .select()
    .from(coinTickers)
    .innerJoin(exchanges, eq(exchanges.id, coinTickers.exchangeId))
    .where(whereCondition)
    .all();
}

function sortExchangeTickerRows(
  rows: ReturnType<typeof getExchangeTickerRows>,
  order: string | undefined,
) {
  const normalizedOrder = (order ?? 'volume_desc').toLowerCase();
  const sortableRows = [...rows];

  switch (normalizedOrder) {
    case 'trust_score_desc':
    case 'volume_desc':
      return sortableRows.sort((left, right) => sortNumber(right.coin_tickers.convertedVolumeUsd, -1) - sortNumber(left.coin_tickers.convertedVolumeUsd, -1));
    case 'volume_asc':
      return sortableRows.sort((left, right) => sortNumber(left.coin_tickers.convertedVolumeUsd, Number.MAX_SAFE_INTEGER) - sortNumber(right.coin_tickers.convertedVolumeUsd, Number.MAX_SAFE_INTEGER));
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported order value: ${order}`);
  }
}

function buildExchangeTickerPayload(
  database: AppDatabase,
  row: ReturnType<typeof getExchangeTickerRows>[number],
  conversionRates: ReturnType<typeof getConversionRates>,
  options: {
    includeExchangeLogo: boolean;
    includeDepth: boolean;
    dexPairFormat: string;
  },
) {
  return {
    base: formatTickerAsset(database, row.coin_tickers.base, row.coin_tickers.coinId, options.dexPairFormat),
    target: row.coin_tickers.target,
    market: {
      name: row.exchanges.name,
      identifier: row.exchanges.id,
      has_trading_incentive: row.exchanges.hasTradingIncentive,
      ...(options.includeExchangeLogo ? { logo: row.exchanges.imageUrl } : {}),
    },
    last: row.coin_tickers.last,
    volume: row.coin_tickers.volume,
    converted_last: {
      btc: row.coin_tickers.convertedLastUsd === null ? null : row.coin_tickers.convertedLastUsd * conversionRates.btc,
      usd: row.coin_tickers.convertedLastUsd,
      eth: row.coin_tickers.convertedLastUsd === null ? null : row.coin_tickers.convertedLastUsd * conversionRates.eth,
    },
    converted_volume: {
      btc: row.coin_tickers.convertedVolumeUsd === null ? null : row.coin_tickers.convertedVolumeUsd * conversionRates.btc,
      usd: row.coin_tickers.convertedVolumeUsd,
      eth: row.coin_tickers.convertedVolumeUsd === null ? null : row.coin_tickers.convertedVolumeUsd * conversionRates.eth,
    },
    trust_score: row.coin_tickers.trustScore,
    bid_ask_spread_percentage: row.coin_tickers.bidAskSpreadPercentage,
    timestamp: row.coin_tickers.lastTradedAt?.getTime() ?? null,
    last_traded_at: row.coin_tickers.lastTradedAt?.toISOString() ?? null,
    last_fetch_at: row.coin_tickers.lastFetchAt?.toISOString() ?? null,
    is_anomaly: row.coin_tickers.isAnomaly,
    is_stale: row.coin_tickers.isStale,
    trade_url: row.coin_tickers.tradeUrl,
    token_info_url: row.coin_tickers.tokenInfoUrl,
    ...(options.includeDepth
      ? {
          cost_to_move_up_usd: row.coin_tickers.convertedVolumeUsd === null ? null : Number((row.coin_tickers.convertedVolumeUsd * 0.001).toFixed(2)),
          cost_to_move_down_usd: row.coin_tickers.convertedVolumeUsd === null ? null : Number((row.coin_tickers.convertedVolumeUsd * 0.0008).toFixed(2)),
        }
      : {}),
    coin_id: row.coin_tickers.coinId,
    target_coin_id: null,
  };
}

function getExchangeTickers(
  database: AppDatabase,
  exchangeId: string,
  options: {
    coinIds?: string[];
    includeExchangeLogo: boolean;
    includeDepth: boolean;
    page: number;
    order?: string;
    dexPairFormat: string;
    marketFreshnessThresholdSeconds: number;
    runtimeState: MarketDataRuntimeState;
  },
) {
  const perPage = 100;
  const rows = sortExchangeTickerRows(getExchangeTickerRows(database, exchangeId, options.coinIds), options.order);
  const start = (options.page - 1) * perPage;
  const conversionRates = getConversionRates(
    database,
    options.marketFreshnessThresholdSeconds,
    getSnapshotAccessPolicy(options.runtimeState),
  );

  return rows.slice(start, start + perPage).map((row) => buildExchangeTickerPayload(database, row, conversionRates, {
    includeExchangeLogo: options.includeExchangeLogo,
    includeDepth: options.includeDepth,
    dexPairFormat: options.dexPairFormat,
  }));
}

function getExchangeOrThrow(database: AppDatabase, exchangeId: string) {
  const exchange = database.db.select().from(exchanges).where(eq(exchanges.id, exchangeId)).limit(1).get();

  if (!exchange) {
    throw new HttpError(404, 'not_found', `Exchange not found: ${exchangeId}`);
  }

  return exchange;
}

function getExchangeVolumeChart(database: AppDatabase, exchangeId: string, days: string) {
  const parsedDays = Number(days);

  if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${days}`);
  }

  const cutoffMs = Date.now() - parsedDays * 24 * 60 * 60 * 1000;

  const allRows = database.db
    .select()
    .from(exchangeVolumePoints)
    .where(eq(exchangeVolumePoints.exchangeId, exchangeId))
    .orderBy(asc(exchangeVolumePoints.timestamp))
    .all();

  const rows = allRows.filter((row) => row.timestamp.getTime() >= cutoffMs);

  if (rows.length === 0) {
    return [];
  }

  // Downsample: <= 2 days -> hourly, > 2 days -> daily
  const bucketMs = parsedDays <= 2 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const buckets = new Map<number, [number, number]>();

  for (const row of rows) {
    const ts = row.timestamp.getTime();
    const bucketKey = Math.floor(ts / bucketMs) * bucketMs;
    buckets.set(bucketKey, [bucketKey, row.volumeBtc]);
  }

  return [...buckets.values()].sort((a, b) => a[0] - b[0]);
}

function sortDerivativesExchangeRows(rows: DerivativesExchangeRow[], order: string | undefined) {
  const normalizedOrder = (order ?? 'open_interest_btc_desc').toLowerCase();
  const sortableRows = [...rows];

  switch (normalizedOrder) {
    case 'open_interest_btc_desc':
      return sortableRows.sort((left, right) => sortNumber(right.openInterestBtc, -1) - sortNumber(left.openInterestBtc, -1));
    case 'open_interest_btc_asc':
      return sortableRows.sort((left, right) => sortNumber(left.openInterestBtc, Number.MAX_SAFE_INTEGER) - sortNumber(right.openInterestBtc, Number.MAX_SAFE_INTEGER));
    case 'trade_volume_24h_btc_desc':
      return sortableRows.sort((left, right) => sortNumber(right.tradeVolume24hBtc, -1) - sortNumber(left.tradeVolume24hBtc, -1));
    case 'trade_volume_24h_btc_asc':
      return sortableRows.sort((left, right) => sortNumber(left.tradeVolume24hBtc, Number.MAX_SAFE_INTEGER) - sortNumber(right.tradeVolume24hBtc, Number.MAX_SAFE_INTEGER));
    case 'name_asc':
      return sortableRows.sort((left, right) => left.name.localeCompare(right.name));
    case 'name_desc':
      return sortableRows.sort((left, right) => right.name.localeCompare(left.name));
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported order value: ${order}`);
  }
}

function getDerivativeRows(database: AppDatabase): DerivativeTickerWithExchangeRow[] {
  return database.db
    .select()
    .from(derivativeTickers)
    .innerJoin(derivativesExchanges, eq(derivativesExchanges.id, derivativeTickers.exchangeId))
    .all();
}

function sortDerivativeRows(rows: DerivativeTickerWithExchangeRow[]) {
  return [...rows].sort((left, right) => sortNumber(right.derivative_tickers.tradeVolume24hBtc, -1) - sortNumber(left.derivative_tickers.tradeVolume24hBtc, -1));
}

function buildDerivativeTickerPayload(row: DerivativeTickerWithExchangeRow) {
  return {
    market: row.derivatives_exchanges.name,
    market_id: row.derivatives_exchanges.id,
    symbol: row.derivative_tickers.symbol,
    index_id: row.derivative_tickers.indexId,
    price: row.derivative_tickers.price,
    price_percentage_change_24h: row.derivative_tickers.pricePercentageChange24h,
    contract_type: row.derivative_tickers.contractType,
    index: row.derivative_tickers.indexValue,
    basis: row.derivative_tickers.basis,
    spread: row.derivative_tickers.spread,
    funding_rate: row.derivative_tickers.fundingRate,
    open_interest_btc: row.derivative_tickers.openInterestBtc,
    trade_volume_24h_btc: row.derivative_tickers.tradeVolume24hBtc,
    last_traded_at: row.derivative_tickers.lastTradedAt?.toISOString() ?? null,
    expired_at: row.derivative_tickers.expiredAt?.toISOString() ?? null,
  };
}

export function registerExchangeRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  runtimeState: MarketDataRuntimeState,
) {
  app.get('/exchanges/list', async (request) => {
    const query = exchangesListQuerySchema.parse(request.query);

    if (query.status === 'inactive') {
      return [];
    }

    const rows = database.db.select().from(exchanges).orderBy(asc(exchanges.id)).all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
    }));
  });

  app.get('/exchanges', async (request) => {
    const query = exchangesQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const rows = database.db.select().from(exchanges).orderBy(asc(exchanges.trustScoreRank), asc(exchanges.id)).all();
    const start = (page - 1) * perPage;

    return rows.slice(start, start + perPage).map(buildExchangeSummary);
  });

  app.get('/exchanges/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = exchangeDetailQuerySchema.parse(request.query);
    const dexPairFormat = parseDexPairFormat(query.dex_pair_format);
    const exchange = getExchangeOrThrow(database, params.id);

    return {
      ...buildExchangeDetail(exchange),
      tickers: getExchangeTickers(database, params.id, {
        includeExchangeLogo: false,
        includeDepth: false,
        page: 1,
        dexPairFormat,
        marketFreshnessThresholdSeconds,
        runtimeState,
      }),
    };
  });

  app.get('/exchanges/:id/volume_chart', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = exchangeVolumeChartQuerySchema.parse(request.query);

    getExchangeOrThrow(database, params.id);

    return getExchangeVolumeChart(database, params.id, query.days);
  });

  app.get('/exchanges/:id/tickers', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = exchangeTickersQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const dexPairFormat = parseDexPairFormat(query.dex_pair_format);
    const exchange = getExchangeOrThrow(database, params.id);

    return {
      name: exchange.name,
      tickers: getExchangeTickers(database, params.id, {
        coinIds: parseCsvQuery(query.coin_ids),
        includeExchangeLogo: parseBooleanQuery(query.include_exchange_logo, false),
        includeDepth: parseBooleanQuery(query.depth, false),
        page,
        order: query.order,
        dexPairFormat,
        marketFreshnessThresholdSeconds,
        runtimeState,
      }),
    };
  });

  app.get('/derivatives/exchanges/list', async () => {
    const rows = database.db.select().from(derivativesExchanges).orderBy(asc(derivativesExchanges.id)).all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
    }));
  });

  app.get('/derivatives/exchanges', async (request) => {
    const query = derivativesExchangesQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const rows = database.db.select().from(derivativesExchanges).all();
    const sortedRows = sortDerivativesExchangeRows(rows, query.order);
    const start = (page - 1) * perPage;

    return sortedRows.slice(start, start + perPage).map(buildDerivativesExchangeSummary);
  });

  app.get('/derivatives', async () => {
    return sortDerivativeRows(getDerivativeRows(database)).map(buildDerivativeTickerPayload);
  });
}
