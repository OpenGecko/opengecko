import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

describe('coin detail parity', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps the high-value bitcoin market_data subset populated for the canonical detail request after runtime seeding imports the persisted corpus', async () => {
    const validationApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        host: '127.0.0.1',
        port: 3102,
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const response = await validationApp.inject({
        method: 'GET',
        url: '/coins/bitcoin?community_data=false&developer_data=false&localization=false&market_data=true&sparkline=false&tickers=false',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.id).toBe('bitcoin');
      expect(body.market_cap_rank).toBe(1);
      expect(body.market_data).toMatchObject({
        current_price: { usd: expect.any(Number) },
        market_cap: { usd: expect.any(Number) },
        total_volume: { usd: expect.any(Number) },
        price_change_percentage_24h: expect.any(Number),
        price_change_percentage_7d: expect.any(Number),
        last_updated: expect.any(String),
        market_cap_rank: 1,
      });
    } finally {
      await validationApp.close();
    }
  });

  it('keeps the high-value bitcoin market_data subset populated on the default/local seeded bootstrap runtime', async () => {
    const localApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        host: '0.0.0.0',
        port: 3000,
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const response = await localApp.inject({
        method: 'GET',
        url: '/coins/bitcoin?community_data=false&developer_data=false&localization=false&market_data=true&sparkline=false&tickers=false',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.id).toBe('bitcoin');
      expect(body.market_cap_rank).toBe(1);
      expect(body.market_data).toMatchObject({
        current_price: { usd: expect.any(Number) },
        market_cap: { usd: expect.any(Number) },
        total_volume: { usd: expect.any(Number) },
        price_change_percentage_24h: expect.any(Number),
        price_change_percentage_7d: expect.any(Number),
        last_updated: expect.any(String),
        market_cap_rank: 1,
      });
    } finally {
      await localApp.close();
    }
  });
});
