import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { SnapshotManifest, SnapshotManifestEntry } from './snapshot-manifest';
import { coingeckoSnapshotManifest } from './snapshot-manifest';
import {
  getSnapshotMetadataRelativePath,
  type SnapshotArtifactMetadata,
} from './snapshot-capture';

export const OFFLINE_REPLAY_REPORT_FORMAT_VERSION = 1 as const;
export const OFFLINE_REPLAY_RULESET_ID = 'coingecko-offline-replay-rules-v1' as const;

export type OfflineReplayOptions = {
  snapshotDir?: string;
  outputDir?: string;
  manifest?: SnapshotManifest;
  fetchImpl?: typeof fetch;
  replayedAt?: () => Date;
  validationApiBaseUrl?: string;
};

export type ReplayArtifactMetadata = {
  entryId: string;
  manifestId: string;
  rulesetId: string;
  reportFormatVersion: number;
  replayedAt: string;
  normalizedPath: string;
  requestPath: string;
  requestQuery: string;
  responseStatus: number;
  artifactRelativePath: string;
  payloadSha256: string;
  byteLength: number;
};

export type ReplayFinding = {
  findingId: string;
  entryId: string;
  normalizedPath: string;
  upstreamArtifactPath: string;
  replayArtifactPath: string;
  upstreamStatus: number;
  replayStatus: number;
  statusMatches: boolean;
  bodyMatches: boolean;
};

export type OfflineReplayReport = {
  reportFormatVersion: number;
  corpusIdentity: string;
  manifestId: string;
  normalizationRulesId: string;
  replayedAt: string;
  validationApiBaseUrl: string;
  entryCount: number;
  findings: ReplayFinding[];
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

function identityHash(entry: SnapshotManifestEntry) {
  return createHash('sha256').update(`${entry.id}:${normalizedPath(entry)}`).digest('hex').slice(0, 16);
}

function getSnapshotArtifactRelativePath(entry: SnapshotManifestEntry) {
  return join('artifacts', `${entry.id}-${identityHash(entry)}.json`);
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function createCorpusIdentity(snapshotDir: string) {
  const files = listFiles(snapshotDir)
    .sort()
    .map((filePath) => {
      const relativePath = filePath.slice(snapshotDir.length + 1);
      const contents = readFileSync(filePath);
      return `${relativePath}:${createHash('sha256').update(contents).digest('hex')}`;
    });

  return createHash('sha256').update(files.join('\n')).digest('hex');
}

function listFiles(rootDir: string): string[] {
  const entries: string[] = [];

  for (const child of readdirSync(rootDir)) {
    const childPath = join(rootDir, child);
    const stats = statSync(childPath);
    if (stats.isDirectory()) {
      entries.push(...listFiles(childPath));
    } else if (stats.isFile()) {
      entries.push(childPath);
    }
  }

  return entries;
}

function createReplayArtifactMetadata(
  entry: SnapshotManifestEntry,
  manifest: SnapshotManifest,
  rulesetId: string,
  replayedAt: string,
  responseStatus: number,
  bodyText: string,
  artifactRelativePath: string,
): ReplayArtifactMetadata {
  return {
    entryId: entry.id,
    manifestId: manifest.manifestId,
    rulesetId,
    reportFormatVersion: OFFLINE_REPLAY_REPORT_FORMAT_VERSION,
    replayedAt,
    normalizedPath: normalizedPath(entry),
    requestPath: entry.path,
    requestQuery: normalizeQuery(entry.query),
    responseStatus,
    artifactRelativePath,
    payloadSha256: createHash('sha256').update(bodyText).digest('hex'),
    byteLength: Buffer.byteLength(bodyText),
  };
}

export async function runOfflineReplay(options: OfflineReplayOptions = {}): Promise<OfflineReplayReport> {
  const manifest = options.manifest ?? coingeckoSnapshotManifest;
  const snapshotDir = resolve(options.snapshotDir ?? 'data/coingecko-snapshots');
  const outputDir = resolve(options.outputDir ?? join(snapshotDir, 'replay'));
  const fetchImpl = options.fetchImpl ?? fetch;
  const replayedAt = (options.replayedAt ?? (() => new Date()))().toISOString();
  const validationApiBaseUrl = options.validationApiBaseUrl ?? 'http://127.0.0.1:3102';

  const findings: ReplayFinding[] = [];
  const corpusIdentity = createCorpusIdentity(snapshotDir);

  for (const entry of manifest.entries.filter((candidate) => candidate.enabled !== false)) {
    const upstreamArtifactRelativePath = getSnapshotArtifactRelativePath(entry);
    const upstreamMetadataRelativePath = getSnapshotMetadataRelativePath(entry.id, upstreamArtifactRelativePath);
    const upstreamArtifactPath = join(snapshotDir, upstreamArtifactRelativePath);
    const upstreamMetadataPath = join(snapshotDir, upstreamMetadataRelativePath);
    const upstreamBody = readJson<unknown>(upstreamArtifactPath);
    const upstreamMetadata = readJson<SnapshotArtifactMetadata>(upstreamMetadataPath);

    const url = `${validationApiBaseUrl}${entry.path}${normalizeQuery(entry.query) ? `?${normalizeQuery(entry.query)}` : ''}`;
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
      },
    });
    const replayBodyText = await response.text();
    const replayBody = replayBodyText.length > 0 ? JSON.parse(replayBodyText) : null;
    const replayArtifactRelativePath = join('artifacts', `${entry.id}-${identityHash(entry)}.json`);
    const replayMetadataRelativePath = join('metadata', `${entry.id}-${identityHash(entry)}.json`);
    const replayArtifactPath = join(outputDir, replayArtifactRelativePath);
    const replayMetadataPath = join(outputDir, replayMetadataRelativePath);

    writeJson(replayArtifactPath, {
      status: response.status,
      body: replayBody,
    });
    writeJson(
      replayMetadataPath,
      createReplayArtifactMetadata(
        entry,
        manifest,
        OFFLINE_REPLAY_RULESET_ID,
        replayedAt,
        response.status,
        replayBodyText,
        replayArtifactRelativePath,
      ),
    );

    findings.push({
      findingId: createHash('sha256').update(`${entry.id}:${upstreamMetadata.payloadSha256}:${response.status}:${replayBodyText}`).digest('hex').slice(0, 16),
      entryId: entry.id,
      normalizedPath: normalizedPath(entry),
      upstreamArtifactPath: upstreamArtifactRelativePath,
      replayArtifactPath: replayArtifactRelativePath,
      upstreamStatus: upstreamMetadata.upstreamStatus,
      replayStatus: response.status,
      statusMatches: upstreamMetadata.upstreamStatus === response.status,
      bodyMatches: JSON.stringify(upstreamBody) === JSON.stringify(replayBody),
    });
  }

  findings.sort((left, right) => left.entryId.localeCompare(right.entryId));

  const report: OfflineReplayReport = {
    reportFormatVersion: OFFLINE_REPLAY_REPORT_FORMAT_VERSION,
    corpusIdentity,
    manifestId: manifest.manifestId,
    normalizationRulesId: OFFLINE_REPLAY_RULESET_ID,
    replayedAt,
    validationApiBaseUrl,
    entryCount: findings.length,
    findings,
  };

  writeJson(join(outputDir, 'report.json'), report);
  return report;
}
