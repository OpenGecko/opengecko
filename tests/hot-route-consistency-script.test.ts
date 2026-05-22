import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts/hot-route-consistency-check.sh');

type FixtureOptions = {
  simpleBitcoinPrice?: number;
  detailEthereumMarketCap?: number;
  globalTotalVolumeUsd?: number;
  simpleDiagnosticState?: 'live' | 'fixture' | 'live_stale';
};

const MARKET_UPDATED_AT = '2026-05-17T00:00:00.000Z';
const MARKET_UPDATED_AT_EPOCH = 1_778_976_000;

function qualityFamily(family: string, state: 'live' | 'fixture' | 'live_stale' = 'live') {
  const live = state === 'live' || state === 'live_stale';
  const stale = state === 'live_stale';

  return {
    family,
    status: live && !stale ? 'pass' : 'degraded',
    source: {
      state: live ? 'live' : 'fixture',
      ownership_class: live ? 'live' : 'fixture',
      fallback: !live,
      freshness_state: stale ? 'stale' : live ? 'fresh' : 'unbudgeted',
      provider_ids: live ? ['coinbase'] : [],
    },
    freshness_budget: {
      status: stale ? 'stale' : live ? 'fresh' : 'unbudgeted',
      reason: stale ? 'freshness_stale' : live ? 'within_budget' : 'fixture_source',
      reason_codes: stale ? ['stale_source'] : live ? ['within_budget'] : ['fixture_source'],
      counts_as_live_evidence: live,
      counts_as_live_freshness_evidence: live && !stale,
    },
    reason_codes: stale ? ['stale_source'] : live ? [] : ['fixture_only'],
  };
}

function buildFixtures(options: FixtureOptions = {}) {
  const markets = [
    {
      id: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      current_price: 100,
      market_cap: 1000,
      total_volume: 10,
      market_cap_rank: 1,
      last_updated: MARKET_UPDATED_AT,
    },
    {
      id: 'ethereum',
      symbol: 'eth',
      name: 'Ethereum',
      current_price: 50,
      market_cap: 500,
      total_volume: 5,
      market_cap_rank: 2,
      last_updated: MARKET_UPDATED_AT,
    },
  ];

  return {
    simple: {
      bitcoin: {
        usd: options.simpleBitcoinPrice ?? 100,
        usd_market_cap: 1000,
        usd_24h_vol: 10,
        last_updated_at: MARKET_UPDATED_AT_EPOCH,
      },
      ethereum: {
        usd: 50,
        usd_market_cap: 500,
        usd_24h_vol: 5,
        last_updated_at: MARKET_UPDATED_AT_EPOCH,
      },
    },
    marketsSelected: markets,
    marketsAll: markets,
    coinBitcoin: {
      id: 'bitcoin',
      market_data: {
        current_price: { usd: 100 },
        market_cap: { usd: 1000 },
        total_volume: { usd: 10 },
        market_cap_rank: 1,
        last_updated: MARKET_UPDATED_AT,
      },
    },
    coinEthereum: {
      id: 'ethereum',
      market_data: {
        current_price: { usd: 50 },
        market_cap: { usd: options.detailEthereumMarketCap ?? 500 },
        total_volume: { usd: 5 },
        market_cap_rank: 2,
        last_updated: MARKET_UPDATED_AT,
      },
    },
    global: {
      data: {
        total_market_cap: { usd: 1500 },
        total_volume: { usd: options.globalTotalVolumeUsd ?? 15 },
        market_cap_percentage: {
          btc: 66.66666666666666,
          eth: 33.33333333333333,
          usdc: 0,
        },
      },
    },
    diagnostics: {
      data: {
        families: [
          qualityFamily('simple', options.simpleDiagnosticState ?? 'live'),
          qualityFamily('coins'),
          qualityFamily('global'),
        ],
      },
    },
  };
}

