import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { marketSnapshots } from '../src/db/schema';
import * as ccxtProvider from '../src/providers/ccxt';
import * as defillamaProvider from '../src/providers/defillama';
import * as sqdProvider from '../src/providers/sqd';
import { resetCurrencyApiSnapshotForTests } from '../src/services/currency-rates';
import { buildCoverageMatrix } from '../src/services/coverage-matrix';
import { buildDataQualityDiagnostics } from '../src/services/data-quality-diagnostics';
import { buildRuntimeDiagnostics } from '../src/services/runtime-diagnostics';

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
        source: { state: string; ownership_class: string; fallback: boolean; latest_source_at: string | null; freshness_state: string; provider_ids: string[]; freshness_budget: {
          current_age_seconds: number | null;
          last_success_at: string | null;
          budget: { target_freshness_seconds: number | null; degraded_after_seconds: number | null };
          status: string;
          reason: string;
          counts_as_live_evidence: boolean;
          counts_as_live_freshness_evidence: boolean;
        } };
        freshness_budget: {
          current_age_seconds: number | null;
          last_success_at: string | null;
          budget: { target_freshness_seconds: number | null; degraded_after_seconds: number | null };
          status: string;
          reason: string;
          counts_as_live_evidence: boolean;
          counts_as_live_freshness_evidence: boolean;
        };
        counts: Record<string, number>;
        timestamps: Record<string, string | null>;
        evidence: { representative_routes: string[]; contract_tests: string[]; runtime_degradation: { active: boolean } };
        reason_codes: string[];
      }>;
      stable_regression_fields: string[];
      score_scopes: string[];
      classification_contract: {
        quality_statuses: string[];
        dimension_ids: string[];
        source_states: string[];
        non_live_source_states: string[];
        coverage_ownership_classes: string[];
        coverage_freshness_states: string[];
        reason_codes: string[];
        live_data_rules: {
          counts_as_live_state: string;
          required_source_ownership_class: string;
          non_live_states_do_not_count_as_live: boolean;
        };
      };
    };

    expect(data.target_threshold).toBe(9);
    expect(data.score_scale).toMatchObject({ min: 0, max: 10 });
    expect(data.score_scopes).toEqual(expect.arrayContaining([
      'contract_compatibility',
      'freshness_liveness',
      'live_source_fidelity',
      'fixture_fallback_transparency',
      'overall_gate',
    ]));
    expect(data.family_aliases.coins).toEqual(expect.arrayContaining(['coins_markets', 'coin_detail']));
    expect(data.family_aliases.assets).toEqual(expect.arrayContaining(['stable_catalog']));
    expect(data.aliases.historical_charts).toEqual(expect.arrayContaining(['historical_charts']));
    expect(data.stable_regression_fields).toEqual(expect.arrayContaining([
      'classification_contract',
      'families[].score',
      'families[].source',
      'families[].freshness_budget',
      'families[].reason_codes',
    ]));
    expect(data.classification_contract.source_states).toEqual([
      'live',
      'hybrid',
      'seeded',
      'fixture',
      'replay',
      'synthetic',
      'fallback',
      'degraded',
      'stale',
      'unavailable',
      'out_of_scope',
    ]);
    expect(data.classification_contract.non_live_source_states).toEqual(expect.arrayContaining([
      'seeded',
      'fixture',
      'replay',
      'synthetic',
      'fallback',
      'degraded',
      'stale',
      'unavailable',
      'out_of_scope',
    ]));
    expect(data.classification_contract.live_data_rules).toMatchObject({
      counts_as_live_state: 'live',
      required_source_ownership_class: 'live',
      non_live_states_do_not_count_as_live: true,
    });

    const requiredFamilies = ['simple', 'coins', 'exchanges', 'global', 'search', 'assets', 'treasury', 'onchain', 'derivatives', 'supply', 'historical'];
    expect(data.families.map((family) => family.family).sort()).toEqual(requiredFamilies.sort());

    for (const family of data.families) {
      expect(Number.isFinite(family.score)).toBe(true);
      expect(family.score).toBeGreaterThanOrEqual(0);
      expect(family.score).toBeLessThanOrEqual(10);
      expect(family.target_threshold).toBe(9);
      expect(Object.keys(family.score_scopes).sort()).toEqual([
        'contract_compatibility',
        'fixture_fallback_transparency',
        'freshness_liveness',
        'live_source_fidelity',
        'overall',
      ].sort());
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
      expect(data.classification_contract.quality_statuses).toContain(family.status);
      expect(data.classification_contract.source_states).toContain(family.source.state);
      expect(data.classification_contract.coverage_ownership_classes).toContain(family.source.ownership_class);
      expect(data.classification_contract.coverage_freshness_states).toContain(family.source.freshness_state);
      expect(family.freshness_budget).toMatchObject({
        status: family.source.freshness_state,
        reason: expect.any(String),
        counts_as_live_evidence: family.source.ownership_class === 'live',
      });
      expect(family.freshness_budget.budget).toHaveProperty('target_freshness_seconds');
      expect(family.freshness_budget.budget).toHaveProperty('degraded_after_seconds');
      expect(family.source.freshness_budget).toEqual(family.freshness_budget);
      expect(family.freshness_budget).toHaveProperty('current_age_seconds');
      expect(family.freshness_budget).toHaveProperty('last_success_at');
      if (family.source.state !== 'live') {
        expect(family.freshness_budget.counts_as_live_evidence).toBe(false);
        expect(family.freshness_budget.counts_as_live_freshness_evidence).toBe(false);
      }
      for (const reasonCode of family.reason_codes) {
        expect(data.classification_contract.reason_codes).toContain(reasonCode);
      }
      for (const dimension of family.dimensions) {
        expect(data.classification_contract.dimension_ids).toContain(dimension.id);
        for (const reasonCode of dimension.reason_codes) {
          expect(data.classification_contract.reason_codes).toContain(reasonCode);
        }
      }
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

  it('maps coverage-matrix contract support and data-fidelity classifications into data-quality source state', async () => {
    await getApp().ready();

    const [qualityResponse, coverageResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/diagnostics/data_quality',
      }),
      getApp().inject({
        method: 'GET',
        url: '/diagnostics/coverage_matrix',
      }),
    ]);

    expect(qualityResponse.statusCode).toBe(200);
    expect(coverageResponse.statusCode).toBe(200);

    const coverageByFamily = new Map((coverageResponse.json().data.entries as Array<{
      family: string;
      ownership_class: string;
      contract_support: { supported: boolean };
      data_fidelity: { classification: string; counts_as_live: boolean; non_live: boolean };
    }>).map((entry) => [entry.family, entry]));
    const qualityFamilies = qualityResponse.json().data.families as Array<{
      family: string;
      source: {
        state: string;
        ownership_class: string;
        evidence_family: string | null;
        fallback: boolean;
      };
      score_scopes: { live_source_fidelity: number };
      target_threshold: number;
    }>;

    for (const family of qualityFamilies) {
      const coverage = coverageByFamily.get(family.source.evidence_family ?? '');
      expect(coverage, `missing coverage entry for ${family.family}`).toBeDefined();
      expect(coverage?.contract_support.supported).toBe(true);
      expect(coverage?.data_fidelity.classification).toBe(family.source.ownership_class);
      expect(coverage?.data_fidelity.counts_as_live).toBe(family.source.state === 'live');
      expect(coverage?.data_fidelity.non_live).toBe(family.source.state !== 'live');

      if (family.source.state !== 'live') {
        expect(family.source.fallback).toBe(true);
        expect(family.score_scopes.live_source_fidelity).toBeLessThan(family.target_threshold);
      }
    }
  });

  it('exposes exchange, global, and derivatives quality evidence for EXGLOBAL assertions', async () => {
    await getApp().ready();

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(response.statusCode).toBe(200);
    const families = response.json().data.families as Array<{
      family: string;
      counts: Record<string, number>;
      evidence: {
        exchange_quality?: {
          assertions: string[];
          major_targets: Array<{
            target_id: string;
            aliases: string[];
            matched_exchange_id: string | null;
            status: string;
            ticker_numeric_quality: {
              total_rows: number;
              valid_numeric_rows: number;
              invalid_or_missing_rows: number;
              latest_ticker_at: string | null;
            };
            volume_chart_evidence: {
              source_backed_point_count: number;
              latest_source_fetched_at: string | null;
            };
            degradation_reason: string | null;
          }>;
          ticker_numeric_quality: {
            total_rows: number;
            valid_last_count: number;
            valid_converted_volume_count: number;
            parseable_timestamp_count: number;
            invalid_row_count: number;
          };
          volume_chart_evidence: {
            source_backed_exchange_count: number;
            live_point_count: number;
            replay_point_count: number;
            dimension_status: string;
            reason_codes: string[];
          };
        };
        global_quality?: {
          assertions: string[];
          source_rows: {
            usable_market_row_count: number;
            market_cap_row_count: number;
            volume_row_count: number;
            latest_market_row_at: string | null;
          };
          recomputation: {
            tolerance_ratio: number;
            total_market_cap_usd: number;
            recomputed_total_market_cap_usd: number;
            market_cap_delta_ratio: number;
            total_volume_usd: number;
            recomputed_total_volume_usd: number;
            volume_delta_ratio: number;
            within_tolerance: boolean;
          };
          reason_codes: string[];
        };
        derivatives_quality?: {
          assertions: string[];
          score_separation: {
            contract_compatibility_state: string;
            live_fidelity_state: string;
            fixture_transparency_state: string;
          };
          ticker_counts: {
            total: number;
            source_backed: number;
            fixture: number;
            live: number;
            replay: number;
            valid_contract_rows: number;
          };
          diagnostics_agreement: {
            public_meta_source_backed_tickers: number;
            diagnostics_source_backed_tickers: number;
            public_meta_fallback_tickers: number;
            diagnostics_fixture_tickers: number;
            agrees: boolean;
          };
          reason_codes: string[];
        };
      };
    }>;

    const exchanges = families.find((family) => family.family === 'exchanges');
    const global = families.find((family) => family.family === 'global');
    const derivatives = families.find((family) => family.family === 'derivatives');

    expect(exchanges?.evidence.exchange_quality).toBeDefined();
    expect(exchanges?.evidence.exchange_quality?.assertions).toEqual(expect.arrayContaining([
      'VAL-EXGLOBAL-026',
      'VAL-EXGLOBAL-027',
      'VAL-EXGLOBAL-028',
    ]));
    expect(exchanges?.evidence.exchange_quality?.major_targets.map((target) => target.target_id)).toEqual([
      'binance',
      'coinbase',
      'kraken',
      'okx',
      'bybit',
    ]);
    expect(exchanges?.evidence.exchange_quality?.major_targets.find((target) => target.target_id === 'binance')).toMatchObject({
      matched_exchange_id: 'binance',
      status: expect.stringMatching(/live_ticker_backed|fixture_or_seeded_tickers|catalog_only/),
      ticker_numeric_quality: expect.objectContaining({
        total_rows: expect.any(Number),
        valid_numeric_rows: expect.any(Number),
      }),
      volume_chart_evidence: expect.objectContaining({
        source_backed_point_count: expect.any(Number),
      }),
    });
    expect(exchanges?.evidence.exchange_quality?.major_targets.find((target) => target.target_id === 'coinbase')?.matched_exchange_id).toBe('gdax');
    expect(exchanges?.evidence.exchange_quality?.major_targets.find((target) => target.target_id === 'okx')?.matched_exchange_id).toBe('okex');
    expect(exchanges?.counts.major_exchange_target_count).toBe(5);

    expect(global?.evidence.global_quality).toBeDefined();
    expect(global?.evidence.global_quality?.assertions).toEqual(expect.arrayContaining([
      'VAL-EXGLOBAL-019',
      'VAL-EXGLOBAL-029',
    ]));
    expect(global?.evidence.global_quality?.source_rows.usable_market_row_count).toBeGreaterThan(0);
    expect(global?.evidence.global_quality?.source_rows.market_cap_row_count).toBeGreaterThanOrEqual(0);
    expect(global?.evidence.global_quality?.recomputation).toMatchObject({
      market_cap_delta_ratio: 0,
      volume_delta_ratio: 0,
    });
    if ((global?.evidence.global_quality?.source_rows.market_cap_row_count ?? 0) > 0) {
      expect(global?.evidence.global_quality?.recomputation.within_tolerance).toBe(true);
      expect(global?.evidence.global_quality?.reason_codes).toEqual([]);
    } else {
      expect(global?.evidence.global_quality?.recomputation.within_tolerance).toBe(false);
      expect(global?.evidence.global_quality?.reason_codes).toContain('sparse_market_rows_or_aggregate_mismatch');
    }
    expect(global?.counts.global_usable_market_row_count).toBe(global?.evidence.global_quality?.source_rows.usable_market_row_count);

    expect(derivatives?.evidence.derivatives_quality).toBeDefined();
    expect(derivatives?.evidence.derivatives_quality?.assertions).toContain('VAL-EXGLOBAL-030');
    expect(derivatives?.evidence.derivatives_quality?.score_separation).toEqual(expect.objectContaining({
      contract_compatibility_state: 'passing',
      live_fidelity_state: 'fixture_only',
      fixture_transparency_state: 'explicit_fixture_rows',
    }));
    expect(derivatives?.evidence.derivatives_quality?.ticker_counts.fixture).toBeGreaterThan(0);
    expect(derivatives?.evidence.derivatives_quality?.diagnostics_agreement).toMatchObject({
      agrees: true,
      public_meta_source_backed_tickers: 0,
      diagnostics_source_backed_tickers: 0,
    });
    expect(derivatives?.evidence.derivatives_quality?.reason_codes).toContain('derivatives_live_fidelity_below_contract_score');
  });

  it('compares global recomputation diagnostics against the public /global route values', async () => {
    await getApp().ready();

    const [qualityResponse, globalResponse] = await Promise.all([
      getApp().inject({
        method: 'GET',
        url: '/diagnostics/data_quality',
      }),
      getApp().inject({
        method: 'GET',
        url: '/global',
      }),
    ]);

    expect(qualityResponse.statusCode).toBe(200);
    expect(globalResponse.statusCode).toBe(200);

    const globalFamily = (qualityResponse.json().data.families as Array<{
      family: string;
      evidence: {
        global_quality?: {
          public_route_values: {
            route: string;
            total_market_cap_usd: number;
            total_volume_usd: number;
            market_cap_percentage: Record<string, number | null>;
          };
          public_route_comparison: {
            compared_route: string;
            market_cap_delta_ratio: number;
            volume_delta_ratio: number;
            dominance_delta_ratios: Record<string, number>;
            within_tolerance: boolean;
          };
        };
      };
    }>).find((family) => family.family === 'global');

    const publicGlobal = globalResponse.json().data as {
      total_market_cap: { usd: number };
      total_volume: { usd: number };
      market_cap_percentage: Record<string, number>;
    };

    expect(globalFamily?.evidence.global_quality?.public_route_values).toMatchObject({
      route: '/global',
      total_market_cap_usd: publicGlobal.total_market_cap.usd,
      total_volume_usd: publicGlobal.total_volume.usd,
    });
    expect(globalFamily?.evidence.global_quality?.public_route_values.market_cap_percentage).toEqual(
      expect.objectContaining({
        btc: publicGlobal.market_cap_percentage.btc,
        eth: publicGlobal.market_cap_percentage.eth,
        usdc: publicGlobal.market_cap_percentage.usdc,
      }),
    );
    expect(globalFamily?.evidence.global_quality?.public_route_comparison).toMatchObject({
      compared_route: '/global',
      market_cap_delta_ratio: 0,
      volume_delta_ratio: 0,
      within_tolerance: true,
    });
  });

  it('fails global public-route comparison when /global values diverge from recomputed diagnostics totals', async () => {
    await getApp().ready();

    const globalResponse = await getApp().inject({
      method: 'GET',
      url: '/global',
    });

    expect(globalResponse.statusCode).toBe(200);
    const publicGlobal = globalResponse.json().data as {
      active_cryptocurrencies: number;
      upcoming_icos: number;
      ongoing_icos: number;
      ended_icos: number;
      markets: number;
      total_market_cap: Record<string, number>;
      total_volume: Record<string, number>;
      market_cap_percentage: Record<string, number>;
      market_cap_change_percentage_24h_usd: number;
      volume_change_percentage_24h_usd: number;
      updated_at: number;
    };
    const driftedPublicGlobal = {
      ...publicGlobal,
      total_market_cap: {
        ...publicGlobal.total_market_cap,
        usd: publicGlobal.total_market_cap.usd > 0 ? publicGlobal.total_market_cap.usd * 1.5 : 100,
      },
      total_volume: {
        ...publicGlobal.total_volume,
        usd: publicGlobal.total_volume.usd > 0 ? publicGlobal.total_volume.usd * 0.5 : 100,
      },
      market_cap_percentage: {
        ...publicGlobal.market_cap_percentage,
        btc: (publicGlobal.market_cap_percentage.btc ?? 0) + 10,
        eth: publicGlobal.market_cap_percentage.eth ?? 0,
        usdc: publicGlobal.market_cap_percentage.usdc ?? 0,
      },
    };
    const runtimeDiagnostics = buildRuntimeDiagnostics(
      getApp().marketDataRuntimeState,
      null,
      getApp().marketFreshnessThresholdSeconds,
    );
    const diagnostics = buildDataQualityDiagnostics(
      buildCoverageMatrix(getApp().db),
      runtimeDiagnostics,
      new Date(),
      getApp().db,
      driftedPublicGlobal,
    );
    const globalFamily = diagnostics.families.find((family) => family.family === 'global');

    expect(globalFamily?.evidence.global_quality?.public_route_values).toMatchObject({
      total_market_cap_usd: driftedPublicGlobal.total_market_cap.usd,
      total_volume_usd: driftedPublicGlobal.total_volume.usd,
    });
    expect(globalFamily?.evidence.global_quality?.public_route_comparison).toMatchObject({
      compared_route: '/global',
      within_tolerance: false,
    });
    expect(globalFamily?.evidence.global_quality?.public_route_comparison.market_cap_delta_ratio).toBeGreaterThan(0);
    expect(globalFamily?.evidence.global_quality?.public_route_comparison.volume_delta_ratio).toBeGreaterThan(0);
    const dominanceDeltaRatios = globalFamily?.evidence.global_quality?.public_route_comparison.dominance_delta_ratios as Record<string, number> | undefined;
    expect(dominanceDeltaRatios?.btc).toBeGreaterThan(0);
    expect(globalFamily?.evidence.global_quality?.reason_codes).toContain('sparse_market_rows_or_aggregate_mismatch');
  });

  it('exposes catalog hybrid quality evidence for search, assets, treasury, onchain, and supply assertions', async () => {
    await getApp().ready();

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(response.statusCode).toBe(200);
    const families = response.json().data.families as Array<{
      family: string;
      counts: Record<string, number>;
      evidence: {
        search_quality?: {
          assertions: string[];
          representative_queries: string[];
          canonical_rank_targets: Array<{ query: string; expected_coin_id: string; max_rank: number }>;
          source_mode: string;
        };
        asset_image_quality?: {
          assertions: string[];
          mapped_token_count: number;
          token_list_logo_count: number;
          deterministic_url_checks: { accepted_prefixes: string[]; placeholder_domains_rejected: string[] };
          canonical_identity_checks: { platform: string; contracts: Array<{ coin_id: string; address: string | null }> };
        };
        treasury_reconciliation?: {
          assertions: string[];
          holding_row_count: number;
          fixture_fallback_holding_count: number;
          totals_by_coin: Array<{ coin_id: string; reconciled: boolean; holding_transaction_delta: number }>;
          source_mode: string;
        };
        onchain_provenance?: {
          assertions: string[];
          network_count: number;
          pool_count: number;
          field_provenance: Record<string, unknown>;
          diagnostics_equivalence: { alias_path: string; specialized_paths: string[] };
        };
        supply_variant_quality?: {
          assertions: string[];
          variant_count: number;
          variants: Array<{ id: string; source_mode: string; point_count: number }>;
          diagnostics_path: string;
        };
        hybrid_provenance?: {
          assertions: string[];
          families: string[];
          required_metadata_fields: string[];
          source_modes: Record<string, string>;
        };
      };
    }>;

    const byFamily = new Map(families.map((family) => [family.family, family]));

    expect(byFamily.get('search')?.evidence.search_quality).toMatchObject({
      assertions: expect.arrayContaining(['VAL-CATALOG-025']),
      representative_queries: expect.arrayContaining(['bitcoin', 'BTC', 'eth', 'usdc']),
      canonical_rank_targets: expect.arrayContaining([
        expect.objectContaining({ query: 'bitcoin', expected_coin_id: 'bitcoin', max_rank: 1 }),
      ]),
      source_mode: 'stable_catalog',
    });

    expect(byFamily.get('assets')?.evidence.asset_image_quality).toMatchObject({
      assertions: expect.arrayContaining(['VAL-CATALOG-010', 'VAL-CATALOG-026', 'VAL-CATALOG-030']),
      mapped_token_count: expect.any(Number),
      deterministic_url_checks: {
        accepted_prefixes: expect.arrayContaining(['https://']),
        placeholder_domains_rejected: expect.arrayContaining(['placeholder.invalid']),
      },
      canonical_identity_checks: expect.objectContaining({ platform: 'ethereum' }),
    });
    expect(byFamily.get('assets')?.counts.mapped_token_count).toBeGreaterThan(0);
    expect(byFamily.get('assets')?.evidence.asset_image_quality?.token_list_logo_count).toBeGreaterThan(0);

    expect(byFamily.get('treasury')?.evidence.treasury_reconciliation).toMatchObject({
      assertions: expect.arrayContaining(['VAL-CATALOG-027']),
      holding_row_count: expect.any(Number),
      fixture_fallback_holding_count: expect.any(Number),
      source_mode: 'fixture',
    });
    expect(byFamily.get('treasury')?.evidence.treasury_reconciliation?.totals_by_coin).toEqual(expect.arrayContaining([
      expect.objectContaining({ coin_id: 'bitcoin', reconciled: true, holding_transaction_delta: 0 }),
    ]));

    expect(byFamily.get('onchain')?.evidence.onchain_provenance).toMatchObject({
      assertions: expect.arrayContaining(['VAL-CATALOG-028']),
      network_count: expect.any(Number),
      pool_count: expect.any(Number),
      field_provenance: expect.objectContaining({
        reserve_usd: expect.any(Object),
        volume_usd_h24: expect.any(Object),
        trades: expect.any(Object),
        ohlcv: expect.any(Object),
        analytics: expect.any(Object),
      }),
      diagnostics_equivalence: {
        alias_path: '/diagnostics/onchain',
        specialized_paths: expect.arrayContaining(['/diagnostics/onchain_analytics', '/diagnostics/onchain_trades']),
      },
    });

    expect(byFamily.get('supply')?.evidence.supply_variant_quality).toMatchObject({
      assertions: expect.arrayContaining(['VAL-CATALOG-029']),
      variant_count: 4,
      diagnostics_path: '/diagnostics/supply_charts',
    });
    expect(byFamily.get('supply')?.evidence.supply_variant_quality?.variants.map((variant) => variant.id).sort()).toEqual([
      'circulating_days',
      'circulating_range',
      'total_days',
      'total_range',
    ].sort());

    for (const family of ['search', 'assets', 'treasury', 'onchain', 'supply']) {
      expect(byFamily.get(family)?.evidence.hybrid_provenance).toMatchObject({
        assertions: expect.arrayContaining(['VAL-CATALOG-023', 'VAL-CATALOG-024']),
        families: expect.arrayContaining(['search', 'assets', 'treasury', 'onchain', 'supply']),
        required_metadata_fields: expect.arrayContaining(['family', 'source_mode', 'source_identifier', 'timestamp_or_version', 'degraded_reason']),
      });
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

  it('caps live family gate scores when freshness budgets are stale', async () => {
    await getApp().ready();

    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1_000);
    getApp().db.db.update(marketSnapshots).set({
      sourceProvidersJson: JSON.stringify(['coinbase']),
      sourceCount: 1,
      lastUpdated: staleTimestamp,
      updatedAt: staleTimestamp,
    }).run();

    const response = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data as {
      gate: { below_target_families: Array<{ family: string; reason_codes: string[] }> };
      families: Array<{
        family: string;
        source: { state: string; freshness_state: string };
        freshness_budget: { status: string; reason: string; current_age_seconds: number | null; counts_as_live_freshness_evidence: boolean };
        score: number;
        target_threshold: number;
        reason_codes: string[];
        failing_dimensions: string[];
      }>;
    };
    const simple = data.families.find((family) => family.family === 'simple');

    expect(simple).toMatchObject({
      source: { state: 'live', freshness_state: 'stale' },
      freshness_budget: {
        status: 'stale',
        reason: 'freshness_stale',
        counts_as_live_freshness_evidence: false,
      },
    });
    expect(simple?.freshness_budget.current_age_seconds).toBeGreaterThan(120);
    expect(simple?.score).toBeLessThan(simple?.target_threshold ?? 9);
    expect(simple?.reason_codes).toEqual(expect.arrayContaining(['stale_source']));
    expect(simple?.failing_dimensions).toEqual(expect.arrayContaining(['freshness_liveness']));
    expect(data.gate.below_target_families.map((family) => family.family)).toContain('simple');
  });

  it('propagates injected provider failures into live-backed data quality scores', async () => {
    await getApp().ready();

    const enableFailureResponse = await getApp().inject({
      method: 'POST',
      url: '/diagnostics/runtime/provider_failure',
      payload: {
        active: true,
        reason: 'validator forced outage',
      },
    });
    expect(enableFailureResponse.statusCode).toBe(200);

    const runtimeResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/runtime',
    });
    expect(runtimeResponse.statusCode).toBe(200);
    expect(runtimeResponse.json().data.degraded.injected_provider_failure).toEqual({
      active: true,
      reason: 'validator forced outage',
    });

    const qualityResponse = await getApp().inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(qualityResponse.statusCode).toBe(200);
    const affectedFamilies = (qualityResponse.json().data.families as Array<{
      family: string;
      source: { state: string; ownership_class: string };
      score_scopes: { live_source_fidelity: number; freshness_liveness: number };
      dimensions: Array<{ id: string; score: number; reason_codes: string[] }>;
      evidence: { runtime_degradation: { active: boolean; reason_codes: string[]; reason: string | null } };
      reason_codes: string[];
    }>).filter((family) => ['simple', 'coins', 'global'].includes(family.family));

    expect(affectedFamilies.length).toBeGreaterThan(0);
    for (const family of affectedFamilies) {
      expect(family.evidence.runtime_degradation).toMatchObject({
        active: true,
        reason_codes: expect.arrayContaining(['provider_error']),
        reason: 'validator forced outage',
      });
      expect(family.reason_codes).toEqual(expect.arrayContaining(['provider_error']));
      expect(family.score_scopes.live_source_fidelity).toBeLessThanOrEqual(6);
      expect(family.score_scopes.freshness_liveness).toBeLessThanOrEqual(6);
      expect(family.dimensions.find((dimension) => dimension.id === 'freshness_liveness')).toMatchObject({
        score: expect.any(Number),
        reason_codes: expect.arrayContaining(['provider_error']),
      });
      if (family.source.ownership_class === 'live') {
        expect(family.source.state).toBe('degraded');
      }
    }
  });
});
