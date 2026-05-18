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

  it('keeps representative public CoinGecko route responses pinned to the provider-health baseline', async () => {
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const routes = {
        simple_price: '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
        coins_markets: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&page=1&per_page=2&price_change_percentage=24h&sparkline=false',
        exchanges: '/exchanges?page=1&per_page=1',
        derivatives: '/derivatives',
        onchain_pool: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      } as const;
      const baseline: Record<string, unknown> = {};

      for (const [name, url] of Object.entries(routes)) {
        const response = await app.inject({
          method: 'GET',
          url,
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        if (name === 'onchain_pool') {
          const payload = body as {
            data?: { attributes?: { price_usd?: unknown; reserve_usd?: unknown; volume_usd?: { h24?: unknown } } };
            meta?: { data_source?: unknown; fixture?: unknown; source?: unknown; field_provenance?: unknown };
          };
          if (payload.data?.attributes) {
            payload.data.attributes.price_usd = '<provider-dependent>';
            payload.data.attributes.reserve_usd = '<provider-dependent>';
            if (payload.data.attributes.volume_usd) {
              payload.data.attributes.volume_usd.h24 = '<provider-dependent>';
            }
          }
          if (payload.meta) {
            const meta = payload.meta as Record<string, unknown>;
            meta.data_source = '<provider-dependent>';
            meta.degraded_reason = '<provider-dependent>';
            meta.fallback_reason = '<provider-dependent>';
            meta.fixture = '<provider-dependent>';
            meta.fixture_version = '<provider-dependent>';
            meta.reason_codes = '<provider-dependent>';
            meta.source = '<provider-dependent>';
            meta.source_identifiers = '<provider-dependent>';
            meta.source_mode = '<provider-dependent>';
            delete meta.field_provenance;
          }
        }
        baseline[name] = body;
      }

      expect(baseline).toMatchInlineSnapshot(`
        {
          "coins_markets": [
            {
              "ath": null,
              "ath_change_percentage": null,
              "ath_date": null,
              "atl": null,
              "atl_change_percentage": null,
              "atl_date": null,
              "circulating_supply": null,
              "current_price": 70681.22808943377,
              "fully_diluted_valuation": null,
              "high_24h": 70681.22808943377,
              "id": "bitcoin",
              "image": "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400",
              "last_updated": "2026-03-20T00:00:00.000Z",
              "low_24h": 66145,
              "market_cap": 1323878876195,
              "market_cap_change_24h": null,
              "market_cap_change_percentage_24h": null,
              "market_cap_rank": 1,
              "max_supply": null,
              "name": "Bitcoin",
              "price_change_24h": null,
              "price_change_percentage_24h": 1.2,
              "price_change_percentage_24h_in_currency": 1.2,
              "roi": null,
              "symbol": "btc",
              "total_supply": null,
              "total_volume": 47657767940,
            },
            {
              "ath": null,
              "ath_change_percentage": null,
              "ath_date": null,
              "atl": null,
              "atl_change_percentage": null,
              "atl_date": null,
              "circulating_supply": null,
              "current_price": 2153.248566172594,
              "fully_diluted_valuation": null,
              "high_24h": 2153.248566172594,
              "id": "ethereum",
              "image": "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png?1696501628",
              "last_updated": "2026-03-20T00:00:00.000Z",
              "low_24h": 1972.03,
              "market_cap": 239883065644,
              "market_cap_change_24h": null,
              "market_cap_change_percentage_24h": null,
              "market_cap_rank": 2,
              "max_supply": null,
              "name": "Ethereum",
              "price_change_24h": null,
              "price_change_percentage_24h": 2.4,
              "price_change_percentage_24h_in_currency": 2.4,
              "roi": {
                "currency": "btc",
                "percentage": 3914.9028999875204,
                "times": 39.149028999875206,
              },
              "symbol": "eth",
              "total_supply": null,
              "total_volume": 18589171218,
            },
          ],
          "derivatives": {
            "data": [
              {
                "basis": 40,
                "contract_type": "perpetual",
                "expired_at": null,
                "funding_rate": 0.0001,
                "index": 85080,
                "index_id": "bitcoin",
                "last_traded_at": "2026-03-20T00:00:00.000Z",
                "market": "Binance Futures",
                "market_id": "binance_futures",
                "open_interest_btc": 120000,
                "price": 85120,
                "price_percentage_change_24h": 1.7,
                "spread": 0.012,
                "symbol": "BTCUSDT",
                "trade_volume_24h_btc": 420000,
              },
              {
                "basis": 6,
                "contract_type": "perpetual",
                "expired_at": null,
                "funding_rate": 0.00012,
                "index": 2004,
                "index_id": "ethereum",
                "last_traded_at": "2026-03-20T00:00:00.000Z",
                "market": "Binance Futures",
                "market_id": "binance_futures",
                "open_interest_btc": 42000,
                "price": 2010,
                "price_percentage_change_24h": 2.2,
                "spread": 0.018,
                "symbol": "ETHUSDT",
                "trade_volume_24h_btc": 110000,
              },
              {
                "basis": 760,
                "contract_type": "futures",
                "expired_at": "2026-06-27T08:00:00.000Z",
                "funding_rate": null,
                "index": 85080,
                "index_id": "bitcoin",
                "last_traded_at": "2026-03-20T00:00:00.000Z",
                "market": "Bybit",
                "market_id": "bybit",
                "open_interest_btc": 18500,
                "price": 85840,
                "price_percentage_change_24h": 1.1,
                "spread": 0.025,
                "symbol": "BTC-27JUN26",
                "trade_volume_24h_btc": 56000,
              },
            ],
            "meta": {
              "fallback_tickers": 3,
              "fixture": true,
              "frozen_at": "2026-03-20",
              "latest_source_fetched_at": null,
              "note": "Derivatives data is seeded fixture until a derivatives refresh writes source-attributed rows.",
              "page": 1,
              "source_backed_tickers": 0,
            },
          },
          "exchanges": [
            {
              "country": "Cayman Islands",
              "description": "One of the world’s largest cryptocurrency exchanges by trading volume, offering a wide range of services including spot, futures, and staking options.",
              "has_trading_incentive": false,
              "id": "binance",
              "image": "https://coin-images.coingecko.com/markets/images/52/small/binance.jpg?1706864274",
              "name": "Binance",
              "source": "fixture",
              "trade_volume_24h_btc": 139508.1218951856,
              "trade_volume_24h_btc_normalized": null,
              "trust_score": 10,
              "trust_score_rank": 1,
              "updated_at": "2026-03-20T00:00:00.000Z",
              "url": "https://www.binance.com/",
              "year_established": 2017,
            },
          ],
          "onchain_pool": {
            "data": {
              "attributes": {
                "address": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
                "base_token_address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                "base_token_symbol": "USDC",
                "name": "USDC / WETH 0.05%",
                "pool_created_at": 1712707200,
                "price_usd": "<provider-dependent>",
                "quote_token_address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                "quote_token_symbol": "WETH",
                "reserve_usd": "<provider-dependent>",
                "transactions": {
                  "h24": {
                    "buys": 12840,
                    "sells": 12590,
                  },
                },
                "volume_usd": {
                  "h24": "<provider-dependent>",
                },
              },
              "id": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
              "relationships": {
                "dex": {
                  "data": {
                    "id": "uniswap_v3",
                    "type": "dex",
                  },
                },
                "network": {
                  "data": {
                    "id": "eth",
                    "type": "network",
                  },
                },
              },
              "type": "pool",
            },
            "meta": {
              "data_source": "<provider-dependent>",
              "degraded_reason": "<provider-dependent>",
              "fallback_reason": "<provider-dependent>",
              "fixture": "<provider-dependent>",
              "fixture_version": "<provider-dependent>",
              "latest_source_fetched_at": null,
              "no_silent_zero_fill": {
                "numeric_fields": [
                  "reserve_usd",
                  "volume_usd",
                  "price_usd",
                ],
                "policy": "null_or_marked_fallback_when_unavailable",
                "zero_fill_is_marked": true,
              },
              "reason_codes": "<provider-dependent>",
              "source": "<provider-dependent>",
              "source_fetched_at": null,
              "source_identifiers": "<provider-dependent>",
              "source_mode": "<provider-dependent>",
              "unavailable_reason": null,
              "updated_at": "2026-03-20T00:00:00.000Z",
            },
          },
          "simple_price": {
            "bitcoin": {
              "last_updated_at": 1773964800,
              "usd": 70681.22808943377,
              "usd_24h_change": 1.2,
              "usd_24h_vol": 47657767940,
              "usd_market_cap": 1323878876195,
            },
            "ethereum": {
              "last_updated_at": 1773964800,
              "usd": 2153.248566172594,
              "usd_24h_change": 2.4,
              "usd_24h_vol": 18589171218,
              "usd_market_cap": 239883065644,
            },
          },
        }
      `);
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
        '/diagnostics/runtime',
        'public, max-age=60, stale-while-revalidate=60',
        (body) => expect(body).toMatchObject({
          data: {
            readiness: expect.any(Object),
            hot_paths: expect.any(Object),
            transport: expect.any(Object),
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
