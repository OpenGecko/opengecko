import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts/operator-proof-smoke.sh');

describe('operator proof smoke script contract', () => {
  it('is shell-parseable', () => {
    const syntaxCheck = spawnSync('bash', ['-n', SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
  });

  it('records reproducible operator evidence while using only temp state and public routes', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');

    expect(script).toContain('DATABASE_URL="${DB_PATH_3100}"');
    expect(script).toContain('DATABASE_URL="${DB_PATH_3102}"');
    expect(script).toContain('PORT=3100');
    expect(script).toContain('PORT=3102');
    expect(script).toContain('RESERVED_PORTS=(3100 3101 3102)');
    expect(script).toContain('check_reserved_ports_clear "preflight"');
    expect(script).toContain('check_reserved_ports_clear "post-cleanup"');
    expect(script).toContain('git rev-parse HEAD');
    expect(script).toContain('bun --version');
    expect(script).toContain('jq');
    expect(script).not.toContain('COINGECKO_API_KEY');
    expect(script).not.toContain('/home/whoami/dev/opengecko/data');
  });

  it('runs endpoint smoke modules serially and proves degraded and recovered states', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');

    expect(script).toContain('run_smoke_modules_serially');
    expect(script).toContain('DEFAULT_SMOKE_MODULES=(exchanges)');
    expect(script).toContain('SMOKE_EXECUTED_FILE');
    expect(script).toContain('SMOKE_SKIPPED_FILE');
    expect(script).toContain('using curated default modules');
    expect(script).toContain('for module in "${modules[@]}"');
    expect(script).not.toContain('serial module smoke skipped');
    expect(script).toContain('/diagnostics/runtime/degraded_state');
    expect(script).toContain('/diagnostics/runtime/provider_failure');
    expect(script).toContain('mode":"degraded_seeded_bootstrap');
    expect(script).toContain('active":true');
    expect(script).toContain('active":false');
    expect(script).toContain('wait_for_port_clear 3100');
    expect(script).toContain('wait_for_port_clear 3102');
  });

  it('gates cross-area proof on finite prioritized market, ticker, chart, and OHLC overlap', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');

    expect(script).toContain('CROSS_OVERLAP_FILE');
    expect(script).toContain('wait_for_cross_overlap_readiness 3100 90');
    expect(script).toContain('has_finite_market_coin');
    expect(script).toContain('has_finite_ticker_coin');
    expect(script).toContain('has_recent_chart_points');
    expect(script).toContain('has_recent_ohlc_points');
    expect(script).toContain('/coins/markets?vs_currency=usd&ids=bitcoin,ethereum');
    expect(script).toContain('/coins/bitcoin/tickers?depth=true');
    expect(script).toContain('/coins/ethereum/tickers?depth=true');
    expect(script).toContain('/exchanges/binance/tickers?coin_ids=bitcoin,ethereum');
    expect(script).toContain('/coins/bitcoin/market_chart?vs_currency=usd&days=1');
    expect(script).toContain('/coins/bitcoin/ohlc?vs_currency=usd&days=1');
    expect(script).toContain('provider_variability_classified_by_diagnostics');
    expect(script).toContain('finite BTC/ETH market, ticker, chart, and OHLC overlap was not ready within proof window');
  });
});
