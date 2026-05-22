import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { coinTickers, coins, ohlcvSyncTargets, quoteSnapshots } from '../src/db/schema';
import * as defillamaProvider from '../src/providers/defillama';
import * as sqdProvider from '../src/providers/sqd';
import { runMarketRefreshOnce } from '../src/services/market-refresh';
import { syncRecentOhlcvWindow } from '../src/services/ohlcv-sync';
import { leaseNextOhlcvTarget } from '../src/services/ohlcv-worker-state';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeDerivativeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import {
  fetchExchangeMarkets,
  fetchExchangeOHLCV,
  fetchExchangeTickers,
} from '../src/providers/ccxt';

type JsonRecord = Record<string, unknown>;

interface BaselineRouteSample {
  id: string;
  method: 'GET' | 'POST';
  url: string;
  status: number;
  body_kind: 'array' | 'object';
  key_set?: string[];
  key_subset?: string[];
  item_key_subset?: string[];
  nested_key_subsets?: Record<string, string[]>;
  nested_array_key_subsets?: Record<string, string[]>;
  data_key_subset?: string[];
  array_tuple_length?: number;
}

interface BaselineErrorSample {
  id: string;
  method: 'GET' | 'POST';
  url: string;
  body?: JsonRecord;
  status: number;
  error: string;
  message: string;
}

interface BaselineSamples {
  routes: BaselineRouteSample[];
  degraded_routes: BaselineRouteSample[];
  errors: BaselineErrorSample[];
}

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeTickers = fetchExchangeTickers as ReturnType<typeof vi.fn>;
const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;

function asRecord(value: unknown): JsonRecord {
  expect(value).toBeTruthy();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as JsonRecord;
}

function sortedKeys(value: JsonRecord): string[] {
  return Object.keys(value).sort();
}

function expectKeySubset(value: JsonRecord, expectedKeys: string[]) {
  for (const key of expectedKeys) {
    expect(value, `expected key ${key}`).toHaveProperty(key);
  }
}

async function loadBaselineSamples(): Promise<BaselineSamples> {
  const fixture = await readFile(
    join(process.cwd(), 'tests/fixtures/refactor-baseline/public-route-samples.json'),
    'utf8',
  );
  return JSON.parse(fixture) as BaselineSamples;
}

