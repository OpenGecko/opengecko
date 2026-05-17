import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts/data-quality-gate.sh');

function runGateWithFixture(fixtureJson: string) {
  const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-data-quality-gate-test-'));
  const evidenceDir = join(tempDir, 'evidence');
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
        OPENGECKO_QUALITY_EVIDENCE_DIR: evidenceDir,
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
    expect(result.stdout).toContain('Evidence artifacts:');
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

  it('writes a stable validation evidence manifest schema when an evidence directory is configured', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-data-quality-gate-evidence-'));
    const fakeCurlPath = join(tempDir, 'curl');
    const evidenceDir = join(tempDir, 'evidence');

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
      const result = spawnSync('bash', [SCRIPT_PATH], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ''}`,
          BASE_URL: 'http://127.0.0.1:3103',
          OPENGECKO_QUALITY_EVIDENCE_DIR: evidenceDir,
          DATA_QUALITY_FIXTURE: JSON.stringify({
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
          }),
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const manifestPath = join(evidenceDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        schema_version: string;
        base_url: string;
        run_timestamp: string;
        request_url: string;
        status: number;
        content_type: string;
        raw_response_path: string;
        parsed_metrics_path: string;
        diagnostics_snapshot_path: string;
        assertion_result_table_path: string;
        mismatch_report_path: string;
        artifact_paths: Record<string, string>;
      };

      expect(manifest).toMatchObject({
        schema_version: 'opengecko.quality-evidence.v1',
        base_url: 'http://127.0.0.1:3103',
        request_url: 'http://127.0.0.1:3103/diagnostics/data_quality',
        status: 200,
        content_type: 'application/json',
      });
      expect(Date.parse(manifest.run_timestamp)).not.toBeNaN();
      expect(manifest.raw_response_path).toBe(join(evidenceDir, 'diagnostics-data-quality.raw.json'));
      expect(manifest.parsed_metrics_path).toBe(join(evidenceDir, 'parsed-metrics.json'));
      expect(manifest.diagnostics_snapshot_path).toBe(join(evidenceDir, 'diagnostics-snapshot.json'));
      expect(manifest.assertion_result_table_path).toBe(join(evidenceDir, 'assertion-results.tsv'));
      expect(manifest.mismatch_report_path).toBe(join(evidenceDir, 'mismatch-report.json'));
      expect(manifest.artifact_paths).toEqual(expect.objectContaining({
        raw_response: manifest.raw_response_path,
        parsed_metrics: manifest.parsed_metrics_path,
        diagnostics_snapshot: manifest.diagnostics_snapshot_path,
        assertion_result_table: manifest.assertion_result_table_path,
        mismatch_report: manifest.mismatch_report_path,
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
