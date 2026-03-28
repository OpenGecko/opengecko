export const INITIAL_STARTUP_STEPS = [
  { id: 'load_config', label: 'Load config' },
  { id: 'connect_database', label: 'Connect database' },
  { id: 'sync_exchange_metadata', label: 'Sync exchange metadata' },
  { id: 'sync_coin_catalog', label: 'Sync coin catalog' },
  { id: 'sync_chain_catalog', label: 'Sync chain catalog' },
  { id: 'build_market_snapshots', label: 'Build market snapshots' },
  { id: 'start_ohlcv_worker', label: 'Start OHLCV worker' },
  { id: 'seed_reference_data', label: 'Seed reference data' },
  { id: 'rebuild_search_index', label: 'Rebuild search index' },
  { id: 'start_http_listener', label: 'Start HTTP listener' },
] as const;

export type StartupStepId = typeof INITIAL_STARTUP_STEPS[number]['id'];

type StepStatus = 'pending' | 'active' | 'done';

type StepFailure = {
  stepId: StartupStepId;
  message: string;
};

type OhlcvProgress = {
  current: number;
  total: number;
};

export type StartupProgressReporter = {
  start: (port?: number) => void;
  begin: (stepId: StartupStepId, ohlcvProgress?: OhlcvProgress) => void;
  complete: (stepId: StartupStepId) => void;
  fail: (stepId: StartupStepId, message: string) => void;
  failCurrent: (message: string) => void;
  updateOhlcvProgress: (current: number, total: number) => void;
};

type CreateStartupProgressTrackerOptions = {
  write?: (value: string) => void;
};

// ANSI escape codes
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

const CHECK = '\u2713'; // ✓
const BLOCK = '\u2588'; // █

export function createStartupProgressTracker(
  options: CreateStartupProgressTrackerOptions = {},
): StartupProgressReporter {
  const write = options.write ?? ((value: string) => process.stdout.write(value));
  const statuses = new Map<StartupStepId, StepStatus>(
    INITIAL_STARTUP_STEPS.map((step) => [step.id, 'pending']),
  );
  const stepStartTimes = new Map<StartupStepId, number>();
  const stepDurations = new Map<StartupStepId, number>();
  let activeStepId: StartupStepId | null = null;
  let ohlcvProgress: OhlcvProgress | null = null;
  let failure: StepFailure | null = null;
  let bannerPrinted = false;
  let listeningPort: number | undefined;

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function printBanner() {
    const banner = [
      '',
      `${C.cyan}╔${'═'.repeat(68)}╗${C.reset}`,
      `${C.cyan}║${' '.repeat(68)}${C.cyan}║${C.reset}`,
      ...['░█▀█░█▀█░█▀▀░█▀█░█▀▀░█▀▀░█▀▀░█░█░█▀█',
          '░█░█░█▀▀░█▀▀░█░█░█░█░█▀▀░█░░░█▀▄░█░█',
          '░▀▀▀░▀░░░▀▀▀░▀░▀░▀▀▀░▀▀▀░▀▀▀░▀░▀░▀▀▀'].map((line) => {
        const pad = 15;
        const right = 68 - pad - line.length;
        return `${C.cyan}║${C.reset}${C.bold}${C.cyan}${' '.repeat(pad)}${line}${' '.repeat(right)}${C.reset}${C.cyan}║${C.reset}`;
      }),
      `${C.cyan}║${' '.repeat(68)}${C.cyan}║${C.reset}`,
      `${C.cyan}║${C.reset}${C.dim}  v0.5.0 \u00b7 CoinGecko-compatible open-source API${' '.repeat(21)}${C.reset}${C.cyan}║${C.reset}`,
      `${C.cyan}║${' '.repeat(68)}${C.cyan}║${C.reset}`,
      `${C.cyan}╚${'═'.repeat(68)}╝${C.reset}`,
      '',
    ].join('\n');
    write(`${banner}\n`);
  }

  function logStep(stepId: StartupStepId, message: string) {
    write(`  ${message}\n`);
  }

  function logListening(port: number) {
    write(`\n  ${C.cyan}▸${C.reset}  Listening on :${port}\n`);
  }

  return {
    start(port?: number) {
      listeningPort = port;

      if (!bannerPrinted) {
        printBanner();
        bannerPrinted = true;
        return;
      }

      if (port !== undefined) {
        logListening(port);
      }
    },
    begin(stepId, nextOhlcvProgress) {
      failure = null;

      if (activeStepId && activeStepId !== stepId && statuses.get(activeStepId) === 'active') {
        const startTime = stepStartTimes.get(activeStepId);
        if (startTime !== undefined) {
          stepDurations.set(activeStepId, Date.now() - startTime);
        }
        statuses.set(activeStepId, 'done');
      }

      stepStartTimes.set(stepId, Date.now());
      activeStepId = stepId;
      statuses.set(stepId, 'active');
      ohlcvProgress = stepId === 'start_ohlcv_worker' ? nextOhlcvProgress ?? ohlcvProgress : null;

      const step = INITIAL_STARTUP_STEPS.find((s) => s.id === stepId);
      const label = step?.label ?? stepId;
      const detail = stepId === 'start_ohlcv_worker' && ohlcvProgress
        ? ` (${ohlcvProgress.current}/${ohlcvProgress.total})`
        : '';
      logStep(stepId, `${C.cyan}${BLOCK}${C.reset}  ${C.bold}${C.cyan}${label}${detail}${C.reset}`);
    },
    complete(stepId) {
      const startTime = stepStartTimes.get(stepId);
      if (startTime !== undefined) {
        stepDurations.set(stepId, Date.now() - startTime);
      }

      statuses.set(stepId, 'done');

      if (activeStepId === stepId) {
        activeStepId = null;
      }

      if (stepId === 'start_ohlcv_worker') {
        ohlcvProgress = null;
      }

      const step = INITIAL_STARTUP_STEPS.find((s) => s.id === stepId);
      const label = step?.label ?? stepId;
      const ms = stepDurations.get(stepId);
      const duration = ms !== undefined ? ` ${C.yellow}${formatMs(ms)}${C.reset}` : '';
      logStep(stepId, `${C.green}${CHECK}${C.reset}  ${label}${duration}`);
    },
    fail(stepId, message) {
      statuses.set(stepId, 'active');
      activeStepId = stepId;
      failure = { stepId, message };

      const step = INITIAL_STARTUP_STEPS.find((s) => s.id === stepId);
      const label = step?.label ?? stepId;
      logStep(stepId, `${C.red}✗${C.reset}  ${label} ${C.red}${C.dim}${message}${C.reset}`);
    },
    failCurrent(message) {
      if (!activeStepId) {
        this.fail('start_http_listener', message);
        return;
      }

      this.fail(activeStepId, message);
    },
    updateOhlcvProgress(current, total) {
      ohlcvProgress = { current, total };

      if (statuses.get('start_ohlcv_worker') !== 'active') {
        this.begin('start_ohlcv_worker', ohlcvProgress);
        return;
      }

      const step = INITIAL_STARTUP_STEPS.find((s) => s.id === 'start_ohlcv_worker');
      const label = step?.label ?? 'start_ohlcv_worker';
      logStep('start_ohlcv_worker', `${C.cyan}${BLOCK}${C.reset}  ${C.bold}${C.cyan}${label} (${current}/${total})${C.reset}`);
    },
  };
}
