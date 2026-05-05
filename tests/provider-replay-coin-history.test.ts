import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { coinHistorySnapshots } from '../src/db/schema';
import {
  ingestCoinHistoryReplay,
  normalizeCoinHistoryReplay,
  type RawCoinHistoryReplay,
} from '../src/services/coin-history-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/coin-history/bitcoin-2026-03-20.json'),
    'utf8',
  )) as RawCoinHistoryReplay;
}

describe('coin history provider replay fixtures', () => {
  it('rejects malformed coin history replay payloads explicitly', () => {
    const fixture = loadFixture();

    expect(() => normalizeCoinHistoryReplay({
      ...fixture,
      coin_id: ' ',
    })).toThrow('Missing coin history field: coin_id');
    expect(() => normalizeCoinHistoryReplay({
      ...fixture,
      captured_at: 'not-a-date',
    })).toThrow('Invalid coin history timestamp');
    expect(() => normalizeCoinHistoryReplay({
      ...fixture,
      date: '20-03-2026',
    })).toThrow('Invalid coin history date');
    expect(() => normalizeCoinHistoryReplay({
      ...fixture,
      market_data: {
        ...fixture.market_data,
        current_price: 'bad',
      },
    })).toThrow('Invalid coin history field');
  });

  it('replays source-attributed dated snapshots into the public coin history route', async () => {
    const fixture = loadFixture();
    const normalized = normalizeCoinHistoryReplay(fixture);

    expect(normalized).toMatchObject({
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      snapshotAt: new Date('2026-03-20T00:00:00.000Z'),
      capturedAt: new Date('2026-05-05T00:40:00.000Z'),
      price: 91234.56,
    });

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      expect(ingestCoinHistoryReplay(app.db, fixture)).toEqual({
        coin_id: 'bitcoin',
        vs_currency: 'usd',
        snapshot_at: '2026-03-20T00:00:00.000Z',
        snapshots_written: 1,
        source_kind: 'replay',
        source_provider: 'coin-history-replay',
        source_fetched_at: '2026-05-05T00:40:00.000Z',
      });
      expect(ingestCoinHistoryReplay(app.db, fixture)).toMatchObject({
        snapshots_written: 1,
      });
      expect(app.db.db.select().from(coinHistorySnapshots)
        .where(eq(coinHistorySnapshots.coinId, 'bitcoin'))
        .all()).toHaveLength(1);

      const historyResponse = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/history?date=20-03-2026&localization=false',
      });
      const coverageMatrixResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/coverage_matrix',
      });

      expect(historyResponse.statusCode).toBe(200);
      expect(historyResponse.json()).toMatchObject({
        id: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        market_data: {
          current_price: {
            usd: 91234.56,
          },
          market_cap: {
            usd: 1812345678901,
          },
          total_volume: {
            usd: 41234567890,
          },
          market_cap_rank: 1,
          last_updated: '2026-03-20T00:00:00.000Z',
        },
        last_updated: '2026-03-20T00:00:00.000Z',
      });
      expect(historyResponse.json()).not.toHaveProperty('source_kind');
      expect(historyResponse.json().market_data).not.toHaveProperty('source_kind');
      expect(coverageMatrixResponse.statusCode).toBe(200);
      expect(coverageMatrixResponse.json().data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'coin_detail',
          ownership_class: 'hybrid',
          last_successful_refresh_at: '2026-05-05T00:40:00.000Z',
          evidence: expect.objectContaining({
            notes: expect.stringContaining('source-attributed replay/live rows'),
          }),
        }),
      ]));
    } finally {
      await app.close();
    }
  });

  it('prefers live history snapshots over replay snapshots for the same coin date', async () => {
    const fixture = loadFixture();
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      ingestCoinHistoryReplay(app.db, fixture);
      ingestCoinHistoryReplay(app.db, {
        ...fixture,
        provider: 'live-history-provider',
        market_data: {
          ...fixture.market_data,
          current_price: 99999,
        },
      }, {
        sourceKind: 'live',
        sourceProvider: 'live-history-provider',
        sourceFetchedAt: new Date('2026-05-05T00:45:00.000Z'),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/history?date=20-03-2026&localization=false',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().market_data.current_price.usd).toBe(99999);
    } finally {
      await app.close();
    }
  });
});
