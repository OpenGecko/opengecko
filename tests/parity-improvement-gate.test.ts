import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createImprovementGateReport } from '../src/coingecko/improvement-gate';

describe('parity improvement gate', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'opengecko-improvement-gate-'));
    tempDirs.push(dir);
    return dir;
  }

  function makeReplayReport(entryIds: string[], contracts?: Record<string, string>) {
    return {
      reportFormatVersion: 1,
      corpusIdentity: 'corpus-1',
      manifestId: 'manifest-1',
      replayTargetManifestIdentity: 'target-1',
      normalizationRulesId: 'coingecko-offline-replay-rules-v1',
      replayedAt: '2026-03-28T00:00:00.000Z',
      validationApiBaseUrl: 'http://127.0.0.1:3102',
      entryCount: entryIds.length,
      findings: entryIds.map((entryId) => ({
        findingId: `${entryId}-finding`,
        entryId,
        normalizedPath: contracts?.[entryId] ?? `/route/${entryId}?page=1`,
      })),
    };
  }

  function makeDiffReport(replayReportPath: string, actionableFindings: unknown[], overrides: Record<string, unknown> = {}) {
    return {
      reportFormatVersion: 1,
      generatedAt: '2026-03-28T00:10:00.000Z',
      corpusIdentity: 'corpus-1',
      manifestId: 'manifest-1',
      replayTargetManifestIdentity: 'target-1',
      normalizationRulesId: 'rules-v1',
      divergenceRegistryId: 'registry-v1',
      replayReportPath,
      totals: {
        findings: actionableFindings.length,
        actionable: actionableFindings.length,
        expected: 0,
      },
      actionableFindings,
      expectedFindings: [],
      ...overrides,
    };
  }

  function finding(entryId: string, gapClass: 'missing_field' | 'value' | 'ranking' | 'freshness' | 'source', diffPath: string) {
    return {
      findingId: `${entryId}-${gapClass}-${diffPath}`,
      findingKey: `${entryId}:${gapClass}:${diffPath}`,
      entryId,
      normalizedPath: `/route/${entryId}?page=1`,
      gapClass,
      classificationReason: 'test',
      status: 'actionable',
      divergenceId: null,
      divergenceReason: null,
      ownershipHints: [{ endpoint_family: 'test' }],
      upstreamArtifactPath: `artifacts/${entryId}.json`,
      replayArtifactPath: `artifacts/${entryId}.json`,
      upstreamStatus: 200,
      replayStatus: 200,
      evidencePaths: {
        upstreamArtifactPath: `artifacts/${entryId}.json`,
        replayArtifactPath: `artifacts/${entryId}.json`,
      },
      diffPaths: [diffPath],
    };
  }

  it('passes only when actionable findings fall because issues were resolved and coverage/contracts stay stable', () => {
    const root = createTempDir();
    const replayDir = join(root, 'replay');
    mkdirSync(replayDir, { recursive: true });

    const baselineReplayPath = join(replayDir, 'baseline-report.json');
    const currentReplayPath = join(replayDir, 'current-report.json');
    const baselineDiffPath = join(replayDir, 'baseline-diff-report.json');
    const currentDiffPath = join(replayDir, 'current-diff-report.json');

    writeFileSync(baselineReplayPath, `${JSON.stringify(makeReplayReport(['a', 'b', 'c']), null, 2)}\n`);
    writeFileSync(currentReplayPath, `${JSON.stringify(makeReplayReport(['a', 'b', 'c']), null, 2)}\n`);
    writeFileSync(baselineDiffPath, `${JSON.stringify(makeDiffReport(baselineReplayPath, [
      finding('a', 'missing_field', 'market_data.market_cap'),
      finding('b', 'value', 'data.total_market_cap.usd'),
      finding('c', 'source', 'image'),
    ]), null, 2)}\n`);
    writeFileSync(currentDiffPath, `${JSON.stringify(makeDiffReport(currentReplayPath, [
      finding('b', 'value', 'data.total_market_cap.usd'),
    ]), null, 2)}\n`);

    const report = createImprovementGateReport({
      baselineReportPath: baselineDiffPath,
      currentReportPath: currentDiffPath,
      generatedAt: () => new Date('2026-03-28T00:20:00.000Z'),
    });

    expect(report.passed).toBe(true);
    expect(report.actionableCounts).toEqual({
      baseline: 3,
      current: 1,
      delta: -2,
    });
    expect(report.coverage.preserved).toBe(true);
    expect(report.requestContract.preserved).toBe(true);
    expect(report.improvementBreakdown).toEqual({
      resolved: 2,
      unchanged: 1,
      introduced: 0,
      reclassified: 0,
    });
    expect(report.baselineActionableSummary).toEqual({
      byGapClass: {
        shape: 0,
        missing_field: 1,
        value: 1,
        ranking: 0,
        freshness: 0,
        source: 1,
      },
      byEntryId: {
        a: 1,
        b: 1,
        c: 1,
      },
    });
    expect(report.currentActionableSummary).toEqual({
      byGapClass: {
        shape: 0,
        missing_field: 0,
        value: 1,
        ranking: 0,
        freshness: 0,
        source: 0,
      },
      byEntryId: {
        b: 1,
      },
    });
    expect(report.resolvedFindings.map((item) => item.entryId)).toEqual(['a', 'c']);
  });

  it('fails when improvement is explained by divergence drift, coverage drift, contract drift, or reclassification', () => {
    const root = createTempDir();
    const replayDir = join(root, 'replay');
    mkdirSync(replayDir, { recursive: true });

    const baselineReplayPath = join(replayDir, 'baseline-report.json');
    const currentReplayPath = join(replayDir, 'current-report.json');
    const baselineDiffPath = join(replayDir, 'baseline-diff-report.json');
    const currentDiffPath = join(replayDir, 'current-diff-report.json');

    writeFileSync(baselineReplayPath, `${JSON.stringify(makeReplayReport(['a', 'b'], {
      a: '/simple/price?ids=bitcoin&vs_currencies=usd',
      b: '/global',
    }), null, 2)}\n`);
    writeFileSync(currentReplayPath, `${JSON.stringify(makeReplayReport(['a'], {
      a: '/simple/price?ids=bitcoin&vs_currencies=eur',
    }), null, 2)}\n`);
    writeFileSync(baselineDiffPath, `${JSON.stringify(makeDiffReport(baselineReplayPath, [
      finding('a', 'missing_field', 'usd_market_cap'),
      finding('b', 'ranking', 'data.markets'),
    ]), null, 2)}\n`);
    writeFileSync(currentDiffPath, `${JSON.stringify(makeDiffReport(currentReplayPath, [
      finding('a', 'value', 'usd_market_cap'),
    ], {
      divergenceRegistryId: 'registry-v2',
    }), null, 2)}\n`);

    const report = createImprovementGateReport({
      baselineReportPath: baselineDiffPath,
      currentReportPath: currentDiffPath,
    });

    expect(report.passed).toBe(false);
    expect(report.failureReasons).toEqual(expect.arrayContaining([
      'Divergence registry changed between baseline and current reports.',
      'Replay coverage changed between baseline and current reports.',
      'Request contract changed for one or more replay entries.',
      'New actionable findings were introduced.',
      'Reclassification findings changed classification instead of only resolving.',
    ]));
    expect(report.coverage.droppedEntryIds).toEqual(['b']);
    expect(report.requestContract.changedEntryIds).toEqual(['a']);
    expect(report.reclassifiedFindings).toHaveLength(1);
    expect(report.reclassifiedFindings[0]).toMatchObject({ entryId: 'a' });
  });
});
