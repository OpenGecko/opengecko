import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { derivativeTickers, derivativesExchanges, type DerivativeTickerRow, type DerivativesExchangeRow } from '../db/schema';
import { sendCacheableJson } from '../http/cache';
import { HttpError } from '../http/errors';
import { parsePositiveInt } from '../http/params';
import { sortNumber } from '../lib/shared';
import { getEndpointFreshnessBudget } from '../services/freshness-budgets';

const derivativesExchangesQuerySchema = z.object({
  order: z.string().optional(),
  per_page: z.string().optional(),
  page: z.string().optional(),
});

const derivativesExchangeDetailQuerySchema = z.object({
  include_tickers: z.enum(['true', 'false']).optional(),
});

const DERIVATIVES_FRESHNESS_BUDGET = getEndpointFreshnessBudget('derivatives');
const DERIVATIVES_HTTP_CACHE_MAX_AGE_SECONDS = Math.min(
  60,
  DERIVATIVES_FRESHNESS_BUDGET?.target_freshness_seconds ?? 60,
);
const DERIVATIVES_HTTP_CACHE_POLICY = {
  maxAgeSeconds: DERIVATIVES_HTTP_CACHE_MAX_AGE_SECONDS,
  staleWhileRevalidateSeconds: DERIVATIVES_HTTP_CACHE_MAX_AGE_SECONDS,
};

type DerivativeTickerWithExchangeRow = {
  derivative_tickers: DerivativeTickerRow;
  derivatives_exchanges: DerivativesExchangeRow;
};

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

function getDerivativesExchangeOrThrow(database: AppDatabase, exchangeId: string) {
  const exchange = database.db.select().from(derivativesExchanges).where(eq(derivativesExchanges.id, exchangeId)).limit(1).get();

  if (!exchange) {
    throw new HttpError(404, 'not_found', `Derivatives exchange not found: ${exchangeId}`);
  }

  return exchange;
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

function buildDerivativesMeta(rows: DerivativeTickerWithExchangeRow[], page = 1) {
  const sourceBackedRows = rows.filter((row) => row.derivative_tickers.sourceKind !== 'seed');
  const latestSourceFetchedAt = sourceBackedRows.reduce<Date | null>((latest, row) => {
    const value = row.derivative_tickers.sourceFetchedAt ?? row.derivative_tickers.lastTradedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);

  if (sourceBackedRows.length > 0) {
    return {
      page,
      fixture: false,
      source: 'ccxt_derivatives',
      source_backed_tickers: sourceBackedRows.length,
      fallback_tickers: Math.max(rows.length - sourceBackedRows.length, 0),
      latest_source_fetched_at: latestSourceFetchedAt?.toISOString() ?? null,
      note: 'Derivatives data includes source-attributed CCXT derivative ticker rows; seeded fallback rows may remain for venues without live rows.',
    };
  }

  return {
    page,
    fixture: true,
    frozen_at: '2026-03-20',
    source_backed_tickers: 0,
    fallback_tickers: rows.length,
    latest_source_fetched_at: null,
    note: 'Derivatives data is seeded fixture until a derivatives refresh writes source-attributed rows.',
  };
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

function getDerivativesExchangeTickers(database: AppDatabase, exchangeId: string) {
  return getDerivativeRows(database)
    .filter((row) => row.derivative_tickers.exchangeId === exchangeId)
    .map(buildDerivativeTickerPayload);
}

export function registerDerivativeRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/derivatives/exchanges/list', async (request, reply) => {
    const rows = database.db.select().from(derivativesExchanges).orderBy(asc(derivativesExchanges.id)).all();

    return sendCacheableJson(request, reply, rows.map((row) => ({
      id: row.id,
      name: row.name,
    })), DERIVATIVES_HTTP_CACHE_POLICY);
  });

  app.get('/derivatives/exchanges', async (request, reply) => {
    const query = derivativesExchangesQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const rows = database.db.select().from(derivativesExchanges).all();
    const sortedRows = sortDerivativesExchangeRows(rows, query.order);
    const start = (page - 1) * perPage;
    const derivativeRows = getDerivativeRows(database);

    return sendCacheableJson(request, reply, {
      data: sortedRows.slice(start, start + perPage).map(buildDerivativesExchangeSummary),
      meta: buildDerivativesMeta(derivativeRows, page),
    }, DERIVATIVES_HTTP_CACHE_POLICY);
  });

  app.get('/derivatives/exchanges/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = derivativesExchangeDetailQuerySchema.parse(request.query);
    const exchange = getDerivativesExchangeOrThrow(database, params.id);

    return sendCacheableJson(request, reply, {
      data: {
        ...buildDerivativesExchangeSummary(exchange),
        ...(query.include_tickers === 'true' ? { tickers: getDerivativesExchangeTickers(database, params.id) } : {}),
      },
      meta: buildDerivativesMeta(getDerivativeRows(database).filter((row) => row.derivative_tickers.exchangeId === params.id)),
    }, DERIVATIVES_HTTP_CACHE_POLICY);
  });

  app.get('/derivatives', async (request, reply) => {
    const rows = sortDerivativeRows(getDerivativeRows(database));

    return sendCacheableJson(request, reply, {
      data: rows.map(buildDerivativeTickerPayload),
      meta: buildDerivativesMeta(rows),
    }, DERIVATIVES_HTTP_CACHE_POLICY);
  });
}
