import { mkdtempSync, rmSync } from 'node:fs';
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
  const mockedFetchExchangeDerivativeTickers = ccxtProvider.fetchExchangeDerivativeTickers as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeOHLCV = ccxtProvider.fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
  const mockedFetchExchangeNetworks = ccxtProvider.fetchExchangeNetworks as ReturnType<typeof vi.fn>;
  const mockedCloseExchangePool = ccxtProvider.closeExchangePool as ReturnType<typeof vi.fn>;

  mockedFetchExchangeMarkets.mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
  ]);
  mockedFetchExchangeTickers.mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85_000, bid: 84_950, ask: 85_050, high: 86_000, low: 84_000, baseVolume: 5_000, quoteVolume: 425_000_000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
  ]);
  mockedFetchExchangeDerivativeTickers.mockResolvedValue([]);
  mockedFetchExchangeOHLCV.mockResolvedValue([]);
  mockedFetchExchangeNetworks.mockResolvedValue([]);
  mockedCloseExchangePool.mockResolvedValue(undefined);
}

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeDerivativeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn(),
  closeExchangePool: vi.fn(),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

describe('data quality diagnostics', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-data-quality-'));
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
        port: 3102,
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance'],
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

  function getApp() {
    if (!app) {
      throw new Error('Test app was not initialized.');
    }
    return app;
  }

  it('exposes stable finite 0-10 scores, dimensions, aliases, and aggregate gate details', async () => {
    await getApp().ready();

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data as {
      target_threshold: number;
      score_scale: { min: number; max: number };
      family_aliases: Record<string, string[]>;
      aliases: Record<string, string[]>;
      gate: {
        status: string;
        threshold: number;
        below_target_families: Array<{
          family: string;
          score: number;
          failing_dimensions: string[];
          reason_codes: string[];
        }>;
      };
      families: Array<{
        family: string;
        score: number;
        target_threshold: number;
        status: string;
        score_scopes: Record<string, number>;
        dimensions: Array<{ id: string; score: number; reason_codes: string[] }>;
        source: { state: string; fallback: boolean; latest_source_at: string | null; provider_ids: string[] };
        counts: Record<string, number>;
        timestamps: Record<string, string | null>;
        evidence: { representative_routes: string[]; contract_tests: string[]; runtime_degradation: { active: boolean } };
        reason_codes: string[];
      }>;
      stable_regression_fields: string[];
    };

    expect(data.target_threshold).toBe(9);
    expect(data.score_scale).toMatchObject({ min: 0, max: 10 });
    expect(data.family_aliases.coins).toEqual(expect.arrayContaining(['coins_markets', 'coin_detail']));
    expect(data.family_aliases.assets).toEqual(expect.arrayContaining(['stable_catalog']));
    expect(data.aliases.historical_charts).toEqual(expect.arrayContaining(['historical_charts']));
    expect(data.stable_regression_fields).toEqual(expect.arrayContaining([
      'families[].score',
      'families[].source',
      'families[].reason_codes',
    ]));

    const requiredFamilies = ['simple', 'coins', 'exchanges', 'global', 'search', 'assets', 'treasury', 'onchain', 'derivatives', 'supply', 'historical'];
    expect(data.families.map((family) => family.family).sort()).toEqual(requiredFamilies.sort());

    for (const family of data.families) {
      expect(Number.isFinite(family.score)).toBe(true);
      expect(family.score).toBeGreaterThanOrEqual(0);
      expect(family.score).toBeLessThanOrEqual(10);
      expect(family.target_threshold).toBe(9);
      expect(family.dimensions.map((dimension) => dimension.id).sort()).toEqual([
        'completeness_coverage',
        'contract_compatibility',
        'fixture_fallback_transparency',
        'freshness_liveness',
        'live_source_fidelity',
        'metadata_truthfulness',
      ].sort());
      for (const dimension of family.dimensions) {
        expect(Number.isFinite(dimension.score)).toBe(true);
        expect(dimension.score).toBeGreaterThanOrEqual(0);
        expect(dimension.score).toBeLessThanOrEqual(10);
      }
      expect(family.evidence.representative_routes.length).toBeGreaterThan(0);
      expect(family.evidence.contract_tests.length).toBeGreaterThan(0);
      expect(family.counts.representative_route_count).toBeGreaterThan(0);
      expect(family.timestamps.generated_at).toEqual(expect.any(String));
    }

    const belowTarget = data.families.filter((family) => family.score < data.target_threshold);
    expect(data.gate.status).toBe(belowTarget.length > 0 ? 'fail' : 'pass');
    expect(data.gate.threshold).toBe(9);
    expect(data.gate.below_target_families.map((family) => family.family).sort()).toEqual(
      belowTarget.map((family) => family.family).sort(),
    );
    for (const family of data.gate.below_target_families) {
      expect(family.failing_dimensions.length).toBeGreaterThan(0);
      expect(family.reason_codes.length).toBeGreaterThan(0);
    }
  });

  it('prevents fixture, seeded, and hybrid families from claiming 9/10 live fidelity', async () => {
    await getApp().ready();

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(response.statusCode).toBe(200);
    const families = response.json().data.families as Array<{
      family: string;
      source: { state: string; fallback: boolean };
      score_scopes: { live_source_fidelity: number; fixture_fallback_transparency: number };
      reason_codes: string[];
    }>;

    for (const family of families.filter((entry) => entry.source.state !== 'live')) {
      expect(family.source.fallback).toBe(true);
      expect(family.score_scopes.live_source_fidelity).toBeLessThan(9);
      expect(family.score_scopes.fixture_fallback_transparency).toBeGreaterThanOrEqual(9);
      expect(family.reason_codes.length).toBeGreaterThan(0);
    }
  });

  it('propagates controlled runtime degradation into affected quality scores', async () => {
    await getApp().ready();

    const beforeResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });
    const beforeSimple = (beforeResponse.json().data.families as Array<{
      family: string;
      score_scopes: { live_source_fidelity: number; };
    }>).find((family) => family.family === 'simple');

    const overrideResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/degraded_state',
      payload: {
        mode: 'stale_disallowed',
        reason: 'test stale source',
      },
    });
    expect(overrideResponse.statusCode).toBe(200);

    const degradedResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(degradedResponse.statusCode).toBe(200);
    const simple = (degradedResponse.json().data.families as Array<{
      family: string;
      source: { state: string };
      score_scopes: { live_source_fidelity: number; freshness_liveness?: number };
      evidence: { runtime_degradation: { active: boolean; reason_codes: string[]; reason: string | null } };
      reason_codes: string[];
    }>).find((family) => family.family === 'simple');

    expect(simple).toBeDefined();
    expect(simple?.evidence.runtime_degradation).toMatchObject({
      active: true,
      reason_codes: expect.arrayContaining(['runtime_degraded']),
      reason: 'test stale source',
    });
    expect(simple?.reason_codes).toEqual(expect.arrayContaining(['runtime_degraded', 'stale_source']));
    expect(simple?.score_scopes.live_source_fidelity).toBeLessThanOrEqual(beforeSimple?.score_scopes.live_source_fidelity ?? 10);
  });
});
