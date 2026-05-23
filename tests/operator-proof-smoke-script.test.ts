import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts/operator-proof-smoke.sh');
const HELPERS_PATH = join(process.cwd(), 'scripts/lib/operator-proof-helpers.sh');
const SERVER_PATH = join(process.cwd(), 'src/server.ts');
const ENDPOINT_SMOKE_PATH = join(process.cwd(), 'scripts/test-endpoints.sh');
const MODULE_COMMON_PATH = join(process.cwd(), 'scripts/modules/lib/common.sh');

describe('operator proof smoke script contract', () => {
  it('is shell-parseable', () => {
    const syntaxCheck = spawnSync('bash', ['-n', SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);

    const helperSyntaxCheck = spawnSync('bash', ['-n', HELPERS_PATH], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(helperSyntaxCheck.status, helperSyntaxCheck.stderr).toBe(0);
  });

  it('records reproducible operator evidence while using only temp state and public routes', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const helpers = readFileSync(HELPERS_PATH, 'utf8');
    const contract = `${script}\n${helpers}`;

    expect(script).toContain('source "${REPO_ROOT}/scripts/lib/operator-proof-helpers.sh"');
    expect(contract).toContain('DATABASE_URL="${DB_PATH_3100}"');
    expect(contract).toContain('DATABASE_URL="${DB_PATH_3102}"');
    expect(contract).toContain('DATABASE_URL="${DB_PATH_3103}"');
    expect(script).toContain('DB_PATH_3102=":memory:"');
    expect(script).toContain('DB_PATH_3103="${PROOF_ROOT}/opengecko-quality.sqlite"');
    expect(contract).toContain('PORT=3100');
    expect(contract).toContain('PORT=3102');
    expect(contract).toContain('PORT=3103');
    expect(contract).toContain('DEFILLAMA_BASE_URL="${defillama_base_url}"');
    expect(contract).toContain('OPEN_GECKO_DISABLE_REPO_DOTENV="${disable_repo_dotenv}"');
    expect(contract).toContain('CCXT_EXCHANGES="${ccxt_exchanges}"');
    expect(contract).toContain('PROVIDER_FANOUT_CONCURRENCY="${provider_fanout_concurrency}"');
    expect(contract).toContain('DEFAULT_LIVE_PROMOTION_CCXT_EXCHANGES=(coinbase kraken okx gate mexc bitget bigone kucoin htx bitmart lbank whitebit coinex ascendex binance bybit)');
    expect(contract).toContain('minimum_live_promotion_exchange_attempts');
    expect(contract).toContain('RESERVED_PORTS=(3100 3102 3103)');
    expect(contract).not.toContain('RESERVED_PORTS=(3100 3101 3102)');
    expect(contract).toContain('check_reserved_ports_clear "preflight"');
    expect(contract).toContain('check_reserved_ports_clear "post-cleanup"');
    expect(contract).toContain('git rev-parse HEAD');
    expect(contract).toContain('bun --version');
    expect(contract).toContain('jq');
    expect(contract).not.toContain('COINGECKO_API_KEY');
    expect(contract).not.toContain('/home/whoami/dev/opengecko/data');
  });

  it('runs endpoint smoke modules serially and proves degraded and recovered states', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const helpers = readFileSync(HELPERS_PATH, 'utf8');
    const contract = `${script}\n${helpers}`;

    expect(contract).toContain('run_smoke_modules_serially');
    expect(contract).toContain('DEFAULT_SMOKE_MODULES=(exchanges)');
    expect(contract).toContain('SMOKE_EXECUTED_FILE');
    expect(contract).toContain('SMOKE_SKIPPED_FILE');
    expect(contract).toContain('SERVER_LIFECYCLE_FILE');
    expect(contract).toContain('server-lifecycle.jsonl');
    expect(contract).toContain('assert_server_running 3100 "after-health"');
    expect(contract).toContain('assert_server_running 3100 "after-smoke-modules"');
    expect(contract).toContain('using curated default modules');
    expect(contract).toContain('for module in "${modules[@]}"');
    expect(contract).not.toContain('serial module smoke skipped');
    expect(contract).toContain('/diagnostics/runtime/degraded_state');
    expect(contract).toContain('/diagnostics/runtime/provider_failure');
    expect(contract).toContain('mode":"degraded_seeded_bootstrap');
    expect(contract).toContain('active":true');
    expect(contract).toContain('active":false');
    expect(contract).toContain('wait_for_port_clear 3100');
    expect(contract).toContain('wait_for_port_clear 3102');
    expect(contract).toContain('wait_for_port_clear 3103');
    expect(contract).toContain('wait_for_initial_sync_completed 3103 90');
    expect(contract).toContain('run_data_quality_gate_serially "http://127.0.0.1:3103"');
  });

  it('gates cross-area proof on finite prioritized market, ticker, chart, and OHLC overlap', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const helpers = readFileSync(HELPERS_PATH, 'utf8');
    const contract = `${script}\n${helpers}`;

    expect(contract).toContain('CROSS_OVERLAP_FILE');
    expect(contract).toContain('wait_for_cross_overlap_readiness 3100 90');
    expect(contract).toContain('run_hot_route_consistency_check_serially "http://127.0.0.1:3100"');
    expect(contract).toContain('BASE_URL=${base_url} bash scripts/hot-route-consistency-check.sh');
    expect(contract).toContain('has_finite_market_coin');
    expect(contract).toContain('has_finite_ticker_coin');
    expect(contract).toContain('has_recent_chart_points');
    expect(contract).toContain('has_recent_ohlc_points');
    expect(contract).toContain('/coins/markets?vs_currency=usd&ids=bitcoin,ethereum');
    expect(contract).toContain('/coins/bitcoin/tickers?depth=true');
    expect(contract).toContain('/coins/ethereum/tickers?depth=true');
    expect(contract).toContain('select_source_backed_exchange_id');
    expect(contract).toContain('/exchanges/${exchange_id}/tickers?coin_ids=bitcoin,ethereum');
    expect(contract).toContain('/coins/bitcoin/market_chart?vs_currency=usd&days=1');
    expect(contract).toContain('/coins/bitcoin/ohlc?vs_currency=usd&days=1');
    expect(contract).toContain('provider_variability_classified_by_diagnostics');
    expect(contract).toContain('finite BTC/ETH market, ticker, chart, and OHLC overlap was not ready within proof window');
  });

  it('writes live-promotion evidence for reachable exchange, hot market, onchain, and blocked-provider assertions', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const helpers = readFileSync(HELPERS_PATH, 'utf8');
    const contract = `${script}\n${helpers}`;

    expect(contract).toContain('LIVE_PROMOTION_FILE="${PROOF_ROOT}/live-promotion-evidence.json"');
    expect(contract).toContain('write_live_promotion_evidence 3100 healthy');
    expect(contract).toContain('VAL-LIVE-001');
    expect(contract).toContain('VAL-LIVE-006');
    expect(contract).toContain('attempted_exchange_count');
    expect(contract).toContain('live_backed_exchange_count');
    expect(contract).toContain('fixture_seeded_replay_contract_only_do_not_count_as_live');
    expect(contract).toContain('live-promotion-attempts-at-least-12');
    expect(contract).toContain('live-promotion-blocked-provider-visibility');
    expect(contract).toContain('live-promotion-hot-market-fresh-live');
    expect(contract).toContain('live-promotion-onchain-external-honest');
    expect(contract).toContain('live_promotion_file');
  });

  it('exposes reusable helpers for port checks, command logs, samples, jq assertions, bundles, and module execution', () => {
    const helpers = readFileSync(HELPERS_PATH, 'utf8');

    for (const helperName of [
      'check_reserved_ports_clear',
      'stop_server',
      'record_command',
      'record_server_lifecycle',
      'assert_server_running',
      'capture_server_log_tail',
      'wait_for_initial_sync_completed',
      'capture_get',
      'capture_post',
      'assert_jq',
      'write_summary',
      'write_versions',
      'default_ccxt_exchanges_csv',
      'select_source_backed_exchange_id',
      'write_live_promotion_evidence',
      'run_smoke_modules_serially',
      'run_data_quality_gate_serially',
      'data_quality_gate_failure_is_pending_scope',
      'run_hot_route_consistency_check_serially',
    ]) {
      expect(helpers).toContain(`${helperName}()`);
    }
  });

  it('captures server process lifecycle in both service logs and proof bundles', () => {
    const server = readFileSync(SERVER_PATH, 'utf8');
    const script = readFileSync(SCRIPT_PATH, 'utf8');
    const helpers = readFileSync(HELPERS_PATH, 'utf8');
    const contract = `${script}\n${helpers}`;

    expect(server).toContain("process.once('SIGTERM'");
    expect(server).toContain("process.once('SIGINT'");
    expect(server).toContain("process.on('unhandledRejection'");
    expect(server).toContain("process.once('uncaughtException'");
    expect(server).toContain("process.on('exit'");
    expect(server).toContain('logged_and_kept_process_alive');
    expect(server).toContain('APP_CLOSE_TIMEOUT_MS');
    expect(server).toContain('app_close_timeout_after_signal');
    expect(server).toContain('server process lifecycle event=');
    expect(contract).toContain('record_server_lifecycle');
    expect(contract).toContain('owned server stopped before expected teardown');
    expect(contract).toContain('server_lifecycle_file');
    expect(contract).toContain('data-quality-gate-pending-scope.json');
    expect(contract).toContain('only pending-scope non-provider live-data families were below threshold');
  });

  it('helper command and port recorders write the stable jsonl contract', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          'PROOF_ROOT="$(mktemp -d /tmp/opengecko-proof-helper-test.XXXXXX)"',
          'COMMANDS_FILE="${PROOF_ROOT}/commands.jsonl"',
          'PORT_CHECKS_FILE="${PROOF_ROOT}/port-checks.jsonl"',
          'SERVER_LIFECYCLE_FILE="${PROOF_ROOT}/server-lifecycle.jsonl"',
          'SERVER_PID=""',
          'CURRENT_PORT=""',
          'FAILURES=0',
          `source "${HELPERS_PATH}"`,
          'record_command "phase" "echo ok" 0',
          'record_port_check "preflight" 3100 "clear" "no listener found" 0',
          'record_server_lifecycle "after-health" 3100 "4242" "running" "owned server process and listener are alive" 0',
          'jq -e \'select(.phase == "phase" and .command == "echo ok" and .exit_code == 0)\' "$COMMANDS_FILE" >/dev/null',
          'jq -e \'select(.phase == "preflight" and .port == 3100 and .status == "clear" and .exit_code == 0)\' "$PORT_CHECKS_FILE" >/dev/null',
          'jq -e \'select(.phase == "after-health" and .port == 3100 and .pid == "4242" and .status == "running" and .exit_code == 0)\' "$SERVER_LIFECYCLE_FILE" >/dev/null',
        ].join('\n'),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('records occupied reserved ports as preflight failures without cleaning unknown listeners', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          'PROOF_ROOT="$(mktemp -d /tmp/opengecko-proof-helper-test.XXXXXX)"',
          'COMMANDS_FILE="${PROOF_ROOT}/commands.jsonl"',
          'PORT_CHECKS_FILE="${PROOF_ROOT}/port-checks.jsonl"',
          'SERVER_PID=""',
          'CURRENT_PORT=""',
          'FAILURES=0',
          'RESERVED_PORTS=(3100 3102 3103)',
          `source "${HELPERS_PATH}"`,
          'lsof() {',
          '  case "$*" in',
          '    *:3103*) printf "4242\\n"; return 0 ;;',
          '    *) return 1 ;;',
          '  esac',
          '}',
          'set +e',
          'check_reserved_ports_clear "preflight"',
          'status="$?"',
          'set -e',
          'test "$status" -eq 98',
          'jq -e \'select(.phase == "preflight" and .port == 3100 and .status == "clear" and .exit_code == 0)\' "$PORT_CHECKS_FILE" >/dev/null',
          'jq -e \'select(.phase == "preflight" and .port == 3102 and .status == "clear" and .exit_code == 0)\' "$PORT_CHECKS_FILE" >/dev/null',
          'jq -e \'select(.phase == "preflight" and .port == 3103 and .status == "occupied" and .detail == "pids=4242; refusing to touch unknown process" and .exit_code == 98)\' "$PORT_CHECKS_FILE" >/dev/null',
          'jq -e \'select(.phase == "reserved-port-preflight" and .command == "check reserved ports 3100 3102 3103 are clear" and .exit_code == 98)\' "$COMMANDS_FILE" >/dev/null',
        ].join('\n'),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('treats partial live simple top-10 breadth as a smoke precondition skip', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opengecko-simple-smoke-'));
    const fakeCurlPath = join(tempDir, 'curl');

    writeFileSync(
      fakeCurlPath,
      `#!/usr/bin/env bash
set -euo pipefail
out=""
write_out=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) write_out="$2"; shift 2 ;;
    --max-time|-H|-d|-X) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done

body='{}'
case "$url" in
  */ping) body='{"gecko_says":"(V3) To the Moon!"}' ;;
  */simple/supported_vs_currencies) body='["usd","eur","usdt"]' ;;
  */simple/price*ids=tether*include_market_cap*) body='{"tether":{"usd":1,"usd_market_cap":100,"usd_24h_vol":10,"usd_24h_change":0,"last_updated_at":1700000000}}' ;;
  */simple/price*include_market_cap*) body='{"bitcoin":{"usd":1,"usd_market_cap":100,"usd_24h_vol":10,"usd_24h_change":1,"last_updated_at":1700000000}}' ;;
  */simple/price*ids=bitcoin*vs_currencies=usd) body='{"bitcoin":{"usd":1}}' ;;
  */simple/price*ids=bitcoin,ethereum,tether,binancecoin,solana,ripple,usd-coin,dogecoin,cardano,tron*) body='{"bitcoin":{"usd":1},"ethereum":{"usd":2}}' ;;
  */simple/price*ids=bitcoin,ethereum,tether,binancecoin,solana,ripple,usd-coin,dogecoin,cardano,tron,avalanche-2*) body='{"bitcoin":{"usd":1},"ethereum":{"usd":2}}' ;;
  */simple/token_price/ethereum*) body='{}' ;;
  */exchange_rates) body='{"rates":{"usd":{"value":100000}}}' ;;
esac

if [[ -n "$out" ]]; then
  printf '%s' "$body" > "$out"
else
  printf '%s' "$body"
fi

if [[ -n "$write_out" ]]; then
  printf '200|0.001|application/json'
fi
`,
    );
    chmodSync(fakeCurlPath, 0o755);

    try {
      const result = spawnSync('bash', ['scripts/modules/simple/simple.sh'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ''}`,
          BASE_URL: 'http://127.0.0.1:3100',
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('SKIP');
      expect(result.stdout).toContain('top-10 live breadth precondition is not met yet');
      expect(result.stdout).toContain('top-50 price basket returns at least one matched asset object');
      expect(result.stdout).not.toContain('FAIL top-10 price basket returns 10 asset objects');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('documents and reuses a configurable endpoint smoke curl timeout budget', () => {
    const endpointSmoke = readFileSync(ENDPOINT_SMOKE_PATH, 'utf8');
    const moduleCommon = readFileSync(MODULE_COMMON_PATH, 'utf8');
    const contract = `${endpointSmoke}\n${moduleCommon}`;

    expect(contract).toContain('ENDPOINT_CURL_MAX_TIME="${ENDPOINT_CURL_MAX_TIME:-20}"');
    expect(endpointSmoke).toContain('BASE_URL="${BASE_URL:-http://127.0.0.1:3100}"');
    expect(moduleCommon).toContain('BASE_URL="${BASE_URL:-http://127.0.0.1:3100}"');
    expect(contract).toContain('ENDPOINT_CURL_MAX_TIME must be a positive integer number of seconds');
    expect(contract).toContain('set ENDPOINT_CURL_MAX_TIME to tune endpoint request budget');
    expect(endpointSmoke).toContain('--max-time "$ENDPOINT_CURL_MAX_TIME" "$full_url"');
    expect(moduleCommon).toContain('--max-time "$ENDPOINT_CURL_MAX_TIME" "${BASE_URL}${path}"');
    expect(endpointSmoke).not.toContain('--max-time 10');
    expect(moduleCommon).not.toContain('--max-time 10');
  });
});
