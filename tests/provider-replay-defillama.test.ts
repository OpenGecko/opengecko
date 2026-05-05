import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { onchainPoolOhlcv } from '../src/db/schema';
import * as defillamaProvider from '../src/providers/defillama';
import {
  ingestOnchainPoolOhlcvReplayBatch,
  normalizeOnchainPoolOhlcvReplayBatch,
  type RawOnchainPoolOhlcvReplay,
} from '../src/services/onchain-ohlcv-ingestion';

type DefillamaReplayFixture = {
  provider: string;
  captured_at: string;
  requests: {
    protocols: { body: unknown };
    pools: { body: unknown };
    dex_overview: { body: unknown };
  };
};

type DefillamaOhlcvReplayFixture = {
  provider: string;
  captured_at: string;
  network_id: string;
  pool_address: string;
  candles: RawOnchainPoolOhlcvReplay[];
};

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/defillama/ethereum-pools.json'),
    'utf8',
  )) as DefillamaReplayFixture;
}

function loadOhlcvFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/defillama/ethereum-pool-ohlcv.json'),
    'utf8',
  )) as DefillamaOhlcvReplayFixture;
}

function createReplayFetch(fixture: DefillamaReplayFixture) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.toString()
        : url.url;

    if (href.endsWith('/protocols')) {
      return new Response(JSON.stringify(fixture.requests.protocols.body), { status: 200 });
    }

    if (href.endsWith('/pools')) {
      return new Response(JSON.stringify(fixture.requests.pools.body), { status: 200 });
    }

    if (href.endsWith('/overview/dexs') || href.endsWith('/overview/dexs/Ethereum')) {
      return new Response(JSON.stringify(fixture.requests.dex_overview.body), { status: 200 });
    }

    return new Response(JSON.stringify({ error: 'unexpected replay request', url: href }), { status: 404 });
  });
}

