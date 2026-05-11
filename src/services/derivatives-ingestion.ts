import { eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { derivativeTickers, derivativesExchanges } from '../db/schema';
import {
  normalizeDerivativeTickerReplayBatch,
  type RawDerivativeTickerReplay,
} from './derivatives-normalizer';

export type DerivativeTickerIngestionOptions = {
  sourceKind?: 'replay' | 'live';
  sourceProvider?: string | null;
  sourceFetchedAt?: Date | null;
};

const FALLBACK_DERIVATIVES_EXCHANGE_METADATA: Record<string, {
  name: string;
  yearEstablished: number | null;
  country: string | null;
  description: string;
  url: string;
  imageUrl: string | null;
  centralised: boolean;
}> = {
  binance_futures: {
    name: 'Binance Futures',
    yearEstablished: 2019,
    country: 'Cayman Islands',
    description: "Binance Futures is Binance's derivatives venue for perpetual and dated futures markets.",
    url: 'https://www.binance.com/en/futures',
    imageUrl: 'https://assets.coingecko.com/markets/images/52/small/binance.jpg',
    centralised: true,
  },
  bybit: {
    name: 'Bybit',
    yearEstablished: 2018,
    country: 'United Arab Emirates',
    description: 'Bybit is a crypto derivatives exchange focused on perpetual and futures trading.',
    url: 'https://www.bybit.com',
    imageUrl: 'https://assets.coingecko.com/markets/images/698/small/bybit_spot.png',
    centralised: true,
  },
  okx: {
    name: 'OKX',
    yearEstablished: 2017,
    country: 'Seychelles',
    description: 'OKX is a global cryptocurrency exchange with spot and derivatives markets.',
    url: 'https://www.okx.com',
    imageUrl: 'https://assets.coingecko.com/markets/images/96/small/WeChat_Image_20220117220452.png',
    centralised: true,
  },
  bitget: {
    name: 'Bitget',
    yearEstablished: 2018,
    country: 'Seychelles',
    description: 'Bitget is a cryptocurrency exchange offering spot and derivatives markets.',
    url: 'https://www.bitget.com',
    imageUrl: 'https://assets.coingecko.com/markets/images/540/small/bitget.png',
    centralised: true,
  },
};

function titleizeExchangeId(exchangeId: string) {
  return exchangeId
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function ensureDerivativesExchange(database: AppDatabase, exchangeId: string, now: Date) {
  const metadata = FALLBACK_DERIVATIVES_EXCHANGE_METADATA[exchangeId] ?? {
    name: titleizeExchangeId(exchangeId),
    yearEstablished: null,
    country: null,
    description: `${titleizeExchangeId(exchangeId)} derivatives venue discovered from configured CCXT derivatives refresh.`,
    url: '',
    imageUrl: null,
    centralised: true,
  };

  database.db.insert(derivativesExchanges).values({
    id: exchangeId,
    name: metadata.name,
    openInterestBtc: null,
    tradeVolume24hBtc: null,
    numberOfPerpetualPairs: null,
    numberOfFuturesPairs: null,
    yearEstablished: metadata.yearEstablished,
    country: metadata.country,
    description: metadata.description,
    url: metadata.url,
    imageUrl: metadata.imageUrl,
    centralised: metadata.centralised,
    updatedAt: now,
  }).onConflictDoNothing().run();
}

function updateDerivativesExchangeAggregate(database: AppDatabase, exchangeId: string, now: Date) {
  const rows = database.db.select().from(derivativeTickers).all().filter((row) => row.exchangeId === exchangeId);
  const sourceBackedRows = rows.filter((row) => row.sourceKind !== 'seed');
  const aggregateRows = sourceBackedRows.length > 0 ? sourceBackedRows : rows;
  const openInterestBtc = aggregateRows.reduce((total, row) => total + (row.openInterestBtc ?? 0), 0);
  const tradeVolume24hBtc = aggregateRows.reduce((total, row) => total + (row.tradeVolume24hBtc ?? 0), 0);
  const perpetualPairs = aggregateRows.filter((row) => row.contractType === 'perpetual').length;
  const futuresPairs = aggregateRows.filter((row) => row.contractType === 'future' || row.expiredAt !== null).length;

  database.db
    .update(derivativesExchanges)
    .set({
      openInterestBtc: aggregateRows.length > 0 ? openInterestBtc : null,
      tradeVolume24hBtc: aggregateRows.length > 0 ? tradeVolume24hBtc : null,
      numberOfPerpetualPairs: aggregateRows.length > 0 ? perpetualPairs : null,
      numberOfFuturesPairs: aggregateRows.length > 0 ? futuresPairs : null,
      updatedAt: now,
    })
    .where(eq(derivativesExchanges.id, exchangeId))
    .run();
}

export function ingestDerivativeTickerReplayBatch(
  database: AppDatabase,
  rawRows: RawDerivativeTickerReplay[],
  options: DerivativeTickerIngestionOptions = {},
) {
  const normalizedRows = normalizeDerivativeTickerReplayBatch(rawRows);
  const sourceKind = options.sourceKind ?? 'replay';
  const sourceProvider = options.sourceProvider?.trim() || null;
  const sourceFetchedAt = options.sourceFetchedAt ?? null;
  const updatedAt = sourceFetchedAt ?? new Date();
  const exchangeIds = [...new Set(normalizedRows.map((row) => row.exchangeId))];

  for (const exchangeId of exchangeIds) {
    ensureDerivativesExchange(database, exchangeId, updatedAt);
  }

  for (const row of normalizedRows) {
    const sourcedRow = {
      ...row,
      sourceKind,
      sourceProvider,
      sourceFetchedAt,
    };

    database.db
      .insert(derivativeTickers)
      .values(sourcedRow)
      .onConflictDoUpdate({
        target: [derivativeTickers.exchangeId, derivativeTickers.symbol],
        set: {
          market: sourcedRow.market,
          indexId: sourcedRow.indexId,
          price: sourcedRow.price,
          pricePercentageChange24h: sourcedRow.pricePercentageChange24h,
          contractType: sourcedRow.contractType,
          indexValue: sourcedRow.indexValue,
          basis: sourcedRow.basis,
          spread: sourcedRow.spread,
          fundingRate: sourcedRow.fundingRate,
          openInterestBtc: sourcedRow.openInterestBtc,
          tradeVolume24hBtc: sourcedRow.tradeVolume24hBtc,
          lastTradedAt: sourcedRow.lastTradedAt,
          expiredAt: sourcedRow.expiredAt,
          sourceKind: sourcedRow.sourceKind,
          sourceProvider: sourcedRow.sourceProvider,
          sourceFetchedAt: sourcedRow.sourceFetchedAt,
        },
      })
      .run();
  }

  for (const exchangeId of exchangeIds) {
    updateDerivativesExchangeAggregate(database, exchangeId, updatedAt);
  }

  return {
    tickers_written: normalizedRows.length,
    exchange_ids: exchangeIds,
    symbols: normalizedRows.map((row) => row.symbol),
    source_kind: sourceKind,
    source_provider: sourceProvider,
    source_fetched_at: sourceFetchedAt?.toISOString() ?? null,
  };
}
