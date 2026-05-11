import { and, eq, lte, ne } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
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
} from '../db/schema';

export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 365;

export type SnapshotRetentionResult = {
  coinHistorySnapshots: number;
  marketChartSourcePoints: number;
  exchangeVolumeSourcePoints: number;
  supplyChartPoints: number;
  onchainPoolOhlcv: number;
  onchainPoolTrades: number;
  onchainTokenHolders: number;
  onchainTokenTraders: number;
  onchainTokenHolderCounts: number;
  derivativeTickers: number;
  treasurySourceDocuments: number;
  totalRowsPruned: number;
};

function retentionCutoff(retentionDays: number, now: Date) {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

function changed(result: { changes?: number } | undefined | void) {
  return result?.changes ?? 0;
}

export function enforceSnapshotRetention(
  database: AppDatabase,
  options: {
    retentionDays?: number;
    now?: Date;
  } = {},
): SnapshotRetentionResult {
  const retentionDays = options.retentionDays ?? DEFAULT_SNAPSHOT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoff = retentionCutoff(retentionDays, now);

  const result = {
    coinHistorySnapshots: changed(database.db.delete(coinHistorySnapshots)
      .where(lte(coinHistorySnapshots.sourceFetchedAt, cutoff))
      .run()),
    marketChartSourcePoints: changed(database.db.delete(marketChartSourcePoints)
      .where(lte(marketChartSourcePoints.sourceFetchedAt, cutoff))
      .run()),
    exchangeVolumeSourcePoints: changed(database.db.delete(exchangeVolumeSourcePoints)
      .where(lte(exchangeVolumeSourcePoints.sourceFetchedAt, cutoff))
      .run()),
    supplyChartPoints: changed(database.db.delete(supplyChartPoints)
      .where(lte(supplyChartPoints.sourceFetchedAt, cutoff))
      .run()),
    onchainPoolOhlcv: changed(database.db.delete(onchainPoolOhlcv)
      .where(lte(onchainPoolOhlcv.sourceFetchedAt, cutoff))
      .run()),
    onchainPoolTrades: changed(database.db.delete(onchainPoolTrades)
      .where(lte(onchainPoolTrades.sourceFetchedAt, cutoff))
      .run()),
    onchainTokenHolders: changed(database.db.delete(onchainTokenHolders)
      .where(lte(onchainTokenHolders.sourceFetchedAt, cutoff))
      .run()),
    onchainTokenTraders: changed(database.db.delete(onchainTokenTraders)
      .where(lte(onchainTokenTraders.sourceFetchedAt, cutoff))
      .run()),
    onchainTokenHolderCounts: changed(database.db.delete(onchainTokenHolderCounts)
      .where(lte(onchainTokenHolderCounts.sourceFetchedAt, cutoff))
      .run()),
    derivativeTickers: changed(database.db.delete(derivativeTickers)
      .where(and(
        ne(derivativeTickers.sourceKind, 'seed'),
        lte(derivativeTickers.sourceFetchedAt, cutoff),
      ))
      .run()),
    treasurySourceDocuments: changed(database.db.delete(treasurySourceDocuments)
      .where(lte(treasurySourceDocuments.acceptedAt, cutoff))
      .run()),
  };

  return {
    ...result,
    totalRowsPruned: Object.values(result).reduce((total, value) => total + value, 0),
  };
}

export function enforceSupplySnapshotRetention(
  database: AppDatabase,
  options: { retentionDays?: number; now?: Date } = {},
) {
  const cutoff = retentionCutoff(options.retentionDays ?? DEFAULT_SNAPSHOT_RETENTION_DAYS, options.now ?? new Date());
  return changed(database.db.delete(supplyChartPoints)
    .where(and(
      eq(supplyChartPoints.sourceProvider, 'market-snapshot-aggregator'),
      lte(supplyChartPoints.sourceFetchedAt, cutoff),
    ))
    .run());
}
