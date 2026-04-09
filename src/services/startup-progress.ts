export const INITIAL_STARTUP_STEPS = [
  { id: 'load_config', label: 'Load configuration' },
  { id: 'connect_database', label: 'Initialize database' },
  { id: 'sync_exchange_metadata', label: 'Sync exchange metadata' },
  { id: 'sync_coin_catalog', label: 'Sync coin catalog' },
  { id: 'sync_chain_catalog', label: 'Sync chain catalog' },
  { id: 'build_market_snapshots', label: 'Refreshing market snapshots' },
  { id: 'start_ohlcv_worker', label: 'Start OHLCV worker' },
  { id: 'seed_reference_data', label: 'Seed reference data' },
  { id: 'rebuild_search_index', label: 'Rebuild search index' },
  { id: 'start_http_listener', label: 'Start HTTP listener' },
] as const;

export type StartupStepId = typeof INITIAL_STARTUP_STEPS[number]['id'];

type OhlcvProgress = {
  current: number;
  total: number;
};

export type RuntimeInfo = {
  runtime: 'node' | 'bun';
  driver: string;
  databaseUrl: string;
};

export type StartupProgressReporter = {
  start: (info: RuntimeInfo) => void;
  begin: (stepId: StartupStepId, ohlcvProgress?: OhlcvProgress) => void;
  complete: (stepId: StartupStepId) => void;
  fail: (stepId: StartupStepId, message: string) => void;
  failCurrent: (message: string) => void;
  reportExchangeResult: (exchangeId: string, status: 'ok' | 'failed', message?: string) => void;
  reportCatalogResult: (id: string, category: string, count: number, durationMs: number) => void;
  reportWarning: (message: string) => void;
  reportStatus: (message: string) => void;
  finish: (port: number) => void;
  updateOhlcvProgress: (current: number, total: number) => void;
};

type CreateStartupProgressTrackerOptions = {
  write?: (value: string) => void;
  isInteractive?: boolean;
};

