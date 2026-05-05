import type { AppDatabase } from '../db/client';
import { onchainPoolTrades, onchainPools } from '../db/schema';
import { parseOnchainTradeTargetConfig } from './onchain-trade-sync';

type TradeSourceRow = typeof onchainPoolTrades.$inferSelect;

function poolKey(networkId: string, poolAddress: string) {
  return `${networkId}:${poolAddress}`;
}

function latestDate(rows: TradeSourceRow[]) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = row.sourceFetchedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function countSourceKind(rows: TradeSourceRow[], sourceKind: 'replay' | 'live') {
  return rows.filter((row) => row.sourceKind === sourceKind).length;
}

export function buildOnchainTradeProviderDiagnostics(
  database: AppDatabase,
  configuredTargetText: string | undefined,
) {
  const configuredTargets = parseOnchainTradeTargetConfig(configuredTargetText);
  const poolRows = database.db.select().from(onchainPools).all();
  const tradeRows = database.db.select().from(onchainPoolTrades).all();

  const candidateKeys = new Set<string>();
  for (const target of configuredTargets) {
    candidateKeys.add(poolKey(target.networkId, target.poolAddress));
  }
  for (const trade of tradeRows) {
    candidateKeys.add(poolKey(trade.networkId, trade.poolAddress));
  }
  for (const pool of poolRows) {
    candidateKeys.add(poolKey(pool.networkId, pool.address));
  }

  const pools = [...candidateKeys].sort().map((key) => {
    const [networkId, poolAddress] = key.split(':');
    const configuredTarget = configuredTargets.find((target) => poolKey(target.networkId, target.poolAddress) === key) ?? null;
    const pool = poolRows.find((row) => poolKey(row.networkId, row.address) === key) ?? null;
    const poolTrades = tradeRows.filter((row) => poolKey(row.networkId, row.poolAddress) === key);
    const liveRows = poolTrades.filter((row) => row.sourceKind === 'live');
    const replayRows = poolTrades.filter((row) => row.sourceKind === 'replay');
    const status = liveRows.length > 0
      ? 'live_backed'
      : replayRows.length > 0
        ? 'replay_backed'
        : configuredTarget
          ? 'configured_pending'
          : pool
            ? 'fixture_only'
            : 'missing';
    const sourceProviders = [...new Set(poolTrades
      .map((row) => row.sourceProvider)
      .filter((provider): provider is string => Boolean(provider)))].sort();
    const tokenAddresses = [...new Set(poolTrades.map((row) => row.tokenAddress))].sort();

    return {
      network_id: networkId,
      pool_address: poolAddress,
      status,
      configured_provider: configuredTarget?.provider ?? null,
      source_providers: sourceProviders,
      row_counts: {
        total: poolTrades.length,
        live: countSourceKind(poolTrades, 'live'),
        replay: countSourceKind(poolTrades, 'replay'),
      },
      tokens: tokenAddresses.map((tokenAddress) => {
        const tokenRows = poolTrades.filter((row) => row.tokenAddress === tokenAddress);

        return {
          token_address: tokenAddress,
          row_counts: {
            total: tokenRows.length,
            live: countSourceKind(tokenRows, 'live'),
            replay: countSourceKind(tokenRows, 'replay'),
          },
        };
      }),
      latest_source_fetched_at: latestDate(poolTrades)?.toISOString() ?? null,
    };
  });

  return {
    configured_targets: configuredTargets.map((target) => ({
      provider: target.provider,
      network_id: target.networkId,
      pool_address: target.poolAddress,
      source_provider: target.provider,
    })),
    pools,
    gaps: {
      configured_without_source_rows: pools
        .filter((pool) => pool.configured_provider !== null && pool.latest_source_fetched_at === null)
        .map((pool) => `${pool.network_id}:${pool.pool_address}`),
      fixture_only_pools: pools
        .filter((pool) => pool.status === 'fixture_only')
        .map((pool) => `${pool.network_id}:${pool.pool_address}`),
      missing_pools: pools
        .filter((pool) => pool.status === 'missing')
        .map((pool) => `${pool.network_id}:${pool.pool_address}`),
    },
    notes: 'Configured onchain trade targets without source rows may be unsupported, failed, or not yet synced; fixture-only pools must not be advertised as live trades.',
  };
}
