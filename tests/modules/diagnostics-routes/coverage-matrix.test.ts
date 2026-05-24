import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../../src/app';
import {
  chartPoints,
  coinTickers,
  exchanges,
  exchangeVolumeSourcePoints,
  marketChartSourcePoints,
  marketSnapshots,
  ohlcvCandles,
  ohlcvSyncTargets,
} from '../../../src/db/schema';
import { upsertCanonicalOhlcvCandle } from '../../../src/services/candle-store';
import * as ccxtProvider from '../../../src/providers/ccxt';
import * as defillamaProvider from '../../../src/providers/defillama';
import * as sqdProvider from '../../../src/providers/sqd';
import { resetCurrencyApiSnapshotForTests } from '../../../src/services/currency-rates';
import {
  COINS_MARKETS_ROUTE_CACHE_POLICY,
  SIMPLE_PRICE_ROUTE_CACHE_POLICY,
} from '../../../src/modules/route-cache-policies';
import {
  ingestCoinHistoryReplay,
  type RawCoinHistoryReplay,
} from '../../../src/services/coin-history-ingestion';
import { syncCoinHistorySnapshots } from '../../../src/services/coin-history-sync';
import {
  ingestExchangeVolumeReplay,
  type RawExchangeVolumeReplay,
} from '../../../src/services/exchange-volume-ingestion';
import { syncExchangeVolumes } from '../../../src/services/exchange-volume-sync';
import {
  ingestMarketChartReplay,
  type RawMarketChartReplay,
} from '../../../src/services/market-chart-ingestion';
import { buildMarketChartProviderDiagnostics } from '../../../src/services/market-chart-diagnostics';
import { syncMarketCharts } from '../../../src/services/market-chart-sync';
import {
  ingestOnchainAnalyticsReplay,
  type RawOnchainAnalyticsReplay,
} from '../../../src/services/onchain-analytics-ingestion';
import { syncOnchainAnalytics } from '../../../src/services/onchain-analytics-sync';
import {
  ingestOnchainTradeReplay,
  type RawOnchainTradeReplay,
} from '../../../src/services/onchain-trade-ingestion';
import { syncOnchainTrades } from '../../../src/services/onchain-trade-sync';
import {
  ingestSupplyChartReplay,
  type RawSupplyChartReplay,
} from '../../../src/services/supply-chart-ingestion';
import { syncSupplyCharts } from '../../../src/services/supply-chart-sync';

const REQUIRED_RUNTIME_PROVIDER_FIELDS = [
  'id',
  'state',
  'last_success_at',
  'last_failure_at',
  'last_failure_reason',
  'failure_count',
  'next_retry_at',
  'alert_status',
] as const;

function resetCcxtProviderMocks() {
  const mockedFetchExchangeMarkets = ccxtProvider.fetchExchangeMarkets as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeTickers = ccxtProvider.fetchExchangeTickers as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeDerivativeTickers = ccxtProvider.fetchExchangeDerivativeTickers as ReturnType<typeof vi.fn>;
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
  mockedFetchExchangeDerivativeTickers.mockResolvedValue([]);
  mockedFetchExchangeOHLCV.mockResolvedValue([]);
  mockedFetchExchangeNetworks.mockResolvedValue([]);
  mockedCloseExchangePool.mockResolvedValue(undefined);
}

