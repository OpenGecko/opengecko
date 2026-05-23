import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = resolve(process.cwd(), '.github/workflows/test.yml');
const baselinePushBranches = ['main'];
const disallowedOnFilters = new Set([
  'paths',
  'paths-ignore',
  'branches-ignore',
  'tags-ignore',
]);

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
};

type ParsedWorkflow = {
  name: string;
  on: {
    push: {
      branches: string[];
    };
    pull_request: null;
  };
  jobs: {
    test: {
      steps: WorkflowStep[];
    };
  };
};

function requireMatch(value: string, pattern: RegExp, description: string): RegExpMatchArray {
  const match = value.match(pattern);

  if (!match) {
    throw new Error(`Unable to parse ${description}`);
  }

  return match;
}

function yamlLines(): string[] {
  const source = readFileSync(workflowPath, 'utf8');

  if (source.includes('\t')) {
    throw new Error('Workflow YAML must not contain tab indentation');
  }

  return source.split(/\r?\n/);
}

function findLineIndex(lines: string[], pattern: RegExp, description: string): number {
  const index = lines.findIndex((line) => pattern.test(line));

  if (index === -1) {
    throw new Error(`Unable to find ${description}`);
  }

  return index;
}

function parseTopLevelKeys(lines: string[]): Set<string> {
  return new Set(lines
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s.*)?$/)?.[1])
    .filter((key): key is string => key !== undefined));
}

function parsePushBranches(lines: string[]): string[] {
  const branchesIndex = findLineIndex(lines, /^    branches:\s*$/, 'on.push.branches');
  const branches: string[] = [];

  for (const line of lines.slice(branchesIndex + 1)) {
    if (!line.trim()) {
      continue;
    }

    if (!line.startsWith('      ')) {
      break;
    }

    const match = requireMatch(line, /^      - ([A-Za-z0-9._/-]+)\s*$/, 'explicit push branch');
    branches.push(match[1]!);
  }

  return branches;
}

function parseSteps(lines: string[]): WorkflowStep[] {
  const stepsIndex = findLineIndex(lines, /^    steps:\s*$/, 'jobs.test.steps');
  const steps: WorkflowStep[] = [];
  let currentStep: WorkflowStep | undefined;
  let inWithBlock = false;

  for (const line of lines.slice(stepsIndex + 1)) {
    if (!line.trim()) {
      continue;
    }

    if (!line.startsWith('      ')) {
      break;
    }

    const stepNameMatch = line.match(/^      - name: (.+)\s*$/);

    if (stepNameMatch) {
      currentStep = { name: stepNameMatch[1] };
      steps.push(currentStep);
      inWithBlock = false;
      continue;
    }

    if (!currentStep) {
      throw new Error('Step property appeared before first named step');
    }

    const stepPropertyMatch = line.match(/^        (uses|run): (.+)\s*$/);

    if (stepPropertyMatch) {
      currentStep[stepPropertyMatch[1] as 'uses' | 'run'] = stepPropertyMatch[2]!;
      inWithBlock = false;
      continue;
    }

    if (/^        with:\s*$/.test(line)) {
      currentStep.with = {};
      inWithBlock = true;
      continue;
    }

    const withPropertyMatch = line.match(/^          ([A-Za-z0-9_-]+): (.+)\s*$/);

    if (inWithBlock && withPropertyMatch) {
      currentStep.with![withPropertyMatch[1]!] = withPropertyMatch[2]!;
      continue;
    }

    throw new Error(`Unsupported workflow step YAML: ${line}`);
  }

  return steps;
}

function parseWorkflow(): ParsedWorkflow {
  const lines = yamlLines();
  const topLevelKeys = parseTopLevelKeys(lines);
  const name = requireMatch(lines.join('\n'), /^name:\s*(.+)\s*$/m, 'workflow name')[1]!;

  for (const key of ['name', 'on', 'jobs']) {
    if (!topLevelKeys.has(key)) {
      throw new Error(`Missing top-level workflow key: ${key}`);
    }
  }

  expect(lines).toContain('  push:');
  expect(lines).toContain('  pull_request:');
  expect(lines).toContain('  test:');

  return {
    name,
    on: {
      push: {
        branches: parsePushBranches(lines),
      },
      pull_request: null,
    },
    jobs: {
      test: {
        steps: parseSteps(lines),
      },
    },
  };
}

function branchFilterMatchesRef(branches: string[], ref: string): boolean {
  const branch = ref.match(/^refs\/heads\/(.+)$/)?.[1];

  if (!branch) {
    return false;
  }

  return branches.includes(branch);
}

describe('Test GitHub Actions workflow', () => {
  it('parses the canonical workflow file with required top-level keys', () => {
    expect(existsSync(workflowPath)).toBe(true);

    const workflow = parseWorkflow();

    expect(workflow.name).toBe('Test');
    expect(workflow.on).toHaveProperty('push');
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.jobs).toHaveProperty('test');
  });

  it('runs push events on master while preserving baseline branch filters', () => {
    const workflow = parseWorkflow();

    expect(workflow.on.push.branches).toContain('master');
    expect(workflow.on.push.branches).toEqual(
      expect.arrayContaining(baselinePushBranches),
    );
    expect(workflow.on.push.branches).not.toContain('*');
    expect(workflow.on.push.branches).not.toContain('**');
  });

  it('does not introduce broad filters under the on trigger block', () => {
    const lines = yamlLines();
    const onIndex = findLineIndex(lines, /^on:\s*$/, 'top-level on trigger');
    const onBlock = lines.slice(onIndex + 1)
      .filter((line) => line.startsWith('  ') && !line.startsWith('jobs:'));

    for (const line of onBlock) {
      const key = line.match(/^    ([A-Za-z-]+):/)?.[1];

      if (key) {
        expect(disallowedOnFilters.has(key)).toBe(false);
      }
    }
  });

  it('keeps validation commands and Bun version pin intact', () => {
    const workflow = parseWorkflow();
    const steps = workflow.jobs.test.steps;
    const commands = steps
      .map((step) => step.run)
      .filter((run): run is string => run !== undefined);

    expect(commands).toEqual(expect.arrayContaining([
      'bun run lint',
      'bun run typecheck',
      'bun run build',
      'bun run test:coverage',
    ]));
    expect(commands.indexOf('bun run lint')).toBeLessThan(commands.indexOf('bun run typecheck'));
    expect(commands.indexOf('bun run typecheck')).toBeLessThan(commands.indexOf('bun run build'));
    expect(commands.indexOf('bun run build')).toBeLessThan(commands.indexOf('bun run test:coverage'));

    const setupBunStep = steps.find((step) => step.uses === 'oven-sh/setup-bun@v2');
    expect(setupBunStep?.with?.['bun-version']).toBe('1.3.9');
  });

  it('selects a synthetic push event targeting refs/heads/master', () => {
    const workflow = parseWorkflow();

    expect(branchFilterMatchesRef(workflow.on.push.branches, 'refs/heads/master')).toBe(true);
  });
});
