import type { AppDatabase } from '../db/client';
import { onchainPools, onchainTokenHolderCounts, onchainTokenHolders, onchainTokenTraders } from '../db/schema';
import { parseOnchainAnalyticsTargetConfig } from './onchain-analytics-sync';

type AnalyticsSourceRow = {
  networkId: string;
  tokenAddress: string;
  sourceKind: 'replay' | 'live';
  sourceProvider: string | null;
  sourceFetchedAt: Date | null;
};

function tokenKey(networkId: string, tokenAddress: string) {
  return `${networkId}:${tokenAddress}`;
}

function latestDate(rows: AnalyticsSourceRow[]) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = row.sourceFetchedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function countSourceKind(rows: AnalyticsSourceRow[], sourceKind: 'replay' | 'live') {
  return rows.filter((row) => row.sourceKind === sourceKind).length;
}

export function buildOnchainAnalyticsProviderDiagnostics(
  database: AppDatabase,
  configuredTargetText: string | undefined,
) {
  const configuredTargets = parseOnchainAnalyticsTargetConfig(configuredTargetText);
  const poolRows = database.db.select().from(onchainPools).all();
  const holderRows = database.db.select().from(onchainTokenHolders).all();
  const traderRows = database.db.select().from(onchainTokenTraders).all();
  const holderCountRows = database.db.select().from(onchainTokenHolderCounts).all();
  const sourceRows: AnalyticsSourceRow[] = [
    ...holderRows,
    ...traderRows.map((row) => ({
      networkId: row.networkId,
      tokenAddress: row.tokenAddress,
      sourceKind: row.sourceKind,
      sourceProvider: row.sourceProvider,
      sourceFetchedAt: row.sourceFetchedAt,
    })),
    ...holderCountRows.map((row) => ({
      networkId: row.networkId,
      tokenAddress: row.tokenAddress,
      sourceKind: row.sourceKind,
      sourceProvider: row.sourceProvider,
      sourceFetchedAt: row.sourceFetchedAt,
    })),
  ];

  const candidateKeys = new Set<string>();
  for (const target of configuredTargets) {
    candidateKeys.add(tokenKey(target.networkId, target.tokenAddress));
  }
  for (const row of sourceRows) {
    candidateKeys.add(tokenKey(row.networkId, row.tokenAddress));
  }
  for (const pool of poolRows) {
    candidateKeys.add(tokenKey(pool.networkId, pool.baseTokenAddress));
    candidateKeys.add(tokenKey(pool.networkId, pool.quoteTokenAddress));
  }

  const tokens = [...candidateKeys].sort().map((key) => {
    const [networkId, tokenAddress] = key.split(':');
    const configuredTarget = configuredTargets.find((target) => tokenKey(target.networkId, target.tokenAddress) === key) ?? null;
    const holders = holderRows.filter((row) => tokenKey(row.networkId, row.tokenAddress) === key);
    const traders = traderRows.filter((row) => tokenKey(row.networkId, row.tokenAddress) === key);
    const holderCounts = holderCountRows.filter((row) => tokenKey(row.networkId, row.tokenAddress) === key);
    const tokenSourceRows = sourceRows.filter((row) => tokenKey(row.networkId, row.tokenAddress) === key);
    const liveRows = tokenSourceRows.filter((row) => row.sourceKind === 'live');
    const replayRows = tokenSourceRows.filter((row) => row.sourceKind === 'replay');
    const hasPools = poolRows.some((pool) =>
      pool.networkId === networkId
      && (pool.baseTokenAddress === tokenAddress || pool.quoteTokenAddress === tokenAddress));
    const status = liveRows.length > 0
      ? 'live_backed'
      : replayRows.length > 0
        ? 'replay_backed'
        : configuredTarget
          ? 'configured_pending'
          : hasPools
            ? 'fixture_only'
            : 'missing';
    const sourceProviders = [...new Set(tokenSourceRows
      .map((row) => row.sourceProvider)
      .filter((provider): provider is string => Boolean(provider)))].sort();

    return {
      network_id: networkId,
      token_address: tokenAddress,
      status,
      configured_provider: configuredTarget?.provider ?? null,
      source_providers: sourceProviders,
      row_counts: {
        holders: {
          total: holders.length,
          live: countSourceKind(holders, 'live'),
          replay: countSourceKind(holders, 'replay'),
        },
        traders: {
          total: traders.length,
          live: countSourceKind(traders, 'live'),
          replay: countSourceKind(traders, 'replay'),
        },
        holder_counts: {
          total: holderCounts.length,
          live: countSourceKind(holderCounts, 'live'),
          replay: countSourceKind(holderCounts, 'replay'),
        },
      },
      latest_source_fetched_at: latestDate(tokenSourceRows)?.toISOString() ?? null,
    };
  });

  return {
    configured_targets: configuredTargets.map((target) => ({
      provider: target.provider,
      network_id: target.networkId,
      token_address: target.tokenAddress,
      source_provider: target.provider,
    })),
    tokens,
    gaps: {
      configured_without_source_rows: tokens
        .filter((token) => token.configured_provider !== null && token.latest_source_fetched_at === null)
        .map((token) => `${token.network_id}:${token.token_address}`),
      fixture_only_tokens: tokens
        .filter((token) => token.status === 'fixture_only')
        .map((token) => `${token.network_id}:${token.token_address}`),
      missing_tokens: tokens
        .filter((token) => token.status === 'missing')
        .map((token) => `${token.network_id}:${token.token_address}`),
    },
    notes: 'Configured onchain analytics targets without source rows may be unsupported, failed, or not yet synced; fixture-only tokens must not be advertised as live analytics.',
  };
}
