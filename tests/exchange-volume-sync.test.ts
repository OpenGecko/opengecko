import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { exchangeVolumeSourcePoints } from '../src/db/schema';
import { runExchangeVolumeSyncJob } from '../src/jobs/sync-exchange-volumes';
import {
  createHttpExchangeVolumeFetcher,
  parseExchangeVolumeTargetConfig,
  syncExchangeVolumes,
} from '../src/services/exchange-volume-sync';
import type { RawExchangeVolumeReplay } from '../src/services/exchange-volume-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/exchange-volumes/binance-volume.json'),
    'utf8',
  )) as RawExchangeVolumeReplay;
}

describe('exchange volume sync', () => {
  it('parses optional provider exchange mappings from environment syntax', () => {
    expect(parseExchangeVolumeTargetConfig(undefined)).toEqual([]);
    expect(parseExchangeVolumeTargetConfig('   ')).toEqual([]);
    expect(parseExchangeVolumeTargetConfig('mock.volume=Binance, gdax')).toEqual([
      {
        provider: 'mock.volume',
        exchangeId: 'binance',
      },
      {
        provider: 'custom',
        exchangeId: 'gdax',
      },
    ]);
    expect(() => parseExchangeVolumeTargetConfig('mock.volume=')).toThrow(
      'Invalid exchange volume target config entry',
    );
  });

  it('exits without opening a database when no exchange volume targets are configured', async () => {
    await expect(runExchangeVolumeSyncJob({
      LOG_LEVEL: 'silent',
      EXCHANGE_VOLUME_TARGETS: '',
    })).resolves.toBeUndefined();
  });

  it('builds a provider-facing HTTP fetcher with stable target URL and defaults', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      captured_at: '2026-05-05T00:40:00.000Z',
      points: [{
        timestamp: '1778025600',
        volume_btc: '144000',
      }],
    }), { status: 200 }));
    const fetcher = createHttpExchangeVolumeFetcher('https://volumes.example/', fetchImpl as unknown as typeof fetch);
    const response = await fetcher({
      provider: 'mock.volume',
      exchangeId: 'binance',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://volumes.example/providers/mock.volume/exchanges/binance/volume_chart',
      expect.objectContaining({
        headers: { accept: 'application/json' },
      }),
    );
    expect(response).toMatchObject({
      provider: 'mock.volume',
      exchange_id: 'binance',
      points: [expect.objectContaining({ volume_btc: '144000' })],
    });
  });

  it('covers optional provider fetcher failure and no-data branches', async () => {
    expect(() => createHttpExchangeVolumeFetcher(undefined)).toThrow('EXCHANGE_VOLUME_BASE_URL is required');

    const notFoundFetcher = createHttpExchangeVolumeFetcher(
      'https://volumes.example',
      vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    );
    await expect(notFoundFetcher({
      provider: 'mock.volume',
      exchangeId: 'binance',
    })).resolves.toBeNull();

    const failedFetcher = createHttpExchangeVolumeFetcher(
      'https://volumes.example',
      vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(failedFetcher({
      provider: 'mock.volume',
      exchangeId: 'binance',
    })).rejects.toThrow('Exchange volume provider request failed with status 500');

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      await expect(syncExchangeVolumes(app.db, {
        targets: [{
          provider: 'mock.volume',
          exchangeId: 'binance',
        }],
        fetcher: vi.fn(async () => null),
        now: new Date('2026-05-05T00:41:00.000Z'),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        points_fetched: 0,
        points_written: 0,
        results: [
          expect.objectContaining({
            provider: 'mock.volume',
            exchange_id: 'binance',
          }),
        ],
      });

      await expect(syncExchangeVolumes(app.db, {
        targets: [{
          provider: 'empty.volume',
          exchangeId: 'binance',
        }],
        fetcher: vi.fn(async () => ({
          provider: 'empty.volume',
          captured_at: '2026-05-05T00:42:00.000Z',
          exchange_id: 'binance',
          points: [],
        })),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        points_fetched: 0,
        points_written: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('syncs mocked provider output into live source-attributed rows without changing chart shape', async () => {
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

      const result = await syncExchangeVolumes(app.db, {
        targets: [{
          provider: 'mock.volume',
          exchangeId: fixture.exchange_id,
        }],
        now: new Date('2026-05-05T00:43:00.000Z'),
        fetcher: vi.fn(async () => fixture),
      });

      expect(result).toMatchObject({
        targets_attempted: 1,
        points_fetched: 3,
        points_written: 3,
        source_fetched_at: '2026-05-05T00:43:00.000Z',
      });
      expect(app.db.db.select().from(exchangeVolumeSourcePoints)
        .where(eq(exchangeVolumeSourcePoints.exchangeId, 'binance'))
        .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          volumeBtc: 142500.25,
          sourceKind: 'live',
          sourceProvider: 'mock.volume',
        }),
      ]));

      const response = await app.inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart/range?from=1777852800&to=1778025600',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        [1777852800 * 1_000, 141000.5],
        [1777939200 * 1_000, 142500.25],
        [1778025600 * 1_000, 143750.75],
      ]);
    } finally {
      await app.close();
    }
  });
});
