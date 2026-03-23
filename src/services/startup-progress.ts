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
  let hasRendered = false;
  let previousLines = 0;
  let listeningPort: number | undefined;

  function pad(str: string, len: number): string {
    return str.length >= len ? str : str + ' '.repeat(len - str.length);
  }

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function render(port?: number) {
    const completedCount = INITIAL_STARTUP_STEPS.filter((step) => statuses.get(step.id) === 'done').length;
    const totalMs = Array.from(stepDurations.values()).reduce((a, b) => a + b, 0);
    const doneSteps = INITIAL_STARTUP_STEPS.filter((s) => statuses.get(s.id) === 'done');
    const labelWidth = Math.max(...INITIAL_STARTUP_STEPS.map((s) => s.label.length), 18);

    // ── Header ──────────────────────────────────────────────────────────
    // Each line inside ║ ║ must be exactly 68 visible characters wide
    const art = [
      '░█▀█░█▀█░█▀▀░█▀█░█▀▀░█▀▀░█▀▀░█░█░█▀█',
      '░█░█░█▀▀░█▀▀░█░█░█░█░█▀▀░█░░░█▀▄░█░█',
      '░▀▀▀░▀░░░▀▀▀░▀░▀░▀▀▀░▀▀▀░▀▀▀░▀░▀░▀▀▀',
    ];
    const artPad = 15; // left padding for art lines
    const header = [
      `${C.cyan}╔${'═'.repeat(68)}╗${C.reset}`,
      `${C.cyan}║${' '.repeat(68)}${C.cyan}║${C.reset}`,
      ...art.map((line) => {
        const right = 68 - artPad - line.length;
        return `${C.cyan}║${C.reset}${C.bold}${C.cyan}${' '.repeat(artPad)}${line}${' '.repeat(right)}${C.reset}${C.cyan}║${C.reset}`;
      }),
      `${C.cyan}║${' '.repeat(68)}${C.cyan}║${C.reset}`,
      `${C.cyan}║${C.reset}${C.dim}  v0.2.1 \u00b7 CoinGecko-compatible open-source API${' '.repeat(21)}${C.reset}${C.cyan}║${C.reset}`,
      `${C.cyan}║${' '.repeat(68)}${C.cyan}║${C.reset}`,
      `${C.cyan}╚${'═'.repeat(68)}╝${C.reset}`,
    ].join('\n');

    // ── Step rows ────────────────────────────────────────────────────────
    const stepLines = INITIAL_STARTUP_STEPS.map((step) => {
      const status = statuses.get(step.id);
      const ms = stepDurations.get(step.id);
      const failed = failure?.stepId === step.id;

      let marker: string;
      let markerColor: string;
      let labelColor: string;
      let msColor: string;

      if (failed) {
        marker = '✗';
        markerColor = C.red;
        labelColor = C.red;
        msColor = C.red;
      } else if (status === 'done') {
        marker = CHECK;
        markerColor = C.green;
        labelColor = C.reset;
        msColor = C.yellow;
      } else if (status === 'active') {
        marker = BLOCK;
        markerColor = C.cyan;
        labelColor = C.bold + C.cyan;
        msColor = C.cyan;
      } else {
        marker = '·';
        markerColor = C.dim;
        labelColor = C.dim;
        msColor = C.dim;
      }

      const detail = step.id === 'start_ohlcv_worker' && ohlcvProgress
        ? ` ${C.dim}(${ohlcvProgress.current}/${ohlcvProgress.total})${C.reset}`
        : '';

      const label = pad(step.label, labelWidth);
      const msStr = ms !== undefined ? pad(formatMs(ms), 6) : pad('', 6);
      const errorSuffix = failed ? ` ${C.red}${C.dim}${failure!.message}${C.reset}` : '';
      const padding = ' '.repeat(Math.max(0, 42 - label.length - msStr.length - detail.length));

      return `  ${markerColor}${marker}${C.reset}  ${labelColor}${label}${C.reset}${padding}${msColor}${msStr}${C.reset}${detail}${errorSuffix}`;
    });

    // ── Footer ───────────────────────────────────────────────────────────
    const allDone = doneSteps.length === INITIAL_STARTUP_STEPS.length;
    const footer = allDone && !failure
      ? `\n  ${C.green}${CHECK}${C.reset}  ${completedCount}/${INITIAL_STARTUP_STEPS.length} systems online · ${formatMs(totalMs)} total${port ? `\n  ${C.cyan}▸${C.reset}  Listening on :${port}` : ''}`
      : failure
        ? `\n  ${C.red}✗${C.reset}  Failed: ${failure.message}`
        : `\n  ${C.cyan}${BLOCK}${C.reset}  Starting... ${completedCount}/${INITIAL_STARTUP_STEPS.length}`;

    const frame = `\n${header}\n${stepLines.join('\n')}${footer}\n`;
    const lines = frame.split('\n').length;
    const moveUp = hasRendered ? `\x1b[${previousLines}A` : '';
    write(`${moveUp}${frame}`);
    hasRendered = true;
    previousLines = lines;
  }

  return {
    start(port?: number) {
      listeningPort = port;
      render(port);
    },
    begin(stepId, nextOhlcvProgress) {
      failure = null;

      if (activeStepId && activeStepId !== stepId && statuses.get(activeStepId) === 'active') {
        // Record duration for the step we just finished
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
      render(listeningPort);
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

      render(listeningPort);
    },
    fail(stepId, message) {
      statuses.set(stepId, 'active');
      activeStepId = stepId;
      failure = { stepId, message };
      render(listeningPort);
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

      render(listeningPort);
    },
  };
}
