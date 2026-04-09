import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadRepoDotenv } from '../config/env';
import { createLogger } from '../lib/logger';
import {
  coingeckoSnapshotManifest,
  SNAPSHOT_CAPTURE_BOUND,
  type SnapshotManifest,
  type SnapshotManifestEntry,
} from './snapshot-manifest';

const COINGECKO_PRO_BASE_URL = 'https://pro-api.coingecko.com/api/v3';

type CaptureTerminalState = 'captured' | 'reused' | 'conditional_skip' | 'failed';

export type SnapshotCaptureOptions = {
  apiKey?: string | null;
  outputDir?: string;
  manifest?: SnapshotManifest;
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  capturedAt?: () => Date;
  logger?: ReturnType<typeof createLogger>;
};

export type SnapshotArtifactMetadata = {
  entryId: string;
  manifestId: string;
  manifestFormatVersion: number;
  artifactFormatVersion: number;
  path: string;
  normalizedPath: string;
  normalizedQuery: string;
  variantId: string;
  url: string;
  capturedAt: string;
  upstreamStatus: number;
  artifactRelativePath: string;
  payloadSha256: string;
  byteLength: number;
  reusedFromExisting: boolean;
  refreshed: boolean;
};

export type SnapshotIndexEntry = SnapshotArtifactMetadata & {
  state: CaptureTerminalState;
  errorMessage: string | null;
};

export type SnapshotCaptureSummary = {
  manifestId: string;
  manifestEntryCount: number;
  requestLimit: number;
  requestTotal: number;
  refresh: boolean;
  totals: Record<CaptureTerminalState, number>;
  entries: SnapshotIndexEntry[];
  indexPath: string;
};

