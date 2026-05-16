import { describe, expect, it } from 'vitest';
import BigNumber from 'bignumber.js';

import {
  buildLiveSnapshotValue,
  buildMarketQuoteAccumulator,
  createMarketQuoteAccumulator,
  getSnapshotOwnership,
  normalizeMarketTimestamp,
} from '../src/services/market-snapshots';

describe('market snapshot service helpers', () => {
  it('classifies seeded and live snapshot ownership explicitly', () => {
    expect(getSnapshotOwnership({ sourceCount: 0 })).toBe('seeded');
    expect(getSnapshotOwnership({ sourceCount: 2 })).toBe('live');
  });

  it('builds live snapshot updates by carrying forward supply-driven market fields', () => {
    const accumulator = createMarketQuoteAccumulator();
    accumulator.priceTotal = new BigNumber(171000);
    accumulator.priceCount = 2;
    accumulator.volumeTotal = new BigNumber(60000000000);
    accumulator.volumeCount = 2;
    accumulator.changeTotal = new BigNumber(4);
    accumulator.changeCount = 2;
    accumulator.latestTimestamp = Date.parse('2026-03-20T00:05:00.000Z');
    accumulator.providers.add('binance');
    accumulator.providers.add('kraken');

    const nextSnapshot = buildLiveSnapshotValue(
      'bitcoin',
      accumulator,
      {
        price: 85000,
        marketCap: 1700000000000,
        marketCapRank: 1,
        fullyDilutedValuation: 1785000000000,
        circulatingSupply: 19850000,
        totalSupply: 21000000,
        maxSupply: 21000000,
        ath: 109000,
        athDate: new Date('2025-12-17T00:00:00.000Z'),
        atl: 15000,
        atlDate: new Date('2023-11-21T00:00:00.000Z'),
        priceChangePercentage24h: 1.8,
      },
      'usd',
      new Date('2026-03-20T00:06:00.000Z'),
    );

    expect(nextSnapshot.coinId).toBe('bitcoin');
    expect(nextSnapshot.vsCurrency).toBe('usd');
    expect(nextSnapshot.price).toBe(85500);
    expect(nextSnapshot.marketCap).toBe(1697175000000);
    expect(nextSnapshot.totalVolume).toBe(30000000000);
    expect(nextSnapshot.marketCapRank).toBe(1);
    expect(nextSnapshot.priceChange24h).toBeCloseTo(1676.4705882352898);
    expect(nextSnapshot.priceChangePercentage24h).toBe(2);
    expect(nextSnapshot.sourceCount).toBe(2);
    expect(nextSnapshot.sourceProvidersJson).toBe(JSON.stringify(['binance', 'kraken']));
    expect(nextSnapshot.updatedAt).toEqual(new Date('2026-03-20T00:06:00.000Z'));
    expect(nextSnapshot.lastUpdated).toEqual(new Date('2026-03-20T00:05:00.000Z'));
  });

  it('normalizes only plausible market timestamps', () => {
    const nowMs = Date.parse('2026-03-21T00:00:00.000Z');

    expect(normalizeMarketTimestamp(1_773_964_800, nowMs)).toBe(Date.parse('2026-03-20T00:00:00.000Z'));
    expect(normalizeMarketTimestamp(Date.parse('2026-03-20T00:01:00.000Z'), nowMs)).toBe(Date.parse('2026-03-20T00:01:00.000Z'));
    expect(normalizeMarketTimestamp(new Date('2026-03-20T00:02:00.000Z'), nowMs)).toBe(Date.parse('2026-03-20T00:02:00.000Z'));
    expect(normalizeMarketTimestamp('2026-03-20T00:03:00.000Z', nowMs)).toBe(Date.parse('2026-03-20T00:03:00.000Z'));
    expect(normalizeMarketTimestamp(Number.NaN, nowMs)).toBeNull();
    expect(normalizeMarketTimestamp(Number.POSITIVE_INFINITY, nowMs)).toBeNull();
    expect(normalizeMarketTimestamp('not-a-date', nowMs)).toBeNull();
    expect(normalizeMarketTimestamp(Date.parse('2009-12-31T23:59:59.000Z'), nowMs)).toBeNull();
    expect(normalizeMarketTimestamp(Date.parse('2026-03-21T00:06:00.000Z'), nowMs)).toBeNull();
  });

  it('aggregates valid provider samples deterministically without invalid numbers or outliers', () => {
    const accumulator = buildMarketQuoteAccumulator([
      {
        provider: 'kraken',
        price: 90_100,
        quoteVolume: 9_010_000,
        changePercentage24h: 2,
        timestamp: Date.parse('2026-03-20T00:02:00.000Z'),
      },
      {
        provider: 'binance',
        price: 90_000,
        quoteVolume: 9_000_000,
        changePercentage24h: 1,
        timestamp: Date.parse('2026-03-20T00:01:00.000Z'),
      },
      {
        provider: 'bad-exchange',
        price: 9_000_000,
        quoteVolume: Number.POSITIVE_INFINITY,
        changePercentage24h: Number.NaN,
        timestamp: Date.parse('2026-03-20T00:03:00.000Z'),
      },
    ]);

    expect(accumulator.priceCount).toBe(2);
    expect(accumulator.priceTotal.dividedBy(accumulator.priceCount).toNumber()).toBe(90_050);
    expect(accumulator.volumeTotal.dividedBy(accumulator.volumeCount).toNumber()).toBe(9_005_000);
    expect(accumulator.changeTotal.dividedBy(accumulator.changeCount).toNumber()).toBe(1.5);
    expect(accumulator.latestTimestamp).toBe(Date.parse('2026-03-20T00:02:00.000Z'));
    expect([...accumulator.providers].sort()).toEqual(['binance', 'kraken']);
  });

  it('preserves null optional market fields when live providers only prove price', () => {
    const accumulator = buildMarketQuoteAccumulator([
      {
        provider: 'binance',
        price: 90_000,
        quoteVolume: null,
        changePercentage24h: null,
        timestamp: Date.parse('2026-03-20T00:01:00.000Z'),
      },
    ]);

    const nextSnapshot = buildLiveSnapshotValue(
      'bitcoin',
      accumulator,
      null,
      'usd',
      new Date('2026-03-20T00:02:00.000Z'),
    );

    expect(nextSnapshot.price).toBe(90_000);
    expect(nextSnapshot.marketCap).toBeNull();
    expect(nextSnapshot.totalVolume).toBeNull();
    expect(nextSnapshot.fullyDilutedValuation).toBeNull();
    expect(nextSnapshot.ath).toBeNull();
    expect(nextSnapshot.atl).toBeNull();
    expect(nextSnapshot.priceChange24h).toBeNull();
    expect(nextSnapshot.priceChangePercentage24h).toBeNull();
    expect(Object.values(nextSnapshot).some((value) => typeof value === 'number' && !Number.isFinite(value))).toBe(false);
  });
});
