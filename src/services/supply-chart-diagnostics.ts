import type { AppDatabase } from '../db/client';
import { coins, supplyChartPoints } from '../db/schema';
import { parseSupplyChartTargetConfig } from './supply-chart-sync';

type SupplyChartSourceRow = typeof supplyChartPoints.$inferSelect;

function latestDate(rows: SupplyChartSourceRow[]) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = row.sourceFetchedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function countSourceKind(rows: SupplyChartSourceRow[], sourceKind: 'replay' | 'live') {
  return rows.filter((row) => row.sourceKind === sourceKind).length;
}

function buildSupplyTypeCounts(rows: SupplyChartSourceRow[], supplyType: 'circulating' | 'total') {
  const typedRows = rows.filter((row) => row.supplyType === supplyType);

  return {
    total: typedRows.length,
    live: countSourceKind(typedRows, 'live'),
    replay: countSourceKind(typedRows, 'replay'),
  };
}

export function buildSupplyChartProviderDiagnostics(
  database: AppDatabase,
  configuredTargetText: string | undefined,
) {
  const configuredTargets = parseSupplyChartTargetConfig(configuredTargetText);
  const coinRows = database.db.select().from(coins).all();
  const supplyRows = database.db.select().from(supplyChartPoints).all();

  const candidateCoinIds = new Set<string>();
  for (const target of configuredTargets) {
    candidateCoinIds.add(target.coinId);
  }
  for (const row of supplyRows) {
    candidateCoinIds.add(row.coinId);
  }
  for (const coin of coinRows) {
    candidateCoinIds.add(coin.id);
  }

  const coinDiagnostics = [...candidateCoinIds].sort().map((coinId) => {
    const configuredTarget = configuredTargets.find((target) => target.coinId === coinId) ?? null;
    const coin = coinRows.find((row) => row.id === coinId) ?? null;
    const coinSupplyRows = supplyRows.filter((row) => row.coinId === coinId);
    const liveRows = coinSupplyRows.filter((row) => row.sourceKind === 'live');
    const replayRows = coinSupplyRows.filter((row) => row.sourceKind === 'replay');
    const status = liveRows.length > 0
      ? 'live_backed'
      : replayRows.length > 0
        ? 'replay_backed'
        : configuredTarget
          ? 'configured_pending'
          : coin
            ? 'fixture_only'
            : 'missing';
    const sourceProviders = [...new Set(coinSupplyRows
      .map((row) => row.sourceProvider)
      .filter((provider): provider is string => Boolean(provider)))].sort();

    return {
      coin_id: coinId,
      status,
      configured_provider: configuredTarget?.provider ?? null,
      source_providers: sourceProviders,
      row_counts: {
        circulating: buildSupplyTypeCounts(coinSupplyRows, 'circulating'),
        total: buildSupplyTypeCounts(coinSupplyRows, 'total'),
      },
      latest_source_fetched_at: latestDate(coinSupplyRows)?.toISOString() ?? null,
    };
  });

  return {
    configured_targets: configuredTargets.map((target) => ({
      provider: target.provider,
      coin_id: target.coinId,
      source_provider: target.provider,
    })),
    coins: coinDiagnostics,
    gaps: {
      configured_without_source_rows: coinDiagnostics
        .filter((coin) => coin.configured_provider !== null && coin.latest_source_fetched_at === null)
        .map((coin) => coin.coin_id),
      fixture_only_coins: coinDiagnostics
        .filter((coin) => coin.status === 'fixture_only')
        .map((coin) => coin.coin_id),
      missing_coins: coinDiagnostics
        .filter((coin) => coin.status === 'missing')
        .map((coin) => coin.coin_id),
    },
    notes: 'Configured supply chart targets without source rows may be unsupported, failed, or not yet synced; fixture-only coins must not be advertised as live supply charts.',
  };
}
