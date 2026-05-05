import type { AppDatabase } from '../db/client';
import { exchangeVolumeSourcePoints, exchanges } from '../db/schema';
import { parseExchangeVolumeTargetConfig } from './exchange-volume-sync';

type ExchangeVolumeSourceRow = typeof exchangeVolumeSourcePoints.$inferSelect;

function latestDate(rows: ExchangeVolumeSourceRow[]) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = row.sourceFetchedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function countSourceKind(rows: ExchangeVolumeSourceRow[], sourceKind: 'replay' | 'live') {
  return rows.filter((row) => row.sourceKind === sourceKind).length;
}

export function buildExchangeVolumeProviderDiagnostics(
  database: AppDatabase,
  configuredTargetText: string | undefined,
) {
  const configuredTargets = parseExchangeVolumeTargetConfig(configuredTargetText);
  const exchangeRows = database.db.select().from(exchanges).all();
  const volumeRows = database.db.select().from(exchangeVolumeSourcePoints).all();

  const candidateExchangeIds = new Set<string>();
  for (const target of configuredTargets) {
    candidateExchangeIds.add(target.exchangeId);
  }
  for (const row of volumeRows) {
    candidateExchangeIds.add(row.exchangeId);
  }
  for (const exchange of exchangeRows) {
    candidateExchangeIds.add(exchange.id);
  }

  const exchangeDiagnostics = [...candidateExchangeIds].sort().map((exchangeId) => {
    const configuredTarget = configuredTargets.find((target) => target.exchangeId === exchangeId) ?? null;
    const exchange = exchangeRows.find((row) => row.id === exchangeId) ?? null;
    const exchangeVolumeRows = volumeRows.filter((row) => row.exchangeId === exchangeId);
    const liveRows = exchangeVolumeRows.filter((row) => row.sourceKind === 'live');
    const replayRows = exchangeVolumeRows.filter((row) => row.sourceKind === 'replay');
    const status = liveRows.length > 0
      ? 'live_backed'
      : replayRows.length > 0
        ? 'replay_backed'
        : configuredTarget
          ? 'configured_pending'
          : exchange
            ? 'fixture_only'
            : 'missing';
    const sourceProviders = [...new Set(exchangeVolumeRows
      .map((row) => row.sourceProvider)
      .filter((provider): provider is string => Boolean(provider)))].sort();

    return {
      exchange_id: exchangeId,
      status,
      configured_provider: configuredTarget?.provider ?? null,
      source_providers: sourceProviders,
      row_counts: {
        total: exchangeVolumeRows.length,
        live: countSourceKind(exchangeVolumeRows, 'live'),
        replay: countSourceKind(exchangeVolumeRows, 'replay'),
      },
      latest_source_fetched_at: latestDate(exchangeVolumeRows)?.toISOString() ?? null,
    };
  });

  return {
    configured_targets: configuredTargets.map((target) => ({
      provider: target.provider,
      exchange_id: target.exchangeId,
      source_provider: target.provider,
    })),
    exchanges: exchangeDiagnostics,
    gaps: {
      configured_without_source_rows: exchangeDiagnostics
        .filter((exchange) => exchange.configured_provider !== null && exchange.latest_source_fetched_at === null)
        .map((exchange) => exchange.exchange_id),
      fixture_only_exchanges: exchangeDiagnostics
        .filter((exchange) => exchange.status === 'fixture_only')
        .map((exchange) => exchange.exchange_id),
      missing_exchanges: exchangeDiagnostics
        .filter((exchange) => exchange.status === 'missing')
        .map((exchange) => exchange.exchange_id),
    },
    notes: 'Configured exchange volume targets without source rows may be unsupported, failed, or not yet synced; fixture-only exchanges must not be advertised as live volume charts.',
  };
}
