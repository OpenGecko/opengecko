import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DiffFinding, DiffReport, GapClass } from './diff-report';

export const COINGECKO_IMPROVEMENT_GATE_FORMAT_VERSION = 1 as const;

const ACTIONABLE_GAP_CLASSES = new Set<GapClass>(['missing_field', 'value', 'ranking', 'freshness', 'source']);

type RequestContractSnapshot = {
  normalizedPath: string;
  requestPath: string;
  requestQuery: string;
};

type ImprovementBreakdown = {
  resolved: number;
  unchanged: number;
  introduced: number;
  reclassified: number;
};

export type ImprovementReport = {
  reportFormatVersion: number;
  generatedAt: string;
  baselineReportPath: string;
  currentReportPath: string;
  baselineReplayReportPath: string;
  currentReplayReportPath: string;
  corpusIdentity: string;
  manifestId: string;
  replayTargetManifestIdentity: string;
  normalizationRulesId: string;
  divergenceRegistryId: string;
  coverage: {
    preserved: boolean;
    baselineEntryIds: string[];
    currentEntryIds: string[];
    droppedEntryIds: string[];
    addedEntryIds: string[];
  };
  requestContract: {
    preserved: boolean;
    changedEntryIds: string[];
    baseline: Record<string, RequestContractSnapshot>;
    current: Record<string, RequestContractSnapshot>;
  };
  actionableCounts: {
    baseline: number;
    current: number;
    delta: number;
  };
  improvementBreakdown: ImprovementBreakdown;
  baselineActionableSummary: {
    byGapClass: Record<GapClass, number>;
    byEntryId: Record<string, number>;
  };
  currentActionableSummary: {
    byGapClass: Record<GapClass, number>;
    byEntryId: Record<string, number>;
  };
  resolvedFindings: DiffFinding[];
  unchangedFindings: Array<{
    baseline: DiffFinding;
    current: DiffFinding;
  }>;
  introducedFindings: DiffFinding[];
  reclassifiedFindings: Array<{
    entryId: string;
    baseline: DiffFinding[];
    current: DiffFinding[];
  }>;
  passed: boolean;
  failureReasons: string[];
};

