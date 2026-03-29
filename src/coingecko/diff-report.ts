import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { OfflineReplayReport, ReplayFinding } from './offline-replay';

export const COINGECKO_DIFF_REPORT_FORMAT_VERSION = 1 as const;

export type GapClass = 'shape' | 'missing_field' | 'value' | 'ranking' | 'freshness' | 'source';

export type NormalizationRuleset = {
  rulesetId: string;
  ignoredPaths: string[];
  orderingInsensitivePaths: string[];
  freshnessPaths: string[];
  sourcePaths: string[];
  numericTolerances: Record<string, number>;
};

export type DivergenceRegistry = {
  registryId: string;
  entries: Array<{
    id: string;
    findingKey: string;
    reason: string;
  }>;
};

export type OwnershipHint = {
  module_path?: string;
  provider_name?: string;
  endpoint_family?: string;
};

export type DiffLeaf = {
  path: string;
  gapClass: GapClass;
  reason: string;
  upstreamValue: unknown;
  replayValue: unknown;
};

export type DiffFinding = {
  findingId: string;
  findingKey: string;
  entryId: string;
  normalizedPath: string;
  gapClass: GapClass;
  classificationReason: string;
  status: 'expected' | 'actionable';
  divergenceId: string | null;
  divergenceReason: string | null;
  ownershipHints: OwnershipHint[];
  upstreamArtifactPath: string;
  replayArtifactPath: string;
  upstreamStatus: number;
  replayStatus: number;
  evidencePaths: {
    upstreamArtifactPath: string;
    replayArtifactPath: string;
  };
  diffPaths: string[];
};

export type DiffReport = {
  reportFormatVersion: number;
  generatedAt: string;
  corpusIdentity: string;
  manifestId: string;
  replayTargetManifestIdentity: string;
  normalizationRulesId: string;
  divergenceRegistryId: string;
  replayReportPath: string;
  totals: {
    findings: number;
    actionable: number;
    expected: number;
  };
  actionableFindings: DiffFinding[];
  expectedFindings: DiffFinding[];
};

