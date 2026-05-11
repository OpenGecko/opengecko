import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import * as defillamaProvider from '../src/providers/defillama';
import * as sqdProvider from '../src/providers/sqd';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: 1773964800000, raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: 1773964800000, raw: {} as never },
  ]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

async function expectCacheableEndpoint(
  app: ReturnType<typeof buildApp>,
  url: string,
  cacheControl: string,
  assertBody: (body: unknown) => void,
) {
  const first = await app.inject({
    method: 'GET',
    url,
  });
  const etag = first.headers.etag;

  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe(cacheControl);
  expect(etag).toMatch(/^W\/".+"$/);
  assertBody(first.json() as unknown);

  const second = await app.inject({
    method: 'GET',
    url,
    headers: {
      'if-none-match': String(etag),
    },
  });

  expect(second.statusCode).toBe(304);
  expect(second.headers.etag).toBe(etag);
  expect(second.headers['cache-control']).toBe(cacheControl);
  expect(second.body).toBe('');

  return etag;
}

describe('HTTP cache semantics', () => {
  it('adds cache headers and supports 304 responses for /ping', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const first = await app.inject({
        method: 'GET',
        url: '/ping',
      });
      const etag = first.headers.etag;

      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=30');
      expect(etag).toMatch(/^W\/".+"$/);
      expect(first.json()).toEqual({
        gecko_says: '(V3) To the Moon!',
      });

      const second = await app.inject({
        method: 'GET',
        url: '/ping',
        headers: {
          'if-none-match': String(etag),
        },
      });

      expect(second.statusCode).toBe(304);
      expect(second.headers.etag).toBe(etag);
      expect(second.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=30');
      expect(second.body).toBe('');
    } finally {
      await app.close();
    }
  });

  it('adds cache headers and supports 304 responses for /health', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/health',
        'public, max-age=60, stale-while-revalidate=30',
        (body) => expect(body).toEqual({
          gecko_says: '(V3) To the Moon!',
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('adds cache headers and supports 304 responses for supported quote currencies', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const first = await app.inject({
        method: 'GET',
        url: '/simple/supported_vs_currencies',
      });
      const etag = first.headers.etag;

      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('public, max-age=3600, stale-while-revalidate=3600');
      expect(etag).toMatch(/^W\/".+"$/);
      expect(first.json()).toEqual(expect.arrayContaining(['usd', 'btc', 'eth']));

      const second = await app.inject({
        method: 'GET',
        url: '/simple/supported_vs_currencies',
        headers: {
          'if-none-match': `W/"different", ${String(etag)}`,
        },
      });

      expect(second.statusCode).toBe(304);
      expect(second.headers.etag).toBe(etag);
      expect(second.headers['cache-control']).toBe('public, max-age=3600, stale-while-revalidate=3600');
      expect(second.body).toBe('');
    } finally {
      await app.close();
    }
  });

  it('adds short-lived cache headers and supports 304 responses for exchange rates', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const first = await app.inject({
        method: 'GET',
        url: '/exchange_rates',
      });
      const etag = first.headers.etag;

      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60');
      expect(etag).toMatch(/^W\/".+"$/);
      expect(first.json()).toMatchObject({
        data: {
          usd: expect.objectContaining({
            type: 'fiat',
          }),
        },
      });

      const second = await app.inject({
        method: 'GET',
        url: '/exchange_rates',
        headers: {
          'if-none-match': String(etag),
        },
      });

      expect(second.statusCode).toBe(304);
      expect(second.headers.etag).toBe(etag);
      expect(second.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60');
      expect(second.body).toBe('');
    } finally {
      await app.close();
    }
  });

  it('adds stable catalog cache headers and supports 304 responses for static endpoint families', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/asset_platforms',
        'public, max-age=3600, stale-while-revalidate=3600',
        (body) => expect(body).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'ethereum',
            name: 'Ethereum',
          }),
        ])),
      );

      await expectCacheableEndpoint(
        app,
        '/token_lists/ethereum/all.json',
        'public, max-age=3600, stale-while-revalidate=3600',
        (body) => expect(body).toMatchObject({
          name: 'OpenGecko Ethereum Token List',
          tokens: expect.any(Array),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/coins/list',
        'public, max-age=3600, stale-while-revalidate=3600',
        (body) => expect(body).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'bitcoin',
            symbol: 'btc',
          }),
        ])),
      );

      await expectCacheableEndpoint(
        app,
        '/coins/categories/list',
        'public, max-age=3600, stale-while-revalidate=3600',
        (body) => {
          expect(body).toEqual(expect.arrayContaining([
            expect.objectContaining({
              category_id: expect.any(String),
              name: expect.any(String),
            }),
          ]));
          expect(body).not.toHaveProperty('data');
          expect(body).not.toHaveProperty('meta');
        },
      );

      await expectCacheableEndpoint(
        app,
        '/coins/categories',
        'public, max-age=300, stale-while-revalidate=300',
        (body) => expect(body).toMatchObject({
          data: expect.any(Array),
          meta: {
            fixture: true,
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/exchanges/list',
        'public, max-age=3600, stale-while-revalidate=3600',
        (body) => expect(body).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'binance',
            name: 'Binance',
          }),
        ])),
      );
    } finally {
      await app.close();
    }
  });

  it('uses query-specific ETags for cacheable catalog endpoints', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const plain = await app.inject({
        method: 'GET',
        url: '/coins/list',
      });
      const withPlatforms = await app.inject({
        method: 'GET',
        url: '/coins/list?include_platform=true',
      });

      expect(plain.statusCode).toBe(200);
      expect(withPlatforms.statusCode).toBe(200);
      expect(plain.headers.etag).toMatch(/^W\/".+"$/);
      expect(withPlatforms.headers.etag).toMatch(/^W\/".+"$/);
      expect(withPlatforms.headers.etag).not.toBe(plain.headers.etag);
    } finally {
      await app.close();
    }
  });

  it('adds budget-limited cache headers and supports 304 responses for hot market routes', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/simple/price?ids=bitcoin&vs_currencies=usd',
        'public, max-age=5, stale-while-revalidate=5',
        (body) => expect(body).toMatchObject({
          bitcoin: {
            usd: expect.any(Number),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
        'public, max-age=5, stale-while-revalidate=5',
        (body) => expect(body).toMatchObject({
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
            usd: expect.any(Number),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/coins/markets?vs_currency=usd&ids=bitcoin&per_page=1&page=1',
        'public, max-age=5, stale-while-revalidate=5',
        (body) => expect(body).toEqual([
          expect.objectContaining({
            id: 'bitcoin',
            current_price: expect.any(Number),
          }),
        ]),
      );
    } finally {
      await app.close();
    }
  });

  it('adds budget-limited cache headers and supports 304 responses for detail routes', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          id: 'bitcoin',
          symbol: 'btc',
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/exchanges?page=1&per_page=1',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toEqual([
          expect.objectContaining({
            id: 'binance',
            name: 'Binance',
          }),
        ]),
      );

      await expectCacheableEndpoint(
        app,
        '/exchanges/binance',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          id: 'binance',
          name: 'Binance',
          tickers: expect.any(Array),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/exchanges/binance/tickers',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          name: 'Binance',
          tickers: expect.any(Array),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('adds cache headers and supports 304 responses for safe diagnostics routes', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        marketChartTargets: 'mock.chart=bitcoin:1d:usd,mock.chart=ethereum:1m:usd',
        optionalProviderSyncEnabled: true,
        optionalProviderSyncIntervalSeconds: 900,
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/diagnostics/chain_coverage',
        'public, max-age=300, stale-while-revalidate=300',
        (body) => expect(body).toMatchObject({
          data: {
            platform_counts: expect.any(Object),
            confidence: expect.any(Object),
            contract_mapping: expect.any(Object),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/ohlcv_sync',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            top100: expect.any(Object),
            targets: expect.any(Object),
            lag: expect.any(Object),
            backfill: expect.any(Object),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/freshness_budgets',
        'public, max-age=300, stale-while-revalidate=300',
        (body) => expect(body).toMatchObject({
          data: {
            budgets: expect.arrayContaining([
              expect.objectContaining({
                family: 'simple',
                target_freshness_seconds: 30,
              }),
            ]),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/coverage_matrix',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            entries: expect.arrayContaining([
              expect.objectContaining({
                family: 'simple',
                ownership_class: expect.any(String),
              }),
              expect.objectContaining({
                family: 'derivatives',
                ownership_class: 'fixture',
              }),
            ]),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/derivatives',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            exchanges: expect.arrayContaining([
              expect.objectContaining({
                exchange_id: 'binance_futures',
                status: 'configured_pending',
                configured_provider_exchange_id: 'binanceusdm',
              }),
            ]),
            gaps: expect.any(Object),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/coin_history',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            histories: expect.any(Array),
            gaps: expect.any(Object),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/exchange_volumes',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            exchanges: expect.arrayContaining([
              expect.objectContaining({
                exchange_id: 'binance',
                status: expect.any(String),
              }),
            ]),
            gaps: expect.any(Object),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/market_charts',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            coins: expect.arrayContaining([
              expect.objectContaining({
                coin_id: 'bitcoin',
                status: expect.any(String),
              }),
            ]),
            gaps: expect.any(Object),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/onchain_analytics',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            tokens: expect.arrayContaining([
              expect.objectContaining({
                network_id: 'eth',
                status: expect.any(String),
              }),
            ]),
            gaps: expect.any(Object),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/onchain_trades',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            pools: expect.arrayContaining([
              expect.objectContaining({
                network_id: 'eth',
                status: expect.any(String),
              }),
            ]),
            gaps: expect.any(Object),
          },
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/diagnostics/supply_charts',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            coins: expect.arrayContaining([
              expect.objectContaining({
                coin_id: 'bitcoin',
                status: expect.any(String),
              }),
            ]),
            gaps: expect.any(Object),
          },
        }),
      );

      app.optionalProviderJobs.recordSuccess('market_charts', {
        startedAt: new Date('2026-05-05T04:00:00.000Z'),
        finishedAt: new Date('2026-05-05T04:00:01.000Z'),
        targetsAttempted: 2,
        rowsWritten: 1,
        partialFailureReason: '1 market chart target(s) failed; first failure: provider timeout for bitcoin',
        partialFailureSamples: [{
          provider: 'mock.chart',
          coin_id: 'bitcoin',
          vs_currency: 'usd',
          interval: '1d',
          error: 'provider timeout for bitcoin',
        }],
      });

      await expectCacheableEndpoint(
        app,
        '/diagnostics/jobs',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            jobs: expect.arrayContaining([
              expect.objectContaining({
                id: 'market_charts',
                status: 'succeeded',
                last_partial_failure_retry_targets_template: 'mock.chart=bitcoin:1d:usd',
                production_freshness_cadence: {
                  scheduler_enabled: true,
                  scheduler_interval_seconds: 900,
                  target_intervals: ['1d', '1m'],
                  strictest_production_freshness_seconds: 300,
                  status: 'interval_slower_than_production_freshness',
                  recommendation: expect.stringContaining('OPTIONAL_PROVIDER_SYNC_INTERVAL_SECONDS to 300 or less'),
                },
              }),
            ]),
            summary: expect.objectContaining({
              partial_failure: 1,
            }),
          },
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('adds cache headers and supports 304 responses for search and derivatives routes', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/search?query=bitcoin',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          coins: expect.any(Array),
          exchanges: expect.any(Array),
          categories: expect.any(Array),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/search/trending',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          coins: expect.any(Array),
          categories: expect.any(Array),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/derivatives/exchanges/list',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'binance_futures',
          }),
        ])),
      );

      const derivativeRoutes = [
        '/derivatives/exchanges',
        '/derivatives/exchanges/binance_futures',
        '/derivatives/exchanges/binance_futures?include_tickers=true',
        '/derivatives',
      ];

      for (const route of derivativeRoutes) {
        await expectCacheableEndpoint(
          app,
          route,
          'public, max-age=60, stale-while-revalidate=60',
          (body) => expect(body).toMatchObject({
            data: expect.anything(),
          }),
        );
      }
    } finally {
      await app.close();
    }
  });

  it('adds cache headers and supports 304 responses for global routes', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/global',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: expect.objectContaining({
            total_market_cap: expect.any(Object),
            total_volume: expect.any(Object),
          }),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/global/decentralized_finance_defi',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: expect.objectContaining({
            defi_market_cap: expect.any(Number),
          }),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/global/market_cap_chart?vs_currency=usd&days=7',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          market_cap_chart: expect.any(Array),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('adds cache headers and supports 304 responses for treasury routes', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/entities/list',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: expect.any(Array),
          meta: expect.objectContaining({
            fixture: true,
          }),
        }),
      );

      const treasuryRoutes = [
        '/companies/public_treasury/bitcoin',
        '/public_treasury/strategy',
        '/public_treasury/strategy/bitcoin/holding_chart?days=7',
        '/public_treasury/strategy/transaction_history',
      ];

      for (const route of treasuryRoutes) {
        await expectCacheableEndpoint(
          app,
          route,
          'public, max-age=60, stale-while-revalidate=60',
          (body) => expect(body).toMatchObject({
            data: expect.anything(),
            meta: expect.objectContaining({
              fixture: true,
            }),
          }),
        );
      }
    } finally {
      await app.close();
    }
  });

  it('adds cache headers and supports 304 responses for coin auxiliary routes', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const coinAuxiliaryRoutes = [
        '/coins/top_gainers_losers?vs_currency=usd',
        '/coins/list/new',
        '/coins/bitcoin/history?date=20-03-2026&localization=false',
        '/coins/bitcoin/tickers',
        '/coins/bitcoin/circulating_supply_chart?days=7',
        '/coins/bitcoin/circulating_supply_chart/range?from=1773446400&to=1773964800',
        '/coins/bitcoin/total_supply_chart?days=7',
        '/coins/bitcoin/total_supply_chart/range?from=1773446400&to=1773964800',
        '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?localization=false&tickers=false&community_data=false&developer_data=false',
      ];

      for (const route of coinAuxiliaryRoutes) {
        await expectCacheableEndpoint(
          app,
          route,
          'public, max-age=60, stale-while-revalidate=60',
          (body) => expect(body).toEqual(expect.anything()),
        );
      }
    } finally {
      await app.close();
    }
  });

  it('adds budget-limited cache headers and supports 304 responses for historical chart routes', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => {
          expect(body).toMatchObject({
            prices: expect.any(Array),
            market_caps: expect.any(Array),
            total_volumes: expect.any(Array),
          });
          expect(JSON.stringify(body)).not.toContain('production_freshness_cadence');
        },
      );

      await expectCacheableEndpoint(
        app,
        '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          prices: expect.any(Array),
          market_caps: expect.any(Array),
          total_volumes: expect.any(Array),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/coins/bitcoin/ohlc?vs_currency=usd&days=7&interval=daily',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => {
          expect(body).toEqual(expect.arrayContaining([
            expect.arrayContaining([
              expect.any(Number),
            ]),
          ]));
          expect(JSON.stringify(body)).not.toContain('production_freshness_cadence');
        },
      );

      await expectCacheableEndpoint(
        app,
        '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1774310400&to=1774310400&interval=daily',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toEqual(expect.any(Array)),
      );

      await expectCacheableEndpoint(
        app,
        '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart?vs_currency=usd&days=7&interval=daily',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          prices: expect.any(Array),
          market_caps: expect.any(Array),
          total_volumes: expect.any(Array),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart/range?vs_currency=usd&from=1773446400&to=1773964800&interval=weekly',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          prices: expect.any(Array),
          market_caps: expect.any(Array),
          total_volumes: expect.any(Array),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('adds budget-limited cache headers and supports 304 responses for exchange volume charts', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/exchanges/binance/volume_chart?days=7',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toEqual(expect.any(Array)),
      );

      await expectCacheableEndpoint(
        app,
        '/exchanges/binance/volume_chart/range?from=0&to=4102444800',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toEqual(expect.any(Array)),
      );
    } finally {
      await app.close();
    }
  });

  it('adds budget-limited cache headers and supports 304 responses for representative onchain routes', async () => {
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);
    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await expectCacheableEndpoint(
        app,
        '/onchain/networks',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: expect.arrayContaining([
            expect.objectContaining({
              id: 'eth',
              type: 'network',
            }),
          ]),
          meta: expect.any(Object),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/onchain/networks/eth/pools',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: expect.arrayContaining([
            expect.objectContaining({
              type: 'pool',
            }),
          ]),
          meta: expect.objectContaining({
            page: 1,
          }),
        }),
      );

      await expectCacheableEndpoint(
        app,
        '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: expect.objectContaining({
            type: 'pool',
            id: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
          }),
          meta: expect.objectContaining({
            data_source: expect.any(String),
          }),
        }),
      );

      const cacheableOnchainDiscoveryRoutes = [
        '/onchain/networks/eth/dexes',
        '/onchain/networks/eth/dexes/uniswap_v3/pools',
        '/onchain/networks/eth/new_pools',
        '/onchain/networks/new_pools',
        '/onchain/networks/trending_pools',
        '/onchain/networks/eth/trending_pools',
        '/onchain/search/pools?query=usdc',
        '/onchain/pools/megafilter?networks=eth',
        '/onchain/pools/trending_search?pools=0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        '/onchain/categories',
        '/onchain/categories/stablecoins/pools',
        '/onchain/networks/eth/pools/multi/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        '/onchain/networks/eth/tokens/multi/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/pools',
        '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        '/onchain/simple/networks/eth/token_price/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
        '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/info',
        '/onchain/tokens/info_recently_updated?network=eth',
        '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_holders',
        '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_traders',
        '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/holders_chart',
      ];

      for (const route of cacheableOnchainDiscoveryRoutes) {
        await expectCacheableEndpoint(
          app,
          route,
          'public, max-age=60, stale-while-revalidate=60',
          (body) => expect(body).toMatchObject({
            data: expect.anything(),
          }),
        );
      }

      const cacheableLiveOnchainRoutes = [
        '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades',
        '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/trades',
        '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour',
        '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/ohlcv/hour',
      ];

      for (const route of cacheableLiveOnchainRoutes) {
        await expectCacheableEndpoint(
          app,
          route,
          'public, max-age=30, stale-while-revalidate=30',
          (body) => expect(body).toMatchObject({
            data: expect.anything(),
          }),
        );
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});
