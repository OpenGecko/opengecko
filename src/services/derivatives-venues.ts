import type { AppDatabase } from '../db/client';
import { derivativeTickers, derivativesExchanges } from '../db/schema';

export type DerivativesSyncVenue = {
  exchangeId: string;
  providerExchangeId: string;
};

export function parseDerivativeVenueConfig(value: string | undefined): DerivativesSyncVenue[] {
  if (!value?.trim()) {
    return [];
  }

  return value.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [exchangeId, providerExchangeId = exchangeId] = entry.split('=').map((part) => part.trim());

      return {
        exchangeId,
        providerExchangeId,
      };
    });
}

function latestDate(rows: Array<{ sourceFetchedAt: Date | null; lastTradedAt: Date | null }>) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = row.sourceFetchedAt ?? row.lastTradedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

export function buildDerivativesProviderDiagnostics(
  database: AppDatabase,
  configuredVenueText: string | undefined,
) {
  const configuredVenues = parseDerivativeVenueConfig(configuredVenueText);
  const exchangeRows = database.db.select().from(derivativesExchanges).all();
  const tickerRows = database.db.select().from(derivativeTickers).all();

  const exchanges = exchangeRows.map((exchange) => {
    const configuredVenue = configuredVenues.find((venue) => venue.exchangeId === exchange.id) ?? null;
    const exchangeTickers = tickerRows.filter((ticker) => ticker.exchangeId === exchange.id);
    const sourceBackedTickers = exchangeTickers.filter((ticker) => ticker.sourceKind !== 'seed');
    const sourceProviders = [...new Set(sourceBackedTickers
      .map((ticker) => ticker.sourceProvider)
      .filter((provider): provider is string => Boolean(provider)))].sort();
    const status = sourceBackedTickers.length > 0
      ? 'source_backed'
      : configuredVenue
        ? 'configured_pending'
        : exchangeTickers.length > 0
          ? 'fixture_only'
          : 'missing';

    return {
      exchange_id: exchange.id,
      name: exchange.name,
      status,
      configured_provider_exchange_id: configuredVenue?.providerExchangeId ?? null,
      source_providers: sourceProviders,
      ticker_counts: {
        total: exchangeTickers.length,
        source_backed: sourceBackedTickers.length,
        fixture: Math.max(exchangeTickers.length - sourceBackedTickers.length, 0),
      },
      latest_source_fetched_at: latestDate(sourceBackedTickers)?.toISOString() ?? null,
    };
  });

  return {
    configured_venues: configuredVenues.map((venue) => ({
      exchange_id: venue.exchangeId,
      provider_exchange_id: venue.providerExchangeId,
      source_provider: `ccxt.${venue.providerExchangeId}`,
    })),
    exchanges,
    gaps: {
      configured_without_source_rows: configuredVenues
        .filter((venue) => !tickerRows.some((ticker) => ticker.exchangeId === venue.exchangeId && ticker.sourceKind !== 'seed'))
        .map((venue) => venue.exchangeId),
      fixture_only_exchanges: exchanges
        .filter((exchange) => exchange.status === 'fixture_only')
        .map((exchange) => exchange.exchange_id),
      missing_exchanges: exchanges
        .filter((exchange) => exchange.status === 'missing')
        .map((exchange) => exchange.exchange_id),
    },
    notes: 'Configured venues without source rows may be unsupported, failed, or not yet synced; fixture-only exchanges must not be advertised as live.',
  };
}
