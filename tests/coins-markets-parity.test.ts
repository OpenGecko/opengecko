import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';

describe('coins markets parity', () => {
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
      market_cap_rank: 1,
    });
    expect(body[0].current_price).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[0].market_cap).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[0].total_volume).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[0].last_updated).toSatisfy((value: string | null) => value === null || typeof value === 'string');
    expect(body[0].price_change_percentage_24h_in_currency).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[0].price_change_percentage_7d_in_currency).toBeNull();
    expect(body[0].high_24h).toBeGreaterThan(body[0].current_price);
    expect(body[0].low_24h).toBeLessThan(body[0].current_price);

    expect(body[1]).toMatchObject({
      id: 'ethereum',
      name: 'Ethereum',
      image: expect.stringContaining('ethereum'),
      market_cap_rank: 2,
    });
    expect(body[1].current_price).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[1].market_cap).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[1].total_volume).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[1].last_updated).toSatisfy((value: string | null) => value === null || typeof value === 'string');
    expect(body[1].price_change_percentage_24h_in_currency).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[1].price_change_percentage_7d_in_currency).toBeNull();

    expect(body[2]).toMatchObject({
      id: 'solana',
      name: 'Solana',
      image: expect.stringContaining('solana'),
    });
    expect(body[2].market_cap_rank).toSatisfy((value: number | null) => typeof value === 'number' && value > 0);
    expect(body[2].current_price).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[2].market_cap).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[2].total_volume).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[2].last_updated).toSatisfy((value: string | null) => value === null || typeof value === 'string');
    expect(body[2].price_change_percentage_24h_in_currency).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[2].price_change_percentage_7d_in_currency).toBeNull();
  });

  it('canonicalizes persisted uppercase symbol names before serializing coins markets rows', { timeout: 30000 }, async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&sparkline=false',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.map((row: { name: string }) => row.name)).toEqual(['Bitcoin', 'Ethereum', 'Solana']);
  });


  it('serializes numeric canonical rank and 24h change fields for seeded bootstrap rows', async () => {
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
        url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h&sparkline=false',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body[0].market_cap_rank).toBe(1);
      expect(body[1].market_cap_rank).toBe(2);
      expect(typeof body[2].market_cap_rank).toBe('number');
      expect(body[2].market_cap_rank).toBeGreaterThan(0);
      expect(body[0].price_change_percentage_24h_in_currency).toBeTypeOf('number');
      expect(body[1].price_change_percentage_24h_in_currency).toBeTypeOf('number');
      expect(body[2].price_change_percentage_24h_in_currency).toBeTypeOf('number');
    } finally {
      await validationApp.close();
    }
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
      expect(body[0].price_change_percentage_24h_in_currency).toBeTypeOf('number');
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
      expect(body[1].price_change_percentage_24h_in_currency).toBeTypeOf('number');
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
      expect(body[2].price_change_percentage_24h_in_currency).toBeTypeOf('number');
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

  it('preserves explicit ids ordering, drops unknown ids, bypasses page slicing, and gates optional market fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=solana,unknown-coin,bitcoin&order=id_desc&page=9&per_page=1&price_change_percentage=24h,7d&sparkline=true&precision=2',
    });

    expect(response.statusCode).toBe(200);

    expect(response.json()).toEqual([
      expect.objectContaining({
        id: 'solana',
        sparkline_in_7d: {
          price: expect.any(Array),
        },
        price_change_percentage_24h_in_currency: expect.any(Number),
        price_change_percentage_7d_in_currency: null,
      }),
      expect.objectContaining({
        id: 'bitcoin',
        sparkline_in_7d: {
          price: expect.any(Array),
        },
        price_change_percentage_24h_in_currency: expect.any(Number),
        price_change_percentage_7d_in_currency: null,
      }),
    ]);

    expect(response.json()).toHaveLength(2);
    expect(response.json().map((row: { id: string }) => row.id)).toEqual(['solana', 'bitcoin']);
    expect(response.json()[0].current_price).toEqual(expect.any(Number));
    expect(Number.isInteger(response.json()[0].current_price)).toBe(false);
    expect(response.json()[0].current_price.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('rejects unsupported order values and invalid precision values with the standard invalid-parameter envelope', async () => {
    const [invalidOrderResponse, invalidPrecisionResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=unsupported',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&precision=not-a-number',
      }),
    ]);

    expect(invalidOrderResponse.statusCode).toBe(400);
    expect(invalidOrderResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'Unsupported order value: unsupported',
    });

    expect(invalidPrecisionResponse.statusCode).toBe(400);
    expect(invalidPrecisionResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'Invalid precision value: not-a-number',
    });
  });
});
