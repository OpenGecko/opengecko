import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { marketSnapshots } from '../src/db/schema';

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

  it('keeps coin detail trust semantics coherent across stale-disallowed, stale-allowed, and degraded seeded bootstrap runtime states', async () => {
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
      await validationApp.ready();
      validationApp.marketDataRuntimeState.listenerBound = true;

      const staleTimestamp = new Date('2025-03-19T00:00:00.000Z');
      validationApp.db.db
        .update(marketSnapshots)
        .set({
          lastUpdated: staleTimestamp,
          sourceProvidersJson: JSON.stringify(['binance']),
          sourceCount: 1,
        })
        .where(eq(marketSnapshots.coinId, 'bitcoin'))
        .run();

      const staleDisallowedOverride = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'stale_disallowed',
          reason: 'validator stale-live disallowed',
        },
      });

      expect(staleDisallowedOverride.statusCode).toBe(200);

      const staleDisallowedDetail = await validationApp.inject({
        method: 'GET',
        url: '/coins/bitcoin',
      });
      const staleDisallowedDiagnostics = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(staleDisallowedDetail.statusCode).toBe(200);
      expect(staleDisallowedDetail.json()).toMatchObject({
        id: 'bitcoin',
        market_data: null,
      });
      expect(staleDisallowedDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'degraded',
          validation_override_active: true,
        },
        degraded: {
          active: true,
          stale_live_enabled: false,
          validation_override: {
            active: true,
            mode: 'stale_disallowed',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'stale_live',
            freshness: {
              is_stale: true,
            },
          },
        },
      });

      const staleAllowedOverride = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'stale_allowed',
          reason: 'validator stale-live allowed',
        },
      });

      expect(staleAllowedOverride.statusCode).toBe(200);

      const [staleAllowedDetail, staleAllowedSimple, staleAllowedMarkets, staleAllowedDiagnostics] = await Promise.all([
        validationApp.inject({
          method: 'GET',
          url: '/coins/bitcoin?tickers=false&community_data=false&developer_data=false&localization=false',
        }),
        validationApp.inject({
          method: 'GET',
          url: '/simple/price?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true',
        }),
        validationApp.inject({
          method: 'GET',
          url: '/coins/markets?vs_currency=usd&ids=bitcoin',
        }),
        validationApp.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        }),
      ]);

      expect(staleAllowedDetail.statusCode).toBe(200);
      expect(staleAllowedDetail.json().market_data.current_price.usd).toBe(staleAllowedSimple.json().bitcoin.usd);
      expect(staleAllowedDetail.json().market_data.current_price.usd).toBe(staleAllowedMarkets.json()[0].current_price);
      expect(Date.parse(staleAllowedDetail.json().market_data.last_updated) / 1000).toBe(staleAllowedSimple.json().bitcoin.last_updated_at);
      expect(staleAllowedDetail.json().market_data.last_updated).toBe(staleAllowedMarkets.json()[0].last_updated);
      expect(staleAllowedDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'degraded',
          validation_override_active: true,
        },
        degraded: {
          active: true,
          stale_live_enabled: true,
          validation_override: {
            active: true,
            mode: 'stale_allowed',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'stale_live',
            freshness: {
              is_stale: true,
            },
          },
        },
      });

      const bootstrapTimestamp = new Date('2026-03-20T00:00:00.000Z');
      validationApp.db.db
        .update(marketSnapshots)
        .set({
          price: 77777,
          marketCap: null,
          totalVolume: null,
          priceChange24h: null,
          priceChangePercentage24h: null,
          sourceProvidersJson: JSON.stringify([]),
          sourceCount: 0,
          lastUpdated: bootstrapTimestamp,
        })
        .where(eq(marketSnapshots.coinId, 'bitcoin'))
        .run();

      const degradedSeededOverride = await validationApp.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: {
          mode: 'degraded_seeded_bootstrap',
          reason: 'validator degraded boot',
        },
      });

      expect(degradedSeededOverride.statusCode).toBe(200);

      const degradedSeededDetail = await validationApp.inject({
        method: 'GET',
        url: '/coins/bitcoin?tickers=false&community_data=false&developer_data=false&localization=false',
      });
      const degradedSeededDiagnostics = await validationApp.inject({
        method: 'GET',
        url: '/diagnostics/runtime',
      });

      expect(degradedSeededDetail.statusCode).toBe(200);
      expect(degradedSeededDetail.json()).toMatchObject({
        id: 'bitcoin',
        market_data: {
          current_price: {
            usd: 77777,
          },
          market_cap: {
            usd: null,
          },
          total_volume: {
            usd: null,
          },
          price_change_24h: null,
          price_change_percentage_24h: null,
          last_updated: expect.any(String),
        },
      });
      expect(degradedSeededDetail.json().market_data.last_updated).not.toBeNull();
      expect(degradedSeededDiagnostics.json().data).toMatchObject({
        readiness: {
          state: 'degraded',
          initial_sync_completed: false,
          validation_override_active: true,
        },
        degraded: {
          active: true,
          stale_live_enabled: true,
          validation_override: {
            active: true,
            mode: 'degraded_seeded_bootstrap',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'degraded_seeded_bootstrap',
            last_successful_live_refresh_at: null,
          },
        },
      });
    } finally {
      await validationApp.close();
    }
  });

  it('preserves explicit null and empty optional-section semantics and only adds sparkline when requested', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/bitcoin?market_data=false&community_data=false&developer_data=false&tickers=false&localization=false&sparkline=true',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'bitcoin',
      market_data: null,
      community_data: null,
      developer_data: null,
      tickers: [],
      localization: {},
    });

    const withoutSparkline = await app.inject({
      method: 'GET',
      url: '/coins/bitcoin?tickers=false&community_data=false&developer_data=false&localization=false',
    });
    const withSparkline = await app.inject({
      method: 'GET',
      url: '/coins/bitcoin?tickers=false&community_data=false&developer_data=false&localization=false&sparkline=true',
    });

    expect(withoutSparkline.statusCode).toBe(200);
    expect(withSparkline.statusCode).toBe(200);
    expect(withoutSparkline.json().market_data.sparkline_7d).toBeNull();
    expect(withSparkline.json().market_data.sparkline_7d).toEqual({
      price: expect.any(Array),
    });
    expect(withSparkline.json().market_data.sparkline_7d.price.length).toBeGreaterThan(0);
  });

  it('fails explicitly for unknown coin ids and unsupported dex_pair_format values', async () => {
    const [unknownCoinResponse, badDexPairFormatResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/coins/not-a-coin',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/bitcoin?dex_pair_format=bad',
      }),
    ]);

    expect(unknownCoinResponse.statusCode).toBe(404);
    expect(unknownCoinResponse.json()).toEqual({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });

    expect(badDexPairFormatResponse.statusCode).toBe(400);
    expect(badDexPairFormatResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'Unsupported dex_pair_format value: bad',
    });
  });
});
