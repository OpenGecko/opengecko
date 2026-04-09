import { afterEach, describe, expect, it, vi } from 'vitest';

describe('defillama provider', () => {
  const originalBaseUrl = process.env.DEFILLAMA_BASE_URL;
  const originalYieldsBaseUrl = process.env.DEFILLAMA_YIELDS_BASE_URL;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalBaseUrl === undefined) {
      delete process.env.DEFILLAMA_BASE_URL;
    } else {
      process.env.DEFILLAMA_BASE_URL = originalBaseUrl;
    }

    if (originalYieldsBaseUrl === undefined) {
      delete process.env.DEFILLAMA_YIELDS_BASE_URL;
    } else {
      process.env.DEFILLAMA_YIELDS_BASE_URL = originalYieldsBaseUrl;
    }

    const module = await import('../src/providers/defillama');
    module.clearDefillamaTokensCache();
  });

  it('fetches protocol and pool data from split configured hosts', async () => {
    process.env.DEFILLAMA_BASE_URL = 'https://defillama.example';
    process.env.DEFILLAMA_YIELDS_BASE_URL = 'https://yields.defillama.example';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            chain: 'Ethereum',
            project: 'uniswap-v3',
            symbol: 'USDC-WETH',
            pool: 'live-usdc-weth',
            tvlUsd: 123456789,
            volumeUsd1d: 22222222,
            underlyingTokens: [
              '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            ],
          },
          {
            chain: 'Ethereum',
            project: 'curve',
            symbol: 'USDC-USDT',
            pool: 'live-usdc-usdt',
            tvlUsd: 98765432,
            volumeUsd1d: 33333333,
            underlyingTokens: [
              '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              '0xdac17f958d2ee523a2206206994597c13d831ec7',
            ],
          },
        ],
      }), { status: 200 }));
    const { fetchDefillamaPoolData } = await import('../src/providers/defillama');

    const result = await fetchDefillamaPoolData({ fetchImpl: fetchMock as typeof fetch });

    expect(result).toEqual({
      protocols: [],
      pools: [
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'USDC-WETH',
          pool: 'live-usdc-weth',
          tvlUsd: 123456789,
          volumeUsd1d: 22222222,
          volumeUsd7d: null,
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          ],
        },
        {
          chain: 'Ethereum',
          project: 'curve',
          symbol: 'USDC-USDT',
          pool: 'live-usdc-usdt',
          tvlUsd: 98765432,
          volumeUsd1d: 33333333,
          volumeUsd7d: null,
          underlyingTokens: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0xdac17f958d2ee523a2206206994597c13d831ec7',
          ],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://defillama.example/protocols', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://yields.defillama.example/pools', expect.any(Object));
  });

  it('returns null and logs when the split yields host request fails', async () => {
    process.env.DEFILLAMA_BASE_URL = 'https://defillama.example';
    process.env.DEFILLAMA_YIELDS_BASE_URL = 'https://yields.defillama.example';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 'uniswap', slug: 'uniswap', name: 'Uniswap', category: 'Dexes', chains: ['Ethereum'], tvl: 1234 },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { fetchDefillamaPoolData } = await import('../src/providers/defillama');

    const result = await fetchDefillamaPoolData({ fetchImpl: fetchMock as typeof fetch });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://yields.defillama.example/pools', expect.any(Object));
  });

  it('fetches token prices and URL-encodes coin identifiers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      coins: {
        'ethereum:0xa0b8': { price: 1, symbol: 'USDC', decimals: 6, confidence: 0.99, timestamp: 123 },
      },
    }), { status: 200 }));

    const { fetchDefillamaTokenPrices } = await import('../src/providers/defillama');

    const result = await fetchDefillamaTokenPrices(['ethereum:0xa0b8'], {
      baseUrl: 'https://api.llama.fi/',
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toEqual({
      'ethereum:0xa0b8': { price: 1, symbol: 'USDC', decimals: 6, confidence: 0.99, timestamp: 123 },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.llama.fi/prices/current/ethereum%3A0xa0b8', expect.any(Object));
  });

  it('returns an empty price map when no token identifiers are provided', async () => {
    const fetchMock = vi.fn();

    const { fetchDefillamaTokenPrices } = await import('../src/providers/defillama');

    const result = await fetchDefillamaTokenPrices([], { fetchImpl: fetchMock as typeof fetch });

    expect(result).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches dex overview aggregates and sums totals', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      protocols: [
        { name: 'uniswap', chains: ['Ethereum'], total24h: 10, total7d: 70, total30d: 300, totalAllTime: 1000, change_1d: 1 },
        { name: 'curve', chains: ['Ethereum'], total24h: 20, total7d: 140, total30d: 600, totalAllTime: 2000, change_1d: -1 },
      ],
    }), { status: 200 }));

    const { fetchDefillamaDexVolumes } = await import('../src/providers/defillama');

    const result = await fetchDefillamaDexVolumes('Ethereum', {
      baseUrl: 'https://api.llama.fi',
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toEqual({
      protocols: [
        { name: 'uniswap', displayName: undefined, disabled: undefined, chains: ['Ethereum'], total24h: 10, total48hto24h: null, total7d: 70, total30d: 300, totalAllTime: 1000, change_1d: 1, change_7d: null, change_1m: null },
        { name: 'curve', displayName: undefined, disabled: undefined, chains: ['Ethereum'], total24h: 20, total48hto24h: null, total7d: 140, total30d: 600, totalAllTime: 2000, change_1d: -1, change_7d: null, change_1m: null },
      ],
      total24h: 30,
      total7d: 210,
      total30d: 900,
      totalAllTime: 3000,
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.llama.fi/overview/dexs/Ethereum', expect.any(Object));
  });

  it('defaults protocol discovery to api.llama.fi and pool discovery to the public yields host when no overrides are set', async () => {
    delete process.env.DEFILLAMA_BASE_URL;
    delete process.env.DEFILLAMA_YIELDS_BASE_URL;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const { fetchDefillamaPoolData } = await import('../src/providers/defillama');

    const result = await fetchDefillamaPoolData({ fetchImpl: fetchMock as typeof fetch });

    expect(result).toEqual({
      protocols: [],
      pools: [],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.llama.fi/protocols', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://yields.llama.fi/pools', expect.any(Object));
  });

  it('returns null and logs through the structured logger when a request fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));

    const { fetchDefillamaPoolData, fetchDefillamaTokenPrices, fetchDefillamaDexVolumes } = await import('../src/providers/defillama');

    await expect(fetchDefillamaPoolData({ fetchImpl: fetchMock as typeof fetch })).resolves.toBeNull();
    await expect(fetchDefillamaTokenPrices(['ethereum:0xa0b8'], { fetchImpl: fetchMock as typeof fetch })).resolves.toBeNull();
    await expect(fetchDefillamaDexVolumes(undefined, { fetchImpl: fetchMock as typeof fetch })).resolves.toBeNull();
  });

  it('fetches discovered pools filtered by chain and minimum TVL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'DAI-USDC',
          pool: 'discovered-dai-usdc',
          tvlUsd: 5_000_000,
          volumeUsd1d: 1_000_000,
          underlyingTokens: [
            '0x6b175474e89094c44da98b954eedeac495271d0f',
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          ],
        },
        {
          chain: 'Ethereum',
          project: 'curve',
          symbol: 'FRAX-USDC',
          pool: 'discovered-frax-usdc',
          tvlUsd: 50_000,
          volumeUsd1d: 10_000,
          underlyingTokens: [
            '0x853d955acef822db058eb8505911ed77f175b99e',
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          ],
        },
        {
          chain: 'Arbitrum',
          project: 'gmx',
          symbol: 'ETH-USDC',
          pool: 'discovered-gmx-eth',
          tvlUsd: 2_000_000,
          volumeUsd1d: 500_000,
          underlyingTokens: [
            '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
            '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
          ],
        },
        {
          chain: 'Ethereum',
          project: 'sushiswap',
          symbol: 'LOW-TVL',
          pool: 'discovered-low-tvl',
          tvlUsd: 5_000,
          volumeUsd1d: 1_000,
          underlyingTokens: [
            '0x1111111111111111111111111111111111111111',
            '0x2222222222222222222222222222222222222222',
          ],
        },
      ],
    }), { status: 200 }));

    const { fetchDefillamaDiscoveredPools } = await import('../src/providers/defillama');

    const result = await fetchDefillamaDiscoveredPools('Ethereum', { fetchImpl: fetchMock as typeof fetch });

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      chain: 'Ethereum',
      project: 'uniswap-v3',
      symbol: 'DAI-USDC',
      pool: 'discovered-dai-usdc',
      tvlUsd: 5_000_000,
      volumeUsd1d: 1_000_000,
    });
  });

  it('returns null when discovered pools request fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }));
    const { fetchDefillamaDiscoveredPools } = await import('../src/providers/defillama');

    const result = await fetchDefillamaDiscoveredPools('Ethereum', { fetchImpl: fetchMock as typeof fetch });

    expect(result).toBeNull();
  });

  it('returns discovered pools without chain filter when chain is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        {
          chain: 'Ethereum',
          project: 'uniswap-v3',
          symbol: 'ETH-USDC',
          pool: 'discovered-eth-usdc',
          tvlUsd: 1_000_000,
          volumeUsd1d: 200_000,
          underlyingTokens: [
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          ],
        },
        {
          chain: 'BSC',
          project: 'pancakeswap',
          symbol: 'BNB-USDT',
          pool: 'discovered-bnb-usdt',
          tvlUsd: 3_000_000,
          volumeUsd1d: 800_000,
          underlyingTokens: [
            '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
            '0x55d398326f99059ff775485246999027b3197955',
          ],
        },
      ],
    }), { status: 200 }));

    const { fetchDefillamaDiscoveredPools } = await import('../src/providers/defillama');

    const result = await fetchDefillamaDiscoveredPools(undefined, { fetchImpl: fetchMock as typeof fetch });

    expect(result).toHaveLength(2);
  });
});
