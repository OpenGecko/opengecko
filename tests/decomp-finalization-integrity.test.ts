import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

type DecompBaselineFixture = {
  schemaVersion: number;
  source: string;
  preDecompositionCommit: string;
  firstDecompositionCommit: string;
  captureCommand: string;
  testCounts: Record<string, {
    metric: string;
    count: number;
  }>;
};

const repoRoot = process.cwd();
const baselinePath = join(repoRoot, 'tests/fixtures/decomp-baseline.json');
const durationBaselinePath = join(repoRoot, 'tests/fixtures/decomp-duration-baseline.json');

function git(args: string[]) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function countNewlines(value: string) {
  return [...value].filter((character) => character === '\n').length;
}

describe('decomposition finalization gate integrity', () => {
  it('pins the decomposition baseline to the genuine pre-decomposition app test file count', () => {
    const fixture = JSON.parse(readFileSync(baselinePath, 'utf8')) as DecompBaselineFixture;

    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'pre-decomposition-git-history',
      preDecompositionCommit: '79eb8fafd027aa5a7b8387417a69511398393921',
      firstDecompositionCommit: 'b79813e0ec2389974c2bd8a56372a4cd88554c37',
      captureCommand:
        'git show 79eb8fafd027aa5a7b8387417a69511398393921:tests/app.test.ts | wc -l',
    });

    expect(git(['rev-parse', `${fixture.firstDecompositionCommit}^`]).trim()).toBe(
      fixture.preDecompositionCommit,
    );

    const appTestBeforeDecomposition = git([
      'show',
      `${fixture.preDecompositionCommit}:tests/app.test.ts`,
    ]);

    expect(fixture.testCounts['tests/app.test.ts']).toEqual({
      metric: 'line_count',
      count: countNewlines(appTestBeforeDecomposition),
    });
  });

  it('does not keep unsupported test duration baseline claims without an automated duration gate', () => {
    expect(existsSync(durationBaselinePath)).toBe(false);
  });
});
