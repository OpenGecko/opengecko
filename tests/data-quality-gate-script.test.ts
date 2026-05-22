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

function freshnessBudgetFixture(overrides: Record<string, unknown> = {}) {
  return {
    family: 'simple',
    current_age_seconds: 10,
    age_seconds: 10,
    last_success_at: '2026-05-17T00:00:00.000Z',
    last_successful_refresh_at: '2026-05-17T00:00:00.000Z',
    budget_seconds: 30,
    budget: {
      target_freshness_seconds: 30,
      degraded_after_seconds: 120,
      basis: 'latest_market_snapshot',
    },
    status: 'fresh',
    reason: 'within_budget',
    reason_codes: ['within_budget'],
    source_state: 'live',
    ownership_class: 'live',
    counts_as_live_evidence: true,
    counts_as_live_freshness_evidence: true,
    non_live_evidence: false,
    provider_ids: ['coinbase'],
    provider_count: 1,
    ...overrides,
  };
}

function passingFixture(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    data: {
      gate: {
        status: 'pass',
        threshold: 9,
        below_target_count: 0,
        below_target_families: [],
        reason_codes: [],
      },
      families: [
        {
          family: 'simple',
          runtime_family_ids: ['simple'],
          aliases: ['simple_price'],
          required: true,
          score: 9.5,
          target_threshold: 9,
          status: 'pass',
          score_scopes: {
            contract_compatibility: 9.5,
            freshness_liveness: 9.5,
            live_source_fidelity: 9.5,
            fixture_fallback_transparency: 9.5,
            overall: 9.5,
          },
          dimensions: [
            {
              id: 'contract_compatibility',
              score: 9.5,
              status: 'pass',
              reason_codes: [],
              message: 'Contract score is backed by route tests.',
            },
          ],
          source: {
            state: 'live',
            ownership_class: 'live',
            fallback: false,
            fallback_status: 'none',
            latest_source_at: '2026-05-17T00:00:00.000Z',
            freshness_state: 'fresh',
            freshness_budget: {
              family: 'simple',
              current_age_seconds: 10,
              age_seconds: 10,
              last_success_at: '2026-05-17T00:00:00.000Z',
              last_successful_refresh_at: '2026-05-17T00:00:00.000Z',
              budget_seconds: 30,
              budget: {
                target_freshness_seconds: 30,
                degraded_after_seconds: 120,
                basis: 'latest_market_snapshot',
              },
              status: 'fresh',
              reason: 'within_budget',
              reason_codes: ['within_budget'],
              source_state: 'live',
              ownership_class: 'live',
              counts_as_live_evidence: true,
              counts_as_live_freshness_evidence: true,
              non_live_evidence: false,
              provider_ids: ['coinbase'],
              provider_count: 1,
            },
            provider_ids: ['coinbase'],
          },
          freshness_budget: {
            family: 'simple',
            current_age_seconds: 10,
            age_seconds: 10,
            last_success_at: '2026-05-17T00:00:00.000Z',
            last_successful_refresh_at: '2026-05-17T00:00:00.000Z',
            budget_seconds: 30,
            budget: {
              target_freshness_seconds: 30,
              degraded_after_seconds: 120,
              basis: 'latest_market_snapshot',
            },
            status: 'fresh',
            reason: 'within_budget',
            reason_codes: ['within_budget'],
            source_state: 'live',
            ownership_class: 'live',
            counts_as_live_evidence: true,
            counts_as_live_freshness_evidence: true,
            non_live_evidence: false,
            provider_ids: ['coinbase'],
            provider_count: 1,
          },
          counts: { representative_route_count: 1 },
          timestamps: { generated_at: '2026-05-17T00:00:00.000Z' },
          evidence: {
            representative_routes: ['/simple/price'],
            contract_tests: ['tests/simple-price-parity.test.ts'],
          },
          reason_codes: [],
          failing_dimensions: [],
          ...overrides,
        },
      ],
    },
  });
}

