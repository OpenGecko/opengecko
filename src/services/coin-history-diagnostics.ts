import type { AppDatabase } from '../db/client';
import { coinHistorySnapshots, coins } from '../db/schema';
import { parseCoinHistoryTargetConfig } from './coin-history-sync';

type CoinHistorySourceRow = typeof coinHistorySnapshots.$inferSelect;

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function candidateKey(coinId: string, date: string) {
  return `${coinId}:${date}`;
}

function latestDate(rows: CoinHistorySourceRow[]) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = row.sourceFetchedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function countSourceKind(rows: CoinHistorySourceRow[], sourceKind: 'replay' | 'live') {
  return rows.filter((row) => row.sourceKind === sourceKind).length;
}

export function buildCoinHistoryProviderDiagnostics(
  database: AppDatabase,
  configuredTargetText: string | undefined,
) {
  const configuredTargets = parseCoinHistoryTargetConfig(configuredTargetText);
  const coinRows = database.db.select().from(coins).all();
  const historyRows = database.db.select().from(coinHistorySnapshots).all();

  const candidateKeys = new Set<string>();
  for (const target of configuredTargets) {
    candidateKeys.add(candidateKey(target.coinId, target.date));
  }
  for (const row of historyRows) {
    candidateKeys.add(candidateKey(row.coinId, dateKey(row.snapshotAt)));
  }

  const historyDiagnostics = [...candidateKeys].sort().map((key) => {
    const [coinId = '', date = ''] = key.split(':', 2);
    const configuredTarget = configuredTargets.find((target) => target.coinId === coinId && target.date === date) ?? null;
    const coin = coinRows.find((row) => row.id === coinId) ?? null;
    const coinDateRows = historyRows.filter((row) => row.coinId === coinId && dateKey(row.snapshotAt) === date);
    const liveRows = coinDateRows.filter((row) => row.sourceKind === 'live');
    const replayRows = coinDateRows.filter((row) => row.sourceKind === 'replay');
    const status = liveRows.length > 0
      ? 'live_backed'
      : replayRows.length > 0
        ? 'replay_backed'
        : configuredTarget
          ? 'configured_pending'
          : coin
            ? 'fallback_only'
            : 'missing';
    const sourceProviders = [...new Set(coinDateRows
      .map((row) => row.sourceProvider)
      .filter((provider): provider is string => Boolean(provider)))].sort();

    return {
      coin_id: coinId,
      date,
      status,
      configured_provider: configuredTarget?.provider ?? null,
      source_providers: sourceProviders,
      row_counts: {
        total: coinDateRows.length,
        live: countSourceKind(coinDateRows, 'live'),
        replay: countSourceKind(coinDateRows, 'replay'),
      },
      latest_source_fetched_at: latestDate(coinDateRows)?.toISOString() ?? null,
    };
  });

  const coinsWithoutHistoryRows = coinRows
    .filter((coin) => !historyRows.some((row) => row.coinId === coin.id))
    .map((coin) => coin.id)
    .sort();

  return {
    configured_targets: configuredTargets.map((target) => ({
      provider: target.provider,
      coin_id: target.coinId,
      date: target.date,
      source_provider: target.provider,
    })),
    histories: historyDiagnostics,
    gaps: {
      configured_without_source_rows: historyDiagnostics
        .filter((history) => history.configured_provider !== null && history.latest_source_fetched_at === null)
        .map((history) => candidateKey(history.coin_id, history.date)),
      fallback_only_coins: coinsWithoutHistoryRows,
      missing_coin_dates: historyDiagnostics
        .filter((history) => history.status === 'missing')
        .map((history) => candidateKey(history.coin_id, history.date)),
    },
    notes: 'Configured coin history targets without source rows may be unsupported, failed, or not yet synced; fallback-only coin history uses seeded chart/current snapshot blending and must not be advertised as live history.',
  };
}
