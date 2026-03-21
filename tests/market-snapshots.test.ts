import { describe, expect, it } from 'vitest';

import { buildLiveSnapshotValue, createMarketQuoteAccumulator, getSnapshotOwnership } from '../src/services/market-snapshots';

describe('market snapshot service helpers', () => {
  it('classifies seeded and live snapshot ownership explicitly', () => {
    expect(getSnapshotOwnership({ sourceCount: 0 })).toBe('seeded');
    expect(getSnapshotOwnership({ sourceCount: 2 })).toBe('live');
  });

  it('builds live snapshot updates by carrying forward supply-driven market fields', () => {
    const accumulator = createMarketQuoteAccumulator();
    accumulator.priceTotal = 171000;
    accumulator.priceCount = 2;
    accumulator.volumeTotal = 60000000000;
    accumulator.volumeCount = 2;
    accumulator.changeTotal = 4;
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
});
