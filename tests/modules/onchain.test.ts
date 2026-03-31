import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app';
import * as defillamaProvider from '../../src/providers/defillama';
import { resetCurrencyApiSnapshotForTests } from '../../src/services/currency-rates';

vi.mock('../../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
  ]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

const defaultDefillamaMocks = () => {
  vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
  vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
};

describe('onchain pool discovery', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }
    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-discovery-'));
    vi.restoreAllMocks();
    resetCurrencyApiSnapshotForTests();
    defaultDefillamaMocks();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('includes discovered pools in the catalog alongside seeded pools', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'USDC-WETH',
          pool: 'seeded-usdc-weth',
          tvlUsd: 222000000,
          volumeUsd1d: 88000000,
          volumeUsd7d: 600000000,
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          ],
        },
        {
          chain: 'Ethereum',
          project: 'curve',
          symbol: 'FRAX-USDC',
          pool: 'discovered-frax-usdc',
          tvlUsd: 5000000,
          volumeUsd1d: 1200000,
          volumeUsd7d: null,
          underlyingTokens: [
            '0x853d955acef822db058eb8505911ed77f175b99e',
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          ],
        },
      ],
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      protocols: [{ name: 'uniswap-v3', total24h: 88000000, total7d: null, total30d: null, totalAllTime: null }],
      total24h: 88000000,
      total7d: null,
      total30d: null,
      totalAllTime: null,
    });

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.data_source).toBe('live');

    const poolAddresses = body.data.map((entry: { id: string }) => entry.id);

    expect(poolAddresses).toContain('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');

    const discoveredPool = body.data.find((entry: { attributes: { name: string } }) =>
      entry.attributes.name === 'FRAX-USDC',
    );
    expect(discoveredPool).toBeDefined();
    expect(discoveredPool!.attributes.reserve_usd).toBe(5000000);
    expect(discoveredPool!.attributes.volume_usd.h24).toBe(1200000);
  });

  it('does not duplicate pools that are already seeded', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'USDC-WETH',
          pool: 'seeded-usdc-weth',
          tvlUsd: 222000000,
          volumeUsd1d: 88000000,
          volumeUsd7d: null,
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          ],
        },
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'USDC-WETH-DUPE',
          pool: 'discovered-usdc-weth-dupe',
          tvlUsd: 1000000,
          volumeUsd1d: 500000,
          volumeUsd7d: null,
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          ],
        },
      ],
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      protocols: [{ name: 'uniswap-v3', total24h: 88000000, total7d: null, total30d: null, totalAllTime: null }],
      total24h: 88000000,
      total7d: null,
      total30d: null,
      totalAllTime: null,
    });

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const poolAddresses = body.data.map((entry: { id: string }) => entry.id);

    expect(poolAddresses).toContain('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');

    const duplicatePools = poolAddresses.filter((addr: string) =>
      addr !== '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'
      && addr !== '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7'
      && addr !== '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
    );
    expect(duplicatePools).toHaveLength(0);
  });

  it('handles null discovered pools gracefully', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'USDC-WETH',
          pool: 'seeded-usdc-weth',
          tvlUsd: 222000000,
          volumeUsd1d: 88000000,
          volumeUsd7d: null,
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          ],
        },
      ],
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      protocols: [{ name: 'uniswap-v3', total24h: 88000000, total7d: null, total30d: null, totalAllTime: null }],
      total24h: 88000000,
      total7d: null,
      total30d: null,
      totalAllTime: null,
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);
  });

  it('filters discovered pools by chain', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        {
          chain: 'Ethereum',
          project: 'aave-v3',
          symbol: 'ETH-POOL',
          pool: 'eth-pool-1',
          tvlUsd: 5000000,
          volumeUsd1d: 1000000,
          volumeUsd7d: null,
          underlyingTokens: [
            '0x6b175474e89094c44da98b954eedeac495271d0f',
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          ],
        },
        {
          chain: 'Arbitrum',
          project: 'aave-v3',
          symbol: 'ARB-POOL',
          pool: 'arb-pool-1',
          tvlUsd: 5000000,
          volumeUsd1d: 1000000,
          volumeUsd7d: null,
          underlyingTokens: [
            '0x6b175474e89094c44da98b954eedeac495271d0f',
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          ],
        },
      ],
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      protocols: [],
      total24h: null,
      total7d: null,
      total30d: null,
      totalAllTime: null,
    });

    const response = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const poolDexIds = body.data.map((entry: { relationships: { dex: { data: { id: string } } } }) => entry.relationships?.dex?.data?.id).filter(Boolean);

    expect(poolDexIds).toContain('aave_v3');
  });

  it('generates consistent addresses for the same discovered pool across catalog rebuilds', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue({
      protocols: [],
      pools: [
        {
          chain: 'Ethereum',
          project: 'aave-v3',
          symbol: 'DAI-USDC',
          pool: 'discovered-aave-dai-usdc',
          tvlUsd: 15000000,
          volumeUsd1d: 3000000,
          volumeUsd7d: null,
          underlyingTokens: [
            '0x6b175474e89094c44da98b954eedeac495271d0f',
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          ],
        },
      ],
    });
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue({
      protocols: [],
      total24h: null,
      total7d: null,
      total30d: null,
      totalAllTime: null,
    });

    const response1 = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });

    const body1 = response1.json();
    const discoveredPool1 = body1.data.find((entry: { attributes: { name: string } }) =>
      entry.attributes.name.includes('DAI') && entry.attributes.name.includes('USDC'),
    );

    const response2 = await getApp().inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?page=1',
    });

    const body2 = response2.json();
    const discoveredPool2 = body2.data.find((entry: { attributes: { name: string } }) =>
      entry.attributes.name.includes('DAI') && entry.attributes.name.includes('USDC'),
    );

    expect(discoveredPool1).toBeDefined();
    expect(discoveredPool2).toBeDefined();
    expect(discoveredPool1!.id).toBe(discoveredPool2!.id);
  });
});
