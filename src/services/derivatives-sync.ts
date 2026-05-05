import type { AppDatabase } from '../db/client';
import { fetchExchangeDerivativeTickers } from '../providers/ccxt';
import { ingestDerivativeTickerReplayBatch } from './derivatives-ingestion';
import type { RawDerivativeTickerReplay } from './derivatives-normalizer';
import type { DerivativesSyncVenue } from './derivatives-venues';

export type DerivativesSyncVenueConfig = DerivativesSyncVenue & {
  exchangeId: string;
  providerExchangeId: string;
  symbols?: string[];
};

export type DerivativesSyncFetcher = (
  providerExchangeId: string,
  exchangeId: string,
  symbols?: string[],
) => Promise<RawDerivativeTickerReplay[]>;

export type DerivativesSyncOptions = {
  venues: DerivativesSyncVenueConfig[];
  fetcher?: DerivativesSyncFetcher;
  now?: Date;
};

export async function syncDerivativeTickers(database: AppDatabase, options: DerivativesSyncOptions) {
  const fetcher = options.fetcher ?? fetchExchangeDerivativeTickers;
  const sourceFetchedAt = options.now ?? new Date();
  const results = [];

  for (const venue of options.venues) {
    const tickers = await fetcher(venue.providerExchangeId, venue.exchangeId, venue.symbols);
    const ingestion = ingestDerivativeTickerReplayBatch(database, tickers, {
      sourceKind: 'live',
      sourceProvider: `ccxt.${venue.providerExchangeId}`,
      sourceFetchedAt,
    });

    results.push({
      exchange_id: venue.exchangeId,
      provider_exchange_id: venue.providerExchangeId,
      tickers_fetched: tickers.length,
      tickers_written: ingestion.tickers_written,
    });
  }

  return {
    venues_attempted: options.venues.length,
    tickers_fetched: results.reduce((total, result) => total + result.tickers_fetched, 0),
    tickers_written: results.reduce((total, result) => total + result.tickers_written, 0),
    source_fetched_at: sourceFetchedAt.toISOString(),
    results,
  };
}