function summarizeStartupMessage(message: string) {
  const singleLine = message.replace(/\s+/g, ' ').trim();

  if (/403 Forbidden/i.test(singleLine) && /block access from your country|regional block/i.test(singleLine)) {
    return '403 Forbidden: regional block';
  }

  if (/timed out|timeout/i.test(singleLine)) {
    return 'Request timed out';
  }

  if (/429|rate limit/i.test(singleLine)) {
    return 'Rate limited';
  }

  if (/503|unavailable/i.test(singleLine)) {
    return 'Provider unavailable';
  }

  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

const BULLET = '\u25cf'; // ●
const PENDING = '\u25cc'; // ◌
const REFRESH = '\u21bb'; // ↻
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const SECTION_BY_STEP: Record<StartupStepId, string> = {
  load_config: 'PRE-FLIGHT CHECKS',
  connect_database: 'PRE-FLIGHT CHECKS',
  sync_exchange_metadata: 'INITIAL DATA SYNCHRONIZATION',
  sync_coin_catalog: 'CATALOG DISCOVERY',
  sync_chain_catalog: 'CATALOG DISCOVERY',
  build_market_snapshots: 'MARKET SNAPSHOTS',
  start_ohlcv_worker: 'BACKGROUND WORKERS',
  seed_reference_data: 'BACKGROUND WORKERS',
  rebuild_search_index: 'BACKGROUND WORKERS',
  start_http_listener: 'HTTP',
};

export function createStartupProgressTracker(
  options: CreateStartupProgressTrackerOptions = {},
): StartupProgressReporter {
  const write = options.write ?? ((value: string) => process.stdout.write(value));
  const isInteractive = options.isInteractive ?? Boolean(process.stdout.isTTY);
  const stepStartTimes = new Map<StartupStepId, number>();
  const stepDurations = new Map<StartupStepId, number>();
  let activeStepId: StartupStepId | null = null;
  let ohlcvProgress: OhlcvProgress | null = null;
  let headerPrinted = false;
  let activeSection: string | null = null;
  let catalogHeaderPrinted = false;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrameIndex = 0;
  let spinnerText: string | null = null;

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function timestamp() {
    return new Date().toISOString().replace('.000Z', 'Z');
  }

  function padRight(value: string, width: number) {
    return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
  }

  function formatExchangeName(exchangeId: string) {
    return exchangeId.charAt(0).toUpperCase() + exchangeId.slice(1);
  }

  function ensureSection(stepId: StartupStepId) {
    const section = SECTION_BY_STEP[stepId];
    if (activeSection === section) {
      return;
    }

    activeSection = section;
    if (headerPrinted) {
      write('\n');
    }
    write(`${BULLET} ${section}\n`);
  }

  function writeLine(message: string) {
    write(`${message}\n`);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerText = null;
    spinnerFrameIndex = 0;
  }

  function renderSpinnerFrame() {
    if (!spinnerText) {
      return;
    }

    if (!isInteractive) {
      return;
    }

    const frame = SPINNER_FRAMES[spinnerFrameIndex % SPINNER_FRAMES.length];
    spinnerFrameIndex += 1;
    write(`\r  ${C.cyan}${frame}${C.reset} ${spinnerText}`);
  }

  function startSpinner(text: string) {
    stopSpinner();
    spinnerText = text;

    if (!isInteractive) {
      writeLine(`  ${REFRESH} ${text}`);
      return;
    }

    renderSpinnerFrame();
    spinnerTimer = setInterval(() => {
      renderSpinnerFrame();
    }, 80);
  }

  function settleSpinner(finalLine?: string) {
    if (spinnerText && isInteractive) {
      write('\r');
      write('\x1b[2K');
    }
    stopSpinner();
    if (finalLine) {
      writeLine(finalLine);
    }
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
      `${C.cyan}╚${'═'.repeat(68)}╝${C.reset}`,
      '',
    ].join('\n');
    write(`${banner}\n`);
  }

  function recordStepDuration(stepId: StartupStepId) {
    const startTime = stepStartTimes.get(stepId);
    if (startTime !== undefined) {
      stepDurations.set(stepId, Date.now() - startTime);
    }
  }

  return {
    start(info) {
      if (headerPrinted) {
        return;
      }

      headerPrinted = true;
      printBanner();
      writeLine(`[${timestamp()}] INFO  System boot initialized`);
      writeLine(`           runtime: ${info.runtime} | driver: ${info.driver}`);
      writeLine(`           db: ${info.databaseUrl}`);
    },
    begin(stepId, nextOhlcvProgress) {
      if (activeStepId && activeStepId !== stepId) {
        recordStepDuration(activeStepId);
        settleSpinner();
      }

      ensureSection(stepId);
      stepStartTimes.set(stepId, Date.now());
      activeStepId = stepId;
      ohlcvProgress = stepId === 'start_ohlcv_worker' ? nextOhlcvProgress ?? ohlcvProgress : null;

      const step = INITIAL_STARTUP_STEPS.find((s) => s.id === stepId);
      const label = step?.label ?? stepId;
      if (stepId === 'sync_exchange_metadata') {
        startSpinner(label);
        return;
      }

      if (stepId === 'build_market_snapshots') {
        startSpinner(label);
        return;
      }

      if (stepId === 'start_ohlcv_worker' && ohlcvProgress) {
        settleSpinner();
        writeLine(`  ${PENDING} ${label} (${ohlcvProgress.current}/${ohlcvProgress.total})`);
        return;
      }
    },
    complete(stepId) {
      ensureSection(stepId);
      recordStepDuration(stepId);
      if (activeStepId === stepId) activeStepId = null;

      if (stepId === 'start_ohlcv_worker') {
        ohlcvProgress = null;
      }

      const step = INITIAL_STARTUP_STEPS.find((s) => s.id === stepId);
      const label = step?.label ?? stepId;
      const ms = stepDurations.get(stepId);
      const suffix = ms !== undefined ? `[${formatMs(ms)}]` : '[OK]';
      settleSpinner(`  ${C.green}✔${C.reset} ${label} ${'.'.repeat(Math.max(2, 56 - label.length))} ${C.yellow}${suffix}${C.reset}`);
    },
    fail(stepId, message) {
      ensureSection(stepId);
      activeStepId = stepId;
      const step = INITIAL_STARTUP_STEPS.find((s) => s.id === stepId);
      const label = step?.label ?? stepId;
      settleSpinner(`  ${C.red}✖${C.reset} ${label} ${'.'.repeat(Math.max(2, 56 - label.length))} ${C.red}[${message}]${C.reset}`);
    },
    failCurrent(message) {
      if (!activeStepId) {
        this.fail('start_http_listener', message);
        return;
      }

      this.fail(activeStepId, message);
    },
    reportExchangeResult(exchangeId, status, message) {
      settleSpinner();
      const label = padRight(formatExchangeName(exchangeId), 12);
      const icon = status === 'ok' ? `${C.green}✔${C.reset}` : `${C.red}✖${C.reset}`;
      const detail = status === 'ok' ? '[OK]' : `[${summarizeStartupMessage(message ?? 'Failed')}]`;
      writeLine(`  ${icon} ${label} ${status === 'ok' ? `${C.yellow}${detail}${C.reset}` : `${C.red}${detail}${C.reset}`}`);
    },
    reportCatalogResult(id, category, count, durationMs) {
      ensureSection('sync_coin_catalog');
      if (!catalogHeaderPrinted) {
        writeLine(`  ${padRight('ID', 8)}${padRight('CATEGORY', 17)}${padRight('COUNT', 9)}${padRight('STATUS', 12)}DURATION`);
        catalogHeaderPrinted = true;
      }

      writeLine(`  ${padRight(id, 8)}${padRight(category, 17)}${padRight(count.toLocaleString(), 9)}${padRight('COMPLETE', 12)}${formatMs(durationMs)}`);
    },
    reportWarning(message) {
      writeLine(`  ${C.yellow}!${C.reset} ${message}`);
    },
    reportStatus(message) {
      writeLine(`  ${C.dim}… ${message}${C.reset}`);
    },
    finish(port) {
      settleSpinner();
      writeLine(`\n[${timestamp()}] ${C.green}SUCCESS${C.reset} | System ready. Listening on http://localhost:${port}`);
    },
    updateOhlcvProgress(current, total) {
      ohlcvProgress = { current, total };

      if (activeStepId !== 'start_ohlcv_worker') {
        this.begin('start_ohlcv_worker', ohlcvProgress);
        return;
      }

      const step = INITIAL_STARTUP_STEPS.find((s) => s.id === 'start_ohlcv_worker');
      const label = step?.label ?? 'start_ohlcv_worker';
      writeLine(`  ${PENDING} ${label} (${current}/${total})`);
    },
  };
}
