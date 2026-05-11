import { and, eq, isNotNull } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { marketSnapshots, supplyChartPoints } from '../db/schema';

const SUPPLY_AGGREGATOR_SOURCE_PROVIDER = 'market-snapshot-aggregator';

function isUsableSupplyValue(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function runSupplyAggregator(database: AppDatabase, now = new Date()) {
  const snapshots = database.db
    .select()
    .from(marketSnapshots)
    .where(and(
      eq(marketSnapshots.vsCurrency, 'usd'),
      isNotNull(marketSnapshots.lastUpdated),
    ))
    .all();

  let rowsWritten = 0;
  let targetsProcessed = 0;

  for (const snapshot of snapshots) {
    let wroteForSnapshot = false;
    const supplyRows = [
      { supplyType: 'circulating' as const, value: snapshot.circulatingSupply },
      { supplyType: 'total' as const, value: snapshot.totalSupply },
    ];

    for (const row of supplyRows) {
      const supplyValue = row.value;

      if (!isUsableSupplyValue(supplyValue)) {
        continue;
      }

      database.db
        .insert(supplyChartPoints)
        .values({
          coinId: snapshot.coinId,
          supplyType: row.supplyType,
          timestamp: snapshot.lastUpdated,
          value: supplyValue,
          sourceKind: 'live',
          sourceProvider: SUPPLY_AGGREGATOR_SOURCE_PROVIDER,
          sourceFetchedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            supplyChartPoints.coinId,
            supplyChartPoints.supplyType,
            supplyChartPoints.timestamp,
            supplyChartPoints.sourceKind,
            supplyChartPoints.sourceProvider,
          ],
          set: {
            value: supplyValue,
            sourceFetchedAt: now,
          },
        })
        .run();
      rowsWritten += 1;
      wroteForSnapshot = true;
    }

    if (wroteForSnapshot) {
      targetsProcessed += 1;
    }
  }

  return {
    targetsProcessed,
    rowsWritten,
  };
}
