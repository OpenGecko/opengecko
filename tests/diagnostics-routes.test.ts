import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import * as ccxtProvider from '../src/providers/ccxt';
import * as defillamaProvider from '../src/providers/defillama';
import * as sqdProvider from '../src/providers/sqd';
import { resetCurrencyApiSnapshotForTests } from '../src/services/currency-rates';

function resetCcxtProviderMocks() {
  const mockedFetchExchangeMarkets = ccxtProvider.fetchExchangeMarkets as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeTickers = ccxtProvider.fetchExchangeTickers as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeOHLCV = ccxtProvider.fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeNetworks = ccxtProvider.fetchExchangeNetworks as ReturnType<typeof vi.fn>;
  const mockedCloseExchangePool = ccxtProvider.closeExchangePool as ReturnType<typeof vi.fn>;

  mockedFetchExchangeMarkets.mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
  ]);
  mockedFetchExchangeTickers.mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
  ]);
  mockedFetchExchangeOHLCV.mockResolvedValue([]);
  mockedFetchExchangeNetworks.mockResolvedValue([]);
  mockedCloseExchangePool.mockResolvedValue(undefined);
}

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn(),
  closeExchangePool: vi.fn(),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('diagnostics routes', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }

    return app;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-diagnostics-'));
    vi.restoreAllMocks();
    resetCurrencyApiSnapshotForTests();
    resetCcxtProviderMocks();
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);
    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);

    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    vi.clearAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns chain coverage diagnostics', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/chain_coverage',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data.platform_counts.total');
    expect(body).toHaveProperty('data.confidence.exact');
    expect(body).toHaveProperty('data.confidence.heuristic');
    expect(body).toHaveProperty('data.confidence.unresolved');
    expect(body).toHaveProperty('data.contract_mapping.active_coins');
    expect(typeof body.data.platform_counts.total).toBe('number');
    expect(typeof body.data.confidence.exact).toBe('number');
    expect(typeof body.data.confidence.heuristic).toBe('number');
    expect(typeof body.data.confidence.unresolved).toBe('number');
    expect(typeof body.data.contract_mapping.active_coins).toBe('number');
  });

  it('returns ohlcv worker lag and failure metrics', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/ohlcv_sync',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveProperty('top100.ready');
    expect(response.json().data).toHaveProperty('targets.waiting');
    expect(response.json().data).toHaveProperty('lag.oldest_recent_sync_ms');
  });

  it('returns endpoint-family freshness budgets', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/freshness_budgets',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.budgets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: 'simple',
        representative_routes: ['/simple/price', '/simple/token_price/:id'],
        target_freshness_seconds: 30,
        degraded_after_seconds: 120,
        budget_basis: 'latest_market_snapshot',
      }),
      expect.objectContaining({
        family: 'coins_markets',
        representative_routes: ['/coins/markets'],
        target_freshness_seconds: 60,
        degraded_after_seconds: 300,
        budget_basis: 'latest_market_snapshot',
      }),
      expect.objectContaining({
        family: 'historical_charts',
        target_freshness_seconds: null,
        degraded_after_seconds: null,
        budget_basis: 'route_interval',
      }),
    ]));
  });

  it('returns endpoint-family coverage ownership matrix', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coverage_matrix',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        generated_at: expect.any(String),
        entries: expect.arrayContaining([
          expect.objectContaining({
            family: 'simple',
            representative_routes: ['/simple/price', '/simple/token_price/:id'],
            ownership_class: expect.stringMatching(/^(live|seeded)$/),
            providers: expect.arrayContaining(['CCXT']),
            freshness: expect.objectContaining({
              target_freshness_seconds: 30,
              degraded_after_seconds: 120,
              state: expect.any(String),
            }),
            evidence: expect.objectContaining({
              tests: expect.arrayContaining(['tests/simple-price-parity.test.ts']),
            }),
          }),
          expect.objectContaining({
            family: 'onchain',
            ownership_class: expect.stringMatching(/^(hybrid|fixture)$/),
            providers: expect.arrayContaining(['DeFiLlama', 'Subsquid']),
            evidence: expect.objectContaining({
              notes: expect.stringContaining('fixture'),
            }),
          }),
          expect.objectContaining({
            family: 'derivatives',
            ownership_class: 'fixture',
            evidence: expect.objectContaining({
              notes: expect.stringContaining('fixtures'),
            }),
          }),
          expect.objectContaining({
            family: 'treasury',
            ownership_class: 'fixture',
          }),
        ]),
      },
    });
  });

  it('keeps coverage matrix entries complete enough to support release claims', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coverage_matrix',
    });

    expect(response.statusCode).toBe(200);
    const entries = response.json().data.entries as Array<{
      family: string;
      representative_routes: string[];
      ownership_class: string;
      providers: string[];
      last_successful_refresh_at: string | null;
      freshness: {
        target_freshness_seconds: number | null;
        degraded_after_seconds: number | null;
        current_age_seconds: number | null;
        state: string;
      };
      evidence: {
        tests: string[];
        notes: string;
      };
    }>;
    const expectedFamilies = [
      'simple',
      'coins_markets',
      'coin_detail',
      'exchanges',
      'onchain',
      'derivatives',
      'historical_charts',
      'treasury',
      'stable_catalog',
    ];

    expect(entries.map((entry) => entry.family).sort()).toEqual([...expectedFamilies].sort());
    expect(new Set(entries.map((entry) => entry.family)).size).toBe(entries.length);

    for (const entry of entries) {
      expect(entry.representative_routes.length).toBeGreaterThan(0);
      expect(entry.representative_routes.every((route) => route.startsWith('/'))).toBe(true);
      expect(entry.ownership_class).toMatch(/^(live|hybrid|seeded|synthetic|fixture|unavailable)$/);
      expect(entry.providers.length).toBeGreaterThan(0);
      expect(entry.providers.every((provider) => provider.trim().length > 0)).toBe(true);
      expect(entry).toHaveProperty('last_successful_refresh_at');
      expect(entry.freshness.state).toMatch(/^(fresh|degraded|stale|unbudgeted|unknown)$/);
      expect(entry.freshness).toHaveProperty('current_age_seconds');
      expect(entry.evidence.tests.length).toBeGreaterThan(0);
      expect(entry.evidence.notes.trim().length).toBeGreaterThan(0);

      for (const testPath of entry.evidence.tests) {
        expect(testPath).toMatch(/^tests\/.+\.test\.ts$/);
        expect(existsSync(testPath)).toBe(true);
      }

      if (entry.freshness.state === 'unbudgeted') {
        expect(entry.freshness.target_freshness_seconds).toBeNull();
        expect(entry.freshness.degraded_after_seconds).toBeNull();
      } else {
        expect(entry.freshness.target_freshness_seconds).toEqual(expect.any(Number));
        expect(entry.freshness.degraded_after_seconds).toEqual(expect.any(Number));
      }
    }

    const evidenceByFamily = new Map(entries.map((entry) => [entry.family, entry.evidence.tests]));
    expect(evidenceByFamily.get('onchain')).toEqual(expect.arrayContaining(['tests/provider-replay-defillama.test.ts']));
    expect(evidenceByFamily.get('derivatives')).toEqual(expect.arrayContaining(['tests/provider-replay-derivatives.test.ts']));
    expect(evidenceByFamily.get('treasury')).toEqual(expect.arrayContaining(['tests/provider-replay-treasury.test.ts']));
  });

  it('returns derivatives provider gap diagnostics for fixture-only and configured-pending venues', async () => {
    await getApp().ready();
    const fixtureOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/derivatives',
    });

    expect(fixtureOnlyResponse.statusCode).toBe(200);
    expect(fixtureOnlyResponse.json().data).toMatchObject({
      configured_venues: [],
      exchanges: expect.arrayContaining([
        expect.objectContaining({
          exchange_id: 'binance_futures',
          status: 'fixture_only',
          configured_provider_exchange_id: null,
          ticker_counts: expect.objectContaining({
            source_backed: 0,
          }),
        }),
      ]),
      gaps: expect.objectContaining({
        fixture_only_exchanges: expect.arrayContaining(['binance_futures']),
      }),
    });

    await getApp().close();
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'configured.db'),
        ccxtExchanges: ['binance'],
        derivativesCcxtExchanges: 'binance_futures=binanceusdm',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
    await getApp().ready();

    const configuredResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/derivatives',
    });

    expect(configuredResponse.statusCode).toBe(200);
    expect(configuredResponse.json().data).toMatchObject({
      configured_venues: [{
        exchange_id: 'binance_futures',
        provider_exchange_id: 'binanceusdm',
        source_provider: 'ccxt.binanceusdm',
      }],
      exchanges: expect.arrayContaining([
        expect.objectContaining({
          exchange_id: 'binance_futures',
          status: 'configured_pending',
          configured_provider_exchange_id: 'binanceusdm',
        }),
      ]),
      gaps: expect.objectContaining({
        configured_without_source_rows: ['binance_futures'],
      }),
    });
  });

  it('returns machine-readable runtime diagnostics for ready live service', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        readiness: {
          state: 'ready',
          listener_bound: false,
          initial_sync_completed: true,
          degraded: false,
          zero_live_completed_boot: false,
          validation_override_active: false,
        },
        degraded: {
          active: false,
          stale_live_enabled: false,
          reason: null,
          injected_provider_failure: {
            active: false,
            reason: null,
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            available: true,
            source_class: 'fresh_live',
            freshness: {
              threshold_seconds: 300,
              is_stale: false,
            },
          },
        },
      },
    });
    expect(typeof response.json().data.hot_paths.shared_market_snapshot.freshness.age_seconds).toBe('number');
    expect(Array.isArray(response.json().data.hot_paths.shared_market_snapshot.providers)).toBe(true);
  });
});
