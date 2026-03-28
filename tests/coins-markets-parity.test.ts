import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';

describe('coins markets parity', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({
      config: {
        databaseUrl: './data/opengecko.db',
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('preserves canonical membership, ordering, and core market fields for the sampled assets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'ethereum', 'solana']);

    expect(body[0]).toMatchObject({
      id: 'bitcoin',
      current_price: null,
      market_cap: null,
      market_cap_rank: 1,
      price_change_percentage_24h_in_currency: expect.any(Number),
      price_change_percentage_7d_in_currency: expect.any(Number),
      last_updated: null,
    });
    expect(body[0].total_volume).toBeNull();

    expect(body[1]).toMatchObject({
      id: 'ethereum',
      current_price: null,
      market_cap: null,
      market_cap_rank: 2,
      price_change_percentage_24h_in_currency: expect.any(Number),
      price_change_percentage_7d_in_currency: expect.any(Number),
      last_updated: null,
    });
    expect(body[1].total_volume).toBeNull();

    expect(body[2]).toMatchObject({
      id: 'solana',
      current_price: null,
      market_cap: null,
      market_cap_rank: 7,
      price_change_percentage_24h_in_currency: expect.any(Number),
      price_change_percentage_7d_in_currency: expect.any(Number),
      last_updated: null,
    });
    expect(body[2].total_volume).toBeNull();
  });

  it('keeps sampled canonical market rows close to the stored upstream artifact for names, images, and populated market metadata', async () => {
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

    const response = await validationApp.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
    });

    try {
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body[0]).toMatchObject({
        id: 'bitcoin',
        name: 'BTC',
      image: expect.stringContaining('bitcoin'),
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        high_24h: expect.any(Number),
        low_24h: expect.any(Number),
        price_change_24h: expect.any(Number),
        price_change_percentage_24h: expect.any(Number),
        market_cap_change_24h: expect.any(Number),
        market_cap_change_percentage_24h: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        name: 'ETH',
      image: expect.stringContaining('ethereum'),
        roi: expect.objectContaining({
          currency: 'btc',
        }),
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        high_24h: expect.any(Number),
        low_24h: expect.any(Number),
        price_change_24h: expect.any(Number),
        price_change_percentage_24h: expect.any(Number),
        market_cap_change_24h: expect.any(Number),
        market_cap_change_percentage_24h: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[2]).toMatchObject({
        id: 'solana',
        name: 'SOL',
      image: expect.stringContaining('solana'),
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        high_24h: expect.any(Number),
        low_24h: expect.any(Number),
        market_cap_change_24h: expect.any(Number),
        market_cap_change_percentage_24h: expect.any(Number),
        last_updated: expect.any(String),
      });
    } finally {
      await validationApp.close();
    }
  });

  it('exposes canonical market rows from the default/local seeded bootstrap runtime', async () => {
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
        url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'ethereum', 'solana']);
      expect(body[0]).toMatchObject({
        id: 'bitcoin',
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[2]).toMatchObject({
        id: 'solana',
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        last_updated: expect.any(String),
      });
    } finally {
      await localApp.close();
    }
  });
});
