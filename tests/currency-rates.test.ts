import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getCurrencyApiSnapshot,
  getCurrencyRefreshDiagnostics,
  getSupportedVsCurrencies,
  refreshCurrencyApiRatesOnce,
  resetCurrencyApiSnapshotForTests,
} from '../src/services/currency-rates';

function createCurrencyPayload(overrides: Record<string, number> = {}) {
  return {
    date: '2026-05-24',
    usdt: {
      usdt: 1,
      usd: 1.01,
      eur: 0.91,
      btc: 0.000011,
      eth: 0.00031,
      ...overrides,
    },
  };
}

function createJsonResponse(payload: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function createFetchImpl(implementation: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(implementation) as unknown as typeof fetch;
}

async function flushMicrotasks(iterations = 1) {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe('currency rates refresh resilience', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetCurrencyApiSnapshotForTests();
  });

  it('serves the bootstrap snapshot and sorted supported currencies before any refresh', () => {
    const snapshot = getCurrencyApiSnapshot();

    for (const key of ['usdt', 'usd', 'eur', 'btc', 'eth']) {
      expect(snapshot.usdt[key]).toEqual(expect.any(Number));
      expect(snapshot.usdt[key]).toBeGreaterThan(0);
    }

    const supportedCurrencies = getSupportedVsCurrencies();
    expect(supportedCurrencies).toEqual([...supportedCurrencies].sort());
    expect(supportedCurrencies).toEqual(supportedCurrencies.map((currency) => currency.toLowerCase()));
    expect(supportedCurrencies).toEqual(expect.arrayContaining(['usdt', 'usd', 'eur', 'btc', 'eth']));
  });

  it('replaces the snapshot and records ok diagnostics after a valid remote payload', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-24T12:00:00.000Z') });
    const payload = createCurrencyPayload({ JPY: 157.25, invalid_zero: 0 });
    const fetchImpl = createFetchImpl(async () => createJsonResponse(payload));

    await refreshCurrencyApiRatesOnce(fetchImpl);

    expect(getCurrencyApiSnapshot()).toBe(payload);
    expect(getSupportedVsCurrencies()).toContain('jpy');
    expect(getSupportedVsCurrencies()).not.toContain('invalid_zero');
    expect(getCurrencyRefreshDiagnostics()).toEqual({
      status: 'ok',
      at: new Date('2026-05-24T12:00:00.000Z'),
    });
  });

  it('preserves the prior snapshot for non-2xx malformed rejection and synchronous throw failures', async () => {
    const failureCases: Array<{
      name: string;
      fetchImpl: typeof fetch;
    }> = [
      {
        name: 'non-2xx',
        fetchImpl: createFetchImpl(async () => createJsonResponse({ error: 'unavailable' }, { ok: false, status: 503 })),
      },
      {
        name: 'malformed',
        fetchImpl: createFetchImpl(async () => createJsonResponse({ date: '2026-05-24', usdt: { usd: 1 } })),
      },
      {
        name: 'rejection',
        fetchImpl: createFetchImpl(async () => {
          throw new TypeError('network unavailable');
        }),
      },
      {
        name: 'synchronous throw',
        fetchImpl: createFetchImpl(() => {
          throw new Error('sync transport failure');
        }),
      },
    ];

    for (const failureCase of failureCases) {
      resetCurrencyApiSnapshotForTests();
      const beforeSnapshot = getCurrencyApiSnapshot();
      const beforeCurrencies = getSupportedVsCurrencies();

      await expect(refreshCurrencyApiRatesOnce(failureCase.fetchImpl)).resolves.toBeUndefined();

      expect(getCurrencyApiSnapshot(), failureCase.name).toBe(beforeSnapshot);
      expect(getSupportedVsCurrencies(), failureCase.name).toEqual(beforeCurrencies);
      expect(getCurrencyRefreshDiagnostics().status, failureCase.name).toBe('error');
      expect(getCurrencyRefreshDiagnostics().reason, failureCase.name).toEqual(expect.any(String));
    }
  });

  it('deduplicates in-flight refreshes and clears the singleton after a failed refresh', async () => {
    let releaseFetch!: (response: Response) => void;
    const fetchImpl = createFetchImpl(() => new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    }));

    const firstRefresh = refreshCurrencyApiRatesOnce(fetchImpl);
    const secondRefresh = refreshCurrencyApiRatesOnce(fetchImpl);
    await flushMicrotasks();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const payload = createCurrencyPayload({ cad: 1.37 });
    releaseFetch(createJsonResponse(payload));
    await Promise.all([firstRefresh, secondRefresh]);
    expect(getCurrencyApiSnapshot()).toBe(payload);

    const failingFetch = createFetchImpl(async () => {
      throw new Error('first failure');
    });
    await refreshCurrencyApiRatesOnce(failingFetch);

    const recoveryPayload = createCurrencyPayload({ aud: 1.52 });
    const recoveryFetch = createFetchImpl(async () => createJsonResponse(recoveryPayload));
    await refreshCurrencyApiRatesOnce(recoveryFetch);

    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
    expect(getCurrencyApiSnapshot()).toBe(recoveryPayload);
  });

  it('wires a real AbortSignal into fetch and aborts it exactly once after the configured timeout', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-24T12:05:00.000Z') });
    const beforeSnapshot = getCurrencyApiSnapshot();
    let capturedSignal: AbortSignal | undefined;
    let abortEvents = 0;
    const fetchImpl = createFetchImpl((_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      capturedSignal?.addEventListener('abort', () => {
        abortEvents += 1;
      });
      return new Promise<Response>(() => undefined);
    });

    const refreshPromise = refreshCurrencyApiRatesOnce(fetchImpl, { timeoutMs: 25 });
    await flushMicrotasks();

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    vi.advanceTimersByTime(25);
    await refreshPromise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(abortEvents).toBe(1);
    expect(getCurrencyApiSnapshot()).toBe(beforeSnapshot);
    expect(getCurrencyRefreshDiagnostics()).toEqual({
      status: 'error',
      at: new Date('2026-05-24T12:05:00.025Z'),
      reason: 'AbortError: Currency API refresh timed out after 25ms',
    });
  });

  it('ignores late successful fetch resolutions after a timeout and allows the next refresh to start', async () => {
    vi.useFakeTimers();
    const beforeSnapshot = getCurrencyApiSnapshot();
    const beforeCurrencies = getSupportedVsCurrencies();
    let resolveFetch!: (response: Response) => void;
    const timedOutFetch = createFetchImpl(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const refreshPromise = refreshCurrencyApiRatesOnce(timedOutFetch, { timeoutMs: 10 });
    await flushMicrotasks();
    vi.advanceTimersByTime(10);
    await refreshPromise;

    const latePayload = createCurrencyPayload({ gbp: 0.79 });
    resolveFetch(createJsonResponse(latePayload));
    await flushMicrotasks(3);

    expect(getCurrencyApiSnapshot()).toBe(beforeSnapshot);
    expect(getSupportedVsCurrencies()).toEqual(beforeCurrencies);
    expect(getCurrencyRefreshDiagnostics().status).toBe('error');

    const recoveryPayload = createCurrencyPayload({ chf: 0.88 });
    const recoveryFetch = createFetchImpl(async () => createJsonResponse(recoveryPayload));
    await refreshCurrencyApiRatesOnce(recoveryFetch);

    expect(timedOutFetch).toHaveBeenCalledTimes(1);
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
    expect(getCurrencyApiSnapshot()).toBe(recoveryPayload);
  });

  it('uses distinct configurable timeout bounds under fake timers', async () => {
    vi.useFakeTimers({ now: 0 });

    const startLow = Date.now();
    let lowSettled = false;
    const lowTimeoutPromise = refreshCurrencyApiRatesOnce(createFetchImpl(() => new Promise<Response>(() => undefined)), {
      timeoutMs: 10,
    }).then(() => {
      lowSettled = true;
    });
    await flushMicrotasks();
    vi.advanceTimersByTime(9);
    await flushMicrotasks();
    expect(lowSettled).toBe(false);
    vi.advanceTimersByTime(1);
    await lowTimeoutPromise;
    expect(Date.now() - startLow).toBe(10);

    const startHigh = Date.now();
    let highSettled = false;
    const highTimeoutPromise = refreshCurrencyApiRatesOnce(createFetchImpl(() => new Promise<Response>(() => undefined)), {
      timeoutMs: 40,
    }).then(() => {
      highSettled = true;
    });
    await flushMicrotasks();
    vi.advanceTimersByTime(39);
    await flushMicrotasks();
    expect(highSettled).toBe(false);
    vi.advanceTimersByTime(1);
    await highTimeoutPromise;
    expect(Date.now() - startHigh).toBe(40);
  });

  it('sanitizes diagnostic failure reasons without leaking URLs headers bodies stacks or environment values', async () => {
    const previousSecret = process.env.OPENGECKO_TEST_CURRENCY_SECRET;
    process.env.OPENGECKO_TEST_CURRENCY_SECRET = 'super-secret-env-value';

    try {
      const fetchImpl = createFetchImpl(async () => {
        throw new Error(
          'boom https://latest.currency-api.pages.dev/v1/currencies/usdt.json?token=secret-token Authorization: Bearer header-secret body {"apiKey":"body-secret"} at thirdParty (/tmp/vendor.js:1:2) super-secret-env-value',
        );
      });

      await refreshCurrencyApiRatesOnce(fetchImpl);

      const diagnostics = getCurrencyRefreshDiagnostics();
      expect(diagnostics.status).toBe('error');
      expect(diagnostics.reason).toEqual(expect.any(String));
      expect(diagnostics.reason).toContain('Error:');
      expect(diagnostics.reason).not.toMatch(/latest\.currency-api\.pages\.dev/i);
      expect(diagnostics.reason).not.toMatch(/https?:\/\//i);
      expect(diagnostics.reason).not.toContain('secret-token');
      expect(diagnostics.reason).not.toContain('Bearer header-secret');
      expect(diagnostics.reason).not.toContain('body-secret');
      expect(diagnostics.reason).not.toContain('thirdParty');
      expect(diagnostics.reason).not.toContain('super-secret-env-value');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.OPENGECKO_TEST_CURRENCY_SECRET;
      } else {
        process.env.OPENGECKO_TEST_CURRENCY_SECRET = previousSecret;
      }
    }
  });

  it('returns a defensive diagnostics copy', async () => {
    const fetchImpl = createFetchImpl(async () => createJsonResponse(createCurrencyPayload()));

    await refreshCurrencyApiRatesOnce(fetchImpl);
    const diagnostics = getCurrencyRefreshDiagnostics();
    diagnostics.at.setFullYear(2000);

    expect(getCurrencyRefreshDiagnostics().at.getFullYear()).not.toBe(2000);
  });
});
