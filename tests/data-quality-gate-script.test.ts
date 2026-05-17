import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts/data-quality-gate.sh');

function runGateWithFixture(fixtureJson: string) {
  const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-data-quality-gate-test-'));
  const fakeCurlPath = join(tempDir, 'curl');

  writeFileSync(
    fakeCurlPath,
    `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    */diagnostics/data_quality) printf '%s' "$DATA_QUALITY_FIXTURE"; exit 0 ;;
  esac
done
echo "unexpected curl request: $*" >&2
exit 22
`,
    { mode: 0o755 },
  );

  try {
    return spawnSync('bash', [SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ''}`,
        BASE_URL: 'http://127.0.0.1:3103',
        DATA_QUALITY_FIXTURE: fixtureJson,
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('focused data quality gate script', () => {
  it('is shell-parseable', () => {
    const syntaxCheck = spawnSync('bash', ['-n', SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
  });

  it('exits zero when the diagnostics gate passes', () => {
    const result = runGateWithFixture(JSON.stringify({
      data: {
        gate: {
          status: 'pass',
          threshold: 9,
          below_target_count: 0,
          below_target_families: [],
          reason_codes: [],
        },
        families: [],
      },
    }));

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('OpenGecko Focused Data Quality Gate');
    expect(result.stdout).toContain('status: pass');
    expect(result.stdout).toContain('below_target_count: 0');
  });

  it('exits non-zero and prints below-threshold dimensions, evidence, and reason codes when the gate fails', () => {
    const result = runGateWithFixture(JSON.stringify({
      data: {
        gate: {
          status: 'fail',
          threshold: 9,
          below_target_count: 1,
          below_target_families: [
            {
              family: 'coins',
              score: 6,
              failing_dimensions: ['freshness_liveness', 'live_source_fidelity'],
              reason_codes: ['provider_error', 'stale_source'],
            },
          ],
          reason_codes: ['required_family_below_threshold'],
        },
        families: [
          {
            family: 'coins',
            score: 6,
            target_threshold: 9,
            status: 'degraded',
            source: {
              state: 'degraded',
              fallback: false,
              latest_source_at: '2026-05-17T00:00:00.000Z',
              provider_ids: ['binance'],
            },
            counts: {
              representative_route_count: 3,
              market_top_n_configured_denominator: 100,
            },
            dimensions: [
              {
                id: 'freshness_liveness',
                score: 6,
                status: 'degraded',
                reason_codes: ['provider_error', 'stale_source'],
                message: 'Freshness score reflects runtime/provider degradation.',
              },
              {
                id: 'live_source_fidelity',
                score: 6,
                status: 'degraded',
                reason_codes: ['provider_error'],
                message: 'Live-fidelity score is capped during provider failure.',
              },
            ],
            evidence: {
              representative_routes: ['/coins/markets'],
              runtime_degradation: {
                active: true,
                reason_codes: ['provider_error'],
                reason: 'validator forced outage',
              },
              market_quality: {
                request_path: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1',
                top_n: {
                  configured_denominator: 100,
                  price_complete_count: 90,
                },
              },
            },
          },
        ],
      },
    }));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status: fail');
    expect(result.stdout).toContain('family: coins');
    expect(result.stdout).toContain('failing_dimensions: freshness_liveness,live_source_fidelity');
    expect(result.stdout).toContain('reason_codes: provider_error,stale_source');
    expect(result.stdout).toContain('freshness_liveness: score=6');
    expect(result.stdout).toContain('runtime_degradation');
    expect(result.stdout).toContain('market_quality');
  });
});
