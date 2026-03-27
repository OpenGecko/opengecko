import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { ohlcvCandles, quoteSnapshots, type OhlcvCandleRow } from '../db/schema';

export type CandleInterval = '1m' | '1d';

export type OhlcvGapDescriptor = {
  coinId: string;
  vsCurrency: string;
  interval: CandleInterval;
  gapStart: Date;
  gapEnd: Date;
  missingTimestamps: Date[];
  missingSlotCount: number;
};

export type CanonicalCandleInput = {
  coinId: string;
  vsCurrency: string;
  interval: CandleInterval;
  timestamp: Date;
  price: number;
  volume?: number | null;
  marketCap?: number | null;
  totalVolume?: number | null;
  source?: string;
};

export type CanonicalOhlcvCandleInput = {
  coinId: string;
  vsCurrency: string;
  interval: CandleInterval;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  marketCap?: number | null;
  totalVolume?: number | null;
  source?: string;
  replaceExisting?: boolean;
};

export type QuoteSnapshotInput = {
  coinId: string;
  vsCurrency: string;
  exchangeId: string;
  symbol: string;
  fetchedAt: Date;
  price: number;
  quoteVolume?: number | null;
  priceChangePercentage24h?: number | null;
  sourcePayloadJson: string;
};

function buildRangeWhere(
  coinId: string,
  vsCurrency: string,
  interval: CandleInterval,
  range?: { from?: number; to?: number },
) {
  const baseCondition = and(
    eq(ohlcvCandles.coinId, coinId),
    eq(ohlcvCandles.vsCurrency, vsCurrency),
    eq(ohlcvCandles.interval, interval),
    eq(ohlcvCandles.source, 'canonical'),
  );

  if (range?.from !== undefined && range?.to !== undefined) {
    return and(baseCondition, gte(ohlcvCandles.timestamp, new Date(range.from)), lte(ohlcvCandles.timestamp, new Date(range.to)));
  }

  if (range?.from !== undefined) {
    return and(baseCondition, gte(ohlcvCandles.timestamp, new Date(range.from)));
  }

  if (range?.to !== undefined) {
    return and(baseCondition, lte(ohlcvCandles.timestamp, new Date(range.to)));
  }

  return baseCondition;
}

export function getCanonicalCandles(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  interval: CandleInterval,
  range?: { from?: number; to?: number },
) {
  return database.db
    .select()
    .from(ohlcvCandles)
    .where(buildRangeWhere(coinId, vsCurrency, interval, range))
    .orderBy(asc(ohlcvCandles.timestamp))
    .all();
}

export function getCanonicalCloseSeries(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  interval: CandleInterval,
  range?: { from?: number; to?: number },
) {
  return getCanonicalCandles(database, coinId, vsCurrency, interval, range).map((row) => ({
    timestamp: row.timestamp,
    price: row.close,
    marketCap: row.marketCap,
    totalVolume: row.totalVolume,
  }));
}

export function recordQuoteSnapshot(database: AppDatabase, input: QuoteSnapshotInput) {
  database.db
    .insert(quoteSnapshots)
    .values({
      coinId: input.coinId,
      vsCurrency: input.vsCurrency,
      exchangeId: input.exchangeId,
      symbol: input.symbol,
      fetchedAt: input.fetchedAt,
      price: input.price,
      quoteVolume: input.quoteVolume ?? null,
      priceChangePercentage24h: input.priceChangePercentage24h ?? null,
      sourcePayloadJson: input.sourcePayloadJson,
    })
    .onConflictDoNothing()
    .run();
}

export function upsertCanonicalCandle(database: AppDatabase, input: CanonicalCandleInput) {
  return upsertCanonicalOhlcvCandle(database, {
    coinId: input.coinId,
    vsCurrency: input.vsCurrency,
    interval: input.interval,
    timestamp: input.timestamp,
    open: input.price,
    high: input.price,
    low: input.price,
    close: input.price,
    volume: input.volume,
    marketCap: input.marketCap,
    totalVolume: input.totalVolume,
    source: input.source,
  });
}

export function upsertCanonicalOhlcvCandle(database: AppDatabase, input: CanonicalOhlcvCandleInput) {
  const source = input.source ?? 'canonical';
  const setValues = input.replaceExisting
    ? {
        open: input.open,
        high: input.high,
        low: input.low,
        close: input.close,
        volume: input.volume ?? null,
        marketCap: input.marketCap ?? null,
        totalVolume: input.totalVolume ?? null,
      }
    : {
        high: sql`MAX(${ohlcvCandles.high}, ${input.high})`,
        low: sql`MIN(${ohlcvCandles.low}, ${input.low})`,
        close: input.close,
        volume: input.volume ?? null,
        marketCap: input.marketCap ?? null,
        totalVolume: input.totalVolume ?? null,
      };

  database.db
    .insert(ohlcvCandles)
    .values({
      coinId: input.coinId,
      vsCurrency: input.vsCurrency,
      source,
      interval: input.interval,
      timestamp: input.timestamp,
      open: input.open,
      high: input.high,
      low: input.low,
      close: input.close,
      volume: input.volume ?? null,
      marketCap: input.marketCap ?? null,
      totalVolume: input.totalVolume ?? null,
    })
    .onConflictDoUpdate({
      target: [ohlcvCandles.coinId, ohlcvCandles.vsCurrency, ohlcvCandles.source, ohlcvCandles.interval, ohlcvCandles.timestamp],
      set: setValues,
    })
    .run();
}

export function toMinuteBucket(timestampMs: number) {
  return new Date(Math.floor(timestampMs / 60_000) * 60_000);
}

