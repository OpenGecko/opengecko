import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { runOfflineReplay } from '../src/coingecko/offline-replay';
import type { SnapshotManifest } from '../src/coingecko/snapshot-manifest';

describe('CoinGecko offline replay', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'opengecko-cg-replay-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeJson(filePath: string, value: unknown) {
    const fs = require('node:fs');
    const path = require('node:path');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  it('replays local snapshots against the validation API and records stable upstream corpus identity plus replay-target traceability', async () => {
    const snapshotDir = createTempDir();
    const outputDir = createTempDir();
    const manifest: SnapshotManifest = {
      manifestId: 'offline-replay-manifest',
      formatVersion: 1,
      artifactFormatVersion: 1,
      maxRequests: 10,
      entries: [
        {
          id: 'simple-price',
          path: '/simple/price',
          query: { ids: 'bitcoin', vs_currencies: 'usd' },
        },
        {
          id: 'global',
          path: '/global',
        },
      ],
    };

    writeJson(join(snapshotDir, 'artifacts/simple-price-277522b7c75ada35.json'), { bitcoin: { usd: 100 } });
    writeJson(join(snapshotDir, 'metadata/simple-price-277522b7c75ada35.json'), {
      entryId: 'simple-price',
      manifestId: 'offline-replay-manifest',
      manifestFormatVersion: 1,
      artifactFormatVersion: 1,
      path: '/simple/price',
      normalizedPath: '/simple/price?ids=bitcoin&vs_currencies=usd',
      normalizedQuery: 'ids=bitcoin&vs_currencies=usd',
      variantId: 'simple-price',
      url: 'https://pro-api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      capturedAt: '2026-03-28T00:00:00.000Z',
      upstreamStatus: 200,
      artifactRelativePath: 'artifacts/simple-price-277522b7c75ada35.json',
      payloadSha256: 'hash-a',
      byteLength: 24,
      reusedFromExisting: false,
      refreshed: false,
    });
    writeJson(join(snapshotDir, 'artifacts/global-d3cbd6bcc95fe9ba.json'), { data: { active_cryptocurrencies: 1 } });
    writeJson(join(snapshotDir, 'metadata/global-d3cbd6bcc95fe9ba.json'), {
      entryId: 'global',
      manifestId: 'offline-replay-manifest',
      manifestFormatVersion: 1,
      artifactFormatVersion: 1,
      path: '/global',
      normalizedPath: '/global',
      normalizedQuery: '',
      variantId: 'global',
      url: 'https://pro-api.coingecko.com/api/v3/global',
      capturedAt: '2026-03-28T00:00:00.000Z',
      upstreamStatus: 200,
      artifactRelativePath: 'artifacts/global-d3cbd6bcc95fe9ba.json',
      payloadSha256: 'hash-b',
      byteLength: 40,
      reusedFromExisting: false,
      refreshed: false,
    });

    const responses = new Map([
      ['http://127.0.0.1:3102/simple/price?ids=bitcoin&vs_currencies=usd', { status: 200, body: { bitcoin: { usd: 101 } } }],
      ['http://127.0.0.1:3102/global', { status: 200, body: { data: { active_cryptocurrencies: 1 } } }],
    ]);

    const report = await runOfflineReplay({
      snapshotDir,
      outputDir,
      manifest,
      replayedAt: () => new Date('2026-03-28T00:05:00.000Z'),
      fetchImpl: (async (input) => {
        const key = String(input);
        const response = responses.get(key);
        if (!response) {
          throw new Error(`Unexpected fetch: ${key}`);
        }
        return {
          status: response.status,
          text: async () => JSON.stringify(response.body),
        } as Response;
      }) as typeof fetch,
    });

    expect(report.manifestId).toBe('offline-replay-manifest');
    expect(report.normalizationRulesId).toBe('coingecko-offline-replay-rules-v1');
    expect(report.entryCount).toBe(2);
    expect(report.corpusIdentity).toBe('187fea2d77765be348bc1025660422a6a34897f8451ef96677da76f9f38037e8');
    expect(report.replayTargetManifestIdentity).toBe('2e725837c50f21c8b149de8e348cd697e881042163b10c59ea9248b4cd4d0b2d');
    expect(report.findings).toMatchObject([
      {
        entryId: 'global',
        replayTargetManifestIdentity: '2e725837c50f21c8b149de8e348cd697e881042163b10c59ea9248b4cd4d0b2d',
        upstreamArtifactPath: 'artifacts/global-d3cbd6bcc95fe9ba.json',
        replayArtifactPath: 'artifacts/global-d3cbd6bcc95fe9ba.json',
        statusMatches: true,
        bodyMatches: true,
      },
      {
        entryId: 'simple-price',
        replayTargetManifestIdentity: '2e725837c50f21c8b149de8e348cd697e881042163b10c59ea9248b4cd4d0b2d',
        upstreamArtifactPath: 'artifacts/simple-price-277522b7c75ada35.json',
        replayArtifactPath: 'artifacts/simple-price-277522b7c75ada35.json',
        statusMatches: true,
        bodyMatches: false,
      },
    ]);

    const replayArtifact = JSON.parse(readFileSync(join(outputDir, 'artifacts/simple-price-277522b7c75ada35.json'), 'utf8'));
    const replayMetadata = JSON.parse(readFileSync(join(outputDir, 'metadata/simple-price-277522b7c75ada35.json'), 'utf8'));
    const savedReport = JSON.parse(readFileSync(join(outputDir, 'report.json'), 'utf8'));

    expect(replayArtifact).toEqual({
      status: 200,
      body: { bitcoin: { usd: 101 } },
    });
    expect(replayMetadata).toMatchObject({
      entryId: 'simple-price',
      manifestId: 'offline-replay-manifest',
      replayTargetManifestIdentity: '2e725837c50f21c8b149de8e348cd697e881042163b10c59ea9248b4cd4d0b2d',
      rulesetId: 'coingecko-offline-replay-rules-v1',
      normalizedPath: '/simple/price?ids=bitcoin&vs_currencies=usd',
      responseStatus: 200,
      artifactRelativePath: 'artifacts/simple-price-277522b7c75ada35.json',
    });
    expect(savedReport.manifestId).toBe('offline-replay-manifest');
    expect(savedReport.corpusIdentity).toBe('187fea2d77765be348bc1025660422a6a34897f8451ef96677da76f9f38037e8');
    expect(savedReport.replayTargetManifestIdentity).toBe('2e725837c50f21c8b149de8e348cd697e881042163b10c59ea9248b4cd4d0b2d');
    expect(savedReport.normalizationRulesId).toBe('coingecko-offline-replay-rules-v1');
    expect(savedReport.findings).toMatchObject([
      {
        entryId: 'global',
        replayTargetManifestIdentity: '2e725837c50f21c8b149de8e348cd697e881042163b10c59ea9248b4cd4d0b2d',
        upstreamArtifactPath: 'artifacts/global-d3cbd6bcc95fe9ba.json',
        replayArtifactPath: 'artifacts/global-d3cbd6bcc95fe9ba.json',
      },
      {
        entryId: 'simple-price',
        replayTargetManifestIdentity: '2e725837c50f21c8b149de8e348cd697e881042163b10c59ea9248b4cd4d0b2d',
        upstreamArtifactPath: 'artifacts/simple-price-277522b7c75ada35.json',
        replayArtifactPath: 'artifacts/simple-price-277522b7c75ada35.json',
      },
    ]);
  });
});
