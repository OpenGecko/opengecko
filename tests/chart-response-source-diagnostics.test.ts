import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, type AppDatabase } from '../src/db/client';
import { coins, marketChartSourcePoints } from '../src/db/schema';
import { createChartResponseSourceDiagnostics } from '../src/services/chart-response-source-diagnostics';
import { buildMarketChartProviderDiagnostics } from '../src/services/market-chart-diagnostics';

describe('chart response source diagnostics', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-chart-response-source-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports a clear fallback alert status when there are no recent fallback events', () => {
    const diagnostics = buildMarketChartProviderDiagnostics(
      database,
      undefined,
      new Date('2026-05-06T00:00:00.000Z'),
      undefined,
      [],
    );

    expect(diagnostics.response_source_fallback_alert).toEqual({
      status: 'clear',
      reason: 'no_recent_fallback_events',
      recent_events_total: 0,
      events_eligible_for_suggestion: 0,
      suggestions_returned: 0,
      stale_events_ignored: 0,
      source_backed_events_suppressed: 0,
    });
    expect(diagnostics.response_source_target_suggestion_batch_previews).toEqual({
      provider_placeholder: '<provider>',
      total_suggestions: 0,
      cap: {
        preview_source: 'response_source_target_suggestions',
        suggestions_returned: 0,
        suggestions_limit: 20,
      },
      groups: {
        daily_history: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          target_count: 0,
          target_templates: [],
          market_chart_targets_template: null,
        },
        intraday_history: {
          target_history: 'intraday_history',
          suggested_action: 'expand_intraday_history',
          target_count: 0,
          target_templates: [],
          market_chart_targets_template: null,
        },
      },
    });
    expect(diagnostics.response_source_target_suggestion_overflow).toEqual({
      basis: 'eligible_unique_targets_after_stale_and_source_backed_filtering',
      suggestions_limit: 20,
      eligible_targets: 0,
      returned_suggestions: 0,
      omitted_by_suggestion_cap: 0,
      target_history_counts: {
        daily_history: {
          eligible_targets: 0,
          returned_suggestions: 0,
          omitted_by_suggestion_cap: 0,
        },
        intraday_history: {
          eligible_targets: 0,
          returned_suggestions: 0,
          omitted_by_suggestion_cap: 0,
        },
      },
    });
  });

  it('persists capped sanitized recent provider-filled and empty events across restarts', () => {
    const diagnostics = createChartResponseSourceDiagnostics(database);

    diagnostics.record('market_chart_days', 'canonical', {
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: 'daily',
      request: { kind: 'days', days: '7' },
    });

    for (let index = 0; index < 55; index += 1) {
      diagnostics.record(index % 2 === 0 ? 'market_chart_range' : 'ohlc_range', index % 2 === 0 ? 'empty' : 'provider_filled', {
        coinId: `coin-${index}`,
        vsCurrency: 'usd',
        interval: 'daily',
        request: {
          kind: 'range',
          from: Date.UTC(2026, 3, 1 + index),
          to: Date.UTC(2026, 3, 1 + index),
        },
      });
    }

    expect(diagnostics.snapshot().market_chart_days.canonical).toBe(1);
    const recentEvents = diagnostics.recentEvents();
    expect(recentEvents).toHaveLength(50);
    expect(recentEvents.every((event) => event.source === 'empty' || event.source === 'provider_filled')).toBe(true);
    expect(recentEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ coin_id: 'coin-0' }),
      expect.objectContaining({ source: 'canonical' }),
    ]));
    expect(JSON.stringify(recentEvents)).not.toContain('secret');
    expect(recentEvents[0]).toMatchObject({
      route: 'market_chart_range',
      source: 'empty',
      coin_id: 'coin-54',
      vs_currency: 'usd',
      interval: 'daily',
      request: {
        kind: 'range',
        days: null,
      },
    });
    expect(recentEvents[0].request.from).toBe('2026-05-25T00:00:00.000Z');

    database.client.close();
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);

    const restartedDiagnostics = createChartResponseSourceDiagnostics(database);
    expect(restartedDiagnostics.snapshot().market_chart_days.canonical).toBe(1);
    expect(restartedDiagnostics.recentEvents()).toHaveLength(50);
    expect(restartedDiagnostics.recentEvents()[0]).toMatchObject({
      route: 'market_chart_range',
      source: 'empty',
      coin_id: 'coin-54',
    });

    const rollups = buildMarketChartProviderDiagnostics(
      database,
      undefined,
      new Date('2026-05-06T00:00:00.000Z'),
      undefined,
      restartedDiagnostics.recentEvents(),
    ).response_source_recent_event_rollups;
    expect(rollups).toMatchObject({
      total_events: 50,
      by_route: {
        market_chart_range: {
          empty: 25,
        },
        ohlc_range: {
          provider_filled: 25,
        },
      },
    });
    expect(rollups?.by_coin).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ coin_id: 'coin-0' }),
    ]));

    const suggestions = buildMarketChartProviderDiagnostics(
      database,
      undefined,
      new Date('2026-05-06T00:00:00.000Z'),
      undefined,
      restartedDiagnostics.recentEvents(),
    ).response_source_target_suggestions;
    expect(suggestions).toHaveLength(20);
    expect(suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        interval: '1d',
        reason: 'recent provider-filled or empty public chart/OHLC fallback events',
        target_template: expect.stringMatching(/^<provider>=coin-/),
      }),
    ]));
    expect(suggestions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ target_template: '<provider>=coin-0:1d:usd' }),
    ]));
  });

  it('suppresses target suggestions for already source-backed targets', () => {
    const now = new Date('2026-05-06T00:00:00.000Z');
    database.db.insert(coins).values({
      id: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      apiSymbol: 'bitcoin',
      hashingAlgorithm: null,
      blockTimeInMinutes: null,
      categoriesJson: '[]',
      descriptionJson: '{}',
      linksJson: '{}',
      imageThumbUrl: null,
      imageSmallUrl: null,
      imageLargeUrl: null,
      marketCapRank: 1,
      genesisDate: null,
      platformsJson: '{}',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run();
    database.db.insert(marketChartSourcePoints).values({
      coinId: 'bitcoin',
      vsCurrency: 'usd',
      interval: '1d',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
      price: 91_000,
      marketCap: null,
      totalVolume: 1_000,
      open: 90_000,
      high: 92_000,
      low: 89_000,
      close: 91_000,
      sourceKind: 'live',
      sourceProvider: 'mock.chart',
      sourceFetchedAt: now,
    }).run();

    const diagnostics = buildMarketChartProviderDiagnostics(
      database,
      'mock.chart=bitcoin:1d:usd',
      now,
      undefined,
      [
        {
          route: 'market_chart_range',
          source: 'empty',
          coin_id: 'bitcoin',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-04-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
          observed_at: '2026-05-06T00:00:00.000Z',
        },
        {
          route: 'ohlc_range',
          source: 'provider_filled',
          coin_id: 'ethereum',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-04-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
          observed_at: '2026-05-06T00:01:00.000Z',
        },
      ],
    );

    expect(diagnostics.response_source_target_suggestions).toEqual([
      expect.objectContaining({
        coin_id: 'ethereum',
        target_template: '<provider>=ethereum:1d:usd',
      }),
    ]);
    expect(diagnostics.response_source_target_suggestion_summary).toEqual({
      recent_events_total: 2,
      stale_events_ignored: 0,
      events_inside_window: 2,
      source_backed_events_suppressed: 1,
      events_eligible_for_suggestion: 1,
      unique_eligible_targets: 1,
      suggestions_returned: 1,
      suggestions_limit: 20,
      sample_requests_limit: 3,
    });
    expect(diagnostics.response_source_target_suggestion_exclusions).toEqual({
      sample_limit: 5,
      stale_events: [],
      source_backed_events: [
        {
          coin_id: 'bitcoin',
          vs_currency: 'usd',
          interval: '1d',
          target_template: '<provider>=bitcoin:1d:usd',
          route: 'market_chart_range',
          source: 'empty',
          observed_at: '2026-05-06T00:00:00.000Z',
          request: { kind: 'range', days: null, from: '2026-04-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
        },
      ],
    });
    expect(diagnostics.response_source_fallback_alert).toEqual({
      status: 'action_needed',
      reason: 'unresolved_recent_fallback_pressure',
      recent_events_total: 2,
      events_eligible_for_suggestion: 1,
      suggestions_returned: 1,
      stale_events_ignored: 0,
      source_backed_events_suppressed: 1,
    });
    const sourceBackedOnlyDiagnostics = buildMarketChartProviderDiagnostics(
      database,
      'mock.chart=bitcoin:1d:usd',
      now,
      undefined,
      [
        {
          route: 'market_chart_range',
          source: 'empty',
          coin_id: 'bitcoin',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-04-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
          observed_at: '2026-05-06T00:00:00.000Z',
        },
      ],
    );
    expect(sourceBackedOnlyDiagnostics.response_source_fallback_alert).toEqual({
      status: 'watch',
      reason: 'source_backed_fallback_pressure_suppressed',
      recent_events_total: 1,
      events_eligible_for_suggestion: 0,
      suggestions_returned: 0,
      stale_events_ignored: 0,
      source_backed_events_suppressed: 1,
    });
    expect(sourceBackedOnlyDiagnostics.response_source_target_suggestion_batch_previews).toEqual(expect.objectContaining({
      total_suggestions: 0,
      cap: {
        preview_source: 'response_source_target_suggestions',
        suggestions_returned: 0,
        suggestions_limit: 20,
      },
      groups: {
        daily_history: expect.objectContaining({
          target_count: 0,
          target_templates: [],
          market_chart_targets_template: null,
        }),
        intraday_history: expect.objectContaining({
          target_count: 0,
          target_templates: [],
          market_chart_targets_template: null,
        }),
      },
    }));
    expect(diagnostics.response_source_target_suggestions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ target_template: '<provider>=bitcoin:1d:usd' }),
    ]));
  });

  it('limits target suggestions to the recent fallback event window', () => {
    const diagnostics = buildMarketChartProviderDiagnostics(
      database,
      undefined,
      new Date('2026-05-06T00:00:00.000Z'),
      undefined,
      [
        {
          route: 'market_chart_range',
          source: 'empty',
          coin_id: 'oldcoin',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-04-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
          observed_at: '2026-04-28T23:59:59.000Z',
        },
        {
          route: 'ohlc_range',
          source: 'provider_filled',
          coin_id: 'recentcoin',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-05-05T00:00:00.000Z', to: '2026-05-05T00:00:00.000Z' },
          observed_at: '2026-05-05T00:00:00.000Z',
        },
      ],
    );

    expect(diagnostics.response_source_recent_event_rollups).toMatchObject({
      total_events: 2,
    });
    expect(diagnostics.response_source_target_suggestion_window).toEqual({
      window_seconds: 604_800,
      cutoff_observed_at: '2026-04-29T00:00:00.000Z',
      ignored_stale_events: 1,
    });
    expect(diagnostics.response_source_target_suggestion_summary).toEqual({
      recent_events_total: 2,
      stale_events_ignored: 1,
      events_inside_window: 1,
      source_backed_events_suppressed: 0,
      events_eligible_for_suggestion: 1,
      unique_eligible_targets: 1,
      suggestions_returned: 1,
      suggestions_limit: 20,
      sample_requests_limit: 3,
    });
    expect(diagnostics.response_source_target_suggestion_exclusions).toEqual({
      sample_limit: 5,
      stale_events: [
        {
          coin_id: 'oldcoin',
          vs_currency: 'usd',
          interval: '1d',
          target_template: '<provider>=oldcoin:1d:usd',
          route: 'market_chart_range',
          source: 'empty',
          observed_at: '2026-04-28T23:59:59.000Z',
          request: { kind: 'range', days: null, from: '2026-04-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
        },
      ],
      source_backed_events: [],
    });
    expect(diagnostics.response_source_fallback_alert).toEqual({
      status: 'action_needed',
      reason: 'unresolved_recent_fallback_pressure',
      recent_events_total: 2,
      events_eligible_for_suggestion: 1,
      suggestions_returned: 1,
      stale_events_ignored: 1,
      source_backed_events_suppressed: 0,
    });
    expect(diagnostics.response_source_target_suggestions).toEqual([
      expect.objectContaining({
        coin_id: 'recentcoin',
        target_template: '<provider>=recentcoin:1d:usd',
      }),
    ]);
    expect(diagnostics.response_source_target_suggestions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ target_template: '<provider>=oldcoin:1d:usd' }),
    ]));
  });

  it('ranks target suggestions by unresolved fallback pressure with stable tie-breakers', () => {
    const diagnostics = buildMarketChartProviderDiagnostics(
      database,
      undefined,
      new Date('2026-05-06T00:00:00.000Z'),
      undefined,
      [
        {
          route: 'market_chart_range',
          source: 'empty',
          coin_id: 'charlie',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-05-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
          observed_at: '2026-05-05T00:00:00.000Z',
        },
        {
          route: 'ohlc_range',
          source: 'provider_filled',
          coin_id: 'charlie',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-05-02T00:00:00.000Z', to: '2026-05-02T00:00:00.000Z' },
          observed_at: '2026-05-05T01:00:00.000Z',
        },
        {
          route: 'market_chart_range',
          source: 'empty',
          coin_id: 'bravo',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-05-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
          observed_at: '2026-05-05T00:00:00.000Z',
        },
        {
          route: 'market_chart_days',
          source: 'empty',
          coin_id: 'bravo',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'days', days: '7', from: null, to: null },
          observed_at: '2026-05-05T00:30:00.000Z',
        },
        {
          route: 'ohlc_days',
          source: 'empty',
          coin_id: 'bravo',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'days', days: '7', from: null, to: null },
          observed_at: '2026-05-05T01:00:00.000Z',
        },
        {
          route: 'market_chart_range',
          source: 'empty',
          coin_id: 'alpha',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-05-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
          observed_at: '2026-05-05T02:00:00.000Z',
        },
        {
          route: 'ohlc_range',
          source: 'provider_filled',
          coin_id: 'alpha',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-05-02T00:00:00.000Z', to: '2026-05-02T00:00:00.000Z' },
          observed_at: '2026-05-05T03:00:00.000Z',
        },
      ],
    );

    expect(diagnostics.response_source_target_suggestions).toEqual([
      expect.objectContaining({
        coin_id: 'bravo',
        route_pressure: {
          dominant_route: 'market_chart_days',
          totals: {
            market_chart_days: 1,
            market_chart_range: 1,
            ohlc_days: 1,
            ohlc_range: 0,
          },
        },
        request_kind_pressure: {
          dominant_kind: 'days',
          totals: {
            days: 2,
            range: 1,
          },
        },
        range_span_pressure: {
          dominant_bucket: 'single_day',
          range_requests: 1,
          buckets: {
            intraday: 0,
            single_day: 1,
            multi_day: 0,
          },
          min_span_seconds: 0,
          max_span_seconds: 0,
        },
        coverage_target_hint: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          request_pattern: 'days',
          range_window: 'single_day',
        },
        priority: {
          rank: 1,
          pressure_score: 3,
          latest_observed_at: '2026-05-05T01:00:00.000Z',
        },
      }),
      expect.objectContaining({
        coin_id: 'alpha',
        route_pressure: {
          dominant_route: 'market_chart_range',
          totals: {
            market_chart_days: 0,
            market_chart_range: 1,
            ohlc_days: 0,
            ohlc_range: 1,
          },
        },
        request_kind_pressure: {
          dominant_kind: 'range',
          totals: {
            days: 0,
            range: 2,
          },
        },
        range_span_pressure: {
          dominant_bucket: 'single_day',
          range_requests: 2,
          buckets: {
            intraday: 0,
            single_day: 2,
            multi_day: 0,
          },
          min_span_seconds: 0,
          max_span_seconds: 0,
        },
        coverage_target_hint: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          request_pattern: 'range',
          range_window: 'single_day',
        },
        priority: {
          rank: 2,
          pressure_score: 2,
          latest_observed_at: '2026-05-05T03:00:00.000Z',
        },
      }),
      expect.objectContaining({
        coin_id: 'charlie',
        priority: {
          rank: 3,
          pressure_score: 2,
          latest_observed_at: '2026-05-05T01:00:00.000Z',
        },
      }),
    ]);
  });

  it('classifies range-span pressure buckets for target suggestions', () => {
    const diagnostics = buildMarketChartProviderDiagnostics(
      database,
      undefined,
      new Date('2026-05-06T00:00:00.000Z'),
      undefined,
      [
        {
          route: 'market_chart_range',
          source: 'empty',
          coin_id: 'intradaycoin',
          vs_currency: 'usd',
          interval: 'hourly',
          request: { kind: 'range', days: null, from: '2026-05-05T00:00:00.000Z', to: '2026-05-05T01:00:00.000Z' },
          observed_at: '2026-05-05T02:00:00.000Z',
        },
        {
          route: 'ohlc_range',
          source: 'provider_filled',
          coin_id: 'historycoin',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-05-01T00:00:00.000Z', to: '2026-05-04T00:00:00.000Z' },
          observed_at: '2026-05-05T03:00:00.000Z',
        },
      ],
    );

    expect(diagnostics.response_source_target_suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin_id: 'intradaycoin',
        interval: '1m',
        coverage_target_hint: {
          target_history: 'intraday_history',
          suggested_action: 'expand_intraday_history',
          request_pattern: 'range',
          range_window: 'intraday',
        },
        range_span_pressure: {
          dominant_bucket: 'intraday',
          range_requests: 1,
          buckets: {
            intraday: 1,
            single_day: 0,
            multi_day: 0,
          },
          min_span_seconds: 3_600,
          max_span_seconds: 3_600,
        },
      }),
      expect.objectContaining({
        coin_id: 'historycoin',
        interval: '1d',
        coverage_target_hint: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          request_pattern: 'range',
          range_window: 'multi_day',
        },
        range_span_pressure: {
          dominant_bucket: 'multi_day',
          range_requests: 1,
          buckets: {
            intraday: 0,
            single_day: 0,
            multi_day: 1,
          },
          min_span_seconds: 259_200,
          max_span_seconds: 259_200,
        },
      }),
    ]));
    expect(diagnostics.response_source_target_suggestion_operator_summary).toEqual({
      total_suggestions: 2,
      target_history_counts: {
        daily_history: 1,
        intraday_history: 1,
      },
      suggested_action_counts: {
        expand_daily_history: 1,
        expand_intraday_history: 1,
      },
      request_pattern_counts: {
        days: 0,
        range: 2,
        none: 0,
      },
      range_window_counts: {
        intraday: 1,
        single_day: 0,
        multi_day: 1,
        none: 0,
      },
    });
    expect(diagnostics.response_source_target_suggestion_batch_previews).toEqual({
      provider_placeholder: '<provider>',
      total_suggestions: 2,
      cap: {
        preview_source: 'response_source_target_suggestions',
        suggestions_returned: 2,
        suggestions_limit: 20,
      },
      groups: {
        daily_history: {
          target_history: 'daily_history',
          suggested_action: 'expand_daily_history',
          target_count: 1,
          target_templates: ['<provider>=historycoin:1d:usd'],
          market_chart_targets_template: '<provider>=historycoin:1d:usd',
        },
        intraday_history: {
          target_history: 'intraday_history',
          suggested_action: 'expand_intraday_history',
          target_count: 1,
          target_templates: ['<provider>=intradaycoin:1m:usd'],
          market_chart_targets_template: '<provider>=intradaycoin:1m:usd',
        },
      },
    });
  });

  it('keeps empty intraday batch preview groups explainable when returned suggestions hit the cap', () => {
    const dailyEvents = Array.from({ length: 20 }, (_, index) => ({
      route: 'market_chart_range' as const,
      source: 'empty' as const,
      coin_id: `daily-${index.toString().padStart(2, '0')}`,
      vs_currency: 'usd',
      interval: 'daily',
      request: {
        kind: 'range' as const,
        days: null,
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-01T00:00:00.000Z',
      },
      observed_at: `2026-05-05T00:${(index + 1).toString().padStart(2, '0')}:00.000Z`,
    }));
    const diagnostics = buildMarketChartProviderDiagnostics(
      database,
      undefined,
      new Date('2026-05-06T00:00:00.000Z'),
      undefined,
      [
        ...dailyEvents,
        {
          route: 'market_chart_range',
          source: 'empty',
          coin_id: 'intraday-capped',
          vs_currency: 'usd',
          interval: 'hourly',
          request: { kind: 'range', days: null, from: '2026-05-01T00:00:00.000Z', to: '2026-05-01T01:00:00.000Z' },
          observed_at: '2026-05-05T00:00:00.000Z',
        },
      ],
    );

    expect(diagnostics.response_source_target_suggestion_summary).toEqual(expect.objectContaining({
      events_eligible_for_suggestion: 21,
      unique_eligible_targets: 21,
      suggestions_returned: 20,
      suggestions_limit: 20,
    }));
    expect(diagnostics.response_source_target_suggestion_overflow).toEqual({
      basis: 'eligible_unique_targets_after_stale_and_source_backed_filtering',
      suggestions_limit: 20,
      eligible_targets: 21,
      returned_suggestions: 20,
      omitted_by_suggestion_cap: 1,
      target_history_counts: {
        daily_history: {
          eligible_targets: 20,
          returned_suggestions: 20,
          omitted_by_suggestion_cap: 0,
        },
        intraday_history: {
          eligible_targets: 1,
          returned_suggestions: 0,
          omitted_by_suggestion_cap: 1,
        },
      },
    });
    expect(diagnostics.response_source_fallback_alert).toEqual(expect.objectContaining({
      status: 'action_needed',
      reason: 'unresolved_recent_fallback_pressure',
      events_eligible_for_suggestion: 21,
      suggestions_returned: 20,
    }));
    expect(diagnostics.response_source_target_suggestions).toHaveLength(20);
    expect(diagnostics.response_source_target_suggestions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ target_template: '<provider>=intraday-capped:1m:usd' }),
    ]));
    expect(diagnostics.response_source_target_suggestion_batch_previews).toEqual(expect.objectContaining({
      total_suggestions: 20,
      cap: {
        preview_source: 'response_source_target_suggestions',
        suggestions_returned: 20,
        suggestions_limit: 20,
      },
      groups: {
        daily_history: expect.objectContaining({
          target_count: 20,
          target_templates: expect.arrayContaining([
            '<provider>=daily-19:1d:usd',
            '<provider>=daily-00:1d:usd',
          ]),
        }),
        intraday_history: expect.objectContaining({
          target_count: 0,
          target_templates: [],
          market_chart_targets_template: null,
        }),
      },
    }));
    expect(diagnostics.response_source_target_suggestion_overflow?.target_history_counts.daily_history.returned_suggestions).toBe(
      diagnostics.response_source_target_suggestion_batch_previews?.groups.daily_history.target_count,
    );
    expect(diagnostics.response_source_target_suggestion_overflow?.target_history_counts.intraday_history.returned_suggestions).toBe(
      diagnostics.response_source_target_suggestion_batch_previews?.groups.intraday_history.target_count,
    );
  });

  it('attaches capped deterministic request samples to target suggestions', () => {
    const diagnostics = buildMarketChartProviderDiagnostics(
      database,
      undefined,
      new Date('2026-05-06T00:00:00.000Z'),
      undefined,
      [
        {
          route: 'market_chart_range',
          source: 'empty',
          coin_id: 'samplecoin',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-05-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
          observed_at: '2026-05-05T00:00:00.000Z',
        },
        {
          route: 'ohlc_range',
          source: 'provider_filled',
          coin_id: 'samplecoin',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'range', days: null, from: '2026-05-04T00:00:00.000Z', to: '2026-05-04T00:00:00.000Z' },
          observed_at: '2026-05-05T03:00:00.000Z',
        },
        {
          route: 'market_chart_days',
          source: 'empty',
          coin_id: 'samplecoin',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'days', days: '30', from: null, to: null },
          observed_at: '2026-05-05T02:00:00.000Z',
        },
        {
          route: 'ohlc_days',
          source: 'provider_filled',
          coin_id: 'samplecoin',
          vs_currency: 'usd',
          interval: 'daily',
          request: { kind: 'days', days: '7', from: null, to: null },
          observed_at: '2026-05-05T01:00:00.000Z',
        },
      ],
    );

    expect(diagnostics.response_source_target_suggestions).toEqual([
      expect.objectContaining({
        coin_id: 'samplecoin',
        event_counts: {
          total: 4,
          provider_filled: 2,
          empty: 2,
        },
        sample_requests: [
          {
            route: 'ohlc_range',
            source: 'provider_filled',
            observed_at: '2026-05-05T03:00:00.000Z',
            request: { kind: 'range', days: null, from: '2026-05-04T00:00:00.000Z', to: '2026-05-04T00:00:00.000Z' },
          },
          {
            route: 'market_chart_days',
            source: 'empty',
            observed_at: '2026-05-05T02:00:00.000Z',
            request: { kind: 'days', days: '30', from: null, to: null },
          },
          {
            route: 'ohlc_days',
            source: 'provider_filled',
            observed_at: '2026-05-05T01:00:00.000Z',
            request: { kind: 'days', days: '7', from: null, to: null },
          },
        ],
      }),
    ]);
    expect(diagnostics.response_source_fallback_alert).toEqual(expect.objectContaining({
      status: 'action_needed',
      reason: 'unresolved_recent_fallback_pressure',
      recent_events_total: 4,
      events_eligible_for_suggestion: 4,
      suggestions_returned: 1,
    }));
  });

  it('caps stale exclusion drilldowns deterministically', () => {
    const diagnostics = buildMarketChartProviderDiagnostics(
      database,
      undefined,
      new Date('2026-05-06T00:00:00.000Z'),
      undefined,
      Array.from({ length: 6 }, (_, index) => ({
        route: 'market_chart_range' as const,
        source: 'empty' as const,
        coin_id: `stale-${index}`,
        vs_currency: 'usd',
        interval: 'daily',
        request: {
          kind: 'range' as const,
          days: null,
          from: `2026-04-0${index + 1}T00:00:00.000Z`,
          to: `2026-04-0${index + 1}T00:00:00.000Z`,
        },
        observed_at: `2026-04-2${index}T00:00:00.000Z`,
      })),
    );

    expect(diagnostics.response_source_target_suggestion_exclusions).toMatchObject({
      sample_limit: 5,
      source_backed_events: [],
    });
    expect(diagnostics.response_source_target_suggestion_exclusions?.stale_events).toHaveLength(5);
    expect(diagnostics.response_source_target_suggestion_exclusions?.stale_events.map((event) => event.coin_id)).toEqual([
      'stale-5',
      'stale-4',
      'stale-3',
      'stale-2',
      'stale-1',
    ]);
    expect(diagnostics.response_source_fallback_alert).toEqual({
      status: 'watch',
      reason: 'stale_fallback_pressure_only',
      recent_events_total: 6,
      events_eligible_for_suggestion: 0,
      suggestions_returned: 0,
      stale_events_ignored: 6,
      source_backed_events_suppressed: 0,
    });
    expect(diagnostics.response_source_target_suggestion_batch_previews).toEqual(expect.objectContaining({
      total_suggestions: 0,
      cap: {
        preview_source: 'response_source_target_suggestions',
        suggestions_returned: 0,
        suggestions_limit: 20,
      },
      groups: {
        daily_history: expect.objectContaining({
          target_count: 0,
          target_templates: [],
          market_chart_targets_template: null,
        }),
        intraday_history: expect.objectContaining({
          target_count: 0,
          target_templates: [],
          market_chart_targets_template: null,
        }),
      },
    }));
  });
});
