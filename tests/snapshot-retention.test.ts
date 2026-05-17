import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDatabase, initializeDatabase, seedStaticReferenceData } from '../src/db/client';
import {
  coinHistorySnapshots,
  derivativeTickers,
  exchangeVolumeSourcePoints,
  marketChartSourcePoints,
  onchainPoolOhlcv,
  onchainPoolTrades,
  onchainTokenHolderCounts,
  onchainTokenHolders,
  onchainTokenTraders,
  supplyChartPoints,
  treasurySourceDocuments,
} from '../src/db/schema';
import { enforceSnapshotRetention, enforceSupplySnapshotRetention } from '../src/services/snapshot-retention';

describe('final snapshot retention', () => {
  it('prunes old append-style source snapshots while preserving current endpoint-visible rows', () => {
    const database = createDatabase(':memory:');
    const oldDate = new Date('2024-01-01T00:00:00.000Z');
    const currentDate = new Date('2026-05-01T00:00:00.000Z');

    try {
      initializeDatabase(database);
      seedStaticReferenceData(database, { includeSeededExchanges: true });

      database.db.insert(coinHistorySnapshots).values([
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          snapshotAt: oldDate,
          price: 50_000,
          sourceKind: 'live',
          sourceProvider: 'retention-old',
          sourceFetchedAt: oldDate,
          updatedAt: oldDate,
          lastUpdated: oldDate,
        },
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          snapshotAt: currentDate,
          price: 90_000,
          sourceKind: 'live',
          sourceProvider: 'retention-current',
          sourceFetchedAt: currentDate,
          updatedAt: currentDate,
          lastUpdated: currentDate,
        },
      ]).run();
      database.db.insert(marketChartSourcePoints).values([
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          interval: '1d',
          timestamp: oldDate,
          price: 50_000,
          open: 49_000,
          high: 51_000,
          low: 48_000,
          close: 50_000,
          sourceKind: 'live',
          sourceProvider: 'retention-old',
          sourceFetchedAt: oldDate,
        },
        {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          interval: '1d',
          timestamp: currentDate,
          price: 90_000,
          open: 89_000,
          high: 91_000,
          low: 88_000,
          close: 90_000,
          sourceKind: 'live',
          sourceProvider: 'retention-current',
          sourceFetchedAt: currentDate,
        },
      ]).run();
      database.db.insert(exchangeVolumeSourcePoints).values([
        {
          exchangeId: 'binance',
          timestamp: oldDate,
          volumeBtc: 10,
          sourceKind: 'live',
          sourceProvider: 'retention-old',
          sourceFetchedAt: oldDate,
        },
        {
          exchangeId: 'binance',
          timestamp: currentDate,
          volumeBtc: 20,
          sourceKind: 'live',
          sourceProvider: 'retention-current',
          sourceFetchedAt: currentDate,
        },
      ]).run();
      database.db.insert(supplyChartPoints).values([
        {
          coinId: 'bitcoin',
          supplyType: 'circulating',
          timestamp: oldDate,
          value: 19_000_000,
          sourceKind: 'live',
          sourceProvider: 'retention-old',
          sourceFetchedAt: oldDate,
        },
        {
          coinId: 'bitcoin',
          supplyType: 'circulating',
          timestamp: currentDate,
          value: 19_800_000,
          sourceKind: 'live',
          sourceProvider: 'retention-current',
          sourceFetchedAt: currentDate,
        },
      ]).run();
      database.db.insert(onchainPoolOhlcv).values([
        {
          networkId: 'eth',
          poolAddress: '0xretentionpool',
          timeframe: 'day',
          aggregate: 1,
          timestamp: oldDate.getTime(),
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          sourceKind: 'live',
          sourceProvider: 'retention-old',
          sourceFetchedAt: oldDate,
        },
        {
          networkId: 'eth',
          poolAddress: '0xretentionpool',
          timeframe: 'day',
          aggregate: 1,
          timestamp: currentDate.getTime(),
          open: 2,
          high: 2,
          low: 2,
          close: 2,
          sourceKind: 'live',
          sourceProvider: 'retention-current',
          sourceFetchedAt: currentDate,
        },
      ]).run();
      database.db.insert(onchainPoolTrades).values([
        {
          networkId: 'eth',
          poolAddress: '0xretentionpool',
          tradeId: 'old',
          tokenAddress: '0xretentiontoken',
          side: 'buy',
          volumeUsd: 1,
          priceUsd: 1,
          txHash: '0xold',
          blockTimestamp: oldDate.getTime(),
          sourceKind: 'live',
          sourceProvider: 'retention-old',
          sourceFetchedAt: oldDate,
        },
        {
          networkId: 'eth',
          poolAddress: '0xretentionpool',
          tradeId: 'current',
          tokenAddress: '0xretentiontoken',
          side: 'sell',
          volumeUsd: 2,
          priceUsd: 2,
          txHash: '0xcurrent',
          blockTimestamp: currentDate.getTime(),
          sourceKind: 'live',
          sourceProvider: 'retention-current',
          sourceFetchedAt: currentDate,
        },
      ]).run();
      database.db.insert(onchainTokenHolders).values([
        {
          networkId: 'eth',
          tokenAddress: '0xretentiontoken',
          holderAddress: '0xoldholder',
          balance: 1,
          shareOfSupply: 0.1,
          sourceKind: 'live',
          sourceProvider: 'retention-old',
          sourceFetchedAt: oldDate,
        },
        {
          networkId: 'eth',
          tokenAddress: '0xretentiontoken',
          holderAddress: '0xcurrentholder',
          balance: 2,
          shareOfSupply: 0.2,
          sourceKind: 'live',
          sourceProvider: 'retention-current',
          sourceFetchedAt: currentDate,
        },
      ]).run();
      database.db.insert(onchainTokenTraders).values([
        {
          networkId: 'eth',
          tokenAddress: '0xretentiontoken',
          traderAddress: '0xoldtrader',
          volumeUsd: 1,
          buyVolumeUsd: 1,
          sellVolumeUsd: 0,
          sourceKind: 'live',
          sourceProvider: 'retention-old',
          sourceFetchedAt: oldDate,
        },
        {
          networkId: 'eth',
          tokenAddress: '0xretentiontoken',
          traderAddress: '0xcurrenttrader',
          volumeUsd: 2,
          buyVolumeUsd: 0,
          sellVolumeUsd: 2,
          sourceKind: 'live',
          sourceProvider: 'retention-current',
          sourceFetchedAt: currentDate,
        },
      ]).run();
      database.db.insert(onchainTokenHolderCounts).values([
        {
          networkId: 'eth',
          tokenAddress: '0xretentiontoken',
          timestamp: oldDate.getTime(),
          holderCount: 1,
          sourceKind: 'live',
          sourceProvider: 'retention-old',
          sourceFetchedAt: oldDate,
        },
        {
          networkId: 'eth',
          tokenAddress: '0xretentiontoken',
          timestamp: currentDate.getTime(),
          holderCount: 2,
          sourceKind: 'live',
          sourceProvider: 'retention-current',
          sourceFetchedAt: currentDate,
        },
      ]).run();
      database.db.insert(derivativeTickers).values([
        {
          exchangeId: 'binance_futures',
          symbol: 'OLD/USDT:USDT',
          market: 'OLDUSDT',
          price: 1,
          contractType: 'perpetual',
          sourceKind: 'live',
          sourceProvider: 'ccxt.retention',
          sourceFetchedAt: oldDate,
        },
        {
          exchangeId: 'binance_futures',
          symbol: 'CURRENT/USDT:USDT',
          market: 'CURRENTUSDT',
          price: 2,
          contractType: 'perpetual',
          sourceKind: 'live',
          sourceProvider: 'ccxt.retention',
          sourceFetchedAt: currentDate,
        },
      ]).run();
      database.db.insert(treasurySourceDocuments).values([
        {
          sourceUrl: 'https://retention.example/old',
          entityId: 'strategy',
          provider: 'retention',
          documentType: 'treasury_disclosure',
          acceptedAt: oldDate,
          contentHash: 'old',
          rawJson: '{}',
          createdAt: oldDate,
          updatedAt: oldDate,
        },
        {
          sourceUrl: 'https://retention.example/current',
          entityId: 'strategy',
          provider: 'retention',
          documentType: 'treasury_disclosure',
          acceptedAt: currentDate,
          contentHash: 'current',
          rawJson: '{}',
          createdAt: currentDate,
          updatedAt: currentDate,
        },
      ]).run();

      const result = enforceSnapshotRetention(database, {
        retentionDays: 365,
        now: new Date('2026-05-11T00:00:00.000Z'),
      });

      expect(result).toMatchObject({
        coinHistorySnapshots: 1,
        marketChartSourcePoints: 1,
        exchangeVolumeSourcePoints: 1,
        supplyChartPoints: 1,
        onchainPoolOhlcv: 1,
        onchainPoolTrades: 1,
        onchainTokenHolders: 1,
        onchainTokenTraders: 1,
        onchainTokenHolderCounts: 1,
        derivativeTickers: 1,
        treasurySourceDocuments: 1,
        totalRowsPruned: 11,
      });
      expect(database.db.select().from(coinHistorySnapshots).where(eq(coinHistorySnapshots.sourceProvider, 'retention-current')).all()).toHaveLength(1);
      expect(database.db.select().from(marketChartSourcePoints).where(eq(marketChartSourcePoints.sourceProvider, 'retention-current')).all()).toHaveLength(1);
      expect(database.db.select().from(exchangeVolumeSourcePoints).where(eq(exchangeVolumeSourcePoints.sourceProvider, 'retention-current')).all()).toHaveLength(1);
      expect(database.db.select().from(supplyChartPoints).where(eq(supplyChartPoints.sourceProvider, 'retention-current')).all()).toHaveLength(1);
      expect(database.db.select().from(onchainPoolOhlcv).where(eq(onchainPoolOhlcv.sourceProvider, 'retention-current')).all()).toHaveLength(1);
      expect(database.db.select().from(onchainPoolTrades).where(eq(onchainPoolTrades.sourceProvider, 'retention-current')).all()).toHaveLength(1);
      expect(database.db.select().from(onchainTokenHolders).where(eq(onchainTokenHolders.sourceProvider, 'retention-current')).all()).toHaveLength(1);
      expect(database.db.select().from(onchainTokenTraders).where(eq(onchainTokenTraders.sourceProvider, 'retention-current')).all()).toHaveLength(1);
      expect(database.db.select().from(onchainTokenHolderCounts).where(eq(onchainTokenHolderCounts.sourceProvider, 'retention-current')).all()).toHaveLength(1);
      expect(database.db.select().from(derivativeTickers).where(eq(derivativeTickers.symbol, 'CURRENT/USDT:USDT')).all()).toHaveLength(1);
      expect(database.db.select().from(treasurySourceDocuments).where(eq(treasurySourceDocuments.sourceUrl, 'https://retention.example/current')).all()).toHaveLength(1);
    } finally {
      database.client.close();
    }
  });

  it('bounds supply aggregator rows independently so repeated daily snapshots do not grow forever', () => {
    const database = createDatabase(':memory:');

    try {
      initializeDatabase(database);
      seedStaticReferenceData(database, { includeSeededExchanges: true });
      database.db.insert(supplyChartPoints).values([
        {
          coinId: 'bitcoin',
          supplyType: 'total',
          timestamp: new Date('2025-01-01T00:00:00.000Z'),
          value: 21_000_000,
          sourceKind: 'live',
          sourceProvider: 'market-snapshot-aggregator',
          sourceFetchedAt: new Date('2025-01-01T00:00:00.000Z'),
        },
        {
          coinId: 'bitcoin',
          supplyType: 'total',
          timestamp: new Date('2026-05-01T00:00:00.000Z'),
          value: 21_000_000,
          sourceKind: 'live',
          sourceProvider: 'market-snapshot-aggregator',
          sourceFetchedAt: new Date('2026-05-01T00:00:00.000Z'),
        },
        {
          coinId: 'bitcoin',
          supplyType: 'total',
          timestamp: new Date('2025-01-01T00:00:00.000Z'),
          value: 21_000_000,
          sourceKind: 'live',
          sourceProvider: 'replay-provider',
          sourceFetchedAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      ]).run();

      expect(enforceSupplySnapshotRetention(database, {
        retentionDays: 365,
        now: new Date('2026-05-11T00:00:00.000Z'),
      })).toBe(1);
      expect(database.db.select().from(supplyChartPoints).all()).toHaveLength(3);
      expect(database.db.select().from(supplyChartPoints).where(eq(supplyChartPoints.sourceProvider, 'replay-provider')).all()).toHaveLength(1);
    } finally {
      database.client.close();
    }
  });
});