const DEFAULT_OWNERSHIP_HINTS: Array<{ matcher: RegExp; hints: OwnershipHint }> = [
  { matcher: /^\/simple\//, hints: { module_path: 'src/modules/simple.ts', provider_name: 'ccxt', endpoint_family: 'simple' } },
  { matcher: /^\/coins\/markets/, hints: { module_path: 'src/modules/coins.ts', provider_name: 'ccxt', endpoint_family: 'coins' } },
  { matcher: /^\/coins\//, hints: { module_path: 'src/modules/coins.ts', provider_name: 'ccxt', endpoint_family: 'coins' } },
  { matcher: /^\/global/, hints: { module_path: 'src/modules/global.ts', provider_name: 'ccxt', endpoint_family: 'global' } },
  { matcher: /^\/exchange_rates/, hints: { module_path: 'src/modules/simple.ts', provider_name: 'ccxt', endpoint_family: 'simple' } },
  { matcher: /^\/exchanges/, hints: { module_path: 'src/modules/exchanges.ts', provider_name: 'ccxt', endpoint_family: 'exchanges' } },
];

function writeJson(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
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

function createDirectoryIdentity(rootDir: string) {
  const files = listFiles(rootDir)
    .sort()
    .map((filePath) => {
      const relativePath = filePath.slice(rootDir.length + 1);
      return `${relativePath}:${createHash('sha256').update(readFileSync(filePath, 'utf8')).digest('hex')}`;
    });
  return createHash('sha256').update(files.join('\n')).digest('hex');
}

function createFileIdentity(filePath: string) {
  return createHash('sha256').update(readFileSync(filePath, 'utf8')).digest('hex');
}

function normalizeValue(value: unknown, path: string, rules: NormalizationRuleset): unknown {
  if (rules.ignoredPaths.includes(path)) {
    return undefined;
  }
  if (Array.isArray(value) && rules.orderingInsensitivePaths.includes(path)) {
    return [...value].map((entry) => normalizeValue(entry, `${path}[]`, rules)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeValue(child, path ? `${path}.${key}` : key, rules)]),
    );
  }
  if (typeof value === 'number') {
    const tolerance = rules.numericTolerances[path];
    if (tolerance !== undefined) {
      return Number(value.toFixed(Math.max(0, Math.ceil(-Math.log10(tolerance)))));
    }
  }
  return value;
}

function collectDiffLeaves(upstreamValue: unknown, replayValue: unknown, path: string, rules: NormalizationRuleset, leaves: DiffLeaf[]) {
  const normalizedUpstream = normalizeValue(upstreamValue, path, rules);
  const normalizedReplay = normalizeValue(replayValue, path, rules);

  if (normalizedUpstream === undefined && normalizedReplay === undefined) {
    return;
  }

  if (normalizedUpstream === null || normalizedReplay === null || typeof normalizedUpstream !== 'object' || typeof normalizedReplay !== 'object') {
    if (JSON.stringify(normalizedUpstream) !== JSON.stringify(normalizedReplay)) {
      leaves.push(classifyLeaf(path, normalizedUpstream, normalizedReplay, rules));
    }
    return;
  }

  if (Array.isArray(normalizedUpstream) || Array.isArray(normalizedReplay)) {
    if (!Array.isArray(normalizedUpstream) || !Array.isArray(normalizedReplay)) {
      leaves.push(classifyLeaf(path, normalizedUpstream, normalizedReplay, rules));
      return;
    }
    collectArrayDiffLeaves(normalizedUpstream, normalizedReplay, path || '$array', rules, leaves);
    return;
  }

  const keys = new Set([
    ...Object.keys(normalizedUpstream as Record<string, unknown>),
    ...Object.keys(normalizedReplay as Record<string, unknown>),
  ]);

  for (const key of [...keys].sort()) {
    collectDiffLeaves(
      (normalizedUpstream as Record<string, unknown>)[key],
      (normalizedReplay as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
      rules,
      leaves,
    );
  }
}

function collectArrayDiffLeaves(upstreamValue: unknown[], replayValue: unknown[], path: string, rules: NormalizationRuleset, leaves: DiffLeaf[]) {
  if (upstreamValue.length !== replayValue.length) {
    leaves.push(classifyLeaf(path, upstreamValue, replayValue, rules));
    return;
  }

  for (let index = 0; index < upstreamValue.length; index += 1) {
    collectDiffLeaves(upstreamValue[index], replayValue[index], `${path}[${index}]`, rules, leaves);
  }
}

function classifyLeaf(path: string, upstreamValue: unknown, replayValue: unknown, rules: NormalizationRuleset): DiffLeaf {
  if (upstreamValue === undefined || replayValue === undefined) {
    return { path, gapClass: 'missing_field', reason: 'Field present on only one side.', upstreamValue, replayValue };
  }
  if (rules.freshnessPaths.some((candidate) => path.includes(candidate))) {
    return { path, gapClass: 'freshness', reason: 'Freshness-sensitive field differs.', upstreamValue, replayValue };
  }
  if (rules.sourcePaths.some((candidate) => path.includes(candidate))) {
    return { path, gapClass: 'source', reason: 'Source/provider-linked field differs.', upstreamValue, replayValue };
  }
  if (Array.isArray(upstreamValue) || Array.isArray(replayValue)) {
    return { path, gapClass: 'ranking', reason: 'Array membership or ordering differs.', upstreamValue, replayValue };
  }
  if ((typeof upstreamValue === 'object' && upstreamValue !== null) || (typeof replayValue === 'object' && replayValue !== null)) {
    return { path, gapClass: 'shape', reason: 'Object shape differs.', upstreamValue, replayValue };
  }
  return { path, gapClass: 'value', reason: 'Scalar value differs.', upstreamValue, replayValue };
}

const GAP_CLASS_PRIORITY: GapClass[] = ['shape', 'missing_field', 'ranking', 'freshness', 'source', 'value'];

function compareGapClassPriority(left: GapClass, right: GapClass) {
  return GAP_CLASS_PRIORITY.indexOf(left) - GAP_CLASS_PRIORITY.indexOf(right);
}

function classifyFinding(replayFinding: ReplayFinding, upstreamArtifact: unknown, replayArtifact: { status: number; body: unknown }, rules: NormalizationRuleset) {
  if (!replayFinding.statusMatches) {
    return {
      gapClass: 'shape' as GapClass,
      reason: `HTTP status differs (${replayFinding.upstreamStatus} vs ${replayFinding.replayStatus}).`,
      diffPaths: ['$status'],
    };
  }

  const leaves: DiffLeaf[] = [];
  collectDiffLeaves(upstreamArtifact, replayArtifact.body, '', rules, leaves);
  leaves.sort((left, right) =>
    compareGapClassPriority(left.gapClass, right.gapClass)
    || left.path.localeCompare(right.path)
    || left.reason.localeCompare(right.reason),
  );

  const primary = leaves[0] ?? {
    gapClass: 'value' as GapClass,
    reason: 'Normalized payload differs.',
    path: '$body',
  };

  return {
    gapClass: primary.gapClass,
    reason: primary.reason,
    diffPaths: leaves.map((leaf) => leaf.path),
  };
}

function ownershipHintsForPath(normalizedPath: string): OwnershipHint[] {
  const routePath = normalizedPath.split('?')[0];
  const match = DEFAULT_OWNERSHIP_HINTS.find((candidate) => candidate.matcher.test(routePath));
  return match ? [match.hints] : [{ endpoint_family: 'unknown' }];
}

export function createDiffReport(options: {
  replayReportPath: string;
  snapshotDir?: string;
  outputPath?: string;
  rulesetPath: string;
  divergenceRegistryPath: string;
  generatedAt?: () => Date;
}): DiffReport {
  const replayReportPath = resolve(options.replayReportPath);
  const snapshotDir = resolve(options.snapshotDir ?? 'data/coingecko-snapshots');
  const replayDir = dirname(replayReportPath);
  const resolvedRulesetPath = resolve(options.rulesetPath);
  const resolvedDivergenceRegistryPath = resolve(options.divergenceRegistryPath);
  const ruleset = readJson<NormalizationRuleset>(resolvedRulesetPath);
  const divergenceRegistry = readJson<DivergenceRegistry>(resolvedDivergenceRegistryPath);
  const replayReport = readJson<OfflineReplayReport>(replayReportPath);
  const divergenceMap = new Map(divergenceRegistry.entries.map((entry) => [entry.findingKey, entry]));

  const findings = replayReport.findings.map((finding) => {
    const upstreamArtifact = readJson<unknown>(join(snapshotDir, finding.upstreamArtifactPath));
    const replayArtifact = readJson<{ status: number; body: unknown }>(join(replayDir, finding.replayArtifactPath));
    const classification = classifyFinding(finding, upstreamArtifact, replayArtifact, ruleset);
    const findingKey = `${finding.entryId}:${classification.gapClass}:${classification.diffPaths.join('|') || '$body'}`;
    const divergence = divergenceMap.get(findingKey) ?? null;
    return {
      findingId: finding.findingId,
      findingKey,
      entryId: finding.entryId,
      normalizedPath: finding.normalizedPath,
      gapClass: classification.gapClass,
      classificationReason: classification.reason,
      status: divergence ? 'expected' : 'actionable',
      divergenceId: divergence?.id ?? null,
      divergenceReason: divergence?.reason ?? null,
      ownershipHints: ownershipHintsForPath(finding.normalizedPath),
      upstreamArtifactPath: finding.upstreamArtifactPath,
      replayArtifactPath: finding.replayArtifactPath,
      upstreamStatus: finding.upstreamStatus,
      replayStatus: finding.replayStatus,
      evidencePaths: {
        upstreamArtifactPath: finding.upstreamArtifactPath,
        replayArtifactPath: finding.replayArtifactPath,
      },
      diffPaths: classification.diffPaths,
    } satisfies DiffFinding;
  }).sort((left, right) =>
    left.normalizedPath.localeCompare(right.normalizedPath)
    || left.gapClass.localeCompare(right.gapClass)
    || left.findingKey.localeCompare(right.findingKey),
  );

  const actionableFindings = findings.filter((finding) => finding.status === 'actionable');
  const expectedFindings = findings.filter((finding) => finding.status === 'expected');

  const report: DiffReport = {
    reportFormatVersion: COINGECKO_DIFF_REPORT_FORMAT_VERSION,
    generatedAt: (options.generatedAt ?? (() => new Date()))().toISOString(),
    corpusIdentity: replayReport.corpusIdentity,
    manifestId: replayReport.manifestId,
    replayTargetManifestIdentity: replayReport.replayTargetManifestIdentity,
    normalizationRulesId: ruleset.rulesetId,
    divergenceRegistryId: divergenceRegistry.registryId,
    replayReportPath,
    totals: {
      findings: findings.length,
      actionable: actionableFindings.length,
      expected: expectedFindings.length,
    },
    actionableFindings,
    expectedFindings,
  };

  if (options.outputPath) {
    writeJson(resolve(options.outputPath), report);
  }

  return report;
}
