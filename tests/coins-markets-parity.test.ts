import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { marketSnapshots } from '../src/db/schema';

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
    if (body[0].current_price !== null && body[0].high_24h !== null && body[0].low_24h !== null) {
      expect(body[0].high_24h).toBeGreaterThanOrEqual(body[0].current_price);
      expect(body[0].low_24h).toBeLessThanOrEqual(body[0].current_price);
    }

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

  it('orders fresh source-backed market rows ahead of source-less rows when stale live data is disallowed', async () => {
    await app.ready();
    app.marketDataRuntimeState.initialSyncCompleted = true;
    app.marketDataRuntimeState.allowStaleLiveService = false;
    app.marketDataRuntimeState.validationOverride = {
      mode: 'stale_disallowed',
      reason: 'market quality scrutiny regression',
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    };
    app.marketDataRuntimeState.hotDataRevision += 1;

    const freshTimestamp = new Date();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 2_000,
        marketCap: 240_000_000_000,
        totalVolume: 10_000_000_000,
        marketCapRank: 2,
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();
    app.db.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify([]),
        sourceCount: 0,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&page=1&per_page=5&sparkline=false',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({
      id: 'ethereum',
      current_price: 2_000,
    });
  });

  it('does not rank fresh null-quality market placeholders above priced market rows', async () => {
    await app.ready();
    app.marketDataRuntimeState.initialSyncCompleted = true;
    app.marketDataRuntimeState.allowStaleLiveService = true;
    app.marketDataRuntimeState.validationOverride = {
      mode: 'stale_allowed',
      reason: 'market quality all-null placeholder regression',
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    };
    app.marketDataRuntimeState.hotDataRevision += 1;

    const freshTimestamp = new Date();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 0,
        marketCap: null,
        totalVolume: null,
        marketCapRank: 1,
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 2_000,
        marketCap: 240_000_000_000,
        totalVolume: 10_000_000_000,
        marketCapRank: 2,
        sourceProvidersJson: JSON.stringify(['coinbase']),
        sourceCount: 1,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&page=1&per_page=5&sparkline=false',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body[0]).toMatchObject({
      id: 'ethereum',
      current_price: 2_000,
      market_cap: 240_000_000_000,
      total_volume: 10_000_000_000,
    });
    expect(body[0].id).not.toBe('bitcoin');
    const bitcoinIndex = body.findIndex((row: { id: string }) => row.id === 'bitcoin');
    const ethereumIndex = body.findIndex((row: { id: string }) => row.id === 'ethereum');
    expect(bitcoinIndex === -1 || bitcoinIndex > ethereumIndex).toBe(true);
  });

  it('publishes stable top-N market quality denominators and replayable evidence in diagnostics', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(response.statusCode).toBe(200);

    const coinsFamily = (response.json().data.families as Array<{
      family: string;
      counts: Record<string, number>;
      evidence: {
        market_quality?: {
          assertions: string[];
          request_path: string;
          top_n: {
            configured_denominator: number;
            measured_denominator: number;
            returned_rows: number;
            price_complete_count: number;
            market_cap_complete_count: number;
            volume_complete_count: number;
            null_quality_row_count: number;
            null_quality_first_page_ids: string[];
          };
        };
        replayable_evidence?: {
          base_url_env: string;
          request_paths: string[];
          diagnostics_paths: string[];
          generated_at: string;
        };
      };
    }>).find((family) => family.family === 'coins');

    expect(coinsFamily).toBeDefined();
    expect(coinsFamily?.counts.market_top_n_configured_denominator).toBe(100);
    expect(coinsFamily?.evidence.market_quality).toMatchObject({
      assertions: expect.arrayContaining([
        'VAL-MARKET-007',
        'VAL-MARKET-008',
        'VAL-MARKET-009',
        'VAL-MARKET-021',
        'VAL-MARKET-022',
      ]),
      request_path: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1',
      top_n: {
        configured_denominator: 100,
        measured_denominator: expect.any(Number),
        returned_rows: expect.any(Number),
        price_complete_count: expect.any(Number),
        market_cap_complete_count: expect.any(Number),
        volume_complete_count: expect.any(Number),
        null_quality_row_count: expect.any(Number),
        null_quality_first_page_ids: expect.any(Array),
      },
    });
    expect(coinsFamily?.evidence.replayable_evidence).toMatchObject({
      base_url_env: 'BASE_URL',
      request_paths: expect.arrayContaining([
        '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1',
      ]),
      diagnostics_paths: expect.arrayContaining(['/diagnostics/data_quality', '/diagnostics/runtime']),
      generated_at: expect.any(String),
    });
  });


  it('null-shapes bootstrap-only market completeness fields for seeded bootstrap rows', async () => {
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
      for (const row of body) {
        expect(row.market_cap_rank).toBeNull();
        expect(row.total_volume).toBeNull();
        expect(row.high_24h).toBeNull();
        expect(row.low_24h).toBeNull();
        expect(row.ath).toBeNull();
        expect(row.atl).toBeNull();
        expect(row.last_updated).toBeNull();
        expect(row.price_change_24h).toBeNull();
        expect(row.price_change_percentage_24h).toBeNull();
        expect(row.price_change_percentage_24h_in_currency).toBeNull();
      }
    } finally {
      await validationApp.close();
    }
  });
  it('keeps seeded bootstrap market rows limited to bootstrap-safe identity and price fields', async () => {
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
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        high_24h: null,
        low_24h: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[0].price_change_percentage_24h_in_currency).toBeNull();
      expect(body[0].price_change_percentage_7d_in_currency).toBeNull();
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        name: 'Ethereum',
        image: expect.stringContaining('ethereum'),
        roi: expect.objectContaining({
          currency: 'btc',
        }),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        high_24h: null,
        low_24h: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[1].price_change_percentage_24h_in_currency).toBeNull();
      expect(body[1].price_change_percentage_7d_in_currency).toBeNull();
      expect(body[2]).toMatchObject({
        id: 'solana',
        name: 'Solana',
        image: expect.stringContaining('solana'),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        high_24h: null,
        low_24h: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[2].price_change_percentage_24h_in_currency).toBeNull();
      expect(body[2].price_change_percentage_7d_in_currency).toBeNull();
    } finally {
      await validationApp.close();
    }
  });

  it('preserves imported live snapshot ownership while null-shaping seeded bootstrap completeness fields', async () => {
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
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        name: 'Ethereum',
        image: expect.stringContaining('ethereum'),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[2]).toMatchObject({
        id: 'solana',
        name: 'Solana',
        image: expect.stringContaining('solana'),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
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
        market_cap: null,
        total_volume: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        current_price: expect.any(Number),
        market_cap: null,
        total_volume: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[2]).toMatchObject({
        id: 'solana',
        current_price: expect.any(Number),
        market_cap: null,
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
    expect(response.json()[0].current_price).toBeTypeOf('number');
  });

  it('treats explicit names and symbols selectors like explicit ids for ordering, unknown omission, and page-slice bypass', async () => {
    const [namesResponse, symbolsResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&names=solana,unknown-coin,bitcoin&page=9&per_page=1',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&symbols=sol,unknown-symbol,btc&page=7&per_page=1',
      }),
    ]);

    expect(namesResponse.statusCode).toBe(200);
    expect(symbolsResponse.statusCode).toBe(200);

    const namesBody = namesResponse.json();
    const symbolsBody = symbolsResponse.json();

    expect(namesBody).toHaveLength(2);
    expect(namesBody.map((row: { id: string }) => row.id)).toEqual(['solana', 'bitcoin']);

    expect(symbolsBody).toHaveLength(2);
    expect(symbolsBody.map((row: { id: string }) => row.id)).toEqual(['solana', 'bitcoin']);
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

  it('keeps fresh live rows ahead of stale disallowed rows for market metric sorting', async () => {
    await app.ready();
    app.marketDataRuntimeState.initialSyncCompleted = true;
    app.marketDataRuntimeState.allowStaleLiveService = false;
    app.marketDataRuntimeState.hotDataRevision += 1;

    app.db.db
      .update(marketSnapshots)
      .set({
        totalVolume: 999_000_000_000,
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    app.db.db
      .update(marketSnapshots)
      .set({
        totalVolume: 1_000,
        sourceProvidersJson: JSON.stringify(['coinbase']),
        sourceCount: 1,
        lastUpdated: new Date(),
      })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=volume_desc&per_page=20&page=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({
      id: 'ethereum',
      total_volume: 1000,
    });
    expect(response.json().some((row: { id: string; total_volume: number | null }) =>
      row.id === 'bitcoin' && row.total_volume === null,
    )).toBe(true);
  });

  it('invalidates the coins markets cache when stale-live access policy flips without a revision bump', async () => {
    await app.ready();
    app.db.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    app.marketDataRuntimeState.initialSyncCompleted = true;
    app.marketDataRuntimeState.allowStaleLiveService = true;
    app.marketDataRuntimeState.hotDataRevision += 1;

    const staleAllowed = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });
    const revisionAfterWarm = app.marketDataRuntimeState.hotDataRevision;

    app.marketDataRuntimeState.allowStaleLiveService = false;

    const staleDisallowed = await app.inject({
      method: 'GET',
      url: '/coins/markets?ids=bitcoin&vs_currency=usd',
    });

    expect(app.marketDataRuntimeState.hotDataRevision).toBe(revisionAfterWarm);
    expect(staleAllowed.statusCode).toBe(200);
    expect(staleAllowed.json()[0]).toMatchObject({
      id: 'bitcoin',
      current_price: expect.any(Number),
      last_updated: expect.any(String),
    });
    expect(staleDisallowed.statusCode).toBe(200);
    expect(staleDisallowed.json()).toEqual([
      expect.objectContaining({
        id: 'bitcoin',
        current_price: null,
        market_cap: null,
        total_volume: null,
        last_updated: null,
      }),
    ]);
  });
});
