import { describe, expect, it, vi } from 'vitest';

import {
  isReadinessBudgetTimeout,
  raceWithReadinessBudget,
  runBudgetedProviderFanout,
} from '../src/services/provider-readiness-coordinator';

describe('provider readiness coordinator', () => {
  it('preserves provider ordering, concurrency limits, and isolated failures during fanout', async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await runBudgetedProviderFanout({
      items: ['binance', 'coinbase', 'kraken', 'okx'],
      concurrency: 2,
      buildBudgetError: (provider, _index, budgetMs) => new Error(`${provider} exceeded ${budgetMs}ms`),
      onStart: (provider) => events.push(`start:${provider}`),
      onComplete: (provider) => events.push(`ok:${provider}`),
      onFailure: (provider, _index, error) => events.push(`failed:${provider}:${error.message}`),
      run: async (provider) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;

        if (provider === 'coinbase') {
          throw new Error('provider timeout');
        }

        return `${provider}:ready`;
      },
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(results).toEqual([
      { status: 'fulfilled', value: 'binance:ready' },
      { status: 'rejected', reason: expect.any(Error) },
      { status: 'fulfilled', value: 'kraken:ready' },
      { status: 'fulfilled', value: 'okx:ready' },
    ]);
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('provider timeout');
    expect(events).toEqual(expect.arrayContaining([
      'start:binance',
      'start:coinbase',
      'failed:coinbase:provider timeout',
      'ok:binance',
      'ok:kraken',
      'ok:okx',
    ]));
  });

  it('returns budget failures in deterministic item order without waiting for hung providers', async () => {
    vi.useFakeTimers();
    const progressFailures: string[] = [];
    const runPromise = runBudgetedProviderFanout({
      items: ['kraken', 'binance', 'coinbase'],
      concurrency: 1,
      budgetMs: 25,
      reportBudgetFailure: true,
      buildBudgetError: (provider, _index, budgetMs) => {
        const error = new Error(`${provider} startup budget exceeded after ${budgetMs}ms`);
        error.name = 'StartupBudgetExceeded';
        return error;
      },
      onFailure: (provider, _index, error, durationMs) => {
        progressFailures.push(`${provider}:${durationMs}:${error.message}`);
      },
      run: async (provider) => {
        if (provider === 'kraken') {
          await new Promise(() => undefined);
        }

        return `${provider}:ready`;
      },
    });

    await vi.advanceTimersByTimeAsync(25);
    const results = await runPromise;
    vi.useRealTimers();

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(results.map((result) => (result as PromiseRejectedResult).reason.message)).toEqual([
      'kraken startup budget exceeded after 25ms',
      'binance startup budget exceeded after 25ms',
      'coinbase startup budget exceeded after 25ms',
    ]);
    expect(progressFailures).toEqual([
      'kraken:25:kraken startup budget exceeded after 25ms',
      'binance:25:binance startup budget exceeded after 25ms',
      'coinbase:25:coinbase startup budget exceeded after 25ms',
    ]);
  });

  it('shares budget racing for startup prewarm without converting late success into failure', async () => {
    await expect(raceWithReadinessBudget(Promise.resolve('ready'), 5)).resolves.toBe('ready');

    vi.useFakeTimers();
    const timeoutPromise = raceWithReadinessBudget(
      new Promise<string>((resolve) => setTimeout(() => resolve('late'), 50)),
      10,
    );
    await vi.advanceTimersByTimeAsync(10);
    const result = await timeoutPromise;
    vi.useRealTimers();

    expect(isReadinessBudgetTimeout(result)).toBe(true);
  });
});
