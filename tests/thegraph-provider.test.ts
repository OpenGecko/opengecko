import { afterEach, describe, expect, it, vi } from 'vitest';

describe('thegraph provider', () => {
  const originalApiKey = process.env.THEGRAPH_API_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalApiKey === undefined) {
      delete process.env.THEGRAPH_API_KEY;
    } else {
      process.env.THEGRAPH_API_KEY = originalApiKey;
    }
  });

  it('returns null for all requests when THEGRAPH_API_KEY is missing', async () => {
    const fetchMock = vi.fn();

    const {
      fetchUniswapV3PoolDetails,
      fetchUniswapV3PoolSwaps,
      fetchUniswapV3PoolSnapshots,
    } = await import('../src/providers/thegraph');

    await expect(fetchUniswapV3PoolDetails('0xpool', { fetchImpl: fetchMock as typeof fetch })).resolves.toBeNull();
    await expect(fetchUniswapV3PoolSwaps('0xpool', 10, { fetchImpl: fetchMock as typeof fetch })).resolves.toBeNull();
    await expect(fetchUniswapV3PoolSnapshots('0xpool', 5, { fetchImpl: fetchMock as typeof fetch })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches pool details from the configured subgraph endpoint', async () => {
    process.env.THEGRAPH_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        pool: {
          id: '0xpool',
          feeTier: '500',
          liquidity: '1000',
          sqrtPrice: '123',
          tick: '42',
          token0: { id: '0xa', symbol: 'USDC', decimals: '6' },
          token1: { id: '0xb', symbol: 'WETH', decimals: '18' },
        },
      },
    }), { status: 200 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { fetchUniswapV3PoolDetails } = await import('../src/providers/thegraph');

    const result = await fetchUniswapV3PoolDetails('0xPool', { fetchImpl: fetchMock as typeof fetch });

    expect(result).toEqual({
      id: '0xpool',
      feeTier: '500',
      liquidity: '1000',
      sqrtPrice: '123',
      tick: '42',
      token0: { id: '0xa', symbol: 'USDC', decimals: 6 },
      token1: { id: '0xb', symbol: 'WETH', decimals: 18 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.thegraph.com/api/test-key/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          accept: 'application/json',
          'content-type': 'application/json',
        }),
      }),
    );

    const request = fetchMock.mock.calls[0]?.[1];
    expect(typeof request?.body).toBe('string');
    expect(JSON.parse(request?.body as string)).toEqual({
      query: expect.stringContaining('query PoolDetails'),
      variables: { poolId: '0xpool' },
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('fetches recent swaps and normalizes timestamps and nested transaction data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        swaps: [
          {
            id: 'swap-1',
            amount0: '-1.2',
            amount1: '0.0004',
            amountUSD: '1200.5',
            timestamp: '1710000000',
            sender: '0xsender',
            recipient: '0xrecipient',
            transaction: {
              id: '0xtx',
              blockNumber: '12345',
            },
            token0: { id: '0xa', symbol: 'USDC', decimals: '6' },
            token1: { id: '0xb', symbol: 'WETH', decimals: '18' },
          },
        ],
      },
    }), { status: 200 }));

    const { fetchUniswapV3PoolSwaps, getUniswapV3PoolSwapsQuery } = await import('../src/providers/thegraph');

    const result = await fetchUniswapV3PoolSwaps('0xPool', 25, {
      apiKey: 'inline-key',
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toEqual([
      {
        id: 'swap-1',
        amount0: '-1.2',
        amount1: '0.0004',
        amountUSD: '1200.5',
        timestamp: 1710000000,
        sender: '0xsender',
        recipient: '0xrecipient',
        transaction: {
          id: '0xtx',
          blockNumber: '12345',
        },
        token0: { id: '0xa', symbol: 'USDC', decimals: 6 },
        token1: { id: '0xb', symbol: 'WETH', decimals: 18 },
      },
    ]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(request?.body as string)).toEqual({
      query: getUniswapV3PoolSwapsQuery(),
      variables: { poolId: '0xpool', first: 25 },
    });
  });

  it('keeps the exported swap query in lockstep with normalized swap fields', async () => {
    const { getUniswapV3PoolSwapsQuery } = await import('../src/providers/thegraph');

    expect(getUniswapV3PoolSwapsQuery()).toContain('id');
    expect(getUniswapV3PoolSwapsQuery()).toContain('amount0');
    expect(getUniswapV3PoolSwapsQuery()).toContain('amount1');
    expect(getUniswapV3PoolSwapsQuery()).toContain('amountUSD');
    expect(getUniswapV3PoolSwapsQuery()).toContain('timestamp');
    expect(getUniswapV3PoolSwapsQuery()).toContain('sender');
    expect(getUniswapV3PoolSwapsQuery()).toContain('recipient');
    expect(getUniswapV3PoolSwapsQuery()).toContain('transaction {');
    expect(getUniswapV3PoolSwapsQuery()).toContain('blockNumber');
    expect(getUniswapV3PoolSwapsQuery()).toContain('token0 {');
    expect(getUniswapV3PoolSwapsQuery()).toContain('token1 {');
    expect(getUniswapV3PoolSwapsQuery()).toContain('symbol');
    expect(getUniswapV3PoolSwapsQuery()).toContain('decimals');
  });

  it('fetches pool day snapshots for liquidity and volume data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        poolDayDatas: [
          {
            date: 1710000000,
            liquidity: '1000',
            sqrtPrice: '200',
            token0Price: '1',
            token1Price: '3500',
            volumeToken0: '100',
            volumeToken1: '0.03',
            volumeUSD: '50000',
            tvlUSD: '250000',
          },
        ],
      },
    }), { status: 200 }));

    const { fetchUniswapV3PoolSnapshots } = await import('../src/providers/thegraph');

    const result = await fetchUniswapV3PoolSnapshots('0xPool', 7, {
      apiKey: 'snapshot-key',
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toEqual([
      {
        date: 1710000000,
        liquidity: '1000',
        sqrtPrice: '200',
        token0Price: '1',
        token1Price: '3500',
        volumeToken0: '100',
        volumeToken1: '0.03',
        volumeUSD: '50000',
        tvlUSD: '250000',
      },
    ]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(request?.body as string)).toEqual({
      query: expect.stringContaining('query PoolSnapshots'),
      variables: { poolId: '0xpool', first: 7 },
    });
  });

  it('returns null and logs when the graph responds with errors or http failures', async () => {
    process.env.THEGRAPH_API_KEY = 'error-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ message: 'subgraph unavailable' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const {
      fetchUniswapV3PoolDetails,
      fetchUniswapV3PoolSwaps,
    } = await import('../src/providers/thegraph');

    await expect(fetchUniswapV3PoolDetails('0xpool', { fetchImpl: fetchMock as typeof fetch })).resolves.toBeNull();
    await expect(fetchUniswapV3PoolSwaps('0xpool', 10, { fetchImpl: fetchMock as typeof fetch })).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
