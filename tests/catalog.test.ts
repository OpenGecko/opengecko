import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedReferenceData, type AppDatabase } from '../src/db/client';
import { getChartSeries, getCoinByContract, getMarketRows } from '../src/modules/catalog';

describe('catalog repository helpers', () => {
  let database: AppDatabase;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-catalog-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedReferenceData(database);
    rebuildSearchIndex(database);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves contract addresses deterministically', () => {
    const coin = getCoinByContract(database, 'ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

    expect(coin?.id).toBe('usd-coin');
  });

  it('filters market rows by ids before other selectors', () => {
    const rows = getMarketRows(database, 'usd', {
      ids: ['bitcoin'],
      symbols: ['eth'],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.coin.id).toBe('bitcoin');
  });

  it('returns deterministic chart ranges', () => {
    const rows = getChartSeries(database, 'bitcoin', 'usd', {
      from: Date.parse('2026-03-16T00:00:00.000Z'),
      to: Date.parse('2026-03-18T00:00:00.000Z'),
    });

    expect(rows.map((row) => row.timestamp.toISOString())).toEqual([
      '2026-03-16T00:00:00.000Z',
      '2026-03-17T00:00:00.000Z',
      '2026-03-18T00:00:00.000Z',
    ]);
  });

  it('supports open-ended chart ranges for history-style reads', () => {
    const rows = getChartSeries(database, 'bitcoin', 'usd', {
      to: Date.parse('2026-03-15T00:00:00.000Z'),
    });

    expect(rows.map((row) => row.timestamp.toISOString())).toEqual([
      '2026-03-14T00:00:00.000Z',
      '2026-03-15T00:00:00.000Z',
    ]);
  });
});
