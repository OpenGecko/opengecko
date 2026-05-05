import type { AppDatabase } from '../db/client';
import { coins, marketChartSourcePoints } from '../db/schema';
import { parseMarketChartTargetConfig } from './market-chart-sync';

type MarketChartSourceRow = typeof marketChartSourcePoints.$inferSelect;

function candidateKey(coinId: string, vsCurrency: string, interval: string) {
  return `${coinId}:${vsCurrency}:${interval}`;
}

function latestDate(rows: MarketChartSourceRow[]) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = row.sourceFetchedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function countSourceKind(rows: MarketChartSourceRow[], sourceKind: 'replay' | 'live') {
  return rows.filter((row) => row.sourceKind === sourceKind).length;
}

export function buildMarketChartProviderDiagnostics(
  database: AppDatabase,
  configuredTargetText: string | undefined,
) {
  const configuredTargets = parseMarketChartTargetConfig(configuredTargetText);
  const coinRows = database.db.select().from(coins).all();
  const chartRows = database.db.select().from(marketChartSourcePoints).all();

  const candidateKeys = new Set<string>();
  for (const target of configuredTargets) {
    candidateKeys.add(candidateKey(target.coinId, target.vsCurrency, target.interval));
  }
  for (const row of chartRows) {
    candidateKeys.add(candidateKey(row.coinId, row.vsCurrency, row.interval));
  }
  for (const coin of coinRows) {
    candidateKeys.add(candidateKey(coin.id, 'usd', '1d'));
  }

  const coinDiagnostics = [...candidateKeys].sort().map((key) => {
    const [coinId = '', vsCurrency = '', interval = ''] = key.split(':', 3);
    const configuredTarget = configuredTargets.find((target) =>
      target.coinId === coinId && target.vsCurrency === vsCurrency && target.interval === interval) ?? null;
    const coin = coinRows.find((row) => row.id === coinId) ?? null;
    const coinChartRows = chartRows.filter((row) =>
      row.coinId === coinId && row.vsCurrency === vsCurrency && row.interval === interval);
    const liveRows = coinChartRows.filter((row) => row.sourceKind === 'live');
    const replayRows = coinChartRows.filter((row) => row.sourceKind === 'replay');
    const status = liveRows.length > 0
      ? 'live_backed'
      : replayRows.length > 0
        ? 'replay_backed'
        : configuredTarget
          ? 'configured_pending'
          : coin
            ? 'fallback_only'
            : 'missing';
    const sourceProviders = [...new Set(coinChartRows
      .map((row) => row.sourceProvider)
      .filter((provider): provider is string => Boolean(provider)))].sort();

    return {
      coin_id: coinId,
      vs_currency: vsCurrency,
      interval,
      status,
      configured_provider: configuredTarget?.provider ?? null,
      source_providers: sourceProviders,
      row_counts: {
        total: coinChartRows.length,
        live: countSourceKind(coinChartRows, 'live'),
        replay: countSourceKind(coinChartRows, 'replay'),
      },
      latest_source_fetched_at: latestDate(coinChartRows)?.toISOString() ?? null,
    };
  });

  return {
    configured_targets: configuredTargets.map((target) => ({
      provider: target.provider,
      coin_id: target.coinId,
      vs_currency: target.vsCurrency,
      interval: target.interval,
      source_provider: target.provider,
    })),
    coins: coinDiagnostics,
    gaps: {
      configured_without_source_rows: coinDiagnostics
        .filter((coin) => coin.configured_provider !== null && coin.latest_source_fetched_at === null)
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
      fallback_only_coins: coinDiagnostics
        .filter((coin) => coin.status === 'fallback_only')
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
      missing_coin_charts: coinDiagnostics
        .filter((coin) => coin.status === 'missing')
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
    },
    notes: 'Configured market chart targets without source rows may be unsupported, failed, or not yet synced; fallback-only market charts use seeded OHLCV/current snapshot blending and must not be advertised as live chart history.',
  };
}
