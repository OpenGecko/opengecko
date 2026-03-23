import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMarketRuntime } from '../src/services/market-runtime';
import type { MarketDataRuntimeState } from '../src/services/market-runtime-state';

vi.mock('../src/db/client', () => ({
  seedStaticReferenceData: vi.fn(),
  rebuildSearchIndex: vi.fn(),
}));

async function advanceTimersBy(ms: number) {
  vi.advanceTimersByTime(ms);
  await Promise.resolve();
}

async function eventually(assertion: () => void) {
  for (let index = 0; index < 20; index += 1) {
    try {
      assertion();
      return;
    } catch {
      vi.advanceTimersByTime(0);
    }

    await Promise.resolve();
  }

  assertion();
}

function createState(overrides: Partial<MarketDataRuntimeState> = {}): MarketDataRuntimeState {
  return {
    initialSyncCompleted: false,
    allowStaleLiveService: false,
    syncFailureReason: null,
    ...overrides,
  };
}

describe('market runtime', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseConfig = {
    ccxtExchanges: ['binance'],
    currencyRefreshIntervalSeconds: 300,
    marketRefreshIntervalSeconds: 60,
    searchRebuildIntervalSeconds: 900,
    marketFreshnessThresholdSeconds: 300,
  };

  it('runs initial sync before starting refresh loop', async () => {
    const runInitialMarketSync = vi.fn().mockResolvedValue({});
    const runCurrencyRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runMarketRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runSearchRebuildOnce = vi.fn().mockResolvedValue(undefined);
    const state = createState();
    const runtime = createMarketRuntime({} as never, baseConfig as never, logger, state, {
      runInitialMarketSync,
      runCurrencyRefreshOnce,
      runMarketRefreshOnce,
      runSearchRebuildOnce,
    });

    await runtime.start();
    await eventually(() => {
      expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(1);
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);
    });

    expect(runInitialMarketSync).toHaveBeenCalledTimes(1);
    expect(state.initialSyncCompleted).toBe(true);
    expect(state.syncFailureReason).toBeNull();
    expect(runSearchRebuildOnce).toHaveBeenCalledTimes(0);

    await eventually(() => {
      vi.advanceTimersByTime(60_000);
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(2);
    });
    expect(runMarketRefreshOnce).toHaveBeenCalledTimes(2);

    await eventually(() => {
      vi.advanceTimersByTime(240_000);
      expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(2);
    });
    expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(2);

    await eventually(() => {
      vi.advanceTimersByTime(840_000);
      expect(runSearchRebuildOnce).toHaveBeenCalledTimes(1);
    });
    expect(runSearchRebuildOnce).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });

  it('does not block startup on a long-running initial sync', async () => {
    let releaseInitialSync!: () => void;
    const runInitialMarketSync = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      releaseInitialSync = resolve;
    }));
    const runCurrencyRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runMarketRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runtime = createMarketRuntime({} as never, baseConfig as never, logger, createState(), {
      runInitialMarketSync,
      runCurrencyRefreshOnce,
      runMarketRefreshOnce,
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
    });

    let startResolved = false;
    const startPromise = runtime.start().then(() => {
      startResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(runInitialMarketSync).toHaveBeenCalledTimes(1);
    expect(startResolved).toBe(true);
    expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(0);
    expect(runMarketRefreshOnce).toHaveBeenCalledTimes(0);

    releaseInitialSync();
    await startPromise;
    await advanceTimersBy(0);

    await runtime.stop();
  });

  it('handles initial sync failure gracefully', async () => {
    const runInitialMarketSync = vi.fn().mockRejectedValue(new Error('network error'));
    const runCurrencyRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runMarketRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runSearchRebuildOnce = vi.fn().mockResolvedValue(undefined);
    const state = createState();
    const mockDb = {
      db: {
        select: () => ({
          from: () => ({
            all: () => [{ value: 0 }],
          }),
        }),
      },
    };
    const runtime = createMarketRuntime(mockDb as never, baseConfig as never, logger, state, {
      runInitialMarketSync,
      runCurrencyRefreshOnce,
      runMarketRefreshOnce,
      runSearchRebuildOnce,
    });

    await runtime.start();
    await eventually(() => {
      expect(state.syncFailureReason).toBe('network error');
    });

    expect(state.initialSyncCompleted).toBe(false);
    expect(state.syncFailureReason).toBe('network error');
    expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(0);
    expect(runMarketRefreshOnce).toHaveBeenCalledTimes(0);

    await runtime.stop();
  });

  it('does not overlap a still-running currency refresh job', async () => {
    let releaseCurrencyJob!: () => void;
    let callCount = 0;
    const runCurrencyRefreshOnce = vi.fn().mockImplementation(() => {
      callCount += 1;

      if (callCount === 2) {
        return new Promise<void>((resolve) => {
          releaseCurrencyJob = resolve;
        });
      }

      return Promise.resolve();
    });
    const runtime = createMarketRuntime({} as never, {
      ...baseConfig,
      currencyRefreshIntervalSeconds: 1,
    } as never, logger, createState(), {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce,
      runMarketRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
    });

    await runtime.start();
    await eventually(() => {
      expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(1);
    });
    expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(1);

    await eventually(() => {
      vi.advanceTimersByTime(1_000);
      expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(2);
    });
    expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(2);

    await advanceTimersBy(1_000);
    expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    releaseCurrencyJob();
    await runtime.stop();
  });

  it('does not overlap a still-running market refresh job', async () => {
    let releaseMarketJob!: () => void;
    let callCount = 0;
    const runMarketRefreshOnce = vi.fn().mockImplementation(() => {
      callCount += 1;

      if (callCount === 2) {
        return new Promise<void>((resolve) => {
          releaseMarketJob = resolve;
        });
      }

      return Promise.resolve();
    });
    const runtime = createMarketRuntime({} as never, {
      ...baseConfig,
      marketRefreshIntervalSeconds: 1,
    } as never, logger, createState(), {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce,
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
    });

    await runtime.start();
    await eventually(() => {
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);
    });
    expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);

    await eventually(() => {
      vi.advanceTimersByTime(1_000);
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(2);
    });
    expect(runMarketRefreshOnce).toHaveBeenCalledTimes(2);

    await advanceTimersBy(1_000);
    expect(runMarketRefreshOnce).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    releaseMarketJob();
    await runtime.stop();
  });
});
