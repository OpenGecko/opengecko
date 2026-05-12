import { describe, expect, it } from 'vitest';

import {
  canAttemptProvider,
  createProviderBreakerState,
  recordProviderFailure,
  recordProviderSuccess,
  summarizeProviderBreakerState,
} from '../src/services/provider-breaker';

describe('provider breaker', () => {
  it('starts providers closed and attemptable', () => {
    const state = createProviderBreakerState(['binance']);

    expect(canAttemptProvider(state, 'binance', 1_000)).toBe(true);
    expect(summarizeProviderBreakerState(state, 1_000)).toMatchObject([
      {
        id: 'binance',
        status: 'closed',
        failure_count: 0,
        retry_in_ms: 0,
      },
    ]);
  });

  it('transitions closed→open after failure and blocks attempts until next_retry_at', () => {
    const state = createProviderBreakerState(['binance'], {
      baseBackoffMs: 1_000,
      jitterRatio: 0,
    });

    recordProviderFailure(state, 'binance', 10_000, 'timeout');

    expect(canAttemptProvider(state, 'binance', 10_999)).toBe(false);
    expect(summarizeProviderBreakerState(state, 10_500)).toMatchObject([
      {
        id: 'binance',
        status: 'open',
        failure_count: 1,
        opened_until: 11_000,
        last_failure_at: 10_000,
        last_failure_reason: 'timeout',
        retry_in_ms: 500,
      },
    ]);
  });

  it('keeps an open breaker hot before next_retry_at without sleeping', () => {
    const state = createProviderBreakerState(['binance'], {
      baseBackoffMs: 1_000,
      jitterRatio: 0,
    });

    recordProviderFailure(state, 'binance', 10_000);

    expect(canAttemptProvider(state, 'binance', 10_999)).toBe(false);
    expect(summarizeProviderBreakerState(state, 10_999)).toMatchObject([
      {
        id: 'binance',
        status: 'open',
        retry_in_ms: 1,
      },
    ]);
  });

  it('transitions open→half_open after next_retry_at using an injected clock', () => {
    const state = createProviderBreakerState(['binance'], {
      baseBackoffMs: 1_000,
      jitterRatio: 0,
    });

    recordProviderFailure(state, 'binance', 10_000);

    expect(canAttemptProvider(state, 'binance', 11_000)).toBe(true);
    expect(summarizeProviderBreakerState(state, 11_000)).toMatchObject([
      {
        id: 'binance',
        status: 'half_open',
        retry_in_ms: 0,
      },
    ]);
  });

  it('transitions half_open→closed after probe success', () => {
    const state = createProviderBreakerState(['binance'], {
      baseBackoffMs: 1_000,
      jitterRatio: 0,
    });

    recordProviderFailure(state, 'binance', 10_000, 'timeout');
    expect(canAttemptProvider(state, 'binance', 11_000)).toBe(true);
    recordProviderSuccess(state, 'binance', 11_100);

    expect(summarizeProviderBreakerState(state, 11_100)).toMatchObject([
      {
        id: 'binance',
        status: 'closed',
        failure_count: 0,
        opened_until: null,
        last_success_at: 11_100,
        last_failure_reason: null,
      },
    ]);
  });

  it('transitions half_open→open after probe failure with larger backoff', () => {
    const state = createProviderBreakerState(['binance'], {
      baseBackoffMs: 1_000,
      multiplier: 2,
      jitterRatio: 0,
    });

    recordProviderFailure(state, 'binance', 10_000, 'first timeout');
    expect(canAttemptProvider(state, 'binance', 11_000)).toBe(true);
    recordProviderFailure(state, 'binance', 11_100, 'second timeout');

    expect(canAttemptProvider(state, 'binance', 13_099)).toBe(false);
    expect(canAttemptProvider(state, 'binance', 13_100)).toBe(true);
    expect(summarizeProviderBreakerState(state, 13_100)).toMatchObject([
      {
        id: 'binance',
        status: 'half_open',
        failure_count: 2,
        opened_until: 13_100,
        last_failure_reason: 'second timeout',
      },
    ]);
  });

  it('applies deterministic bounded jitter to the retry deadline', () => {
    const state = createProviderBreakerState(['binance'], {
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      jitterRatio: 0.5,
      jitter: () => 0.4,
    });

    recordProviderFailure(state, 'binance', 10_000);

    expect(summarizeProviderBreakerState(state, 10_000)).toMatchObject([
      {
        id: 'binance',
        status: 'open',
        opened_until: 11_200,
        retry_in_ms: 1_200,
      },
    ]);
  });

  it('bounds jitter within the configured min and max retry deadlines', () => {
    const baseBackoffMs = 1_000;
    const jitterRatio = 0.5;
    const now = 10_000;
    const minimumRetryDeadline = now + baseBackoffMs;
    const maximumRetryDeadline = now + baseBackoffMs + (baseBackoffMs * jitterRatio);
    const lowerBoundState = createProviderBreakerState(['binance'], {
      baseBackoffMs,
      maxBackoffMs: 10_000,
      jitterRatio,
      jitter: () => -1,
    });
    const upperBoundState = createProviderBreakerState(['binance'], {
      baseBackoffMs,
      maxBackoffMs: 10_000,
      jitterRatio,
      jitter: () => 2,
    });

    recordProviderFailure(lowerBoundState, 'binance', now);
    recordProviderFailure(upperBoundState, 'binance', now);

    expect(summarizeProviderBreakerState(lowerBoundState, now)).toMatchObject([
      {
        opened_until: minimumRetryDeadline,
        retry_in_ms: baseBackoffMs,
      },
    ]);
    expect(summarizeProviderBreakerState(upperBoundState, now)).toMatchObject([
      {
        opened_until: maximumRetryDeadline,
        retry_in_ms: maximumRetryDeadline - now,
      },
    ]);
  });

  it('caps jittered backoff at the configured maximum', () => {
    const state = createProviderBreakerState(['binance'], {
      baseBackoffMs: 1_000,
      maxBackoffMs: 1_500,
      multiplier: 4,
      jitterRatio: 1,
      jitter: () => 1,
    });

    recordProviderFailure(state, 'binance', 10_000);
    recordProviderFailure(state, 'binance', 10_100);

    expect(summarizeProviderBreakerState(state, 10_100)).toMatchObject([
      {
        opened_until: 11_600,
        retry_in_ms: 1_500,
      },
    ]);
  });
});
