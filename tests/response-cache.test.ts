import { describe, expect, it } from 'vitest';

import { createResponseCache } from '../src/services/response-cache';

describe('response cache service', () => {
  it('returns cloned fresh entries for the matching revision', () => {
    const cache = createResponseCache({
      ttlMs: 1_000,
      clone: (value: { nested: { count: number } }) => ({
        nested: {
          count: value.nested.count,
        },
      }),
    });

    cache.set('simple-price:bitcoin-usd', { nested: { count: 1 } }, 7, 100);

    const cached = cache.getFresh('simple-price:bitcoin-usd', 7, 500);
    expect(cached).toEqual({ nested: { count: 1 } });

    cached!.nested.count = 9;
    expect(cache.getFresh('simple-price:bitcoin-usd', 7, 500)).toEqual({ nested: { count: 1 } });
  });

  it('misses stale, expired, and unknown entries without deleting valid entries', () => {
    const cache = createResponseCache({
      ttlMs: 1_000,
      clone: (value: string[]) => [...value],
    });

    cache.set('a', ['fresh'], 1, 100);
    cache.set('b', ['expired'], 1, 100);

    expect(cache.getFresh('missing', 1, 500)).toBeNull();
    expect(cache.getFresh('a', 2, 500)).toBeNull();
    expect(cache.getFresh('b', 1, 1_100)).toBeNull();
    expect(cache.getFresh('a', 1, 500)).toEqual(['fresh']);
    expect(cache.size()).toBe(2);
  });

  it('deletes only expired entries', () => {
    const cache = createResponseCache({
      ttlMs: 1_000,
      clone: (value: number) => value,
    });

    cache.set('fresh', 1, 1, 500);
    cache.set('expired', 2, 1, 0);

    expect(cache.deleteExpired(1_001)).toBe(1);
    expect(cache.size()).toBe(1);
    expect(cache.getFresh('fresh', 1, 1_001)).toBe(1);
    expect(cache.getFresh('expired', 1, 1_001)).toBeNull();
  });

  it('bounds entries by least recently used order', () => {
    const cache = createResponseCache({
      ttlMs: 1_000,
      maxEntries: 2,
      clone: (value: string) => value,
    });

    cache.set('a', 'first', 1, 0);
    cache.set('b', 'second', 1, 0);
    expect(cache.getFresh('a', 1, 10)).toBe('first');

    cache.set('c', 'third', 1, 0);

    expect(cache.size()).toBe(2);
    expect(cache.getFresh('a', 1, 10)).toBe('first');
    expect(cache.getFresh('b', 1, 10)).toBeNull();
    expect(cache.getFresh('c', 1, 10)).toBe('third');
  });

  it('can serve explicitly requested stale entries for the same revision', () => {
    const cache = createResponseCache({
      ttlMs: 1_000,
      clone: (value: string[]) => [...value],
    });

    cache.set('stale', ['value'], 3, 0);

    expect(cache.getFresh('stale', 3, 1_100)).toBeNull();
    expect(cache.getStale('stale', 3)).toEqual(['value']);
    expect(cache.getStale('stale', 4)).toBeNull();
  });

  it('coalesces concurrent cold fills for the same key and revision', async () => {
    const cache = createResponseCache({
      ttlMs: 1_000,
      clone: (value: { count: number }) => ({ count: value.count }),
    });
    let producerCalls = 0;
    let resolveProducer: ((value: { count: number }) => void) | null = null;
    const producer = () => {
      producerCalls += 1;
      return new Promise<{ count: number }>((resolve) => {
        resolveProducer = resolve;
      });
    };

    const first = cache.getOrSet('same', 1, producer, 0);
    const second = cache.getOrSet('same', 1, producer, 0);
    await Promise.resolve();

    expect(producerCalls).toBe(1);
    resolveProducer!({ count: 1 });

    await expect(first).resolves.toEqual({ count: 1 });
    await expect(second).resolves.toEqual({ count: 1 });
    expect(cache.getFresh('same', 1, 500)).toEqual({ count: 1 });

    const cached = await cache.getOrSet('same', 1, () => ({ count: 2 }), 500);
    expect(cached).toEqual({ count: 1 });
    expect(producerCalls).toBe(1);
  });

  it('does not poison coalesced fills after producer failure', async () => {
    const cache = createResponseCache({
      ttlMs: 1_000,
      clone: (value: number) => value,
    });

    await expect(cache.getOrSet('flaky', 1, async () => {
      throw new Error('provider failed');
    }, 0)).rejects.toThrow('provider failed');

    await expect(cache.getOrSet('flaky', 1, async () => 2, 0)).resolves.toBe(2);
    expect(cache.getFresh('flaky', 1, 1)).toBe(2);
  });
});
