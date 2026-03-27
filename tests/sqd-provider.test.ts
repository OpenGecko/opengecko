import { afterEach, describe, expect, it, vi } from 'vitest';

describe('sqd provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes uniswap v3 swap log words into normalized fields', async () => {
    const { decodeUniswapV3SwapLog } = await import('../src/providers/sqd');

    const encoded =
      '0x'
      + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0bdc0'
      + '00000000000000000000000000000000000000000000000000000000000181cd'
      + '0000000000000000000000000000000000000001000000000000000000000000'
      + '00000000000000000000000000000000000000000000000000000000000f4240'
      + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6';

    expect(decodeUniswapV3SwapLog(encoded)).toEqual({
      amount0: '-1000000',
      amount1: '98765',
      sqrtPriceX96: '79228162514264337593543950336',
      liquidity: '1000000',
      tick: -10,
    });
  });

  it('fetches swap logs across worker pages and normalizes them', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('105', { status: 200 }))
      .mockResolvedValueOnce(new Response('https://worker-1', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          header: { number: 102, timestamp: 1710000000 },
          logs: [
            {
              data: '0x'
                + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0bdc0'
                + '00000000000000000000000000000000000000000000000000000000000181cd'
                + '0000000000000000000000000000000000000001000000000000000000000000'
                + '00000000000000000000000000000000000000000000000000000000000f4240'
                + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6',
              transactionHash: '0xtx1',
            },
          ],
        },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response('https://worker-2', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          header: { number: 105, timestamp: 1710000300 },
          logs: [
            {
              data: '0x'
                + '00000000000000000000000000000000000000000000000000000000000003e8'
                + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0c'
                + '0000000000000000000000000000000000000001000000000000000000000001'
                + '0000000000000000000000000000000000000000000000000000000000001234'
                + '0000000000000000000000000000000000000000000000000000000000000005',
              transactionHash: '0xtx2',
            },
          ],
        },
      ]), { status: 200 }));

    const { fetchEthereumPoolSwapLogs } = await import('../src/providers/sqd');

    const result = await fetchEthereumPoolSwapLogs('0x88e6A0c2ddd26fce6b7c8F1ec5fef66F5f8f2b4B', {
      fetchImpl: fetchMock as typeof fetch,
      fromBlock: 100,
      toBlock: 105,
      requestDelayMs: 0,
    });

    expect(result).toEqual([
      {
        blockNumber: 102,
        blockTimestamp: 1710000000,
        txHash: '0xtx1',
        amount0: '-1000000',
        amount1: '98765',
        sqrtPriceX96: '79228162514264337593543950336',
        liquidity: '1000000',
        tick: -10,
      },
      {
        blockNumber: 105,
        blockTimestamp: 1710000300,
        txHash: '0xtx2',
        amount0: '1000',
        amount1: '-500',
        sqrtPriceX96: '79228162514264337593543950337',
        liquidity: '4660',
        tick: 5,
      },
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://v2.archive.subsquid.io/network/ethereum-mainnet/height', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://v2.archive.subsquid.io/network/ethereum-mainnet/100/worker', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://v2.archive.subsquid.io/network/ethereum-mainnet/103/worker', expect.objectContaining({ method: 'GET' }));
  });

  it('skips decoded logs that are missing a transaction hash', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('100', { status: 200 }))
      .mockResolvedValueOnce(new Response('https://worker-1', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          header: { number: 100, timestamp: 1710000000 },
          logs: [
            {
              data: '0x'
                + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0bdc0'
                + '00000000000000000000000000000000000000000000000000000000000181cd'
                + '0000000000000000000000000000000000000001000000000000000000000000'
                + '00000000000000000000000000000000000000000000000000000000000f4240'
                + 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6',
            },
          ],
        },
      ]), { status: 200 }));

    const { fetchEthereumPoolSwapLogs } = await import('../src/providers/sqd');

    await expect(fetchEthereumPoolSwapLogs('0xpool', {
      fetchImpl: fetchMock as typeof fetch,
      fromBlock: 100,
      toBlock: 100,
      requestDelayMs: 0,
    })).resolves.toEqual([]);
  });


  it('returns an empty list when dataset height is below the requested start block', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('99', { status: 200 }));
    const { fetchEthereumPoolSwapLogs } = await import('../src/providers/sqd');

    await expect(fetchEthereumPoolSwapLogs('0xpool', {
      fetchImpl: fetchMock as typeof fetch,
      fromBlock: 100,
    })).resolves.toEqual([]);
  });

  it('returns null when SQD height lookup yields an invalid worker endpoint URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('100', { status: 200 }))
      .mockResolvedValueOnce(new Response('not-a-url', { status: 200 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchEthereumPoolSwapLogs } = await import('../src/providers/sqd');

    await expect(fetchEthereumPoolSwapLogs('0xpool', {
      fetchImpl: fetchMock as typeof fetch,
      fromBlock: 100,
      toBlock: 100,
      requestDelayMs: 0,
    })).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledOnce();
  });


  it('returns null and logs when the provider degrades or rate-limits repeatedly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', {
      status: 429,
      headers: { 'retry-after': '0' },
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchEthereumPoolSwapLogs } = await import('../src/providers/sqd');

    await expect(fetchEthereumPoolSwapLogs('0xpool', {
      fetchImpl: fetchMock as typeof fetch,
      fromBlock: 100,
      maxRetries: 2,
    })).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
