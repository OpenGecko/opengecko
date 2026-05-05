export type ResponseCacheEntry<TValue> = {
  value: TValue;
  expiresAt: number;
  revision: number;
};

export type ResponseCache<TValue> = {
  getFresh: (key: string, revision: number, now?: number) => TValue | null;
  getStale: (key: string, revision: number) => TValue | null;
  getOrSet: (
    key: string,
    revision: number,
    producer: () => TValue | Promise<TValue>,
    now?: number,
  ) => Promise<TValue>;
  set: (key: string, value: TValue, revision: number, now?: number) => void;
  deleteExpired: (now?: number) => number;
  size: () => number;
};

export type ResponseCacheOptions<TValue> = {
  ttlMs: number;
  maxEntries?: number;
  clone: (value: TValue) => TValue;
};

export function createResponseCache<TValue>(options: ResponseCacheOptions<TValue>): ResponseCache<TValue> {
  const entries = new Map<string, ResponseCacheEntry<TValue>>();
  const inFlight = new Map<string, Promise<TValue>>();
  const maxEntries = Math.max(options.maxEntries ?? Number.POSITIVE_INFINITY, 0);

  function refreshLruOrder(key: string, entry: ResponseCacheEntry<TValue>) {
    entries.delete(key);
    entries.set(key, entry);
  }

  function evictOverflow() {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value as string | undefined;

      if (oldestKey === undefined) {
        return;
      }

      entries.delete(oldestKey);
    }
  }

  return {
    getFresh(key, revision, now = Date.now()) {
      const cached = entries.get(key);

      if (!cached || cached.revision !== revision || cached.expiresAt <= now) {
        return null;
      }

      refreshLruOrder(key, cached);
      return options.clone(cached.value);
    },
    getStale(key, revision) {
      const cached = entries.get(key);

      if (!cached || cached.revision !== revision) {
        return null;
      }

      refreshLruOrder(key, cached);
      return options.clone(cached.value);
    },
    async getOrSet(key, revision, producer, now = Date.now()) {
      const cached = this.getFresh(key, revision, now);

      if (cached) {
        return cached;
      }

      const inFlightKey = `${revision}:${key}`;
      const existing = inFlight.get(inFlightKey);

      if (existing) {
        return options.clone(await existing);
      }

      const produced = Promise.resolve()
        .then(producer)
        .then((value) => {
          this.set(key, value, revision, now);
          return value;
        });

      inFlight.set(inFlightKey, produced);

      try {
        return options.clone(await produced);
      } finally {
        inFlight.delete(inFlightKey);
      }
    },
    set(key, value, revision, now = Date.now()) {
      if (maxEntries === 0) {
        return;
      }

      entries.set(key, {
        value: options.clone(value),
        expiresAt: now + options.ttlMs,
        revision,
      });
      evictOverflow();
    },
    deleteExpired(now = Date.now()) {
      let deleted = 0;

      for (const [key, entry] of entries) {
        if (entry.expiresAt >= now) {
          continue;
        }

        entries.delete(key);
        deleted += 1;
      }

      return deleted;
    },
    size() {
      return entries.size;
    },
  };
}
