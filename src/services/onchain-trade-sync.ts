import type { AppDatabase } from '../db/client';
import { normalizeAddress } from '../modules/onchain/helpers';
import {
  ingestOnchainTradeReplay,
  type RawOnchainTradeReplay,
} from './onchain-trade-ingestion';
import { enforceSnapshotRetention } from './snapshot-retention';

const DEFAULT_TIMEOUT_MS = 15_000;

export type OnchainTradeSyncTarget = {
  provider: string;
  networkId: string;
  poolAddress: string;
};

export type OnchainTradeSyncFetcher = (
  target: OnchainTradeSyncTarget,
) => Promise<RawOnchainTradeReplay | null>;

export type OnchainTradeSyncOptions = {
  targets: OnchainTradeSyncTarget[];
  fetcher?: OnchainTradeSyncFetcher;
  providerBaseUrl?: string;
  now?: Date;
};

export function parseOnchainTradeTargetConfig(value: string | undefined): OnchainTradeSyncTarget[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [providerPart, targetPart] = entry.includes('=') ? entry.split('=', 2) : ['custom', entry];
      const target = targetPart ?? '';
      const separatorIndex = target.indexOf(':');

      if (!providerPart?.trim() || separatorIndex <= 0 || separatorIndex === target.length - 1) {
        throw new Error(`Invalid onchain trade target config entry: ${entry}`);
      }

      return {
        provider: providerPart.trim(),
        networkId: target.slice(0, separatorIndex).trim().toLowerCase(),
        poolAddress: normalizeAddress(target.slice(separatorIndex + 1).trim()),
      };
    });
}

export function createHttpOnchainTradeFetcher(
  providerBaseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): OnchainTradeSyncFetcher {
  const baseUrl = providerBaseUrl?.replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('ONCHAIN_TRADE_BASE_URL is required when using the default onchain trade fetcher');
  }

  return async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const url = `${baseUrl}/providers/${encodeURIComponent(target.provider)}/networks/${encodeURIComponent(target.networkId)}/pools/${encodeURIComponent(target.poolAddress)}/trades`;

    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Onchain trade provider request failed with status ${response.status}`);
      }

      const raw = await response.json() as Partial<RawOnchainTradeReplay>;

      return {
        provider: raw.provider ?? target.provider,
        captured_at: raw.captured_at ?? new Date().toISOString(),
        network_id: raw.network_id ?? target.networkId,
        pool_address: raw.pool_address ?? target.poolAddress,
        trades: raw.trades ?? [],
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function syncOnchainTrades(database: AppDatabase, options: OnchainTradeSyncOptions) {
  const sourceFetchedAt = options.now ?? new Date();
  const fetcher = options.fetcher ?? createHttpOnchainTradeFetcher(options.providerBaseUrl);
  const results = [];

  for (const target of options.targets) {
    const raw = await fetcher(target);

    if (!raw) {
      results.push({
        provider: target.provider,
        network_id: target.networkId,
        pool_address: target.poolAddress,
        trades_fetched: 0,
        trades_written: 0,
      });
      continue;
    }

    const ingestion = ingestOnchainTradeReplay(database, raw, {
      sourceKind: 'live',
      sourceProvider: target.provider,
      sourceFetchedAt,
    });

    results.push({
      provider: target.provider,
      network_id: ingestion.network_id,
      pool_address: ingestion.pool_address,
      trades_fetched: raw.trades?.length ?? 0,
      trades_written: ingestion.trades_written,
    });
  }

  const tradesWritten = results.reduce((total, result) => total + result.trades_written, 0);
  const retention = tradesWritten > 0
    ? enforceSnapshotRetention(database, { now: sourceFetchedAt })
    : null;

  return {
    targets_attempted: options.targets.length,
    trades_fetched: results.reduce((total, result) => total + result.trades_fetched, 0),
    trades_written: tradesWritten,
    rows_pruned: retention?.totalRowsPruned ?? 0,
    source_fetched_at: sourceFetchedAt.toISOString(),
    results,
  };
}
