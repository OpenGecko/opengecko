import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { resetCurrencyApiSnapshotForTests } from '../src/services/currency-rates';

const { fetchEthereumPoolSwapLogsMock } = vi.hoisted(() => ({
  fetchEthereumPoolSwapLogsMock: vi.fn(),
}));

vi.mock('../src/providers/sqd', () => ({
  fetchEthereumPoolSwapLogs: fetchEthereumPoolSwapLogsMock,
  resolveAddressLabel: () => null,
}));

describe('onchain token trades timeout safety', () => {
  it('serves token trades from persisted or fixture data without waiting on live upstream trade fetches', async () => {
    const previousVitestFlag = process.env.VITEST;
    process.env.VITEST = 'false';
    resetCurrencyApiSnapshotForTests();
    fetchEthereumPoolSwapLogsMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return null;
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

      const startedAt = Date.now();
      const response = await app.inject({
        method: 'GET',
        url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades?limit=5',
      });
      const durationMs = Date.now() - startedAt;

      expect(response.statusCode).toBe(200);
      expect(durationMs).toBeLessThan(250);
      expect(fetchEthereumPoolSwapLogsMock).not.toHaveBeenCalled();
      const body = response.json();
      expect(body.data[0]).toEqual(expect.objectContaining({
        type: 'trade',
        attributes: expect.objectContaining({
          tx_hash: expect.any(String),
          block_timestamp: expect.any(Number),
          volume_in_usd: expect.any(String),
        }),
      }));
      expect(body).toMatchObject({
        meta: expect.objectContaining({
          network: 'eth',
          token_address: expect.any(String),
          source: expect.any(String),
          fixture: expect.any(Boolean),
          updated_at: null,
        }),
      });
    } finally {
      await app.close();
      if (previousVitestFlag === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitestFlag;
      }
      fetchEthereumPoolSwapLogsMock.mockReset();
    }
  });
});
