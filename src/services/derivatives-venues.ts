import type { AppDatabase } from '../db/client';
import { derivativeTickers, derivativesExchanges } from '../db/schema';

export type DerivativesSyncVenue = {
  exchangeId: string;
  providerExchangeId: string;
};

export type DerivativesVenueRefreshState = {
  exchangeId: string;
  providerExchangeId: string;
  status: 'success' | 'unsupported_or_empty' | 'error';
  attemptedAt: Date;
  succeededAt: Date | null;
  tickersFetched: number;
  tickersWritten: number;
  lastError: string | null;
};

const derivativesVenueRefreshState = new Map<string, DerivativesVenueRefreshState>();

export function recordDerivativesVenueRefreshState(state: DerivativesVenueRefreshState) {
  derivativesVenueRefreshState.set(state.exchangeId, state);
}

export function resetDerivativesVenueRefreshStateForTests() {
  derivativesVenueRefreshState.clear();
}

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

function resolveConfiguredVenueStatus(options: {
  refreshDisabled?: boolean;
  configured: boolean;
  refreshState: DerivativesVenueRefreshState | null;
  sourceBackedCount: number;
  totalTickerCount: number;
}) {
  if (options.refreshDisabled && options.configured) {
    return 'disabled';
  }

  if (options.refreshState?.status === 'error') {
    return 'errored';
  }

  if (options.refreshState?.status === 'unsupported_or_empty') {
    return 'unsupported_or_empty';
  }

  if (options.sourceBackedCount > 0) {
    return 'source_backed';
  }

  if (options.configured) {
    return 'configured_pending';
  }

  return options.totalTickerCount > 0 ? 'fixture_only' : 'missing';
}

export function buildDerivativesProviderDiagnostics(
  database: AppDatabase,
  configuredVenueText: string | undefined,
  options: { refreshDisabled?: boolean } = {},
) {
  const configuredVenues = parseDerivativeVenueConfig(configuredVenueText);
  const exchangeRows = database.db.select().from(derivativesExchanges).all();
  const tickerRows = database.db.select().from(derivativeTickers).all();

  const exchanges = exchangeRows.map((exchange) => {
    const configuredVenue = configuredVenues.find((venue) => venue.exchangeId === exchange.id) ?? null;
    const refreshState = derivativesVenueRefreshState.get(exchange.id) ?? null;
    const exchangeTickers = tickerRows.filter((ticker) => ticker.exchangeId === exchange.id);
    const sourceBackedTickers = exchangeTickers.filter((ticker) => ticker.sourceKind !== 'seed');
    const sourceProviders = [...new Set(sourceBackedTickers
      .map((ticker) => ticker.sourceProvider)
      .filter((provider): provider is string => Boolean(provider)))].sort();
    const status = resolveConfiguredVenueStatus({
      refreshDisabled: options.refreshDisabled,
      configured: configuredVenue !== null,
      refreshState,
      sourceBackedCount: sourceBackedTickers.length,
      totalTickerCount: exchangeTickers.length,
    });

    return {
      exchange_id: exchange.id,
      name: exchange.name,
      status,
      configured_provider_exchange_id: configuredVenue?.providerExchangeId ?? null,
      enabled: Boolean(configuredVenue && !options.refreshDisabled),
      source_providers: sourceProviders,
      ticker_counts: {
        total: exchangeTickers.length,
        source_backed: sourceBackedTickers.length,
        fixture: Math.max(exchangeTickers.length - sourceBackedTickers.length, 0),
      },
      latest_source_fetched_at: latestDate(sourceBackedTickers)?.toISOString() ?? null,
      last_refresh_attempt_at: refreshState?.attemptedAt.toISOString() ?? null,
      last_refresh_success_at: refreshState?.succeededAt?.toISOString() ?? null,
      last_refresh_error: refreshState?.lastError ?? null,
      opt_out_reason: options.refreshDisabled && configuredVenue ? 'DERIVATIVES_REFRESH_DISABLED=true' : null,
    };
  });
  const exchangeIds = new Set(exchangeRows.map((row) => row.id));
  const missingConfiguredExchanges = configuredVenues
    .filter((venue) => !exchangeIds.has(venue.exchangeId))
    .map((venue) => {
      const refreshState = derivativesVenueRefreshState.get(venue.exchangeId) ?? null;
      return {
        exchange_id: venue.exchangeId,
        name: venue.exchangeId,
        status: resolveConfiguredVenueStatus({
          refreshDisabled: options.refreshDisabled,
          configured: true,
          refreshState,
          sourceBackedCount: 0,
          totalTickerCount: 0,
        }),
        configured_provider_exchange_id: venue.providerExchangeId,
        enabled: !options.refreshDisabled,
        source_providers: [],
        ticker_counts: {
          total: 0,
          source_backed: 0,
          fixture: 0,
        },
        latest_source_fetched_at: null,
        last_refresh_attempt_at: refreshState?.attemptedAt.toISOString() ?? null,
        last_refresh_success_at: refreshState?.succeededAt?.toISOString() ?? null,
        last_refresh_error: refreshState?.lastError ?? null,
        opt_out_reason: options.refreshDisabled ? 'DERIVATIVES_REFRESH_DISABLED=true' : null,
      };
    });
  const diagnosticExchanges = [...exchanges, ...missingConfiguredExchanges];

  return {
    configured_venues: configuredVenues.map((venue) => ({
      exchange_id: venue.exchangeId,
      provider_exchange_id: venue.providerExchangeId,
      source_provider: `ccxt.${venue.providerExchangeId}`,
    })),
    exchanges: diagnosticExchanges,
    gaps: {
      configured_without_source_rows: configuredVenues
        .filter((venue) => !tickerRows.some((ticker) => ticker.exchangeId === venue.exchangeId && ticker.sourceKind !== 'seed'))
        .map((venue) => venue.exchangeId),
      fixture_only_exchanges: diagnosticExchanges
        .filter((exchange) => exchange.status === 'fixture_only')
        .map((exchange) => exchange.exchange_id),
      missing_exchanges: diagnosticExchanges
        .filter((exchange) => exchange.status === 'missing')
        .map((exchange) => exchange.exchange_id),
      errored_exchanges: diagnosticExchanges
        .filter((exchange) => exchange.status === 'errored')
        .map((exchange) => exchange.exchange_id),
      disabled_exchanges: diagnosticExchanges
        .filter((exchange) => exchange.status === 'disabled')
        .map((exchange) => exchange.exchange_id),
    },
    notes: 'Configured venues without source rows may be disabled, unsupported, failed, or not yet synced; fixture-only exchanges must not be advertised as live.',
  };
}
