import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { coinHistorySnapshots } from '../src/db/schema';
import { runCoinHistorySyncJob } from '../src/jobs/sync-coin-history';
import {
  createHttpCoinHistoryFetcher,
  parseCoinHistoryTargetConfig,
  syncCoinHistorySnapshots,
} from '../src/services/coin-history-sync';
import {
  ingestCoinHistoryReplay,
  type RawCoinHistoryReplay,
} from '../src/services/coin-history-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/coin-history/bitcoin-2026-03-20.json'),
    'utf8',
  )) as RawCoinHistoryReplay;
}

describe('coin history sync', () => {
  it('parses optional provider coin/date mappings from environment syntax', () => {
    expect(parseCoinHistoryTargetConfig(undefined)).toEqual([]);
    expect(parseCoinHistoryTargetConfig('   ')).toEqual([]);
    expect(parseCoinHistoryTargetConfig('mock.history=Bitcoin:2026-03-20, ethereum:2026-03-21')).toEqual([
      {
        provider: 'mock.history',
        coinId: 'bitcoin',
        date: '2026-03-20',
      },
      {
        provider: 'custom',
        coinId: 'ethereum',
        date: '2026-03-21',
      },
    ]);
    expect(() => parseCoinHistoryTargetConfig('mock.history=bitcoin')).toThrow(
      'Invalid coin history target config entry',
    );
    expect(() => parseCoinHistoryTargetConfig('mock.history=bitcoin:20-03-2026')).toThrow(
      'Invalid coin history target config entry',
    );
  });

  it('exits without opening a database when no coin history targets are configured', async () => {
    await expect(runCoinHistorySyncJob({
      LOG_LEVEL: 'silent',
      COIN_HISTORY_TARGETS: '',
    })).resolves.toBeUndefined();
  });

  it('builds a provider-facing HTTP fetcher with stable target URL and defaults', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      captured_at: '2026-05-05T00:50:00.000Z',
      market_data: {
        current_price: '92000',
      },
    }), { status: 200 }));
    const fetcher = createHttpCoinHistoryFetcher('https://history.example/', fetchImpl as unknown as typeof fetch);
    const response = await fetcher({
      provider: 'mock.history',
      coinId: 'bitcoin',
      date: '2026-03-20',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://history.example/providers/mock.history/coins/bitcoin/history?date=2026-03-20',
      expect.objectContaining({
        headers: { accept: 'application/json' },
      }),
    );
    expect(response).toMatchObject({
      provider: 'mock.history',
      coin_id: 'bitcoin',
      date: '2026-03-20',
      market_data: {
        current_price: '92000',
      },
    });
  });

  it('covers optional provider fetcher failure and no-data branches', async () => {
    expect(() => createHttpCoinHistoryFetcher(undefined)).toThrow('COIN_HISTORY_BASE_URL is required');

    const notFoundFetcher = createHttpCoinHistoryFetcher(
      'https://history.example',
      vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    );
    await expect(notFoundFetcher({
      provider: 'mock.history',
      coinId: 'bitcoin',
      date: '2026-03-20',
    })).resolves.toBeNull();

    const emptyFetcher = createHttpCoinHistoryFetcher(
      'https://history.example',
      vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    );
    await expect(emptyFetcher({
      provider: 'mock.history',
      coinId: 'bitcoin',
      date: '2026-03-20',
    })).resolves.toBeNull();

    const failedFetcher = createHttpCoinHistoryFetcher(
      'https://history.example',
      vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(failedFetcher({
      provider: 'mock.history',
      coinId: 'bitcoin',
      date: '2026-03-20',
    })).rejects.toThrow('Coin history provider request failed with status 500');

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      await expect(syncCoinHistorySnapshots(app.db, {
        targets: [{
          provider: 'mock.history',
          coinId: 'bitcoin',
          date: '2026-03-20',
        }],
        fetcher: vi.fn(async () => null),
        now: new Date('2026-05-05T00:51:00.000Z'),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        snapshots_fetched: 0,
        snapshots_written: 0,
        results: [
          expect.objectContaining({
            provider: 'mock.history',
            coin_id: 'bitcoin',
            date: '2026-03-20',
          }),
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('syncs mocked provider output into live source-attributed rows without changing history shape', async () => {
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

      const result = await syncCoinHistorySnapshots(app.db, {
        targets: [{
          provider: 'mock.history',
          coinId: fixture.coin_id,
          date: fixture.date,
        }],
        now: new Date('2026-05-05T00:52:00.000Z'),
        fetcher: vi.fn(async () => ({
          ...fixture,
          provider: 'mock.history',
          market_data: {
            ...fixture.market_data,
            current_price: 100001,
          },
        })),
      });

      expect(result).toMatchObject({
        targets_attempted: 1,
        snapshots_fetched: 1,
        snapshots_written: 1,
        source_fetched_at: '2026-05-05T00:52:00.000Z',
      });
      expect(app.db.db.select().from(coinHistorySnapshots)
        .where(eq(coinHistorySnapshots.coinId, 'bitcoin'))
        .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          price: 100001,
          sourceKind: 'live',
          sourceProvider: 'mock.history',
        }),
      ]));

      const response = await app.inject({
        method: 'GET',
        url: '/coins/bitcoin/history?date=20-03-2026&localization=false',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: 'bitcoin',
        market_data: {
          current_price: {
            usd: 100001,
          },
          market_cap: {
            usd: 1812345678901,
          },
        },
      });
      expect(response.json()).not.toHaveProperty('source_kind');
      expect(response.json().market_data).not.toHaveProperty('source_kind');
    } finally {
      await app.close();
    }
  });
});
