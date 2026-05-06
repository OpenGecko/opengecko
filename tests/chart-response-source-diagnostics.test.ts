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
  });
});
