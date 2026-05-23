import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts/scheduler-backoff-validation.sh');

describe('scheduler backoff validation script contract', () => {
  it('is shell-parseable', () => {
    const syntaxCheck = spawnSync('bash', ['-n', SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
  });

  it('documents and asserts the VAL-SCHED-004 black-box validation path', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');

    expect(script).toContain('Deterministic black-box validation for VAL-SCHED-004');
    expect(script).toContain('BASE_URL="${BASE_URL:-http://127.0.0.1:3102}"');
    expect(script).toContain('PORT=3102');
    expect(script).toContain('DATABASE_URL=:memory:');
    expect(script).toContain('/diagnostics/runtime/scheduler_backoff_validation');
    expect(script).toContain('/diagnostics/jobs');
    expect(script).toContain('VALIDATION_JOB_NAME="validation-scheduler-backoff"');
    expect(script).toContain('.data.job.status == "retrying"');
    expect(script).toContain('.data.job.retry_attempt_count >= 1');
    expect(script).toContain('.data.job.next_retry_at != null');
    expect(script).toContain('.data.job.backoff.active == true');
    expect(script).toContain('.data.job.backoff.next_retry_at == .data.job.next_retry_at');
    expect(script).toContain('.data.scheduler.allowed_job_statuses | index("retrying") != null');
    expect(script).toContain('validator-secret-token');
    expect(script).toContain('contains("validator-secret-token") | not');
    expect(script).toContain('kill "$STARTED_SERVER_PID"');
    expect(script).not.toContain('PORT=3000');
  });
});
