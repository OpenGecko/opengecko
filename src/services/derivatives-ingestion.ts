import type { AppDatabase } from '../db/client';
import { derivativeTickers } from '../db/schema';
import {
  normalizeDerivativeTickerReplayBatch,
  type RawDerivativeTickerReplay,
} from './derivatives-normalizer';

export type DerivativeTickerIngestionOptions = {
  sourceKind?: 'replay' | 'live';
  sourceProvider?: string | null;
  sourceFetchedAt?: Date | null;
};

export function ingestDerivativeTickerReplayBatch(
  database: AppDatabase,
  rawRows: RawDerivativeTickerReplay[],
  options: DerivativeTickerIngestionOptions = {},
) {
  const normalizedRows = normalizeDerivativeTickerReplayBatch(rawRows);
  const sourceKind = options.sourceKind ?? 'replay';
  const sourceProvider = options.sourceProvider?.trim() || null;
  const sourceFetchedAt = options.sourceFetchedAt ?? null;

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

  return {
    tickers_written: normalizedRows.length,
    exchange_ids: [...new Set(normalizedRows.map((row) => row.exchangeId))],
    symbols: normalizedRows.map((row) => row.symbol),
    source_kind: sourceKind,
    source_provider: sourceProvider,
    source_fetched_at: sourceFetchedAt?.toISOString() ?? null,
  };
}