describe('focused data quality gate script', () => {
  it('is shell-parseable', () => {
    const syntaxCheck = spawnSync('bash', ['-n', SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
  });

  it('defaults to the mission data-quality validation service instead of port 3000', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');

    expect(script).toContain('BASE_URL="${BASE_URL:-http://127.0.0.1:3103}"');
    expect(script).not.toContain('BASE_URL="${BASE_URL:-http://localhost:3000}"');
  });

  it('exits zero when the diagnostics gate passes', () => {
    const result = runGateWithFixture(passingFixture());

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('OpenGecko Focused Data Quality Gate');
    expect(result.stdout).toContain('status: pass');
    expect(result.stdout).toContain('below_target_count: 0');
    expect(result.stdout).toContain('Evidence artifacts:');
  });

  it('prints public global route comparison evidence when diagnostics expose it', () => {
    const result = runGateWithFixture(JSON.stringify({
      data: {
        gate: {
          status: 'pass',
          threshold: 9,
          below_target_count: 0,
          below_target_families: [],
          reason_codes: [],
        },
        families: [
          {
            family: 'global',
            runtime_family_ids: ['global'],
            aliases: ['global_aggregates'],
            required: true,
            score: 9.5,
            target_threshold: 9,
            status: 'pass',
            score_scopes: {
              contract_compatibility: 9.5,
              freshness_liveness: 9.5,
              live_source_fidelity: 9.5,
              fixture_fallback_transparency: 9.5,
              overall: 9.5,
            },
            source: { state: 'live', ownership_class: 'live', fallback: false, freshness_state: 'fresh', latest_source_at: null, provider_ids: [], freshness_budget: freshnessBudgetFixture({ family: 'global' }) },
            freshness_budget: freshnessBudgetFixture({ family: 'global' }),
            counts: {},
            dimensions: [
              {
                id: 'contract_compatibility',
                score: 9.5,
                status: 'pass',
                reason_codes: [],
                message: 'Contract score is backed by route tests.',
              },
            ],
            evidence: {
              global_quality: {
                public_route_values: {
                  route: '/global',
                  total_market_cap_usd: 100,
                  total_volume_usd: 10,
                  market_cap_percentage: { btc: 50 },
                },
                recomputation: {
                  tolerance_ratio: 0.000001,
                  recomputed_total_market_cap_usd: 100,
                  recomputed_total_volume_usd: 10,
                },
                public_route_comparison: {
                  compared_route: '/global',
                  market_cap_delta_ratio: 0,
                  volume_delta_ratio: 0,
                  dominance_delta_ratios: { btc: 0 },
                  within_tolerance: true,
                },
              },
            },
            reason_codes: [],
            failing_dimensions: [],
          },
        ],
      },
    }));

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Global public route comparison');
    expect(result.stdout).toContain('public_total_market_cap_usd: 100');
    expect(result.stdout).toContain('recomputed_total_market_cap_usd: 100');
    expect(result.stdout).toContain('tolerance_ratio: 0.000001');
    expect(result.stdout).toContain('within_tolerance: true');
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
            runtime_family_ids: ['coins_markets'],
            aliases: ['coins_markets'],
            required: true,
            score: 6,
            target_threshold: 9,
            status: 'degraded',
            score_scopes: {
              contract_compatibility: 9.5,
              freshness_liveness: 6,
              live_source_fidelity: 6,
              fixture_fallback_transparency: 9.5,
              overall: 6,
            },
            source: {
              state: 'degraded',
              ownership_class: 'live',
              fallback: true,
              fallback_status: 'degraded',
              latest_source_at: '2026-05-17T00:00:00.000Z',
              freshness_state: 'degraded',
              freshness_budget: freshnessBudgetFixture({
                family: 'coins',
                current_age_seconds: 90,
                age_seconds: 90,
                status: 'degraded',
                reason: 'freshness_degraded',
                reason_codes: ['freshness_degraded'],
                source_state: 'degraded',
                counts_as_live_evidence: false,
                counts_as_live_freshness_evidence: false,
                non_live_evidence: true,
                provider_ids: ['binance'],
              }),
              provider_ids: ['binance'],
            },
            freshness_budget: freshnessBudgetFixture({
              family: 'coins',
              current_age_seconds: 90,
              age_seconds: 90,
              status: 'degraded',
              reason: 'freshness_degraded',
              reason_codes: ['freshness_degraded'],
              source_state: 'degraded',
              counts_as_live_evidence: false,
              counts_as_live_freshness_evidence: false,
              non_live_evidence: true,
              provider_ids: ['binance'],
            }),
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

  it('rejects malformed passing diagnostics with no family entries', () => {
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

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('schema/classification validation failed');
    expect(result.stderr).toContain('families_empty');
  });

  it('rejects unknown classifications and reason codes before passing the gate', () => {
    const result = runGateWithFixture(passingFixture({
      source: {
        state: 'magic',
        ownership_class: 'fixture',
        fallback: true,
        latest_source_at: null,
        freshness_state: 'fresh',
        provider_ids: [],
      },
      reason_codes: ['unregistered_reason_code'],
    }));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('family_source_state_unknown:simple:magic');
    expect(result.stderr).toContain('unknown_family_reason_code:simple:unregistered_reason_code');
  });

  it('rejects fixture, replay, or seeded data overclaimed as live source fidelity', () => {
    const result = runGateWithFixture(passingFixture({
      source: {
        state: 'fixture',
        ownership_class: 'fixture',
        fallback: true,
        latest_source_at: null,
        freshness_state: 'fresh',
        provider_ids: ['fixture'],
      },
      score_scopes: {
        contract_compatibility: 9.5,
        freshness_liveness: 9.5,
        live_source_fidelity: 9.5,
        fixture_fallback_transparency: 9.5,
        overall: 9.5,
      },
      reason_codes: ['fixture_only'],
    }));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('non_live_source_claims_live_fidelity:simple:fixture');
  });

  it('rejects live classifications carrying blocked-provider or stale evidence', () => {
    const result = runGateWithFixture(passingFixture({
      source: {
        state: 'live',
        ownership_class: 'live',
        fallback: false,
        latest_source_at: '2026-05-17T00:00:00.000Z',
        freshness_state: 'fresh',
        provider_ids: ['bybit'],
      },
      reason_codes: ['provider_blocked'],
    }));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('live_source_has_non_live_reason:simple');
  });

  it('rejects stale required families that are not listed below target', () => {
    const result = runGateWithFixture(passingFixture({
      source: {
        state: 'live',
        ownership_class: 'live',
        fallback: false,
        latest_source_at: '2026-05-17T00:00:00.000Z',
        freshness_state: 'stale',
        provider_ids: ['coinbase'],
      },
    }));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('stale_required_family_not_below_target:simple');
  });

  it('rejects mismatched below-threshold gate summaries', () => {
    const result = runGateWithFixture(JSON.stringify({
      data: {
        gate: {
          status: 'fail',
          threshold: 9,
          below_target_count: 0,
          below_target_families: [],
          reason_codes: ['required_family_below_threshold'],
        },
        families: [
          JSON.parse(passingFixture()).data.families[0],
        ].map((family) => ({
          ...family,
          score: 8,
          status: 'degraded',
          reason_codes: ['partial_coverage'],
        })),
      },
    }));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('below_target_family_mismatch');
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
          DATA_QUALITY_FIXTURE: passingFixture(),
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
      const assertionTable = readFileSync(manifest.assertion_result_table_path, 'utf8');
      expect(assertionTable).toContain('VAL-DQ-001\tpass');
      expect(assertionTable).toContain('VAL-DQ-004\tpass');
      expect(assertionTable).toContain('VAL-DQ-010\tpass');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