function resetProviderMocks() {
  mockedFetchExchangeMarkets.mockReset();
  mockedFetchExchangeTickers.mockReset();
  mockedFetchExchangeOHLCV.mockReset();

  mockedFetchExchangeMarkets.mockImplementation(async (exchangeId: string) => {
    if (exchangeId === 'binance') {
      return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
      ];
    }

    if (exchangeId === 'coinbase') {
      return [
        { exchangeId: 'coinbase', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
    }

    return [];
  });

  mockedFetchExchangeTickers.mockImplementation(async (exchangeId: string) => {
    if (exchangeId === 'binance') {
      return [
        {
          exchangeId: 'binance',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          last: 85_000,
          bid: 84_950,
          ask: 85_050,
          high: 86_000,
          low: 84_000,
          baseVolume: 5_000,
          quoteVolume: 425_000_000,
          percentage: 1.8,
          timestamp: Date.now(),
          raw: {} as never,
        },
        {
          exchangeId: 'binance',
          symbol: 'ETH/USDT',
          base: 'ETH',
          quote: 'USDT',
          last: 2_000,
          bid: 1_999,
          ask: 2_001,
          high: 2_050,
          low: 1_950,
          baseVolume: 50_000,
          quoteVolume: 100_000_000,
          percentage: 2.56,
          timestamp: Date.now(),
          raw: {} as never,
        },
      ];
    }

    if (exchangeId === 'coinbase') {
      return [
        {
          exchangeId: 'coinbase',
          symbol: 'BTC/USD',
          base: 'BTC',
          quote: 'USD',
          last: 85_100,
          bid: 85_050,
          ask: 85_150,
          high: 86_100,
          low: 84_100,
          baseVolume: 3_000,
          quoteVolume: 255_300_000,
          percentage: 1.7,
          timestamp: Date.now(),
          raw: {} as never,
        },
      ];
    }

    return [];
  });

  mockedFetchExchangeOHLCV.mockResolvedValue([]);
}

describe('pre-refactor characterization baseline', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-refactor-baseline-'));
    vi.restoreAllMocks();
    resetProviderMocks();
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);
    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);

    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        port: 3102,
        ccxtExchanges: ['binance', 'coinbase'],
        logLevel: 'silent',
        marketFreshnessThresholdSeconds: 300,
        disableRemoteCurrencyRefresh: true,
      },
      startBackgroundJobs: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    vi.clearAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('replays the captured public route and diagnostics status/key-set samples', async () => {
    const baseline = await loadBaselineSamples();

    for (const sample of baseline.routes) {
      const response = await app!.inject({
        method: sample.method,
        url: sample.url,
      });
      expect(response.statusCode, sample.id).toBe(sample.status);

      const body = response.json() as unknown;
      if (sample.body_kind === 'array') {
        expect(Array.isArray(body), sample.id).toBe(true);
        const bodyArray = body as unknown[];
        if (sample.item_key_subset && bodyArray.length > 0) {
          expectKeySubset(asRecord(bodyArray[0]), sample.item_key_subset);
        }
        if (sample.array_tuple_length && bodyArray.length > 0) {
          expect(bodyArray[0], sample.id).toHaveLength(sample.array_tuple_length);
        }
        continue;
      }

      const bodyRecord = asRecord(body);
      if (sample.key_set) {
        expect(sortedKeys(bodyRecord), sample.id).toEqual([...sample.key_set].sort());
      }
      if (sample.key_subset) {
        expectKeySubset(bodyRecord, sample.key_subset);
      }
      if (sample.data_key_subset) {
        expectKeySubset(asRecord(bodyRecord.data), sample.data_key_subset);
      }
      if (sample.nested_key_subsets) {
        for (const [key, nestedKeys] of Object.entries(sample.nested_key_subsets)) {
          expectKeySubset(asRecord(bodyRecord[key]), nestedKeys);
        }
      }
      if (sample.nested_array_key_subsets) {
        for (const [key, nestedKeys] of Object.entries(sample.nested_array_key_subsets)) {
          const nestedArray = bodyRecord[key] as unknown[];
          expect(Array.isArray(nestedArray), `${sample.id}.${key}`).toBe(true);
          if (nestedArray.length > 0) {
            expectKeySubset(asRecord(nestedArray[0]), nestedKeys);
          }
        }
      }
    }
  });

  it('pins canonical error envelopes for validation and not-found boundaries', async () => {
    const baseline = await loadBaselineSamples();

    for (const sample of baseline.errors) {
      const response = await app!.inject({
        method: sample.method,
        url: sample.url,
        payload: sample.body,
      });
      const body = asRecord(response.json());

      expect(response.statusCode, sample.id).toBe(sample.status);
      expect(sortedKeys(body), sample.id).toEqual(['error', 'message']);
      expect(body).toEqual({
        error: sample.error,
        message: sample.message,
      });
    }
  });

  it('replays degraded and unavailable-provider route/diagnostics baseline samples', async () => {
    const baseline = await loadBaselineSamples();

    for (const sample of baseline.degraded_routes) {
      if (sample.id.startsWith('provider-failure')) {
        const controlResponse = await app!.inject({
          method: 'POST',
          url: '/diagnostics/runtime/provider_failure',
          payload: {
            active: true,
            reason: 'validator forced outage',
          },
        });
        expect(controlResponse.statusCode, `${sample.id}: provider failure control`).toBe(200);
      }

      if (sample.id.startsWith('degraded-seeded')) {
        const controlResponse = await app!.inject({
          method: 'POST',
          url: '/diagnostics/runtime/degraded_state',
          payload: {
            mode: 'degraded_seeded_bootstrap',
            reason: 'validator degraded boot',
          },
        });
        expect(controlResponse.statusCode, `${sample.id}: degraded state control`).toBe(200);
      }

      const response = await app!.inject({
        method: sample.method,
        url: sample.url,
      });
      expect(response.statusCode, sample.id).toBe(sample.status);

      const body = response.json() as unknown;
      if (sample.body_kind === 'array') {
        expect(Array.isArray(body), sample.id).toBe(true);
        const bodyArray = body as unknown[];
        expect(bodyArray.length, sample.id).toBeGreaterThan(0);
        if (sample.item_key_subset) {
          expectKeySubset(asRecord(bodyArray[0]), sample.item_key_subset);
        }
        if (sample.id === 'degraded-seeded-coins-markets') {
          expect(asRecord(bodyArray[0])).toMatchObject({
            id: 'bitcoin',
            market_cap: null,
            market_cap_rank: null,
            total_volume: null,
            last_updated: null,
          });
        }
        continue;
      }

      const bodyRecord = asRecord(body);
      if (sample.key_subset) {
        expectKeySubset(bodyRecord, sample.key_subset);
      }
      if (sample.data_key_subset) {
        expectKeySubset(asRecord(bodyRecord.data), sample.data_key_subset);
      }

      const data = asRecord(bodyRecord.data);
      if (sample.id === 'provider-failure-diagnostics-runtime') {
        expect(asRecord(data.degraded)).toMatchObject({
          active: false,
          injected_provider_failure: {
            active: true,
            reason: 'validator forced outage',
          },
        });
      }
      if (sample.id === 'degraded-seeded-diagnostics-runtime') {
        expect(asRecord(data.readiness)).toMatchObject({
          state: 'degraded',
          validation_override_active: true,
        });
        expect(asRecord(asRecord(data.hot_paths).shared_market_snapshot)).toMatchObject({
          source_class: 'degraded_seeded_bootstrap',
          provider_count: 0,
        });
      }

      await app!.inject({
        method: 'POST',
        url: '/diagnostics/runtime/provider_failure',
        payload: { active: false },
      });
      await app!.inject({
        method: 'POST',
        url: '/diagnostics/runtime/degraded_state',
        payload: { mode: 'off' },
      });
    }
  });

  it('characterizes table-driven OHLCV lease ordering and cursor promotion boundaries', async () => {
    const now = new Date('2026-03-23T00:00:00.000Z');
    const ensureCoin = (id: string, rank: number) => {
      app!.db.db.insert(coins).values({
        id,
        symbol: id.slice(0, 3),
        name: id,
        apiSymbol: id,
        hashingAlgorithm: null,
        blockTimeInMinutes: null,
        categoriesJson: '[]',
        descriptionJson: '{}',
        linksJson: '{}',
        imageThumbUrl: null,
        imageSmallUrl: null,
        imageLargeUrl: null,
        marketCapRank: rank,
        genesisDate: null,
        platformsJson: '{}',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
    };
    const seedTarget = (values: Partial<typeof ohlcvSyncTargets.$inferInsert> & Pick<typeof ohlcvSyncTargets.$inferInsert, 'coinId' | 'exchangeId' | 'symbol'>) => {
      app!.db.db.insert(ohlcvSyncTargets).values({
        coinId: values.coinId,
        exchangeId: values.exchangeId,
        symbol: values.symbol,
        vsCurrency: values.vsCurrency ?? 'usd',
        interval: values.interval ?? '1d',
        priorityTier: values.priorityTier ?? 'long_tail',
        latestSyncedAt: values.latestSyncedAt ?? null,
        oldestSyncedAt: values.oldestSyncedAt ?? null,
        targetHistoryDays: values.targetHistoryDays ?? 365,
        status: values.status ?? 'idle',
        lastAttemptAt: values.lastAttemptAt ?? null,
        lastSuccessAt: values.lastSuccessAt ?? null,
        lastError: values.lastError ?? null,
        failureCount: values.failureCount ?? 0,
        nextRetryAt: values.nextRetryAt ?? null,
        lastRequestedAt: values.lastRequestedAt ?? null,
        createdAt: values.createdAt ?? new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: values.updatedAt ?? new Date('2026-03-22T00:00:00.000Z'),
      }).run();
    };

    const leaseCases = [
      {
        name: 'top100 target ranks ahead of long-tail target',
        targets: [
          { coinId: 'some-microcap', exchangeId: 'binance', symbol: 'SMC/USDT', priorityTier: 'long_tail' as const },
          { coinId: 'bitcoin', exchangeId: 'binance', symbol: 'BTC/USDT', priorityTier: 'top100' as const },
        ],
        expected: { coinId: 'bitcoin', interval: '1d' },
      },
      {
        name: 'retry-due failure ranks ahead of idle peer in same tier',
        targets: [
          { coinId: 'bitcoin', exchangeId: 'binance', symbol: 'BTC/USDT', priorityTier: 'top100' as const, status: 'idle' as const },
          { coinId: 'ethereum', exchangeId: 'binance', symbol: 'ETH/USDT', priorityTier: 'top100' as const, status: 'failed' as const, failureCount: 1, nextRetryAt: new Date('2026-03-22T23:59:00.000Z') },
        ],
        expected: { coinId: 'ethereum', interval: '1d' },
      },
      {
        name: 'never-synced intraday target ranks ahead of complete daily backfill',
        targets: [
          { coinId: 'bitcoin', exchangeId: 'binance', symbol: 'BTC/USDT', interval: '1d' as const, priorityTier: 'top100' as const, latestSyncedAt: new Date('2026-03-22T00:00:00.000Z'), oldestSyncedAt: new Date('2021-03-23T00:00:00.000Z'), targetHistoryDays: 3650, lastSuccessAt: new Date('2026-03-22T00:00:00.000Z') },
          { coinId: 'bitcoin', exchangeId: 'binance', symbol: 'BTC/USDT', interval: '1m' as const, priorityTier: 'top100' as const, targetHistoryDays: 30 },
        ],
        expected: { coinId: 'bitcoin', interval: '1m' },
      },
      {
        name: 'retry-backoff target is not eligible',
        targets: [
          { coinId: 'bitcoin', exchangeId: 'binance', symbol: 'BTC/USDT', priorityTier: 'top100' as const, status: 'failed' as const, failureCount: 2, nextRetryAt: new Date('2026-03-23T00:10:00.000Z') },
        ],
        expected: null,
      },
    ];

    for (const leaseCase of leaseCases) {
      app!.db.client.prepare('DELETE FROM ohlcv_sync_targets').run();
      for (const [index, coinId] of ['bitcoin', 'ethereum', 'some-microcap'].entries()) {
        ensureCoin(coinId, index + 1);
      }
      for (const target of leaseCase.targets) {
        seedTarget(target);
      }

      const leased = leaseNextOhlcvTarget(app!.db, now);
      if (leaseCase.expected === null) {
        expect(leased, leaseCase.name).toBeNull();
      } else {
        expect(leased, leaseCase.name).toMatchObject({
          ...leaseCase.expected,
          status: 'running',
          lastAttemptAt: now,
        });
      }
    }

    app!.db.client.prepare("DELETE FROM ohlcv_candles WHERE coin_id = 'bitcoin'").run();
    mockedFetchExchangeOHLCV.mockResolvedValue([
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2026-03-22T00:00:00.000Z'),
        open: 82_000,
        high: 81_000,
        low: 83_000,
        close: 82_500,
        volume: 1_200,
        raw: [0, 0, 0, 0, 0, 0],
      },
      {
        exchangeId: 'binance',
        symbol: 'BTC/USDT',
        timeframe: '1d',
        timestamp: Date.parse('2026-03-23T00:00:00.000Z'),
        open: 83_000,
        high: 84_000,
        low: 82_000,
        close: 83_500,
        volume: 1_300,
        raw: [0, 0, 0, 0, 0, 0],
      },
    ]);

    const result = await syncRecentOhlcvWindow(app!.db, {
      coinId: 'bitcoin',
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      vsCurrency: 'usd',
      interval: '1d',
      priorityTier: 'top100',
      latestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      oldestSyncedAt: new Date('2026-03-21T00:00:00.000Z'),
      targetHistoryDays: 30,
    }, now);

    expect(result.rawFetchedCount).toBe(2);
    expect(result.acceptedCount).toBe(1);
    expect(result.persistedCount).toBe(1);
    expect(result.acceptedCandles.map((candle) => candle.timestamp)).toEqual([Date.parse('2026-03-23T00:00:00.000Z')]);
  });

  it('characterizes table-driven market and ticker ingestion acceptance and rejection decisions', async () => {
    const cases = [
      {
        name: 'accepts finite supported BTC/USD ticker',
        exchangeId: 'binance',
        market: { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin' },
        ticker: { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', last: 90_000, bid: 89_990, ask: 90_010, baseVolume: 10, quoteVolume: 900_000, timestamp: Date.now() - 60_000, raw: {} },
        accepted: true,
      },
      {
        name: 'rejects non-finite price',
        exchangeId: 'coinbase',
        market: { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin' },
        ticker: { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', last: Number.NaN, bid: null, ask: null, baseVolume: null, quoteVolume: null, timestamp: Date.now() - 60_000, raw: {} },
        accepted: false,
      },
      {
        name: 'rejects provider-stale candidate',
        exchangeId: 'kraken',
        market: { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin' },
        ticker: { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', last: 91_000, bid: 90_990, ask: 91_010, baseVolume: 10, quoteVolume: 910_000, timestamp: Date.now() - 60_000, raw: { isStale: true } },
        accepted: false,
      },
    ];

    for (const ingestionCase of cases) {
      app!.db.client.prepare('DELETE FROM coin_tickers').run();
      app!.db.client.prepare('DELETE FROM quote_snapshots').run();
      mockedFetchExchangeMarkets.mockImplementation(async (exchangeId: string) => exchangeId === ingestionCase.exchangeId
        ? [{ exchangeId, raw: {}, ...ingestionCase.market }]
        : []);
      mockedFetchExchangeTickers.mockImplementation(async (exchangeId: string) => exchangeId === ingestionCase.exchangeId
        ? [{ exchangeId, high: null, low: null, percentage: null, ...ingestionCase.ticker } as never]
        : []);

      await runMarketRefreshOnce(app!.db, {
        ccxtExchanges: [ingestionCase.exchangeId],
        providerFanoutConcurrency: 1,
      });

      const tickers = app!.db.db.select().from(coinTickers).all();
      const quotes = app!.db.db.select().from(quoteSnapshots).all();
      if (ingestionCase.accepted) {
        expect(tickers, ingestionCase.name).toHaveLength(1);
        expect(quotes, ingestionCase.name).toHaveLength(1);
        expect(tickers[0]).toMatchObject({
          coinId: 'bitcoin',
          exchangeId: ingestionCase.exchangeId,
          convertedLastUsd: 90_000,
        });
      } else {
        expect(tickers, ingestionCase.name).toHaveLength(0);
        expect(quotes, ingestionCase.name).toHaveLength(0);
      }
    }
  });

  it('documents representative runtime, scheduling, ingestion, OHLCV, and proof guards in the baseline suite', async () => {
    const baseline = await loadBaselineSamples();
    const baselineIds = new Set([
      ...baseline.routes.map((sample) => sample.id),
      ...baseline.degraded_routes.map((sample) => sample.id),
      ...baseline.errors.map((sample) => sample.id),
    ]);

    expect(Array.from(baselineIds)).toEqual(expect.arrayContaining([
      'diagnostics-runtime',
      'diagnostics-cache',
      'diagnostics-exchanges',
      'diagnostics-coverage-matrix',
      'diagnostics-market-charts',
      'diagnostics-jobs',
      'provider-failure-diagnostics-runtime',
      'degraded-seeded-diagnostics-runtime',
      'degraded-seeded-coins-markets',
      'coins-markets',
      'exchange-tickers',
      'market-chart',
      'ohlc',
      'simple-price-missing-selector',
      'invalid-degraded-state-mode',
      'coins-markets-unsupported-order',
      'exchange-tickers-unsupported-order',
    ]));

    const proofScript = await readFile(join(process.cwd(), 'scripts/operator-proof-smoke.sh'), 'utf8');
    const proofHelpers = await readFile(join(process.cwd(), 'scripts/lib/operator-proof-helpers.sh'), 'utf8');
    const proofContract = `${proofScript}\n${proofHelpers}`;
    expect(proofContract).toContain('RESERVED_PORTS=(3100 3102 3103)');
    expect(proofContract).toContain('check_reserved_ports_clear "preflight"');
    expect(proofContract).toContain('check_reserved_ports_clear "post-cleanup"');
    expect(proofContract).toContain('run_data_quality_gate_serially "http://127.0.0.1:3103"');
    expect(proofContract).toContain('/diagnostics/runtime/degraded_state');
    expect(proofContract).toContain('/diagnostics/runtime/provider_failure');

    const proofScriptResponse = await app!.inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });
    const runtime = asRecord(asRecord(proofScriptResponse.json()).data);
    expect(asRecord(runtime.readiness)).toEqual(expect.objectContaining({
      state: expect.stringMatching(/^(starting|ready|degraded)$/),
      listener_bound: expect.any(Boolean),
      initial_sync_completed: expect.any(Boolean),
      degraded: expect.any(Boolean),
    }));
    expect(asRecord(runtime.hot_paths)).toHaveProperty('cache_revision');
  });
});
