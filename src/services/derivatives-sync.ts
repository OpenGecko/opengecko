import type { AppDatabase } from '../db/client';
import { fetchExchangeDerivativeTickers } from '../providers/ccxt';
import { ingestDerivativeTickerReplayBatch } from './derivatives-ingestion';
import type { RawDerivativeTickerReplay } from './derivatives-normalizer';
import { recordDerivativesVenueRefreshState, type DerivativesSyncVenue } from './derivatives-venues';
import { sanitizeSchedulerDiagnosticError } from './job-scheduler';

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

function formatDerivativesSyncError(error: unknown) {
  return sanitizeSchedulerDiagnosticError(error).replace(/\s+/g, ' ').slice(0, 240);
}

export async function syncDerivativeTickers(database: AppDatabase, options: DerivativesSyncOptions) {
  const fetcher = options.fetcher ?? fetchExchangeDerivativeTickers;
  const sourceFetchedAt = options.now ?? new Date();
  const results = [];
  const partialFailures: Array<{ target: string; reason: string }> = [];

  for (const venue of options.venues) {
    try {
      const tickers = await fetcher(venue.providerExchangeId, venue.exchangeId, venue.symbols);
      const ingestion = ingestDerivativeTickerReplayBatch(database, tickers, {
        sourceKind: 'live',
        sourceProvider: `ccxt.${venue.providerExchangeId}`,
        sourceFetchedAt,
      });
      const status = tickers.length > 0 ? 'success' : 'unsupported_or_empty';
      const result = {
        exchange_id: venue.exchangeId,
        provider_exchange_id: venue.providerExchangeId,
        status,
        tickers_fetched: tickers.length,
        tickers_written: ingestion.tickers_written,
        last_error: null,
      };

      if (tickers.length === 0) {
        partialFailures.push({
          target: venue.exchangeId,
          reason: `ccxt.${venue.providerExchangeId} returned no derivative tickers`,
        });
      }

      recordDerivativesVenueRefreshState({
        exchangeId: venue.exchangeId,
        providerExchangeId: venue.providerExchangeId,
        status,
        attemptedAt: sourceFetchedAt,
        succeededAt: tickers.length > 0 ? sourceFetchedAt : null,
        tickersFetched: tickers.length,
        tickersWritten: ingestion.tickers_written,
        lastError: null,
      });
      results.push(result);
    } catch (error) {
      const reason = formatDerivativesSyncError(error);
      partialFailures.push({
        target: venue.exchangeId,
        reason,
      });
      recordDerivativesVenueRefreshState({
        exchangeId: venue.exchangeId,
        providerExchangeId: venue.providerExchangeId,
        status: 'error',
        attemptedAt: sourceFetchedAt,
        succeededAt: null,
        tickersFetched: 0,
        tickersWritten: 0,
        lastError: reason,
      });
      results.push({
        exchange_id: venue.exchangeId,
        provider_exchange_id: venue.providerExchangeId,
        status: 'error',
        tickers_fetched: 0,
        tickers_written: 0,
        last_error: reason,
      });
    }
  }

  return {
    venues_attempted: options.venues.length,
    tickers_fetched: results.reduce((total, result) => total + result.tickers_fetched, 0),
    tickers_written: results.reduce((total, result) => total + result.tickers_written, 0),
    source_fetched_at: sourceFetchedAt.toISOString(),
    targetsProcessed: options.venues.length,
    rowsWritten: results.reduce((total, result) => total + result.tickers_written, 0),
    partialFailures,
    results,
  };
}
