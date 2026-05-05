import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { onchainTokenHolders } from '../src/db/schema';
import { runOnchainAnalyticsSyncJob } from '../src/jobs/sync-onchain-analytics';
import {
  createHttpOnchainAnalyticsFetcher,
  parseOnchainAnalyticsTargetConfig,
  syncOnchainAnalytics,
} from '../src/services/onchain-analytics-sync';
import type { RawOnchainAnalyticsReplay } from '../src/services/onchain-analytics-ingestion';

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/onchain-analytics/eth-usdc-token-analytics.json'),
    'utf8',
  )) as RawOnchainAnalyticsReplay;
}

describe('onchain analytics sync', () => {
  it('parses optional provider target mappings from environment syntax', () => {
    expect(parseOnchainAnalyticsTargetConfig(undefined)).toEqual([]);
    expect(parseOnchainAnalyticsTargetConfig('   ')).toEqual([]);
    expect(parseOnchainAnalyticsTargetConfig(
      'etherscan=ETH:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, eth:0xdAC17F958D2ee523a2206206994597C13D831ec7',
    )).toEqual([
      {
        provider: 'etherscan',
        networkId: 'eth',
        tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      },
      {
        provider: 'custom',
        networkId: 'eth',
        tokenAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      },
    ]);
    expect(() => parseOnchainAnalyticsTargetConfig('etherscan=eth')).toThrow(
      'Invalid onchain analytics target config entry',
    );
  });

  it('exits without opening a database when no onchain analytics targets are configured', async () => {
    await expect(runOnchainAnalyticsSyncJob({
      LOG_LEVEL: 'silent',
      ONCHAIN_ANALYTICS_TARGETS: '',
    })).resolves.toBeUndefined();
  });

  it('builds a provider-facing HTTP fetcher with stable target URL and defaults', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      captured_at: '2026-05-05T00:04:00.000Z',
      holders: [{ address: '0xholder900000000000000000000000000000000001', balance: '1', share_of_supply: '0.1' }],
    }), { status: 200 }));
    const fetcher = createHttpOnchainAnalyticsFetcher('https://analytics.example/', fetchImpl as unknown as typeof fetch);
    const response = await fetcher({
      provider: 'etherscan',
      networkId: 'eth',
      tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://analytics.example/providers/etherscan/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/analytics',
      expect.objectContaining({
        headers: { accept: 'application/json' },
      }),
    );
    expect(response).toMatchObject({
      provider: 'etherscan',
      network_id: 'eth',
      token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      holders: [expect.objectContaining({ balance: '1' })],
      traders: [],
      holders_chart: [],
    });
  });

  it('covers optional provider fetcher failure and no-data branches', async () => {
    expect(() => createHttpOnchainAnalyticsFetcher(undefined)).toThrow('ONCHAIN_ANALYTICS_BASE_URL is required');

    const notFoundFetcher = createHttpOnchainAnalyticsFetcher(
      'https://analytics.example',
      vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    );
    await expect(notFoundFetcher({
      provider: 'etherscan',
      networkId: 'eth',
      tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    })).resolves.toBeNull();

    const failedFetcher = createHttpOnchainAnalyticsFetcher(
      'https://analytics.example',
      vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(failedFetcher({
      provider: 'etherscan',
      networkId: 'eth',
      tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    })).rejects.toThrow('Onchain analytics provider request failed with status 500');

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      await expect(syncOnchainAnalytics(app.db, {
        targets: [{
          provider: 'mock.analytics',
          networkId: 'eth',
          tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        }],
        fetcher: vi.fn(async () => null),
        now: new Date('2026-05-05T00:06:00.000Z'),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        holders_fetched: 0,
        traders_fetched: 0,
        holder_counts_fetched: 0,
        holders_written: 0,
        traders_written: 0,
        holder_counts_written: 0,
        results: [
          expect.objectContaining({
            provider: 'mock.analytics',
            network_id: 'eth',
            token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          }),
        ],
      });

      await expect(syncOnchainAnalytics(app.db, {
        targets: [{
          provider: 'empty.analytics',
          networkId: 'eth',
          tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        }],
        fetcher: vi.fn(async () => ({
          provider: 'empty.analytics',
          captured_at: '2026-05-05T00:07:00.000Z',
          network_id: 'eth',
          token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        })),
      })).resolves.toMatchObject({
        targets_attempted: 1,
        holders_fetched: 0,
        traders_fetched: 0,
        holder_counts_fetched: 0,
        holders_written: 0,
        traders_written: 0,
        holder_counts_written: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('syncs mocked provider output into live source-attributed rows without changing route payload shape', async () => {
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

      const result = await syncOnchainAnalytics(app.db, {
        targets: [{
          provider: 'mock.analytics',
          networkId: fixture.network_id,
          tokenAddress: fixture.token_address,
        }],
        now: new Date('2026-05-05T00:05:00.000Z'),
        fetcher: vi.fn(async () => fixture),
      });

      expect(result).toMatchObject({
        targets_attempted: 1,
        holders_fetched: 2,
        traders_fetched: 2,
        holder_counts_fetched: 3,
        holders_written: 2,
        traders_written: 2,
        holder_counts_written: 3,
        source_fetched_at: '2026-05-05T00:05:00.000Z',
      });
      expect(app.db.db.select().from(onchainTokenHolders)
        .where(eq(onchainTokenHolders.tokenAddress, fixture.token_address))
        .all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceKind: 'live',
          sourceProvider: 'mock.analytics',
        }),
      ]));

      const holdersResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/tokens/${fixture.token_address}/top_holders?holders=1&include_pnl_details=true`,
      });
      const tradersResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/tokens/${fixture.token_address}/top_traders?traders=1&include_address_label=true`,
      });
      const holdersChartResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/tokens/${fixture.token_address}/holders_chart?days=30`,
      });

      expect(holdersResponse.json()).toMatchObject({
        data: [expect.objectContaining({
          type: 'holder',
          attributes: expect.objectContaining({ balance: '300000000' }),
        })],
        meta: {
          fixture: false,
          source: 'live',
          note: 'Holder data is source-attributed live provider data',
        },
      });
      expect(tradersResponse.json()).toMatchObject({
        data: [expect.objectContaining({
          type: 'trader',
          attributes: expect.objectContaining({ address_label: 'Replay Whale' }),
        })],
        meta: {
          fixture: false,
          source: 'live',
          note: 'Trader data is source-attributed live provider data',
        },
      });
      expect(holdersChartResponse.json()).toMatchObject({
        data: [
          expect.objectContaining({ type: 'holders_chart_point' }),
          expect.objectContaining({ type: 'holders_chart_point' }),
          expect.objectContaining({ type: 'holders_chart_point' }),
        ],
        meta: {
          fixture: false,
          source: 'live',
          note: 'Holders chart data is source-attributed live provider data',
        },
      });
    } finally {
      await app.close();
    }
  });
});
