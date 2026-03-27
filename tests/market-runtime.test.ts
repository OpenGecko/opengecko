import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMarketRuntime } from '../src/services/market-runtime';
import * as startupPrewarmModule from '../src/services/startup-prewarm';
import type { MarketDataRuntimeState } from '../src/services/market-runtime-state';
import { createMetricsRegistry } from '../src/services/metrics';

vi.mock('../src/db/client', () => ({
  seedStaticReferenceData: vi.fn(),
  rebuildSearchIndex: vi.fn(),
}));

async function flushMicrotasks(iterations = 5) {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

async function flushAsyncWork() {
  await flushMicrotasks(20);
}

async function advanceTimersBy(ms: number) {
  vi.advanceTimersByTime(ms);
  await flushMicrotasks();
}

async function eventually(assertion: () => void) {
  for (let index = 0; index < 20; index += 1) {
    try {
      assertion();
      return;
    } catch {
      vi.advanceTimersByTime(0);
    }

    await flushMicrotasks();
  }

  assertion();
}

function createState(overrides: Partial<MarketDataRuntimeState> = {}): MarketDataRuntimeState {
  return {
    initialSyncCompleted: false,
    allowStaleLiveService: false,
    syncFailureReason: null,
    listenerBound: false,
    hotDataRevision: 0,
    validationOverride: {
      mode: 'off',
      reason: null,
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    },
    providerFailureCooldownUntil: null,
    forcedProviderFailure: {
      active: false,
      reason: null,
    },
    startupPrewarm: {
      enabled: false,
      budgetMs: 0,
      readyWithinBudget: true,
      firstRequestWarmBenefitsObserved: false,
      firstRequestWarmBenefitPending: false,
      targets: [],
      completedAt: null,
      totalDurationMs: null,
      targetResults: [],
    },
    ...overrides,
  };
}

describe('market runtime', () => {
  const injectedResponse = { statusCode: 200 };
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
    providerFanoutConcurrency: 2,
    startupPrewarmBudgetMs: 250,
  };

  const metrics = createMetricsRegistry();

  it('runs initial sync before starting refresh loop', async () => {
    const runInitialMarketSync = vi.fn().mockResolvedValue({});
    const runCurrencyRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runMarketRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runSearchRebuildOnce = vi.fn().mockResolvedValue(undefined);
    const startOhlcvRuntime = vi.fn().mockResolvedValue(undefined);
    const state = createState();
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, baseConfig as never, logger, state, metrics, {
      runInitialMarketSync,
      runCurrencyRefreshOnce,
      runMarketRefreshOnce,
      runSearchRebuildOnce,
      startOhlcvRuntime,
    });

    await runtime.start();
    await runtime.whenReady();
    await eventually(() => {
      expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(1);
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(0);
    });

    expect(runInitialMarketSync).toHaveBeenCalledTimes(1);
    expect(startOhlcvRuntime).toHaveBeenCalledTimes(1);
    expect(state.initialSyncCompleted).toBe(true);
    expect(state.listenerBound).toBe(false);
    expect(state.syncFailureReason).toBeNull();
    expect(state.hotDataRevision).toBe(2);
    expect(runSearchRebuildOnce).toHaveBeenCalledTimes(0);

    runtime.markListenerBound();
    await eventually(() => {
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);
    });
    await eventually(() => {
      expect(state.hotDataRevision).toBe(3);
    });

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

  it('waits for a long-running initial sync before reporting readiness', async () => {
    let releaseInitialSync!: () => void;
    const runInitialMarketSync = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      releaseInitialSync = resolve;
    }));
    const runCurrencyRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runMarketRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runSearchRebuildOnce = vi.fn().mockResolvedValue(undefined);
    const startOhlcvRuntime = vi.fn().mockResolvedValue(undefined);
    const stopOhlcvRuntime = vi.fn().mockResolvedValue(undefined);
    const state = createState();
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, baseConfig as never, logger, state, metrics, {
      runInitialMarketSync,
      runCurrencyRefreshOnce,
      runMarketRefreshOnce,
      runSearchRebuildOnce,
      startOhlcvRuntime,
      stopOhlcvRuntime,
    });

    const startPromise = runtime.start();
    await flushMicrotasks();
    const readyPromise = runtime.whenReady();
    await flushMicrotasks();

    expect(runInitialMarketSync).toHaveBeenCalledTimes(1);
    let readySettled = false;
    void readyPromise.then(() => {
      readySettled = true;
    });
    await flushMicrotasks();
    expect(readySettled).toBe(false);
    expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(0);
    expect(runMarketRefreshOnce).toHaveBeenCalledTimes(0);

    releaseInitialSync();
    await readyPromise;

    expect(readySettled).toBe(true);
    expect(startOhlcvRuntime).toHaveBeenCalledTimes(1);
    expect(state.initialSyncCompleted).toBe(true);
    expect(state.hotDataRevision).toBe(2);
    await eventually(() => {
      expect(runCurrencyRefreshOnce).toHaveBeenCalledTimes(1);
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(0);
    });

    runtime.markListenerBound();
    await eventually(() => {
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);
    });
    await eventually(() => {
      expect(state.hotDataRevision).toBe(3);
    });

    const stopPromise = runtime.stop();
    await flushMicrotasks();
    expect(stopOhlcvRuntime).toHaveBeenCalledTimes(1);
    expect(state.listenerBound).toBe(false);
    await startPromise;
    await stopPromise;
  });

  it('allows stop to finish before a pending initial sync settles', async () => {
    let releaseInitialSync!: () => void;
    const runInitialMarketSync = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      releaseInitialSync = resolve;
    }));
    const stopOhlcvRuntime = vi.fn().mockResolvedValue(undefined);
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, baseConfig as never, logger, createState(), metrics, {
      runInitialMarketSync,
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime,
    });

    const startPromise = runtime.start();
    await flushMicrotasks();

    const stopPromise = runtime.stop();
    await flushMicrotasks();

    expect(stopOhlcvRuntime).toHaveBeenCalledTimes(1);

    releaseInitialSync();
    await startPromise;
    await stopPromise;
  });

  it('handles initial sync failure gracefully', async () => {
    const runInitialMarketSync = vi.fn().mockRejectedValue(new Error('network error'));
    const runCurrencyRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runMarketRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runSearchRebuildOnce = vi.fn().mockResolvedValue(undefined);
    const startOhlcvRuntime = vi.fn().mockResolvedValue(undefined);
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
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, mockDb as never, baseConfig as never, logger, state, metrics, {
      runInitialMarketSync,
      runCurrencyRefreshOnce,
      runMarketRefreshOnce,
      runSearchRebuildOnce,
      startOhlcvRuntime,
    });

    await runtime.start();
    await eventually(() => {
      expect(state.syncFailureReason).toBe('network error');
    });

    expect(state.initialSyncCompleted).toBe(false);
    expect(state.syncFailureReason).toBe('network error');
    expect(state.hotDataRevision).toBe(0);
    expect(startOhlcvRuntime).toHaveBeenCalledTimes(0);
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
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, {
      ...baseConfig,
      currencyRefreshIntervalSeconds: 1,
    } as never, logger, createState(), metrics, {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce,
      runMarketRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      startOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
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

  it('logs background job completion on a single line for consistent pretty output', async () => {
    let releaseMarketRefresh!: () => void;
    const runMarketRefreshOnce = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      releaseMarketRefresh = resolve;
    }));
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, baseConfig as never, logger, createState(), metrics, {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce,
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      startOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
    });

    await runtime.start();
    await eventually(() => {
      expect(logger.info).toHaveBeenCalledWith('background job completed job=currency_refresh');
    });
    expect(runMarketRefreshOnce).toHaveBeenCalledTimes(0);
    runtime.markListenerBound();
    await eventually(() => {
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);
    });
    releaseMarketRefresh();
    await flushAsyncWork();
    await eventually(() => {
      expect(logger.info).toHaveBeenCalledWith('background job completed job=market_refresh');
    });

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
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, {
      ...baseConfig,
      marketRefreshIntervalSeconds: 1,
    } as never, logger, createState(), metrics, {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce,
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      startOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
    });

    await runtime.start();
    await runtime.whenReady();
    runtime.markListenerBound();
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

  it('tracks listener bind state separately from initial sync readiness and clears it on stop', async () => {
    const state = createState();
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, baseConfig as never, logger, state, metrics, {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      startOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
    });

    await runtime.start();
    await runtime.whenReady();

    expect(state.initialSyncCompleted).toBe(true);
    expect(state.listenerBound).toBe(false);

    runtime.markListenerBound();
    expect(state.listenerBound).toBe(true);

    await runtime.stop();
    expect(state.listenerBound).toBe(false);
  });
  it('runs startup prewarm during the background-runtime startup path before listener binding', async () => {
    const state = createState();
    const app = { inject: vi.fn().mockResolvedValue({ statusCode: 200 }) };
    const prewarmSpy = vi.spyOn(startupPrewarmModule, 'runStartupPrewarm').mockResolvedValue(undefined);
    const runMarketRefreshOnce = vi.fn().mockResolvedValue(undefined);
    const runtime = createMarketRuntime(app as never, {} as never, baseConfig as never, logger, state, metrics, {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce,
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      startOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
    });

    try {
      await runtime.start();
      await runtime.whenReady();

      expect(prewarmSpy).toHaveBeenCalledTimes(1);
      expect(prewarmSpy).toHaveBeenCalledWith(app, state, metrics, baseConfig.startupPrewarmBudgetMs);
      expect(state.listenerBound).toBe(false);
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(0);

      runtime.markListenerBound();
      await eventually(() => {
        expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);
      });
    } finally {
      prewarmSpy.mockRestore();
      await runtime.stop();
    }
  });

  it('resolves background runtime readiness at the prewarm budget boundary and defers trailing timed-out work', async () => {
    const state = createState();
    let releaseTrailingPrewarm!: () => void;
    const runStartupPrewarmSpy = vi.spyOn(startupPrewarmModule, 'runStartupPrewarm').mockImplementation(async (_app, runtimeState) => {
      runtimeState.startupPrewarm = {
        enabled: true,
        budgetMs: 250,
        readyWithinBudget: true,
        firstRequestWarmBenefitsObserved: false,
        firstRequestWarmBenefitPending: true,
        targets: [
          {
            id: 'simple_price_bitcoin_usd',
            label: 'Simple price BTC/USD',
            endpoint: '/simple/price?ids=bitcoin&vs_currencies=usd',
          },

        ],
        completedAt: 250,
        totalDurationMs: 250,
        targetResults: [
          {
            id: 'simple_price_bitcoin_usd',
            label: 'Simple price BTC/USD',
            endpoint: '/simple/price?ids=bitcoin&vs_currencies=usd',
            status: 'completed',
            durationMs: 25,
            cacheSurface: 'simple_price',
            warmCacheRevision: 1,
            firstObservedRequest: null,
          },

        ],
      };

      await new Promise<void>((resolve) => {
        releaseTrailingPrewarm = resolve;
      });
    });
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue({ statusCode: 200 }) } as never, {} as never, baseConfig as never, logger, state, metrics, {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      startOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
    });

    try {
      const startPromise = runtime.start();
      await flushMicrotasks();

      const readyPromise = runtime.whenReady();
      await flushMicrotasks();

      let readySettled = false;
      void readyPromise.then(() => {
        readySettled = true;
      });
      await flushMicrotasks();

      expect(runStartupPrewarmSpy).toHaveBeenCalledTimes(1);
      expect(readySettled).toBe(false);
      expect(state.initialSyncCompleted).toBe(true);
      expect(state.startupPrewarm.targetResults).toMatchObject([
        {
          id: 'simple_price_bitcoin_usd',
          status: 'completed',
        },
      ]);

      releaseTrailingPrewarm();
      await readyPromise;
      await startPromise;

      expect(readySettled).toBe(true);
    } finally {
      runStartupPrewarmSpy.mockRestore();
      await runtime.stop();
    }
  });


  it('marks runtime degraded after repeated market refresh failures and clears failure indicators on recovery', async () => {
    let shouldFailRefresh = true;
    const runMarketRefreshOnce = vi.fn().mockImplementation(async () => {
      if (shouldFailRefresh) {
        throw new Error('provider timeout');
      }
    });
    const state = createState({
      initialSyncCompleted: true,
      hotDataRevision: 2,
    });
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, {
      ...baseConfig,
      marketRefreshIntervalSeconds: 1,
    } as never, logger, state, metrics, {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce,
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      startOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
    });

    await runtime.start();
    await runtime.whenReady();

    expect(state.syncFailureReason).toBeNull();
    expect(state.allowStaleLiveService).toBe(false);
    expect(state.providerFailureCooldownUntil).toBeNull();
    expect(state.initialSyncCompleted).toBe(true);
    expect(state.hotDataRevision).toBe(4);

    runtime.markListenerBound();
    await eventually(() => {
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);
    });
    await eventually(() => {
      expect(state.syncFailureReason).toBe('provider timeout');
      expect(state.allowStaleLiveService).toBe(true);
    });

    shouldFailRefresh = false;
    await eventually(() => {
      vi.advanceTimersByTime(1_000);
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(2);
    });

    await eventually(() => {
      expect(state.syncFailureReason).toBeNull();
      expect(state.allowStaleLiveService).toBe(false);
    });
    expect(state.initialSyncCompleted).toBe(true);
    expect(state.hotDataRevision).toBe(5);

    await runtime.stop();
  });

  it('preserves provider cooldown state across failed refreshes and clears it after successful recovery', async () => {
    const firstCooldownUntil = Date.now() + 60_000;
    const state = createState({
      initialSyncCompleted: true,
      allowStaleLiveService: true,
      syncFailureReason: 'provider failure cooldown active after exchange refresh failure',
      providerFailureCooldownUntil: firstCooldownUntil,
      hotDataRevision: 5,
    });
    let shouldFailRefresh = true;
    const runMarketRefreshOnce = vi.fn().mockImplementation(async () => {
      if (shouldFailRefresh) {
        state.providerFailureCooldownUntil = firstCooldownUntil;
        throw new Error('provider failure cooldown active after exchange refresh failure');
      }

      state.providerFailureCooldownUntil = null;
    });
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, {
      ...baseConfig,
      marketRefreshIntervalSeconds: 1,
    } as never, logger, state, metrics, {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce,
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      startOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
    });

    await runtime.start();
    await runtime.whenReady();

    expect(state.providerFailureCooldownUntil).toBeNull();
    expect(state.syncFailureReason).toBeNull();
    expect(state.allowStaleLiveService).toBe(false);

    runtime.markListenerBound();
    await eventually(() => {
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(1);
    });
    await eventually(() => {
      expect(state.providerFailureCooldownUntil).toBe(firstCooldownUntil);
      expect(state.syncFailureReason).toBe('provider failure cooldown active after exchange refresh failure');
      expect(state.allowStaleLiveService).toBe(true);
    });

    shouldFailRefresh = false;
    await eventually(() => {
      vi.advanceTimersByTime(1_000);
      expect(runMarketRefreshOnce).toHaveBeenCalledTimes(2);
    });
    await eventually(() => {
      expect(state.providerFailureCooldownUntil).toBeNull();
      expect(state.syncFailureReason).toBeNull();
      expect(state.allowStaleLiveService).toBe(false);
    });

    await runtime.stop();
  });

  it('records provider refresh metrics for failures and recovery', async () => {
    const isolatedMetrics = createMetricsRegistry();
    isolatedMetrics.recordProviderRefresh('failure', 4, 4);
    isolatedMetrics.recordProviderRefresh('success', 4, 0);

    const metricsText = isolatedMetrics.renderPrometheus();
    expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="failure"} 1');
    expect(metricsText).toContain('opengecko_provider_refresh_total{outcome="success"} 1');
    expect(metricsText).toContain('opengecko_provider_exchange_count 4');
    expect(metricsText).toContain('opengecko_provider_failed_exchange_count 0');
  });

  it('clears stale refresh failure state on a successful first market refresh after startup recovery', async () => {
    const state = createState({
      initialSyncCompleted: true,
      allowStaleLiveService: true,
      syncFailureReason: 'provider timeout',
      hotDataRevision: 7,
    });
    const runtime = createMarketRuntime({ inject: vi.fn().mockResolvedValue(injectedResponse) } as never, {} as never, baseConfig as never, logger, state, metrics, {
      runInitialMarketSync: vi.fn().mockResolvedValue({}),
      runCurrencyRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runMarketRefreshOnce: vi.fn().mockResolvedValue(undefined),
      runSearchRebuildOnce: vi.fn().mockResolvedValue(undefined),
      startOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
      stopOhlcvRuntime: vi.fn().mockResolvedValue(undefined),
    });

    await runtime.start();
    await runtime.whenReady();

    expect(state.syncFailureReason).toBeNull();
    expect(state.allowStaleLiveService).toBe(false);
    expect(state.hotDataRevision).toBe(9);

    runtime.markListenerBound();
    await eventually(() => {
      expect(state.hotDataRevision).toBe(10);
    });

    await runtime.stop();
  });
});