function runConsistencyScript(options: FixtureOptions = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-hot-route-consistency-test-'));
  const fakeCurlPath = join(tempDir, 'curl');
  const fixtures = buildFixtures(options);

  writeFileSync(
    fakeCurlPath,
    `#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
case "$url" in
  */simple/price*) printf '%s' "$SIMPLE_FIXTURE"; exit 0 ;;
  */coins/markets*ids=bitcoin,ethereum*) printf '%s' "$MARKETS_SELECTED_FIXTURE"; exit 0 ;;
  */coins/markets*page=1*) printf '%s' "$MARKETS_ALL_FIXTURE"; exit 0 ;;
  */coins/bitcoin\\?*) printf '%s' "$COIN_BITCOIN_FIXTURE"; exit 0 ;;
  */coins/ethereum\\?*) printf '%s' "$COIN_ETHEREUM_FIXTURE"; exit 0 ;;
  */global) printf '%s' "$GLOBAL_FIXTURE"; exit 0 ;;
  */diagnostics/data_quality) printf '%s' "$DIAGNOSTICS_FIXTURE"; exit 0 ;;
esac
echo "unexpected curl request: $url" >&2
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
        BASE_URL: 'http://127.0.0.1:3100',
        SIMPLE_FIXTURE: JSON.stringify(fixtures.simple),
        MARKETS_SELECTED_FIXTURE: JSON.stringify(fixtures.marketsSelected),
        MARKETS_ALL_FIXTURE: JSON.stringify(fixtures.marketsAll),
        COIN_BITCOIN_FIXTURE: JSON.stringify(fixtures.coinBitcoin),
        COIN_ETHEREUM_FIXTURE: JSON.stringify(fixtures.coinEthereum),
        GLOBAL_FIXTURE: JSON.stringify(fixtures.global),
        DIAGNOSTICS_FIXTURE: JSON.stringify(fixtures.diagnostics),
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('hot route consistency script', () => {
  it('is shell-parseable', () => {
    const syntaxCheck = spawnSync('bash', ['-n', SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
  });

  it('passes when hot routes and diagnostics agree within documented tolerances', () => {
    const result = runConsistencyScript();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('OpenGecko Hot Route Consistency Check');
    expect(result.stdout).toContain('VAL-CROSS-001: pass');
    expect(result.stdout).toContain('VAL-CROSS-002: pass');
    expect(result.stdout).toContain('VAL-CROSS-003: pass');
    expect(result.stdout).toContain('VAL-CROSS-004: pass');
    expect(result.stdout).toContain('simple: source_state=live');
    expect(result.stdout).toContain('live_promotion_proof=true');
  });

  it('fails when /simple/price diverges from /coins/markets', () => {
    const result = runConsistencyScript({ simpleBitcoinPrice: 101 });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VAL-CROSS-001: fail');
    expect(result.stderr).toContain('VAL-CROSS-001: simple_markets_mismatch:bitcoin:usd');
  });

  it('fails when /coins/{id} market data diverges from /coins/markets', () => {
    const result = runConsistencyScript({ detailEthereumMarketCap: 700 });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VAL-CROSS-002: fail');
    expect(result.stderr).toContain('VAL-CROSS-002: coin_detail_markets_mismatch:ethereum:market_cap.usd');
  });

  it('fails when /global aggregates diverge from recomputed market snapshots', () => {
    const result = runConsistencyScript({ globalTotalVolumeUsd: 30 });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VAL-CROSS-003: fail');
    expect(result.stderr).toContain('VAL-CROSS-003: global_markets_mismatch:global:total_volume.usd');
  });

  it('does not count non-live diagnostic classifications as live promotion proof', () => {
    const result = runConsistencyScript({ simpleDiagnosticState: 'fixture' });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('VAL-CROSS-004: pass');
    expect(result.stdout).toContain('simple: source_state=fixture');
    expect(result.stdout).toContain('live_promotion_proof=false');
  });

  it('fails when diagnostics classify a hot route as live without matching freshness evidence', () => {
    const result = runConsistencyScript({ simpleDiagnosticState: 'live_stale' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VAL-CROSS-004: fail');
    expect(result.stderr).toContain('VAL-CROSS-004: diagnostic_live_evidence_incomplete:simple');
  });
});
