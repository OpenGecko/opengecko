import { describe, expect, it } from 'vitest';

import {
  canAttemptProvider,
  classifyProviderFailure,
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
        failure_kind: 'timeout',
        last_failure_reason: 'provider request timed out',
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
        failure_kind: 'timeout',
        last_failure_reason: 'provider request timed out',
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

  it('classifies provider failures into controlled diagnostic states without raw upstream text', () => {
    expect(classifyProviderFailure(new Error('binance ticker fetch timed out after 10000ms'))).toEqual({
      kind: 'timeout',
      reason: 'provider request timed out',
    });
    expect(classifyProviderFailure(new Error('403 Forbidden: cloudfront block access from your country'))).toEqual({
      kind: 'regional_block',
      reason: 'provider regionally blocked',
    });
    expect(classifyProviderFailure(new Error('429 Too Many Requests rate limit exceeded'))).toEqual({
      kind: 'rate_limited',
      reason: 'provider rate limited',
    });
    expect(classifyProviderFailure(new Error('BadSymbol: kraken does not have market symbol BTC/FOO'))).toEqual({
      kind: 'unavailable_market',
      reason: 'provider market unavailable',
    });
    expect(classifyProviderFailure(new Error('Unexpected token < in JSON at position 0'))).toEqual({
      kind: 'malformed_response',
      reason: 'provider response malformed',
    });
  });

  it('records classified failure metadata for breaker summaries', () => {
    const state = createProviderBreakerState(['bybit'], {
      baseBackoffMs: 1_000,
      jitterRatio: 0,
    });

    recordProviderFailure(
      state,
      'bybit',
      10_000,
      'ccxt bybit 403 Forbidden: block access from your country stack trace with request headers',
    );

    expect(summarizeProviderBreakerState(state, 10_000)).toMatchObject([
      {
        id: 'bybit',
        status: 'open',
        failure_kind: 'regional_block',
        last_failure_reason: 'provider regionally blocked',
      },
    ]);
  });
});
