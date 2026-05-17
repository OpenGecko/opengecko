import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import * as defillamaProvider from '../src/providers/defillama';
import * as sqdProvider from '../src/providers/sqd';

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
  method: 'GET';
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
  method: 'GET';
  url: string;
  status: number;
  error: string;
  message: string;
}

interface BaselineSamples {
  routes: BaselineRouteSample[];
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

  it('documents representative runtime, scheduling, ingestion, OHLCV, and proof guards in the baseline suite', async () => {
    const baseline = await loadBaselineSamples();
    const baselineIds = new Set([
      ...baseline.routes.map((sample) => sample.id),
      ...baseline.errors.map((sample) => sample.id),
    ]);

    expect(Array.from(baselineIds)).toEqual(expect.arrayContaining([
      'diagnostics-runtime',
      'diagnostics-cache',
      'diagnostics-exchanges',
      'diagnostics-coverage-matrix',
      'diagnostics-market-charts',
      'diagnostics-jobs',
      'coins-markets',
      'exchange-tickers',
      'market-chart',
      'ohlc',
      'simple-price-missing-selector',
      'coins-markets-unsupported-order',
      'exchange-tickers-unsupported-order',
    ]));

    const proofScript = await readFile(join(process.cwd(), 'scripts/operator-proof-smoke.sh'), 'utf8');
    expect(proofScript).toContain('RESERVED_PORTS=(3100 3101 3102)');
    expect(proofScript).toContain('check_reserved_ports_clear "preflight"');
    expect(proofScript).toContain('check_reserved_ports_clear "post-cleanup"');
    expect(proofScript).toContain('/diagnostics/runtime/degraded_state');
    expect(proofScript).toContain('/diagnostics/runtime/provider_failure');

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