function normalizeQuery(query: Record<string, string> | undefined) {
  if (!query || Object.keys(query).length === 0) {
    return '';
  }

  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function normalizedPath(entry: SnapshotManifestEntry) {
  const query = normalizeQuery(entry.query);
  return query.length > 0 ? `${entry.path}?${query}` : entry.path;
}

function variantId(entry: SnapshotManifestEntry) {
  return entry.variantId ?? entry.id;
}

function identityHash(entry: SnapshotManifestEntry) {
  return createHash('sha256').update(`${entry.id}:${normalizedPath(entry)}`).digest('hex').slice(0, 16);
}

function ensureManifestIsBounded(manifest: SnapshotManifest) {
  if (manifest.entries.length > manifest.maxRequests || manifest.entries.length > SNAPSHOT_CAPTURE_BOUND) {
    throw new Error(`Snapshot manifest exceeds bounded request limit (${manifest.entries.length} > ${Math.min(manifest.maxRequests, SNAPSHOT_CAPTURE_BOUND)}).`);
  }
}

function ensureManifestEntryIdentities(manifest: SnapshotManifest) {
  const seenIds = new Set<string>();
  const seenNormalizedPaths = new Set<string>();

  for (const entry of manifest.entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Snapshot manifest contains duplicate entry id: ${entry.id}`);
    }

    const normalized = normalizedPath(entry);
    if (seenNormalizedPaths.has(normalized)) {
      throw new Error(`Snapshot manifest contains duplicate normalized path: ${normalized}`);
    }

    seenIds.add(entry.id);
    seenNormalizedPaths.add(normalized);
  }
}

function ensureApiKey(apiKey: string | null | undefined) {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('COINGECKO_API_KEY is required in the runtime environment for snapshot capture.');
  }
}

function assertApiKey(apiKey: string | null | undefined): string {
  ensureApiKey(apiKey);
  return apiKey!;
}

function getArtifactRelativePath(entry: SnapshotManifestEntry) {
  return join('artifacts', `${entry.id}-${identityHash(entry)}.json`);
}

function getMetadataRelativePath(entry: SnapshotManifestEntry) {
  return getSnapshotMetadataRelativePath(entry.id, getArtifactRelativePath(entry));
}

function createMetadata(
  entry: SnapshotManifestEntry,
  manifest: SnapshotManifest,
  outputDir: string,
  status: number,
  body: string,
  capturedAt: string,
  reusedFromExisting: boolean,
  refreshed: boolean,
): SnapshotArtifactMetadata {
  const artifactRelativePath = getArtifactRelativePath(entry);

  return {
    entryId: entry.id,
    manifestId: manifest.manifestId,
    manifestFormatVersion: manifest.formatVersion,
    artifactFormatVersion: manifest.artifactFormatVersion,
    path: entry.path,
    normalizedPath: normalizedPath(entry),
    normalizedQuery: normalizeQuery(entry.query),
    variantId: variantId(entry),
    url: `${COINGECKO_PRO_BASE_URL}${entry.path}${normalizeQuery(entry.query) ? `?${normalizeQuery(entry.query)}` : ''}`,
    capturedAt,
    upstreamStatus: status,
    artifactRelativePath,
    payloadSha256: createHash('sha256').update(body).digest('hex'),
    byteLength: Buffer.byteLength(body),
    reusedFromExisting,
    refreshed,
  };
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readMetadata(filePath: string): SnapshotArtifactMetadata | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as SnapshotArtifactMetadata;
  } catch {
    return null;
  }
}

export async function captureCoinGeckoSnapshots(options: SnapshotCaptureOptions = {}): Promise<SnapshotCaptureSummary> {
  if (options.apiKey === undefined) {
    loadRepoDotenv();
  }

  const manifest = options.manifest ?? coingeckoSnapshotManifest;
  const outputDir = resolve(options.outputDir ?? 'data/coingecko-snapshots');
  const refresh = options.refresh ?? false;
  const logger = options.logger ?? createLogger({ level: 'info', pretty: false });
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey ?? process.env.COINGECKO_API_KEY ?? null;

  ensureManifestIsBounded(manifest);
  ensureManifestEntryIdentities(manifest);
  const resolvedApiKey = assertApiKey(apiKey);

  const enabledEntries = manifest.entries.filter((entry) => entry.enabled !== false);
  const totals: Record<CaptureTerminalState, number> = {
    captured: 0,
    reused: 0,
    conditional_skip: 0,
    failed: 0,
  };
  const entries: SnapshotIndexEntry[] = [];
  let requestTotal = 0;

  mkdirSync(outputDir, { recursive: true });

  for (const entry of enabledEntries) {
    const artifactPath = join(outputDir, getArtifactRelativePath(entry));
    const metadataPath = join(outputDir, getMetadataRelativePath(entry));
    const artifactExists = (() => {
      try {
        return statSync(artifactPath).isFile() && statSync(metadataPath).isFile();
      } catch {
        return false;
      }
    })();

    if (artifactExists && !refresh) {
      const metadata = readMetadata(metadataPath);
      if (!metadata) {
        totals.failed += 1;
        entries.push({
          ...createMetadata(entry, manifest, outputDir, 0, '', new Date(0).toISOString(), false, false),
          state: 'failed',
          errorMessage: 'Existing snapshot metadata is unreadable.',
        });
        continue;
      }

      totals.reused += 1;
      entries.push({
        ...metadata,
        reusedFromExisting: true,
        refreshed: false,
        state: 'reused',
        errorMessage: null,
      });
      continue;
    }

    const capturedAt = (options.capturedAt ?? (() => new Date()))().toISOString();
    const query = normalizeQuery(entry.query);
    const url = `${COINGECKO_PRO_BASE_URL}${entry.path}${query ? `?${query}` : ''}`;
    requestTotal += 1;

    try {
      const headers = new Headers();
      headers.set('accept', 'application/json');
      headers.set('x-cg-pro-api-key', resolvedApiKey);
      const response = await fetchImpl(url, { headers });

      const body = await response.text();
      const metadata = createMetadata(entry, manifest, outputDir, response.status, body, capturedAt, false, refresh);

      if (!response.ok) {
        totals.failed += 1;
        entries.push({
          ...metadata,
          state: 'failed',
          errorMessage: `Upstream request failed with status ${response.status}.`,
        });
        continue;
      }

      writeJson(artifactPath, JSON.parse(body));
      writeJson(metadataPath, metadata);
      totals.captured += 1;
      entries.push({
        ...metadata,
        state: 'captured',
        errorMessage: null,
      });
    } catch (error) {
      const metadata = createMetadata(entry, manifest, outputDir, 0, '', capturedAt, false, refresh);
      totals.failed += 1;
      entries.push({
        ...metadata,
        state: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const indexPath = join(outputDir, 'index.json');
  const summary: SnapshotCaptureSummary = {
    manifestId: manifest.manifestId,
    manifestEntryCount: enabledEntries.length,
    requestLimit: manifest.maxRequests,
    requestTotal,
    refresh,
    totals,
    entries,
    indexPath,
  };

  writeJson(indexPath, summary);
  logger.info({
    manifestId: summary.manifestId,
    manifestEntryCount: summary.manifestEntryCount,
    requestTotal: summary.requestTotal,
    totals: summary.totals,
    refresh: summary.refresh,
  }, 'CoinGecko snapshot capture complete');
  return summary;
}

export function formatSnapshotCaptureSummary(summary: SnapshotCaptureSummary) {
  return JSON.stringify({
    manifest_id: summary.manifestId,
    manifest_entry_count: summary.manifestEntryCount,
    request_total: summary.requestTotal,
    request_limit: summary.requestLimit,
    refresh: summary.refresh,
    totals: summary.totals,
    entries: summary.entries.map((entry) => ({
      entry_id: entry.entryId,
      state: entry.state,
      variant_id: entry.variantId,
      normalized_path: entry.normalizedPath,
      artifact_path: entry.artifactRelativePath,
      refreshed: entry.refreshed,
      reused_from_existing: entry.reusedFromExisting,
      upstream_status: entry.upstreamStatus,
      error_message: entry.errorMessage,
    })),
  }, null, 2);
}

export function getSnapshotMetadataRelativePath(entryId: string, artifactRelativePath: string) {
  const artifactFile = artifactRelativePath.split('/').pop() ?? `${entryId}.json`;
  return join('metadata', artifactFile);
}
