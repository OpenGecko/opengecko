import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import {
  derivativeTickers,
  exchanges,
  exchangeVolumeSourcePoints,
  marketChartSourcePoints,
  onchainPoolTrades,
} from '../src/db/schema';
import { buildCoverageMatrix } from '../src/services/coverage-matrix';

let database: AppDatabase;

beforeEach(() => {
  database = createDatabase(':memory:');
  migrateDatabase(database);
  seedStaticReferenceData(database);
});

afterEach(() => {
  database.client.close();
});

function coverageEntry(family: string, now = new Date('2026-05-15T00:00:00.000Z')) {
  return buildCoverageMatrix(database, now).entries.find((entry) => entry.family === family);
}

function historicalChartsEntry(now = new Date('2026-05-15T00:00:00.000Z')) {
  return coverageEntry('historical_charts', now);
}

describe('coverage matrix source-backed promotion', () => {
  it('does not promote historical charts from a single replay row', () => {
    database.db.insert(marketChartSourcePoints).values({
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
      timestamp: new Date('2026-05-14T00:00:00.000Z'),
      price: 90_000,
      marketCap: 1_800_000_000_000,
      totalVolume: 40_000_000_000,
      open: 89_000,
      high: 91_000,
      low: 88_500,
      close: 90_000,
      sourceKind: 'replay',
      sourceProvider: 'custom',
      sourceFetchedAt: new Date('2026-05-14T00:05:00.000Z'),
    }).run();

    expect(historicalChartsEntry()).toMatchObject({
      ownership_class: 'seeded',
      last_successful_refresh_at: null,
    });
  });

  it('keeps historical charts hybrid when live source rows do not meet breadth thresholds', () => {
    for (let day = 1; day <= 3; day += 1) {
      database.db.insert(marketChartSourcePoints).values({
        coinId: 'bitcoin',
        vsCurrency: 'usd',
        interval: '1d',
        timestamp: new Date(`2026-05-${String(day).padStart(2, '0')}T00:00:00.000Z`),
        price: 90_000 + day,
        marketCap: 1_800_000_000_000,
        totalVolume: 40_000_000_000,
        open: 89_000,
        high: 91_000,
        low: 88_500,
        close: 90_000 + day,
        sourceKind: 'live',
        sourceProvider: 'custom',
        sourceFetchedAt: new Date('2026-05-14T00:05:00.000Z'),
      }).run();
    }

    expect(historicalChartsEntry()).toMatchObject({
      ownership_class: 'hybrid',
      last_successful_refresh_at: '2026-05-14T00:05:00.000Z',
    });
  });

  it('can promote historical charts to live only after enough enabled target breadth and depth are source-backed', () => {
    const targets = [
      { coinId: 'bitcoin', interval: '1d' as const, points: 30 },
      { coinId: 'ethereum', interval: '1d' as const, points: 30 },
      { coinId: 'bitcoin', interval: '1m' as const, points: 60 },
      { coinId: 'ethereum', interval: '1m' as const, points: 60 },
    ];

    for (const target of targets) {
      for (let index = 0; index < target.points; index += 1) {
        const timestamp = target.interval === '1d'
          ? new Date(Date.UTC(2026, 3, 15 + index))
          : new Date(Date.UTC(2026, 4, 14, 23, index));
        database.db.insert(marketChartSourcePoints).values({
          coinId: target.coinId,
          vsCurrency: 'usd',
          interval: target.interval,
          timestamp,
          price: 1_000 + index,
          marketCap: 10_000 + index,
          totalVolume: 100_000 + index,
          open: 990 + index,
          high: 1_010 + index,
          low: 980 + index,
          close: 1_000 + index,
          sourceKind: 'live',
          sourceProvider: 'custom',
          sourceFetchedAt: new Date('2026-05-14T23:59:00.000Z'),
        }).run();
      }
    }

    expect(historicalChartsEntry()).toMatchObject({
      ownership_class: 'live',
      last_successful_refresh_at: '2026-05-14T23:59:00.000Z',
    });
  });

  it('does not promote exchange volumes from replay-only volume rows', () => {
    database.db.insert(exchanges).values({
      id: 'binance',
      name: 'Binance',
      country: null,
      yearEstablished: 2017,
      url: 'https://www.binance.com',
      imageUrl: null,
      trustScore: 10,
      trustScoreRank: 1,
      tradeVolume24hBtc: null,
      tradeVolume24hBtcNormalized: null,
      description: '',
      hasTradingIncentive: false,
      centralised: true,
      publicNotice: null,
      alertNotice: null,
      updatedAt: new Date('2026-05-14T00:00:00.000Z'),
    }).onConflictDoNothing().run();
    database.db.insert(exchangeVolumeSourcePoints).values({
      exchangeId: 'binance',
      timestamp: new Date('2026-05-14T00:00:00.000Z'),
      volumeBtc: 141_000,
      sourceKind: 'replay',
      sourceProvider: 'exchange-volume-replay',
      sourceFetchedAt: new Date('2026-05-14T00:10:00.000Z'),
    }).run();

    expect(coverageEntry('exchanges')).toMatchObject({
      ownership_class: 'seeded',
      last_successful_refresh_at: null,
    });
  });

  it('promotes exchange volumes only when live source rows exist', () => {
    database.db.insert(exchanges).values({
      id: 'binance',
      name: 'Binance',
      country: null,
      yearEstablished: 2017,
      url: 'https://www.binance.com',
      imageUrl: null,
      trustScore: 10,
      trustScoreRank: 1,
      tradeVolume24hBtc: null,
      tradeVolume24hBtcNormalized: null,
      description: '',
      hasTradingIncentive: false,
      centralised: true,
      publicNotice: null,
      alertNotice: null,
      updatedAt: new Date('2026-05-14T00:00:00.000Z'),
    }).onConflictDoNothing().run();
    database.db.insert(exchangeVolumeSourcePoints).values({
      exchangeId: 'binance',
      timestamp: new Date('2026-05-14T00:00:00.000Z'),
      volumeBtc: 141_000,
      sourceKind: 'live',
      sourceProvider: 'ccxt.binance',
      sourceFetchedAt: new Date('2026-05-14T00:10:00.000Z'),
    }).run();

    expect(coverageEntry('exchanges')).toMatchObject({
      ownership_class: 'hybrid',
      last_successful_refresh_at: '2026-05-14T00:10:00.000Z',
    });
  });

  it('does not promote derivatives from replay-only ticker rows', () => {
    database.db.delete(derivativeTickers).run();
    database.db.insert(derivativeTickers).values({
      exchangeId: 'binance_futures',
      symbol: 'BTC/USDT:USDT',
      market: 'BTCUSDT',
      indexId: 'BTC',
      price: 64_000,
      pricePercentageChange24h: 2.4,
      contractType: 'perpetual',
      indexValue: 63_990,
      basis: 10,
      spread: 0.002,
      fundingRate: 0.0001,
      openInterestBtc: 182_500,
      tradeVolume24hBtc: 912_000,
      lastTradedAt: new Date('2026-05-14T00:00:00.000Z'),
      expiredAt: null,
      sourceKind: 'replay',
      sourceProvider: 'ccxt.binance_futures',
      sourceFetchedAt: new Date('2026-05-14T00:01:00.000Z'),
    }).run();

    expect(coverageEntry('derivatives')).toMatchObject({
      ownership_class: 'fixture',
      last_successful_refresh_at: '2026-05-14T00:00:00.000Z',
    });
  });

  it('promotes derivatives only when live ticker rows exist', () => {
    database.db.delete(derivativeTickers).run();
    database.db.insert(derivativeTickers).values({
      exchangeId: 'binance_futures',
      symbol: 'BTC/USDT:USDT',
      market: 'BTCUSDT',
      indexId: 'BTC',
      price: 64_000,
      pricePercentageChange24h: 2.4,
      contractType: 'perpetual',
      indexValue: 63_990,
      basis: 10,
      spread: 0.002,
      fundingRate: 0.0001,
      openInterestBtc: 182_500,
      tradeVolume24hBtc: 912_000,
      lastTradedAt: new Date('2026-05-14T00:00:00.000Z'),
      expiredAt: null,
      sourceKind: 'live',
      sourceProvider: 'ccxt.binance_futures',
      sourceFetchedAt: new Date('2026-05-14T00:01:00.000Z'),
    }).run();

    expect(coverageEntry('derivatives')).toMatchObject({
      ownership_class: 'hybrid',
      last_successful_refresh_at: '2026-05-14T00:01:00.000Z',
    });
  });

  it('does not promote onchain from replay-only trade rows', () => {
    database.db.insert(onchainPoolTrades).values({
      networkId: 'eth',
      poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      tradeId: 'replay-1',
      tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      side: 'buy',
      volumeUsd: 275_000,
      priceUsd: 1,
      txHash: '0xreplay1',
      blockTimestamp: 1_710_000_300,
      sourceKind: 'replay',
      sourceProvider: 'sqd-swap-replay',
      sourceFetchedAt: new Date('2026-05-14T00:09:00.000Z'),
    }).run();

    expect(coverageEntry('onchain')).toMatchObject({
      ownership_class: 'hybrid',
      last_successful_refresh_at: '2026-03-20T00:00:00.000Z',
    });
  });

  it('tracks live onchain trade rows as source-backed freshness evidence', () => {
    database.db.insert(onchainPoolTrades).values({
      networkId: 'eth',
      poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      tradeId: 'live-1',
      tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      side: 'buy',
      volumeUsd: 275_000,
      priceUsd: 1,
      txHash: '0xlive1',
      blockTimestamp: 1_710_000_300,
      sourceKind: 'live',
      sourceProvider: 'sqd.live',
      sourceFetchedAt: new Date('2026-05-14T00:09:00.000Z'),
    }).run();

    expect(coverageEntry('onchain')).toMatchObject({
      ownership_class: 'hybrid',
      last_successful_refresh_at: '2026-05-14T00:09:00.000Z',
    });
  });
});
