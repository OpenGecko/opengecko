import type { AppDatabase } from '../db/client';
import { normalizeAddress } from '../modules/onchain/helpers';
import {
  ingestOnchainAnalytics,
  type RawOnchainAnalyticsReplay,
} from './onchain-analytics-ingestion';

const DEFAULT_TIMEOUT_MS = 15_000;

export type OnchainAnalyticsSyncTarget = {
  provider: string;
  networkId: string;
  tokenAddress: string;
};

export type OnchainAnalyticsSyncFetcher = (
  target: OnchainAnalyticsSyncTarget,
) => Promise<RawOnchainAnalyticsReplay | null>;

export type OnchainAnalyticsSyncOptions = {
  targets: OnchainAnalyticsSyncTarget[];
  fetcher?: OnchainAnalyticsSyncFetcher;
  providerBaseUrl?: string;
  now?: Date;
};

export function parseOnchainAnalyticsTargetConfig(value: string | undefined): OnchainAnalyticsSyncTarget[] {
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
        throw new Error(`Invalid onchain analytics target config entry: ${entry}`);
      }

      return {
        provider: providerPart.trim(),
        networkId: target.slice(0, separatorIndex).trim().toLowerCase(),
        tokenAddress: normalizeAddress(target.slice(separatorIndex + 1).trim()),
      };
    });
}

export function createHttpOnchainAnalyticsFetcher(
  providerBaseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): OnchainAnalyticsSyncFetcher {
  const baseUrl = providerBaseUrl?.replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('ONCHAIN_ANALYTICS_BASE_URL is required when using the default onchain analytics fetcher');
  }

  return async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const url = `${baseUrl}/providers/${encodeURIComponent(target.provider)}/networks/${encodeURIComponent(target.networkId)}/tokens/${encodeURIComponent(target.tokenAddress)}/analytics`;

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
        throw new Error(`Onchain analytics provider request failed with status ${response.status}`);
      }

      const raw = await response.json() as Partial<RawOnchainAnalyticsReplay>;

      return {
        provider: raw.provider ?? target.provider,
        captured_at: raw.captured_at ?? new Date().toISOString(),
        network_id: raw.network_id ?? target.networkId,
        token_address: raw.token_address ?? target.tokenAddress,
        holders: raw.holders ?? [],
        traders: raw.traders ?? [],
        holders_chart: raw.holders_chart ?? [],
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function syncOnchainAnalytics(database: AppDatabase, options: OnchainAnalyticsSyncOptions) {
  const sourceFetchedAt = options.now ?? new Date();
  const fetcher = options.fetcher ?? createHttpOnchainAnalyticsFetcher(options.providerBaseUrl);
  const results = [];

  for (const target of options.targets) {
    const raw = await fetcher(target);

    if (!raw) {
      results.push({
        provider: target.provider,
        network_id: target.networkId,
        token_address: target.tokenAddress,
        holders_fetched: 0,
        traders_fetched: 0,
        holder_counts_fetched: 0,
        holders_written: 0,
        traders_written: 0,
        holder_counts_written: 0,
      });
      continue;
    }

    const ingestion = ingestOnchainAnalytics(database, raw, {
      sourceKind: 'live',
      sourceProvider: target.provider,
      sourceFetchedAt,
    });

    results.push({
      provider: target.provider,
      network_id: ingestion.network_id,
      token_address: ingestion.token_address,
      holders_fetched: raw.holders?.length ?? 0,
      traders_fetched: raw.traders?.length ?? 0,
      holder_counts_fetched: raw.holders_chart?.length ?? 0,
      holders_written: ingestion.holders_written,
      traders_written: ingestion.traders_written,
      holder_counts_written: ingestion.holder_counts_written,
    });
  }

  return {
    targets_attempted: options.targets.length,
    holders_fetched: results.reduce((total, result) => total + result.holders_fetched, 0),
    traders_fetched: results.reduce((total, result) => total + result.traders_fetched, 0),
    holder_counts_fetched: results.reduce((total, result) => total + result.holder_counts_fetched, 0),
    holders_written: results.reduce((total, result) => total + result.holders_written, 0),
    traders_written: results.reduce((total, result) => total + result.traders_written, 0),
    holder_counts_written: results.reduce((total, result) => total + result.holder_counts_written, 0),
    source_fetched_at: sourceFetchedAt.toISOString(),
    results,
  };
}
