import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedReferenceData, type AppDatabase } from '../src/db/client';
import { HttpError } from '../src/http/errors';
import { buildExchangeRatesPayload, getConversionRate, SUPPORTED_VS_CURRENCIES } from '../src/lib/conversion';
import type { SnapshotAccessPolicy } from '../src/modules/market-freshness';

const seedFriendlyPolicy: SnapshotAccessPolicy = {
  initialSyncCompleted: false,
  allowStaleLiveService: false,
};

describe('conversion helpers', () => {
  let database: AppDatabase;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-conversion-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedReferenceData(database);
    rebuildSearchIndex(database);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes the supported vs currencies from one shared module', () => {
    expect([...SUPPORTED_VS_CURRENCIES]).toEqual(['usd', 'eur', 'btc', 'eth']);
  });

  it('returns stable conversion rates for supported currencies', () => {
    expect(getConversionRate(database, 'usd', 300, seedFriendlyPolicy)).toBe(1);
    expect(getConversionRate(database, 'eur', 300, seedFriendlyPolicy)).toBe(0.8627000182076447);
    expect(getConversionRate(database, 'btc', 300, seedFriendlyPolicy)).toBe(1 / 85_000);
    expect(getConversionRate(database, 'eth', 300, seedFriendlyPolicy)).toBe(1 / 2_000);
  });

  it('throws consistently for unsupported currencies', () => {
    expect(() => getConversionRate(database, 'sgd', 300, seedFriendlyPolicy)).toThrowError(HttpError);
    expect(() => getConversionRate(database, 'sgd', 300, seedFriendlyPolicy)).toThrow('Unsupported vs_currency: sgd');
  });

  it('builds the exchange-rates payload from the shared conversion source', () => {
    expect(buildExchangeRatesPayload(database, 300, seedFriendlyPolicy)).toEqual({
      rates: {
        btc: {
          name: 'Bitcoin',
          unit: 'BTC',
          value: 1,
          type: 'crypto',
        },
        eth: {
          name: 'Ether',
          unit: 'ETH',
          value: 42.5,
          type: 'crypto',
        },
        usd: {
          name: 'US Dollar',
          unit: '$',
          value: 85_000,
          type: 'fiat',
        },
        eur: {
          name: 'Euro',
          unit: '€',
          value: 73_329.50154764981,
          type: 'fiat',
        },
      },
    });
  });
});
