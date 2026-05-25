import { describe, expect, it } from 'vitest';

import {
  restoreDashboardLocalState,
  safePersistJson,
  sanitizeControls,
  sanitizeHoldings,
  sanitizeIdList
} from '../frontend/src/lib/dashboard-local-state';

const keys = {
  watchlist: 'watchlist',
  holdings: 'holdings',
  controls: 'controls'
};

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe('dashboard local state helpers', () => {
  it('sanitizes id lists without treating strings as iterables', () => {
    expect(sanitizeIdList('bitcoin')).toEqual([]);
    expect(sanitizeIdList([' bitcoin ', 'ethereum', 'bitcoin', '', 42])).toEqual(['bitcoin', 'ethereum']);
    expect(sanitizeIdList(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('keeps only positive finite holdings keyed by valid asset ids', () => {
    expect(
      sanitizeHoldings({
        bitcoin: 1.25,
        ethereum: '2.5',
        tether: 0,
        solana: -3,
        cardano: 'not-a-number'
      })
    ).toEqual({ bitcoin: 1.25, ethereum: 2.5 });
  });

  it('sanitizes compare, selected coin, row limit, and segment controls', () => {
    expect(
      sanitizeControls({
        compareIds: ['bitcoin', 'ethereum', 'solana', 'cardano', 'dogecoin'],
        selectedCoinId: ' bitcoin ',
        rowsPerPage: '50',
        segment: 'watchlist'
      })
    ).toEqual({
      compareIds: ['bitcoin', 'ethereum', 'solana', 'cardano'],
      selectedCoinId: 'bitcoin',
      rowsPerPage: 50,
      segment: 'watchlist'
    });

    expect(sanitizeControls({ rowsPerPage: 10, segment: 'unknown' })).toEqual({
      compareIds: [],
      selectedCoinId: null,
      rowsPerPage: 25,
      segment: 'all'
    });
  });

  it('repairs malformed keys independently without discarding valid state', () => {
    const storage = new MemoryStorage();
    storage.setItem(keys.watchlist, '{bad json');
    storage.setItem(keys.holdings, JSON.stringify({ bitcoin: 2, ethereum: '3', solana: -1 }));
    storage.setItem(
      keys.controls,
      JSON.stringify({
        compareIds: ['bitcoin', 'ethereum', 'solana', 'cardano', 'dogecoin'],
        selectedCoinId: 'ethereum',
        rowsPerPage: 100,
        segment: 'watchlist',
        stale: true
      })
    );

    const restored = restoreDashboardLocalState(storage, keys);

    expect(restored.watchlistIds).toEqual([]);
    expect(restored.holdings).toEqual({ bitcoin: 2, ethereum: 3 });
    expect(restored.controls.compareIds).toEqual(['bitcoin', 'ethereum', 'solana', 'cardano']);
    expect(restored.controls.selectedCoinId).toBe('ethereum');
    expect(restored.repairedKeys).toEqual(['watchlist', 'portfolio holdings', 'dashboard controls']);
    expect(storage.getItem(keys.watchlist)).toBe('[]');
    expect(storage.getItem(keys.holdings)).toBe(JSON.stringify({ bitcoin: 2, ethereum: 3 }));
  });

  it('does not throw when browser storage rejects writes', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => undefined
    };

    expect(safePersistJson(storage, keys.watchlist, ['bitcoin'])).toBe(false);
  });
});