type ReplayReportLike = {
  corpusIdentity: string;
  manifestId: string;
  replayTargetManifestIdentity: string;
  normalizationRulesId: string;
  findings: Array<{
    entryId: string;
    normalizedPath: string;
  }>;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function makeFindingIdentity(finding: DiffFinding) {
  return `${finding.entryId}::${finding.gapClass}::${finding.diffPaths.join('|')}`;
}

function getActionableFindings(report: DiffReport) {
  return report.actionableFindings.filter((finding) => ACTIONABLE_GAP_CLASSES.has(finding.gapClass));
}

function summarizeFindings(findings: DiffFinding[]) {
  const byGapClass = Object.fromEntries(
    ['shape', 'missing_field', 'value', 'ranking', 'freshness', 'source']
      .map((gapClass) => [gapClass, 0]),
  ) as Record<GapClass, number>;
  const byEntryId: Record<string, number> = {};

  for (const finding of findings) {
    byGapClass[finding.gapClass] += 1;
    byEntryId[finding.entryId] = (byEntryId[finding.entryId] ?? 0) + 1;
  }

  return {
    byGapClass,
    byEntryId: Object.fromEntries(Object.entries(byEntryId).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function mapRequestContracts(reportPath: string) {
  const replayReport = readJson<ReplayReportLike>(reportPath);
  const contractMap = Object.fromEntries(
    replayReport.findings
      .map((finding) => {
        const [requestPath, queryString = ''] = finding.normalizedPath.split('?');
        return [finding.entryId, {
          normalizedPath: finding.normalizedPath,
          requestPath,
          requestQuery: queryString,
        } satisfies RequestContractSnapshot] as const;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    replayReport,
    contractMap,
  };
}

function compareRecords<T>(baseline: Record<string, T>, current: Record<string, T>) {
  const baselineKeys = Object.keys(baseline).sort((left, right) => left.localeCompare(right));
  const currentKeys = Object.keys(current).sort((left, right) => left.localeCompare(right));
  return {
    baselineKeys,
    currentKeys,
    dropped: baselineKeys.filter((key) => !(key in current)),
    added: currentKeys.filter((key) => !(key in baseline)),
  };
}

export function createImprovementGateReport(options: {
  baselineReportPath: string;
  currentReportPath: string;
  generatedAt?: () => Date;
}): ImprovementReport {
  const baselineReportPath = resolve(options.baselineReportPath);
  const currentReportPath = resolve(options.currentReportPath);
  const baselineDiff = readJson<DiffReport>(baselineReportPath);
  const currentDiff = readJson<DiffReport>(currentReportPath);

  const baselineReplay = mapRequestContracts(baselineDiff.replayReportPath);
  const currentReplay = mapRequestContracts(currentDiff.replayReportPath);

  const baselineActionable = getActionableFindings(baselineDiff);
  const currentActionable = getActionableFindings(currentDiff);

  const baselineByIdentity = new Map(baselineActionable.map((finding) => [makeFindingIdentity(finding), finding]));
  const currentByIdentity = new Map(currentActionable.map((finding) => [makeFindingIdentity(finding), finding]));

  const resolvedFindings = [...baselineByIdentity.entries()]
    .filter(([identity]) => !currentByIdentity.has(identity))
    .map(([, finding]) => finding)
    .sort((left, right) => left.entryId.localeCompare(right.entryId) || left.findingKey.localeCompare(right.findingKey));

  const unchangedFindings = [...baselineByIdentity.entries()]
    .filter(([identity]) => currentByIdentity.has(identity))
    .map(([identity, finding]) => ({
      baseline: finding,
      current: currentByIdentity.get(identity)!,
    }))
    .sort((left, right) => left.baseline.entryId.localeCompare(right.baseline.entryId) || left.baseline.findingKey.localeCompare(right.baseline.findingKey));

  const introducedFindings = [...currentByIdentity.entries()]
    .filter(([identity]) => !baselineByIdentity.has(identity))
    .map(([, finding]) => finding)
    .sort((left, right) => left.entryId.localeCompare(right.entryId) || left.findingKey.localeCompare(right.findingKey));

  const reclassifiedFindings = Object.entries(
    baselineActionable.reduce<Record<string, { baseline: DiffFinding[]; current: DiffFinding[] }>>((acc, finding) => {
      acc[finding.entryId] ??= { baseline: [], current: [] };
      acc[finding.entryId].baseline.push(finding);
      return acc;
    }, currentActionable.reduce<Record<string, { baseline: DiffFinding[]; current: DiffFinding[] }>>((acc, finding) => {
      acc[finding.entryId] ??= { baseline: [], current: [] };
      acc[finding.entryId].current.push(finding);
      return acc;
    }, {})),
  )
    .filter(([, value]) => value.baseline.length > 0 && value.current.length > 0)
    .filter(([, value]) => {
      const baselineIds = new Set(value.baseline.map(makeFindingIdentity));
      const currentIds = new Set(value.current.map(makeFindingIdentity));
      const sameSet = baselineIds.size === currentIds.size && [...baselineIds].every((identity) => currentIds.has(identity));
      return !sameSet;
    })
    .map(([entryId, value]) => ({
      entryId,
      baseline: [...value.baseline].sort((left, right) => left.findingKey.localeCompare(right.findingKey)),
      current: [...value.current].sort((left, right) => left.findingKey.localeCompare(right.findingKey)),
    }))
    .sort((left, right) => left.entryId.localeCompare(right.entryId));

  const coverageCompare = compareRecords(baselineReplay.contractMap, currentReplay.contractMap);
  const requestContractChanges = coverageCompare.baselineKeys
    .filter((entryId) => entryId in currentReplay.contractMap)
    .filter((entryId) => JSON.stringify(baselineReplay.contractMap[entryId]) !== JSON.stringify(currentReplay.contractMap[entryId]))
    .sort();

  const failureReasons: string[] = [];

  if (baselineDiff.corpusIdentity !== currentDiff.corpusIdentity) {
    failureReasons.push('Corpus identity changed between baseline and current reports.');
  }
  if (baselineDiff.manifestId !== currentDiff.manifestId) {
    failureReasons.push('Manifest ID changed between baseline and current reports.');
  }
  if (baselineDiff.replayTargetManifestIdentity !== currentDiff.replayTargetManifestIdentity) {
    failureReasons.push('Replay-target manifest identity changed between baseline and current reports.');
  }
  if (baselineDiff.normalizationRulesId !== currentDiff.normalizationRulesId) {
    failureReasons.push('Normalization ruleset changed between baseline and current reports.');
  }
  if (baselineDiff.divergenceRegistryId !== currentDiff.divergenceRegistryId) {
    failureReasons.push('Divergence registry changed between baseline and current reports.');
  }
  if (coverageCompare.dropped.length > 0 || coverageCompare.added.length > 0) {
    failureReasons.push('Replay coverage changed between baseline and current reports.');
  }
  if (requestContractChanges.length > 0) {
    failureReasons.push('Request contract changed for one or more replay entries.');
  }
  if (currentActionable.length >= baselineActionable.length) {
    failureReasons.push('Actionable findings did not decrease.');
  }
  if (introducedFindings.length > 0) {
    failureReasons.push('New actionable findings were introduced.');
  }
  if (reclassifiedFindings.length > 0) {
    failureReasons.push('Reclassification findings changed classification instead of only resolving.');
  }

  return {
    reportFormatVersion: COINGECKO_IMPROVEMENT_GATE_FORMAT_VERSION,
    generatedAt: (options.generatedAt ?? (() => new Date()))().toISOString(),
    baselineReportPath,
    currentReportPath,
    baselineReplayReportPath: baselineDiff.replayReportPath,
    currentReplayReportPath: currentDiff.replayReportPath,
    corpusIdentity: currentDiff.corpusIdentity,
    manifestId: currentDiff.manifestId,
    replayTargetManifestIdentity: currentDiff.replayTargetManifestIdentity,
    normalizationRulesId: currentDiff.normalizationRulesId,
    divergenceRegistryId: currentDiff.divergenceRegistryId,
    coverage: {
      preserved: coverageCompare.dropped.length === 0 && coverageCompare.added.length === 0,
      baselineEntryIds: coverageCompare.baselineKeys,
      currentEntryIds: coverageCompare.currentKeys,
      droppedEntryIds: coverageCompare.dropped,
      addedEntryIds: coverageCompare.added,
    },
    requestContract: {
      preserved: requestContractChanges.length === 0,
      changedEntryIds: requestContractChanges,
      baseline: baselineReplay.contractMap,
      current: currentReplay.contractMap,
    },
    actionableCounts: {
      baseline: baselineActionable.length,
      current: currentActionable.length,
      delta: currentActionable.length - baselineActionable.length,
    },
    improvementBreakdown: {
      resolved: resolvedFindings.length,
      unchanged: unchangedFindings.length,
      introduced: introducedFindings.length,
      reclassified: reclassifiedFindings.length,
    },
    baselineActionableSummary: summarizeFindings(baselineActionable),
    currentActionableSummary: summarizeFindings(currentActionable),
    resolvedFindings,
    unchangedFindings,
    introducedFindings,
    reclassifiedFindings,
    passed: failureReasons.length === 0,
    failureReasons,
  };
}
