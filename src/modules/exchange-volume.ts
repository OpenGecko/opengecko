import { asc, eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { exchangeVolumePoints } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseFiniteNumber, parsePositiveInt } from '../http/params';

export function getExchangeVolumeChart(database: AppDatabase, exchangeId: string, days: string) {
  const parsedDays = parsePositiveInt(days, 1, 'days');

  const cutoffMs = Date.now() - parsedDays * 24 * 60 * 60 * 1000;

  const allRows = database.db
    .select()
    .from(exchangeVolumePoints)
    .where(eq(exchangeVolumePoints.exchangeId, exchangeId))
    .orderBy(asc(exchangeVolumePoints.timestamp))
    .all();

  const rows = allRows.filter((row) => row.timestamp.getTime() >= cutoffMs);

  if (rows.length === 0) {
    return [];
  }

  return rows
    .filter((row) => Number.isFinite(row.volumeBtc))
    .map((row) => [row.timestamp.getTime(), row.volumeBtc] satisfies [number, number]);
}

function parseRangeBound(value: string, name: 'from' | 'to') {
  return parseFiniteNumber(value, 0, name);
}

export function getExchangeVolumeChartRange(database: AppDatabase, exchangeId: string, from: string, to: string) {
  const fromSeconds = parseRangeBound(from, 'from');
  const toSeconds = parseRangeBound(to, 'to');

  if (fromSeconds > toSeconds) {
    throw new HttpError(400, 'invalid_parameter', 'Invalid time range: from must be less than or equal to to.');
  }

  const fromMs = fromSeconds * 1000;
  const toMs = toSeconds * 1000;

  return database.db
    .select()
    .from(exchangeVolumePoints)
    .where(eq(exchangeVolumePoints.exchangeId, exchangeId))
    .orderBy(asc(exchangeVolumePoints.timestamp))
    .all()
    .filter((row) => {
      const timestamp = row.timestamp.getTime();

      return timestamp >= fromMs && timestamp <= toMs && Number.isFinite(row.volumeBtc);
    })
    .map((row) => [row.timestamp.getTime(), row.volumeBtc] satisfies [number, number]);
}