export function toDailyBucket(timestampMs: number) {
  const timestamp = new Date(timestampMs);

  return new Date(Date.UTC(timestamp.getUTCFullYear(), timestamp.getUTCMonth(), timestamp.getUTCDate()));
}

export function seedDailyCandlesFromCloseSeries(
  rows: Array<{ coinId: string; vsCurrency: string; timestamp: Date; price: number; marketCap: number | null; totalVolume: number | null }>,
) {
  return rows.map((row) => ({
    coinId: row.coinId,
    vsCurrency: row.vsCurrency,
    source: 'canonical',
    interval: '1d',
    timestamp: row.timestamp,
    open: row.price,
    high: row.price,
    low: row.price,
    close: row.price,
    volume: row.totalVolume,
    marketCap: row.marketCap,
    totalVolume: row.totalVolume,
  })) satisfies OhlcvCandleRow[];
}

function getIntervalMs(interval: CandleInterval) {
  switch (interval) {
    case '1m':
      return 60_000;
    case '1d':
      return 24 * 60 * 60 * 1000;
  }
}

export function detectOhlcvGaps(
  database: AppDatabase,
  coinId: string,
  vsCurrency: string,
  interval: CandleInterval,
): OhlcvGapDescriptor[] {
  const rows = getCanonicalCandles(database, coinId, vsCurrency, interval);

  if (rows.length < 2) {
    return [];
  }

  const intervalMs = getIntervalMs(interval);
  const gaps: OhlcvGapDescriptor[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];

    if (!previous || !current) {
      continue;
    }

    const previousTimestamp = previous.timestamp.getTime();
    const currentTimestamp = current.timestamp.getTime();
    const delta = currentTimestamp - previousTimestamp;

    if (delta <= intervalMs) {
      continue;
    }

    const missingTimestamps: Date[] = [];

    for (let timestamp = previousTimestamp + intervalMs; timestamp < currentTimestamp; timestamp += intervalMs) {
      missingTimestamps.push(new Date(timestamp));
    }

    if (missingTimestamps.length === 0) {
      continue;
    }

    gaps.push({
      coinId,
      vsCurrency,
      interval,
      gapStart: missingTimestamps[0]!,
      gapEnd: missingTimestamps[missingTimestamps.length - 1]!,
      missingTimestamps,
      missingSlotCount: missingTimestamps.length,
    });
  }

  return gaps;
}

export async function repairOhlcvGaps(
  database: AppDatabase,
  target: {
    coinId: string;
    exchangeId: string;
    symbol: string;
    vsCurrency: string;
    interval: CandleInterval;
    retentionDays?: number;
  },
  fetchCandles: (since: number, limit?: number) => Promise<Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number | null;
  }>>,
) {
  const intervalMs = getIntervalMs(target.interval);
  let gaps = detectOhlcvGaps(database, target.coinId, target.vsCurrency, target.interval);
  const initialGapCount = gaps.length;
  let repairedCount = 0;
  const exhaustedGapStarts = new Set<number>();

  while (gaps.length > 0) {
    const gap = gaps.reduce((selected, candidate) => (
      candidate.missingSlotCount > selected.missingSlotCount
      || (
        candidate.missingSlotCount === selected.missingSlotCount
        && candidate.gapStart.getTime() < selected.gapStart.getTime()
      )
        ? candidate
        : selected
    ));
    const gapStartTime = gap.gapStart.getTime();

    if (exhaustedGapStarts.has(gapStartTime)) {
      break;
    }
    const fetchedCandles = await fetchCandles(gap.gapStart.getTime(), gap.missingSlotCount);
    const requestedTimestamps = new Set(gap.missingTimestamps.map((value) => value.getTime()));
    let repairedThisPass = 0;

    for (const candle of fetchedCandles) {
      if (!requestedTimestamps.has(candle.timestamp)) {
        continue;
      }

      upsertCanonicalOhlcvCandle(database, {
        coinId: target.coinId,
        vsCurrency: target.vsCurrency,
        interval: target.interval,
        timestamp: new Date(candle.timestamp),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        totalVolume: candle.volume,
        replaceExisting: true,
      });
      repairedCount += 1;
      repairedThisPass += 1;
    }

    if (repairedThisPass === 0) {
      exhaustedGapStarts.add(gapStartTime);
    }

    gaps = detectOhlcvGaps(database, target.coinId, target.vsCurrency, target.interval);
  }

  if (target.retentionDays) {
    enforceOhlcvRetention(database, {
      coinId: target.coinId,
      vsCurrency: target.vsCurrency,
      interval: target.interval,
      retentionDays: target.retentionDays,
    });
  }

  return {
    gapsRepaired: initialGapCount,
    candlesRepaired: repairedCount,
    intervalMs,
  };
}

export function enforceOhlcvRetention(
  database: AppDatabase,
  input: {
    coinId: string;
    vsCurrency: string;
    interval: CandleInterval;
    retentionDays: number;
    now?: Date;
  },
) {
  const newest = database.db
    .select()
    .from(ohlcvCandles)
    .where(buildRangeWhere(input.coinId, input.vsCurrency, input.interval))
    .orderBy(desc(ohlcvCandles.timestamp))
    .get();

  if (!newest) {
    return 0;
  }

  const referenceTime = input.now?.getTime() ?? newest.timestamp.getTime();
  const retentionMs = input.retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(referenceTime - retentionMs);

  const result = database.db
    .delete(ohlcvCandles)
    .where(and(
      buildRangeWhere(input.coinId, input.vsCurrency, input.interval),
      lte(ohlcvCandles.timestamp, cutoff),
    ))
    .run();

  return result?.changes ?? 0;
}
