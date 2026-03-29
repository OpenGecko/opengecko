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

  it('preserves canonical membership, ordering, and core market fields for the sampled assets', { timeout: 30000 }, async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'ethereum', 'solana']);

    expect(body[0]).toMatchObject({
      id: 'bitcoin',
      name: 'Bitcoin',
      image: expect.stringContaining('bitcoin'),
      current_price: null,
      market_cap: null,
      market_cap_rank: 1,
      total_volume: null,
      last_updated: null,
    });
    expect(body[0].price_change_percentage_24h_in_currency).toBeNull();
    expect(body[0].price_change_percentage_7d_in_currency).toBeNull();
    expect(body[0].high_24h).toBeGreaterThan(100000);
    expect(body[0].low_24h).toBeLessThan(70000);

    expect(body[1]).toMatchObject({
      id: 'ethereum',
      name: 'Ethereum',
      image: expect.stringContaining('ethereum'),
      current_price: null,
      market_cap: null,
      market_cap_rank: 2,
      total_volume: null,
      last_updated: null,
    });
    expect(body[1].price_change_percentage_24h_in_currency).toBeNull();
    expect(body[1].price_change_percentage_7d_in_currency).toBeNull();

    expect(body[2]).toMatchObject({
      id: 'solana',
      name: 'Solana',
      image: expect.stringContaining('solana'),
      current_price: null,
      market_cap: null,
      market_cap_rank: expect.any(Number),
      total_volume: null,
      last_updated: null,
    });
    expect(body[2].market_cap_rank).toBeGreaterThan(0);
    expect(body[2].market_cap_rank).toBeLessThan(10);
    expect(body[2].price_change_percentage_24h_in_currency).toBeNull();
    expect(body[2].price_change_percentage_7d_in_currency).toBeNull();
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
        name: 'Bitcoin',
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
      expect(body[0].price_change_percentage_24h_in_currency).toBeCloseTo(body[0].price_change_percentage_24h, 10);
      expect(body[0].price_change_percentage_7d_in_currency).toBeNull();
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        name: 'Ethereum',
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
      expect(body[1].price_change_percentage_24h_in_currency).toBeCloseTo(body[1].price_change_percentage_24h, 10);
      expect(body[1].price_change_percentage_7d_in_currency).toBeNull();
      expect(body[2]).toMatchObject({
        id: 'solana',
        name: 'Solana',
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
      expect(body[2].price_change_percentage_24h_in_currency).toBeCloseTo(body[2].price_change_percentage_24h, 10);
      expect(body[2].price_change_percentage_7d_in_currency).toBeNull();
    } finally {
      await validationApp.close();
    }
  });

  it('preserves imported live snapshot ownership during seeded bootstrap serialization', async () => {
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
      const [marketsResponse, diagnosticsResponse] = await Promise.all([
        validationApp.inject({
          method: 'GET',
          url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
        }),
        validationApp.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        }),
      ]);

      expect(marketsResponse.statusCode).toBe(200);
      const body = marketsResponse.json();

      expect(body[0]).toMatchObject({
        id: 'bitcoin',
        name: 'Bitcoin',
        image: expect.stringContaining('bitcoin'),
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        price_change_24h: expect.any(Number),
        price_change_percentage_24h: expect.any(Number),
        market_cap_change_24h: expect.any(Number),
        market_cap_change_percentage_24h: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        name: 'Ethereum',
        image: expect.stringContaining('ethereum'),
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        price_change_24h: expect.any(Number),
        price_change_percentage_24h: expect.any(Number),
        market_cap_change_24h: expect.any(Number),
        market_cap_change_percentage_24h: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[2]).toMatchObject({
        id: 'solana',
        name: 'Solana',
        image: expect.stringContaining('solana'),
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        market_cap_change_24h: expect.any(Number),
        market_cap_change_percentage_24h: expect.any(Number),
        last_updated: expect.any(String),
      });

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data).toMatchObject({
        readiness: {
          state: 'starting',
          initial_sync_completed: false,
        },
        degraded: {
          active: false,
          validation_override: {
            active: true,
            mode: 'seeded_bootstrap',
            reason: 'validation runtime seeded from persistent live snapshots',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'seeded_bootstrap',
            provider_count: expect.any(Number),
          },
        },
      });
      expect(diagnosticsResponse.json().data.hot_paths.shared_market_snapshot.provider_count).toBeGreaterThan(0);
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
