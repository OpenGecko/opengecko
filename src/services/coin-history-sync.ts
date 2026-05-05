import type { AppDatabase } from '../db/client';
import {
  ingestCoinHistoryReplay,
  type RawCoinHistoryReplay,
} from './coin-history-ingestion';

const DEFAULT_TIMEOUT_MS = 15_000;

export type CoinHistorySyncTarget = {
  provider: string;
  coinId: string;
  date: string;
};

export type CoinHistorySyncFetcher = (
  target: CoinHistorySyncTarget,
) => Promise<RawCoinHistoryReplay | null>;

export type CoinHistorySyncOptions = {
  targets: CoinHistorySyncTarget[];
  fetcher?: CoinHistorySyncFetcher;
  providerBaseUrl?: string;
  now?: Date;
};

function parseTargetSelector(selector: string, entry: string) {
  const [coinPart, datePart] = selector.split(':', 2);
  const coinId = coinPart?.trim().toLowerCase();
  const date = datePart?.trim();

  if (!coinId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid coin history target config entry: ${entry}`);
  }

  return { coinId, date };
}

export function parseCoinHistoryTargetConfig(value: string | undefined): CoinHistorySyncTarget[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [providerPart, selectorPart] = entry.includes('=') ? entry.split('=', 2) : ['custom', entry];
      const provider = providerPart?.trim();
      const selector = selectorPart?.trim();

      if (!provider || !selector) {
        throw new Error(`Invalid coin history target config entry: ${entry}`);
      }

      return {
        provider,
        ...parseTargetSelector(selector, entry),
      };
    });
}

export function createHttpCoinHistoryFetcher(
  providerBaseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CoinHistorySyncFetcher {
  const baseUrl = providerBaseUrl?.replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('COIN_HISTORY_BASE_URL is required when using the default coin history fetcher');
  }

  return async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const url = `${baseUrl}/providers/${encodeURIComponent(target.provider)}/coins/${encodeURIComponent(target.coinId)}/history?date=${encodeURIComponent(target.date)}`;

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
        throw new Error(`Coin history provider request failed with status ${response.status}`);
      }

      const raw = await response.json() as Partial<RawCoinHistoryReplay>;

      if (!raw.market_data) {
        return null;
      }

      return {
        provider: raw.provider ?? target.provider,
        captured_at: raw.captured_at ?? new Date().toISOString(),
        coin_id: raw.coin_id ?? target.coinId,
        date: raw.date ?? target.date,
        vs_currency: raw.vs_currency,
        market_data: raw.market_data,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function syncCoinHistorySnapshots(database: AppDatabase, options: CoinHistorySyncOptions) {
  const sourceFetchedAt = options.now ?? new Date();
  const fetcher = options.fetcher ?? createHttpCoinHistoryFetcher(options.providerBaseUrl);
  const results = [];

  for (const target of options.targets) {
    const raw = await fetcher(target);

    if (!raw) {
      results.push({
        provider: target.provider,
        coin_id: target.coinId,
        date: target.date,
        snapshots_fetched: 0,
        snapshots_written: 0,
      });
      continue;
    }

    const ingestion = ingestCoinHistoryReplay(database, raw, {
      sourceKind: 'live',
      sourceProvider: target.provider,
      sourceFetchedAt,
    });

    results.push({
      provider: target.provider,
      coin_id: ingestion.coin_id,
      date: target.date,
      snapshots_fetched: 1,
      snapshots_written: ingestion.snapshots_written,
    });
  }

  return {
    targets_attempted: options.targets.length,
    snapshots_fetched: results.reduce((total, result) => total + result.snapshots_fetched, 0),
    snapshots_written: results.reduce((total, result) => total + result.snapshots_written, 0),
    source_fetched_at: sourceFetchedAt.toISOString(),
    results,
  };
}
