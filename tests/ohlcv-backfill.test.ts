import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, initializeDatabase, type AppDatabase } from '../src/db/client';
import { getCanonicalCandles } from '../src/services/candle-store';
import { runOhlcvBackfillOnce } from '../src/services/ohlcv-backfill';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([
    {
      exchangeId: 'coinbase',
      symbol: 'BTC/USD',
      timeframe: '1d',
      timestamp: Date.parse('2026-03-19T00:00:00.000Z'),
      open: 81000,
      high: 82000,
      low: 80000,
      close: 81500,
      volume: 12345,
      raw: [0, 0, 0, 0, 0, 0],
    },
  ]),
  isSupportedExchangeId: (value: string) => ['binance', 'coinbase', 'kraken'].includes(value),
}));

describe('ohlcv backfill service', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-backfill-'));
    database = createDatabase(join(tempDir, 'test.db'));
    initializeDatabase(database);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes fetched daily candles into the canonical store', async () => {
    await runOhlcvBackfillOnce(database, { ccxtExchanges: ['coinbase'] }, { lookbackDays: 30 });

    const rows = getCanonicalCandles(database, 'bitcoin', 'usd', '1d', {
      from: Date.parse('2026-03-19T00:00:00.000Z'),
      to: Date.parse('2026-03-19T00:00:00.000Z'),
    });

    expect(rows[0]).toMatchObject({
      open: 81000,
      high: 82000,
      low: 80000,
      close: 81500,
      totalVolume: 12345,
    });
  });
});
