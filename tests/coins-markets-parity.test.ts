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
      current_price: expect.any(Number),
      market_cap: expect.any(Number),
      market_cap_rank: 1,
      price_change_percentage_24h_in_currency: expect.any(Number),
      price_change_percentage_7d_in_currency: expect.any(Number),
      last_updated: expect.any(String),
    });
    expect(body[0].total_volume).toBeNull();

    expect(body[1]).toMatchObject({
      id: 'ethereum',
      current_price: expect.any(Number),
      market_cap: expect.any(Number),
      market_cap_rank: 2,
      price_change_percentage_24h_in_currency: expect.any(Number),
      price_change_percentage_7d_in_currency: expect.any(Number),
      last_updated: expect.any(String),
    });
    expect(body[1].total_volume).toBeNull();

    expect(body[2]).toMatchObject({
      id: 'solana',
      current_price: expect.any(Number),
      market_cap: expect.any(Number),
      market_cap_rank: 4,
      price_change_percentage_24h_in_currency: expect.any(Number),
      price_change_percentage_7d_in_currency: expect.any(Number),
      last_updated: expect.any(String),
    });
    expect(body[2].total_volume).toBeNull();
  });
});