vi.mock('../../../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeDerivativeTickers: vi.fn().mockResolvedValue([]),
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

  function loadOnchainAnalyticsFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/onchain-analytics/eth-usdc-token-analytics.json'),
      'utf8',
    )) as RawOnchainAnalyticsReplay;
  }

  function loadCoinHistoryFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/coin-history/bitcoin-2026-03-20.json'),
      'utf8',
    )) as RawCoinHistoryReplay;
  }

  function loadExchangeVolumeFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/exchange-volumes/binance-volume.json'),
      'utf8',
    )) as RawExchangeVolumeReplay;
  }

  function loadMarketChartFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/market-charts/bitcoin-chart.json'),
      'utf8',
    )) as RawMarketChartReplay;
  }

  function loadOnchainTradeFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/onchain-trades/eth-usdc-weth-pool-trades.json'),
      'utf8',
    )) as RawOnchainTradeReplay;
  }

  function loadSupplyChartFixture() {
    return JSON.parse(readFileSync(
      join(process.cwd(), 'tests/fixtures/provider-replay/supply-charts/bitcoin-supply.json'),
      'utf8',
    )) as RawSupplyChartReplay;
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

  it('returns endpoint-family coverage ownership matrix', async () => {
    await getApp().ready();
    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coverage_matrix',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        schema_version: 1,
        generated_at: expect.any(String),
        classification_contract: {
          contract_support_statuses: ['supported'],
          data_fidelity_classifications: expect.arrayContaining(['live', 'hybrid', 'seeded', 'fixture', 'synthetic', 'unavailable']),
          source_states: expect.arrayContaining(['live', 'seeded', 'fixture', 'replay', 'stale', 'out_of_scope']),
          live_data_rules: expect.objectContaining({
            contract_support_does_not_imply_live_data: true,
            only_data_fidelity_classification_live_counts_as_live: true,
          }),
        },
        entries: expect.arrayContaining([
          expect.objectContaining({
            family: 'simple',
            representative_routes: ['/simple/price', '/simple/token_price/:id'],
            ownership_class: expect.stringMatching(/^(live|seeded)$/),
            contract_support: expect.objectContaining({
              status: 'supported',
              supported: true,
            }),
            data_fidelity: expect.objectContaining({
              classification: expect.stringMatching(/^(live|seeded)$/),
              counts_as_live: expect.any(Boolean),
              freshness_state: expect.any(String),
            }),
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

  it('promotes coverage matrix only from source-backed fresh snapshots and historical rows', async () => {
    await getApp().ready();
    const now = new Date('2026-05-14T12:00:00.000Z');
    getApp().db.db.update(marketSnapshots).set({
      sourceProvidersJson: JSON.stringify([]),
      sourceCount: 0,
      lastUpdated: now,
      updatedAt: now,
    }).run();
    getApp().db.db.delete(ohlcvCandles).run();
    getApp().db.db.delete(marketChartSourcePoints).run();

    const fixtureOnlyResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coverage_matrix',
    });
    const fixtureOnlyEntries = fixtureOnlyResponse.json().data.entries as Array<{ family: string; ownership_class: string }>;

    expect(fixtureOnlyEntries.find((entry) => entry.family === 'simple')?.ownership_class).toBe('seeded');
    expect(fixtureOnlyEntries.find((entry) => entry.family === 'coins_markets')?.ownership_class).toBe('seeded');

    getApp().db.db.update(marketSnapshots).set({
      sourceProvidersJson: JSON.stringify(['binance']),
      sourceCount: 1,
      lastUpdated: now,
      updatedAt: now,
    }).where(and(
      eq(marketSnapshots.coinId, 'bitcoin'),
      eq(marketSnapshots.vsCurrency, 'usd'),
    )).run();
    upsertCanonicalOhlcvCandle(getApp().db, {
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
      timestamp: now,
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 10,
      source: 'canonical',
      replaceExisting: true,
    });

    const promotedResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/coverage_matrix',
    });
    const promotedEntries = promotedResponse.json().data.entries as Array<{
      family: string;
      ownership_class: string;
      last_successful_refresh_at: string | null;
      evidence: { notes: string };
    }>;

    expect(promotedEntries.find((entry) => entry.family === 'simple')).toMatchObject({
      ownership_class: 'live',
      last_successful_refresh_at: now.toISOString(),
    });
    expect(promotedEntries.find((entry) => entry.family === 'coins_markets')).toMatchObject({
      ownership_class: 'live',
      last_successful_refresh_at: now.toISOString(),
    });
    expect(promotedEntries.find((entry) => entry.family === 'historical_charts')).toMatchObject({
      ownership_class: 'seeded',
      last_successful_refresh_at: null,
    });
    expect(promotedEntries.find((entry) => entry.family === 'historical_charts')?.evidence.notes).toContain(
      'live classification requires at least 30 live points',
    );
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
      contract_support: {
        status: string;
        supported: boolean;
        representative_route_count: number;
        representative_routes: string[];
        evidence_tests: string[];
      };
      data_fidelity: {
        classification: string;
        source_state: string;
        counts_as_live: boolean;
        non_live: boolean;
        reason_codes: string[];
        latest_source_at: string | null;
        freshness_state: string;
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
      'supply_charts',
      'treasury',
      'stable_catalog',
    ];

    expect(entries.map((entry) => entry.family).sort()).toEqual([...expectedFamilies].sort());
    expect(new Set(entries.map((entry) => entry.family)).size).toBe(entries.length);

    for (const entry of entries) {
      expect(entry.representative_routes.length).toBeGreaterThan(0);
      expect(entry.representative_routes.every((route) => route.startsWith('/'))).toBe(true);
      expect(entry.ownership_class).toMatch(/^(live|hybrid|seeded|synthetic|fixture|unavailable)$/);
      expect(entry.contract_support).toMatchObject({
        status: 'supported',
        supported: true,
        representative_route_count: entry.representative_routes.length,
        representative_routes: entry.representative_routes,
        evidence_tests: entry.evidence.tests,
      });
      expect(entry.data_fidelity.classification).toBe(entry.ownership_class);
      expect(entry.data_fidelity.source_state).toBe(entry.ownership_class);
      expect(entry.data_fidelity.counts_as_live).toBe(entry.ownership_class === 'live');
      expect(entry.data_fidelity.non_live).toBe(entry.ownership_class !== 'live');
      expect(entry.data_fidelity.freshness_state).toBe(entry.freshness.state);
      expect(entry.data_fidelity.latest_source_at).toBe(entry.last_successful_refresh_at);
      if (entry.ownership_class === 'live') {
        expect(entry.data_fidelity.reason_codes).toEqual([]);
      } else {
        expect(entry.data_fidelity.reason_codes.length).toBeGreaterThan(0);
      }
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

});
