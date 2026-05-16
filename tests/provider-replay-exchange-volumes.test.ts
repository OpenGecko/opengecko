import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { exchangeVolumeSourcePoints } from '../src/db/schema';
import {
  ingestExchangeVolumeReplay,
  normalizeExchangeVolumeReplay,
  type RawExchangeVolumeReplay,
} from '../src/services/exchange-volume-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/exchange-volumes/binance-volume.json'),
    'utf8',
  )) as RawExchangeVolumeReplay;
}

describe('exchange volume provider replay fixtures', () => {
  it('rejects malformed exchange volume replay payloads explicitly', () => {
    const fixture = loadFixture();

    expect(() => normalizeExchangeVolumeReplay({
      ...fixture,
      exchange_id: ' ',
    })).toThrow('Missing exchange volume field: exchange_id');
    expect(() => normalizeExchangeVolumeReplay({
      ...fixture,
      captured_at: 'not-a-date',
    })).toThrow('Invalid exchange volume captured_at timestamp');
    expect(() => normalizeExchangeVolumeReplay({
      ...fixture,
      points: [{ ...fixture.points[0]!, timestamp: 'bad' }],
    })).toThrow('Invalid exchange volume timestamp');
    expect(() => normalizeExchangeVolumeReplay({
      ...fixture,
      points: [{ ...fixture.points[0]!, volume_btc: 'bad' }],
    })).toThrow('Invalid exchange volume field');
  });

  it('replays source-attributed exchange volume rows into public volume chart routes', async () => {
    const fixture = loadFixture();
    const normalized = normalizeExchangeVolumeReplay(fixture);

    expect(normalized).toMatchObject({
      exchangeId: 'binance',
      capturedAt: new Date('2026-05-05T00:20:00.000Z'),
      points: expect.arrayContaining([
        expect.objectContaining({
          timestamp: new Date(1777852800 * 1_000),
          volumeBtc: 141000.5,
        }),
      ]),
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

      expect(ingestExchangeVolumeReplay(app.db, fixture)).toEqual({
        exchange_id: 'binance',
        points_written: 3,
        source_kind: 'replay',
        source_provider: 'exchange-volume-replay',
        source_fetched_at: '2026-05-05T00:20:00.000Z',
      });
      expect(ingestExchangeVolumeReplay(app.db, fixture)).toMatchObject({
        points_written: 3,
      });
      expect(app.db.db.select().from(exchangeVolumeSourcePoints)
        .where(eq(exchangeVolumeSourcePoints.exchangeId, 'binance'))
        .all()).toHaveLength(3);

      vi.useFakeTimers({ now: new Date('2026-05-05T00:25:00.000Z') });
      const rollingResponse = await app.inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart?days=7',
      });
      vi.useRealTimers();
      const rangeResponse = await app.inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart/range?from=1777852800&to=1778025600',
      });
      const coverageMatrixResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/coverage_matrix',
      });

      expect(rollingResponse.statusCode).toBe(200);
      expect(rollingResponse.json()).toEqual([
        [1777852800 * 1_000, 141000.5],
        [1777939200 * 1_000, 142500.25],
        [1778025600 * 1_000, 143750.75],
      ]);
      expect(rangeResponse.statusCode).toBe(200);
      expect(rangeResponse.json()).toEqual([
        [1777852800 * 1_000, 141000.5],
        [1777939200 * 1_000, 142500.25],
        [1778025600 * 1_000, 143750.75],
      ]);
      expect(coverageMatrixResponse.statusCode).toBe(200);
      expect(coverageMatrixResponse.json().data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'exchanges',
          last_successful_refresh_at: '2026-03-20T00:00:00.000Z',
          evidence: expect.objectContaining({
            notes: expect.stringContaining('replay rows prove adapter shape but do not promote production coverage'),
          }),
        }),
      ]));
    } finally {
      await app.close();
    }
  });

  it('prefers live source rows over replay rows at the same exchange-volume timestamp', async () => {
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

      ingestExchangeVolumeReplay(app.db, fixture);
      ingestExchangeVolumeReplay(app.db, {
        ...fixture,
        provider: 'live-volume-provider',
        points: [{
          timestamp: 1777939200,
          volume_btc: 200000,
        }],
      }, {
        sourceKind: 'live',
        sourceProvider: 'live-volume-provider',
        sourceFetchedAt: new Date('2026-05-05T00:30:00.000Z'),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart/range?from=1777939200&to=1777939200',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        [1777939200 * 1_000, 200000],
      ]);
    } finally {
      await app.close();
    }
  });
});