describe('provider replay fixtures', () => {
  it('replays DeFiLlama raw pool responses through normalized provider rows and public onchain pool output', async () => {
    const fixture = loadFixture();
    const fetchMock = createReplayFetch(fixture);

    const [poolData, dexVolumes] = await Promise.all([
      defillamaProvider.fetchDefillamaPoolData({
        baseUrl: 'https://api.llama.fi',
        yieldsBaseUrl: 'https://yields.llama.fi',
        fetchImpl: fetchMock as typeof fetch,
      }),
      defillamaProvider.fetchDefillamaDexVolumes('Ethereum', {
        baseUrl: 'https://api.llama.fi',
        fetchImpl: fetchMock as typeof fetch,
      }),
    ]);

    expect(poolData).toEqual({
      protocols: [
        {
          id: '219',
          slug: 'uniswap-v3',
          name: 'Uniswap V3',
          category: 'Dexes',
          chains: ['Ethereum'],
          tvl: 4100000000,
        },
      ],
      pools: [
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'USDC-WETH',
          pool: 'eth-uniswap-v3-usdc-weth-005',
          tvlUsd: 400000000,
          volumeUsd1d: 80000000,
          volumeUsd7d: 500000000,
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          ],
        },
      ],
    });
    expect(dexVolumes).toMatchObject({
      protocols: [
        expect.objectContaining({
          name: 'uniswap-v3',
          total24h: 80000000,
          total7d: 500000000,
        }),
      ],
      total24h: 80000000,
      total7d: 500000000,
    });

    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(poolData);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(dexVolumes);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          type: 'pool',
          attributes: {
            name: 'USDC / WETH 0.05%',
            reserve_usd: 400000000,
            volume_usd: {
              h24: 80000000,
            },
            price_usd: 1.230769,
          },
        },
        meta: {
          data_source: 'live',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('replays source-attributed DeFiLlama pool OHLCV into public onchain OHLCV routes', async () => {
    const fixture = loadOhlcvFixture();
    const normalizedRows = normalizeOnchainPoolOhlcvReplayBatch(fixture.candles);

    expect(normalizedRows).toEqual([
      {
        networkId: 'eth',
        poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        timeframe: 'hour',
        aggregate: 1,
        timestamp: 1714741200,
        open: 1.0001,
        high: 1.0005,
        low: 0.9998,
        close: 1.0003,
        volumeUsd: 2450000.55,
      },
      {
        networkId: 'eth',
        poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        timeframe: 'hour',
        aggregate: 1,
        timestamp: 1714744800,
        open: 1.0003,
        high: 1.001,
        low: 1.0002,
        close: 1.0008,
        volumeUsd: 3100000.45,
      },
      {
        networkId: 'eth',
        poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        timeframe: 'hour',
        aggregate: 1,
        timestamp: 1714748400,
        open: 1.0008,
        high: 1.0012,
        low: 1.0004,
        close: 1.0006,
        volumeUsd: 2800000,
      },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();

      const ingestionOptions = {
        sourceProvider: `${fixture.provider}.pool_ohlcv`,
        sourceFetchedAt: new Date(fixture.captured_at),
      };
      expect(ingestOnchainPoolOhlcvReplayBatch(app.db, fixture.candles, ingestionOptions)).toEqual({
        candles_written: 3,
        pool_addresses: ['0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'],
        timeframes: ['hour'],
        source_kind: 'replay',
        source_provider: 'defillama.pool_ohlcv',
        source_fetched_at: '2026-05-05T00:02:00.000Z',
      });
      expect(ingestOnchainPoolOhlcvReplayBatch(app.db, fixture.candles, ingestionOptions)).toMatchObject({
        candles_written: 3,
        pool_addresses: ['0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'],
      });
      expect(app.db.db.select().from(onchainPoolOhlcv)
        .where(eq(onchainPoolOhlcv.poolAddress, fixture.pool_address))
        .all()).toHaveLength(3);

      const poolOhlcvResponse = await app.inject({
        method: 'GET',
        url: `/onchain/networks/${fixture.network_id}/pools/${fixture.pool_address}/ohlcv/hour`,
      });
      const tokenOhlcvResponse = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/ohlcv/hour?include_inactive_source=true',
      });
      const coverageMatrixResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/coverage_matrix',
      });

      expect(poolOhlcvResponse.statusCode).toBe(200);
      expect(poolOhlcvResponse.json()).toMatchObject({
        data: {
          id: `${fixture.network_id}:${fixture.pool_address}:hour`,
          type: 'ohlcv',
          attributes: {
            network: fixture.network_id,
            pool_address: fixture.pool_address,
            timeframe: 'hour',
            source: 'replay',
            ohlcv_list: [
              {
                timestamp: 1714741200,
                open: 1.0001,
                high: 1.0005,
                low: 0.9998,
                close: 1.0003,
                volume_usd: 2450000.55,
              },
              {
                timestamp: 1714744800,
                open: 1.0003,
                high: 1.001,
                low: 1.0002,
                close: 1.0008,
                volume_usd: 3100000.45,
              },
              {
                timestamp: 1714748400,
                open: 1.0008,
                high: 1.0012,
                low: 1.0004,
                close: 1.0006,
                volume_usd: 2800000,
              },
            ],
          },
        },
      });

      expect(tokenOhlcvResponse.statusCode).toBe(200);
      const tokenSeries = tokenOhlcvResponse.json().data.attributes.ohlcv_list;
      const replayTimestampPoint = tokenSeries.find((point: { timestamp: number }) => point.timestamp === 1714741200);
      expect(replayTimestampPoint).toEqual(expect.objectContaining({
        timestamp: 1714741200,
        volume_usd: expect.any(Number),
      }));
      expect(replayTimestampPoint.volume_usd).toBeGreaterThan(2450000.55);
      expect(tokenOhlcvResponse.json().data.attributes.source_pools).toContain(fixture.pool_address);

      expect(coverageMatrixResponse.statusCode).toBe(200);
      expect(coverageMatrixResponse.json().data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'onchain',
          ownership_class: 'hybrid',
          last_successful_refresh_at: '2026-05-05T00:02:00.000Z',
          evidence: expect.objectContaining({
            notes: expect.stringContaining('source-attributed replay/live rows'),
          }),
        }),
      ]));
    } finally {
      await app.close();
    }
  });
});
