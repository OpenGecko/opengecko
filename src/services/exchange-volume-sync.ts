import type { AppDatabase } from '../db/client';
import {
  ingestExchangeVolumeReplay,
  type RawExchangeVolumeReplay,
} from './exchange-volume-ingestion';
import { enforceSnapshotRetention } from './snapshot-retention';

const DEFAULT_TIMEOUT_MS = 15_000;

export type ExchangeVolumeSyncTarget = {
  provider: string;
  exchangeId: string;
};

export type ExchangeVolumeSyncFetcher = (
  target: ExchangeVolumeSyncTarget,
) => Promise<RawExchangeVolumeReplay | null>;

export type ExchangeVolumeSyncOptions = {
  targets: ExchangeVolumeSyncTarget[];
  fetcher?: ExchangeVolumeSyncFetcher;
  providerBaseUrl?: string;
  now?: Date;
};

export function parseExchangeVolumeTargetConfig(value: string | undefined): ExchangeVolumeSyncTarget[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [providerPart, exchangePart] = entry.includes('=') ? entry.split('=', 2) : ['custom', entry];
      const provider = providerPart?.trim();
      const exchangeId = exchangePart?.trim().toLowerCase();

      if (!provider || !exchangeId) {
        throw new Error(`Invalid exchange volume target config entry: ${entry}`);
      }

      return {
        provider,
        exchangeId,
      };
    });
}

export function createHttpExchangeVolumeFetcher(
  providerBaseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): ExchangeVolumeSyncFetcher {
  const baseUrl = providerBaseUrl?.replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('EXCHANGE_VOLUME_BASE_URL is required when using the default exchange volume fetcher');
  }

  return async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const url = `${baseUrl}/providers/${encodeURIComponent(target.provider)}/exchanges/${encodeURIComponent(target.exchangeId)}/volume_chart`;

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
        throw new Error(`Exchange volume provider request failed with status ${response.status}`);
      }

      const raw = await response.json() as Partial<RawExchangeVolumeReplay>;

      return {
        provider: raw.provider ?? target.provider,
        captured_at: raw.captured_at ?? new Date().toISOString(),
        exchange_id: raw.exchange_id ?? target.exchangeId,
        points: raw.points ?? [],
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function syncExchangeVolumes(database: AppDatabase, options: ExchangeVolumeSyncOptions) {
  const sourceFetchedAt = options.now ?? new Date();
  const fetcher = options.fetcher ?? createHttpExchangeVolumeFetcher(options.providerBaseUrl);
  const results = [];

  for (const target of options.targets) {
    const raw = await fetcher(target);

    if (!raw) {
      results.push({
        provider: target.provider,
        exchange_id: target.exchangeId,
        points_fetched: 0,
        points_written: 0,
      });
      continue;
    }

    const ingestion = ingestExchangeVolumeReplay(database, raw, {
      sourceKind: 'live',
      sourceProvider: target.provider,
      sourceFetchedAt,
    });

    results.push({
      provider: target.provider,
      exchange_id: ingestion.exchange_id,
      points_fetched: raw.points?.length ?? 0,
      points_written: ingestion.points_written,
    });
  }

  const pointsWritten = results.reduce((total, result) => total + result.points_written, 0);
  const retention = pointsWritten > 0
    ? enforceSnapshotRetention(database, { now: sourceFetchedAt })
    : null;

  return {
    targets_attempted: options.targets.length,
    points_fetched: results.reduce((total, result) => total + result.points_fetched, 0),
    points_written: pointsWritten,
    rows_pruned: retention?.totalRowsPruned ?? 0,
    source_fetched_at: sourceFetchedAt.toISOString(),
    results,
  };
}
