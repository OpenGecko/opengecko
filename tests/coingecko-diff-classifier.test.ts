import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createDiffReport } from '../src/coingecko/diff-report';

describe('CoinGecko diff classifier', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupCase(name: string, replayFinding: Record<string, unknown>, upstreamBody: unknown, replayBody: unknown, rulesOverride: Record<string, unknown> = {}, divergenceEntries: Array<Record<string, unknown>> = []) {
    const root = mkdtempSync(join(tmpdir(), `opengecko-diff-${name}-`));
    tempDirs.push(root);
    const snapshotDir = join(root, 'snapshots');
    const replayDir = join(snapshotDir, 'replay');
    mkdirSync(join(snapshotDir, 'artifacts'), { recursive: true });
    mkdirSync(join(replayDir, 'artifacts'), { recursive: true });
    mkdirSync(join(snapshotDir, 'registry'), { recursive: true });

    writeFileSync(join(snapshotDir, 'artifacts/test-artifact.json'), `${JSON.stringify(upstreamBody, null, 2)}\n`);
    writeFileSync(join(replayDir, 'artifacts/test-artifact.json'), `${JSON.stringify({ status: replayFinding.replayStatus, body: replayBody }, null, 2)}\n`);
    writeFileSync(join(replayDir, 'report.json'), `${JSON.stringify({
      reportFormatVersion: 1,
      corpusIdentity: 'corpus',
      manifestId: 'manifest',
      replayTargetManifestIdentity: 'target',
      normalizationRulesId: 'legacy-ruleset',
      replayedAt: '2026-03-28T00:00:00.000Z',
      validationApiBaseUrl: 'http://127.0.0.1:3102',
      entryCount: 1,
      findings: [replayFinding],
    }, null, 2)}\n`);
    writeFileSync(join(snapshotDir, 'normalization-rules.json'), `${JSON.stringify({
      rulesetId: 'rules-v1',
      ignoredPaths: [],
      orderingInsensitivePaths: [],
      freshnessPaths: ['last_updated'],
      sourcePaths: ['image'],
      numericTolerances: {},
      ...rulesOverride,
    }, null, 2)}\n`);
    writeFileSync(join(snapshotDir, 'registry/divergence-registry.json'), `${JSON.stringify({
      registryId: 'registry-v1',
      entries: divergenceEntries,
    }, null, 2)}\n`);

    return {
      snapshotDir,
      replayReportPath: join(replayDir, 'report.json'),
      rulesetPath: join(snapshotDir, 'normalization-rules.json'),
      divergenceRegistryPath: join(snapshotDir, 'registry/divergence-registry.json'),
    };
  }

  const baseFinding = {
    findingId: 'finding',
    entryId: 'entry',
    normalizedPath: '/coins/bitcoin',
    replayTargetManifestIdentity: 'target',
    upstreamArtifactPath: 'artifacts/test-artifact.json',
    replayArtifactPath: 'artifacts/test-artifact.json',
    upstreamStatus: 200,
    replayStatus: 200,
    statusMatches: true,
    bodyMatches: false,
  };

  it('classifies missing fields', () => {
    const paths = setupCase('missing', baseFinding, { market_data: { current_price: 1, market_cap: 2 } }, { market_data: { current_price: 1 } });
    const report = createDiffReport(paths);
    expect(report.actionableFindings[0]?.gapClass).toBe('missing_field');
    expect(report.actionableFindings[0]?.diffPaths).toEqual(['market_data.market_cap']);
  });

  it('classifies scalar value diffs', () => {
    const paths = setupCase('value', baseFinding, { market_data: { current_price: 1 } }, { market_data: { current_price: 2 } });
    const report = createDiffReport(paths);
    expect(report.actionableFindings[0]?.gapClass).toBe('value');
  });

  it('classifies nested row-field differences instead of root-array ranking when array membership and order match', () => {
    const paths = setupCase(
      'coins-markets-nested',
      { ...baseFinding, normalizedPath: '/coins/markets' },
      [
        { id: 'bitcoin', market_cap_rank: 1, current_price: 100 },
        { id: 'ethereum', market_cap_rank: 2, current_price: 50 },
      ],
      [
        { id: 'bitcoin', market_cap_rank: 1, current_price: 101 },
        { id: 'ethereum', market_cap_rank: 2, current_price: 49 },
      ],
    );
    const report = createDiffReport(paths);
    expect(report.actionableFindings[0]?.gapClass).toBe('value');
    expect(report.actionableFindings[0]?.diffPaths).toEqual([
      '$array[0].current_price',
      '$array[1].current_price',
    ]);
  });

  it('classifies freshness paths using rules', () => {
    const paths = setupCase('freshness', baseFinding, { market_data: { last_updated: 'a' } }, { market_data: { last_updated: 'b' } });
    const report = createDiffReport(paths);
    expect(report.actionableFindings[0]?.gapClass).toBe('freshness');
  });

  it('classifies source paths using rules', () => {
    const paths = setupCase('source', baseFinding, { image: 'upstream' }, { image: 'replay' });
    const report = createDiffReport(paths);
    expect(report.actionableFindings[0]?.gapClass).toBe('source');
  });

  it('classifies status mismatches as shape diffs', () => {
    const paths = setupCase('shape', { ...baseFinding, replayStatus: 404, statusMatches: false }, { ok: true }, { error: 'missing' });
    const report = createDiffReport(paths);
    expect(report.actionableFindings[0]?.gapClass).toBe('shape');
  });

  it('uses a single primary gap class with stable priority when multiple leaf diffs exist', () => {
    const paths = setupCase(
      'priority',
      baseFinding,
      {
        market_data: {
          current_price: 1,
          market_cap: 2,
          last_updated: 'a',
        },
      },
      {
        market_data: {
          current_price: 3,
          last_updated: 'b',
        },
      },
    );
    const report = createDiffReport(paths);
    expect(report.actionableFindings).toHaveLength(1);
    expect(report.actionableFindings[0]?.gapClass).toBe('missing_field');
    expect(report.actionableFindings[0]?.diffPaths).toEqual([
      'market_data.market_cap',
      'market_data.last_updated',
      'market_data.current_price',
    ]);
  });
});
