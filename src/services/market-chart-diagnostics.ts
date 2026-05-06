import type { AppDatabase } from '../db/client';
import { coins, marketChartSourcePoints } from '../db/schema';
import type { ChartResponseSourceCounts, ChartResponseSourceRecentEvent } from './chart-response-source-diagnostics';
import { parseMarketChartTargetConfig } from './market-chart-sync';

type MarketChartSourceRow = typeof marketChartSourcePoints.$inferSelect;
type ResponseSourceRecentEventSource = ChartResponseSourceRecentEvent['source'];
type ResponseSourceRecentEventRoute = ChartResponseSourceRecentEvent['route'];
type ResponseSourceTargetSuggestionRequestSample = {
  route: ResponseSourceRecentEventRoute;
  source: ResponseSourceRecentEventSource;
  observed_at: string;
  request: ChartResponseSourceRecentEvent['request'];
};
type ResponseSourceTargetSuggestionExclusionSample = ResponseSourceTargetSuggestionRequestSample & {
  coin_id: string;
  vs_currency: string;
  interval: '1d' | '1m';
  target_template: string;
};

const DAILY_FRESHNESS_THRESHOLD_SECONDS = 36 * 60 * 60;
const INTRADAY_FRESHNESS_THRESHOLD_SECONDS = 30 * 60;
const DAILY_DEPTH_THRESHOLD_DAYS = 30;
const INTRADAY_DEPTH_THRESHOLD_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RESPONSE_SOURCE_EVENT_ROUTES: ResponseSourceRecentEventRoute[] = ['market_chart_days', 'market_chart_range', 'ohlc_days', 'ohlc_range'];
const RESPONSE_SOURCE_EVENT_SOURCES: ResponseSourceRecentEventSource[] = ['provider_filled', 'empty'];
const RESPONSE_SOURCE_EVENT_COIN_LIMIT = 20;
const RESPONSE_SOURCE_TARGET_SUGGESTION_LIMIT = 20;
const RESPONSE_SOURCE_TARGET_SUGGESTION_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const RESPONSE_SOURCE_TARGET_SUGGESTION_SAMPLE_LIMIT = 3;
const RESPONSE_SOURCE_TARGET_SUGGESTION_EXCLUSION_LIMIT = 5;

function candidateKey(coinId: string, vsCurrency: string, interval: string) {
  return `${coinId}:${vsCurrency}:${interval}`;
}

function latestDate(rows: MarketChartSourceRow[]) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = row.sourceFetchedAt;

    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function countSourceKind(rows: MarketChartSourceRow[], sourceKind: 'replay' | 'live') {
  return rows.filter((row) => row.sourceKind === sourceKind).length;
}

function timestampBounds(rows: MarketChartSourceRow[]) {
  return rows.reduce<{ oldest: Date | null; newest: Date | null }>((bounds, row) => {
    const timestamp = row.timestamp;

    return {
      oldest: bounds.oldest === null || timestamp.getTime() < bounds.oldest.getTime()
        ? timestamp
        : bounds.oldest,
      newest: bounds.newest === null || timestamp.getTime() > bounds.newest.getTime()
        ? timestamp
        : bounds.newest,
    };
  }, { oldest: null, newest: null });
}

function freshnessThresholdSeconds(interval: string) {
  return interval === '1m' ? INTRADAY_FRESHNESS_THRESHOLD_SECONDS : DAILY_FRESHNESS_THRESHOLD_SECONDS;
}

function depthThresholdDays(interval: string) {
  return interval === '1m' ? INTRADAY_DEPTH_THRESHOLD_DAYS : DAILY_DEPTH_THRESHOLD_DAYS;
}

function granularityDays(interval: string) {
  return interval === '1m' ? 1 / 1_440 : 1;
}

function buildCoverageDiagnostics(rows: MarketChartSourceRow[], interval: string, now: Date) {
  const latestFetchedAt = latestDate(rows);
  const bounds = timestampBounds(rows);
  const freshnessThreshold = freshnessThresholdSeconds(interval);
  const depthThreshold = depthThresholdDays(interval);
  const sourceAgeSeconds = latestFetchedAt === null
    ? null
    : Math.max(0, Math.floor((now.getTime() - latestFetchedAt.getTime()) / 1_000));
  const sourceCoverageDays = bounds.oldest === null || bounds.newest === null
    ? 0
    : Math.max(granularityDays(interval), (bounds.newest.getTime() - bounds.oldest.getTime()) / DAY_MS + granularityDays(interval));

  return {
    oldest_point_at: bounds.oldest?.toISOString() ?? null,
    newest_point_at: bounds.newest?.toISOString() ?? null,
    source_age_seconds: sourceAgeSeconds,
    freshness_threshold_seconds: freshnessThreshold,
    freshness: latestFetchedAt === null
      ? 'unknown'
      : sourceAgeSeconds !== null && sourceAgeSeconds <= freshnessThreshold
        ? 'fresh'
        : 'stale',
    source_coverage_days: Number(sourceCoverageDays.toFixed(6)),
    depth_threshold_days: depthThreshold,
    depth: rows.length === 0
      ? 'empty'
      : sourceCoverageDays >= depthThreshold
        ? 'deep'
        : 'shallow',
  };
}

function countBy<T extends string>(values: T[], expectedValues: T[]) {
  return Object.fromEntries(expectedValues.map((value) => [
    value,
    values.filter((candidate) => candidate === value).length,
  ])) as Record<T, number>;
}

function emptyRecentEventSourceCounts() {
  return Object.fromEntries(RESPONSE_SOURCE_EVENT_SOURCES.map((source) => [source, 0])) as Record<ResponseSourceRecentEventSource, number>;
}

function emptyRecentEventRouteCounts() {
  return Object.fromEntries(RESPONSE_SOURCE_EVENT_ROUTES.map((route) => [
    route,
    emptyRecentEventSourceCounts(),
  ])) as Record<ResponseSourceRecentEventRoute, Record<ResponseSourceRecentEventSource, number>>;
}

function buildResponseSourceRecentEventRollups(events: ChartResponseSourceRecentEvent[]) {
  const byRoute = emptyRecentEventRouteCounts();
  const coinRollups = new Map<string, {
    coin_id: string;
    vs_currency: string;
    total: number;
    provider_filled: number;
    empty: number;
    routes: Record<ResponseSourceRecentEventRoute, Record<ResponseSourceRecentEventSource, number>>;
  }>();

  for (const event of events) {
    byRoute[event.route][event.source] += 1;

    const key = `${event.coin_id}:${event.vs_currency}`;
    const existing = coinRollups.get(key) ?? {
      coin_id: event.coin_id,
      vs_currency: event.vs_currency,
      total: 0,
      provider_filled: 0,
      empty: 0,
      routes: emptyRecentEventRouteCounts(),
    };

    existing.total += 1;
    existing[event.source] += 1;
    existing.routes[event.route][event.source] += 1;
    coinRollups.set(key, existing);
  }

  return {
    total_events: events.length,
    by_route: byRoute,
    by_coin: [...coinRollups.values()]
      .sort((left, right) =>
        right.total - left.total
        || right.provider_filled - left.provider_filled
        || right.empty - left.empty
        || left.coin_id.localeCompare(right.coin_id)
        || left.vs_currency.localeCompare(right.vs_currency))
      .slice(0, RESPONSE_SOURCE_EVENT_COIN_LIMIT),
  };
}

function targetIntervalFromEvent(event: ChartResponseSourceRecentEvent) {
  if (event.interval === '1m' || event.interval === 'hourly') {
    return '1m';
  }

  return '1d';
}

function responseSourceTargetSuggestionCutoffMs(now: Date) {
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return todayUtcMs - RESPONSE_SOURCE_TARGET_SUGGESTION_WINDOW_SECONDS * 1_000;
}

function sortSuggestionSampleRequests(
  left: ResponseSourceTargetSuggestionRequestSample,
  right: ResponseSourceTargetSuggestionRequestSample,
) {
  return Date.parse(right.observed_at) - Date.parse(left.observed_at)
    || left.route.localeCompare(right.route)
    || left.source.localeCompare(right.source)
    || JSON.stringify(left.request).localeCompare(JSON.stringify(right.request));
}

function sortSuggestionExclusionSamples(
  left: ResponseSourceTargetSuggestionExclusionSample,
  right: ResponseSourceTargetSuggestionExclusionSample,
) {
  return sortSuggestionSampleRequests(left, right)
    || left.coin_id.localeCompare(right.coin_id)
    || left.vs_currency.localeCompare(right.vs_currency)
    || left.interval.localeCompare(right.interval);
}

function targetSuggestionExclusionSample(event: ChartResponseSourceRecentEvent): ResponseSourceTargetSuggestionExclusionSample {
  const interval = targetIntervalFromEvent(event);

  return {
    coin_id: event.coin_id,
    vs_currency: event.vs_currency,
    interval,
    target_template: `<provider>=${event.coin_id}:${interval}:${event.vs_currency}`,
    route: event.route,
    source: event.source,
    observed_at: event.observed_at,
    request: event.request,
  };
}

function buildResponseSourceTargetSuggestions(
  events: ChartResponseSourceRecentEvent[],
  sourceBackedTargetKeys: Set<string>,
  now: Date,
) {
  const cutoffMs = responseSourceTargetSuggestionCutoffMs(now);
  const suggestions = new Map<string, {
    coin_id: string;
    vs_currency: string;
    interval: '1d' | '1m';
    target_template: string;
    reason: string;
    event_counts: {
      total: number;
      provider_filled: number;
      empty: number;
    };
    routes: Record<ResponseSourceRecentEventRoute, Record<ResponseSourceRecentEventSource, number>>;
    sample_requests: ResponseSourceTargetSuggestionRequestSample[];
  }>();

  for (const event of events) {
    const observedAtMs = Date.parse(event.observed_at);
    if (!Number.isFinite(observedAtMs) || observedAtMs < cutoffMs) {
      continue;
    }

    const interval = targetIntervalFromEvent(event);
    const key = candidateKey(event.coin_id, event.vs_currency, interval);
    if (sourceBackedTargetKeys.has(key)) {
      continue;
    }

    const existing = suggestions.get(key) ?? {
      coin_id: event.coin_id,
      vs_currency: event.vs_currency,
      interval,
      target_template: `<provider>=${event.coin_id}:${interval}:${event.vs_currency}`,
      reason: 'recent provider-filled or empty public chart/OHLC fallback events',
      event_counts: {
        total: 0,
        provider_filled: 0,
        empty: 0,
      },
      routes: emptyRecentEventRouteCounts(),
      sample_requests: [],
    };

    existing.event_counts.total += 1;
    existing.event_counts[event.source] += 1;
    existing.routes[event.route][event.source] += 1;
    existing.sample_requests.push({
      route: event.route,
      source: event.source,
      observed_at: event.observed_at,
      request: event.request,
    });
    suggestions.set(key, existing);
  }

  return [...suggestions.values()]
    .map((suggestion) => ({
      ...suggestion,
      sample_requests: suggestion.sample_requests
        .sort(sortSuggestionSampleRequests)
        .slice(0, RESPONSE_SOURCE_TARGET_SUGGESTION_SAMPLE_LIMIT),
    }))
    .sort((left, right) =>
      right.event_counts.total - left.event_counts.total
      || right.event_counts.provider_filled - left.event_counts.provider_filled
      || right.event_counts.empty - left.event_counts.empty
      || left.coin_id.localeCompare(right.coin_id)
      || left.vs_currency.localeCompare(right.vs_currency)
      || left.interval.localeCompare(right.interval))
    .slice(0, RESPONSE_SOURCE_TARGET_SUGGESTION_LIMIT);
}

function buildResponseSourceTargetSuggestionExclusions(
  events: ChartResponseSourceRecentEvent[],
  sourceBackedTargetKeys: Set<string>,
  now: Date,
) {
  const cutoffMs = responseSourceTargetSuggestionCutoffMs(now);
  const staleEvents: ResponseSourceTargetSuggestionExclusionSample[] = [];
  const sourceBackedEvents: ResponseSourceTargetSuggestionExclusionSample[] = [];

  for (const event of events) {
    const observedAtMs = Date.parse(event.observed_at);
    if (!Number.isFinite(observedAtMs) || observedAtMs < cutoffMs) {
      staleEvents.push(targetSuggestionExclusionSample(event));
      continue;
    }

    const interval = targetIntervalFromEvent(event);
    const key = candidateKey(event.coin_id, event.vs_currency, interval);
    if (sourceBackedTargetKeys.has(key)) {
      sourceBackedEvents.push(targetSuggestionExclusionSample(event));
    }
  }

  return {
    sample_limit: RESPONSE_SOURCE_TARGET_SUGGESTION_EXCLUSION_LIMIT,
    stale_events: staleEvents
      .sort(sortSuggestionExclusionSamples)
      .slice(0, RESPONSE_SOURCE_TARGET_SUGGESTION_EXCLUSION_LIMIT),
    source_backed_events: sourceBackedEvents
      .sort(sortSuggestionExclusionSamples)
      .slice(0, RESPONSE_SOURCE_TARGET_SUGGESTION_EXCLUSION_LIMIT),
  };
}

function buildResponseSourceTargetSuggestionSummary(
  events: ChartResponseSourceRecentEvent[],
  sourceBackedTargetKeys: Set<string>,
  now: Date,
  suggestionsReturned: number,
) {
  const cutoffMs = responseSourceTargetSuggestionCutoffMs(now);
  let staleEventsIgnored = 0;
  let sourceBackedEventsSuppressed = 0;
  let eligibleEvents = 0;
  const uniqueEligibleTargets = new Set<string>();

  for (const event of events) {
    const observedAtMs = Date.parse(event.observed_at);
    if (!Number.isFinite(observedAtMs) || observedAtMs < cutoffMs) {
      staleEventsIgnored += 1;
      continue;
    }

    const interval = targetIntervalFromEvent(event);
    const key = candidateKey(event.coin_id, event.vs_currency, interval);
    if (sourceBackedTargetKeys.has(key)) {
      sourceBackedEventsSuppressed += 1;
      continue;
    }

    eligibleEvents += 1;
    uniqueEligibleTargets.add(key);
  }

  return {
    recent_events_total: events.length,
    stale_events_ignored: staleEventsIgnored,
    events_inside_window: events.length - staleEventsIgnored,
    source_backed_events_suppressed: sourceBackedEventsSuppressed,
    events_eligible_for_suggestion: eligibleEvents,
    unique_eligible_targets: uniqueEligibleTargets.size,
    suggestions_returned: suggestionsReturned,
    suggestions_limit: RESPONSE_SOURCE_TARGET_SUGGESTION_LIMIT,
    sample_requests_limit: RESPONSE_SOURCE_TARGET_SUGGESTION_SAMPLE_LIMIT,
  };
}

function buildResponseSourceTargetSuggestionWindow(now: Date, events?: ChartResponseSourceRecentEvent[]) {
  if (!events) {
    return null;
  }

  const cutoffMs = responseSourceTargetSuggestionCutoffMs(now);

  return {
    window_seconds: RESPONSE_SOURCE_TARGET_SUGGESTION_WINDOW_SECONDS,
    cutoff_observed_at: new Date(cutoffMs).toISOString(),
    ignored_stale_events: events.filter((event) => {
      const observedAtMs = Date.parse(event.observed_at);
      return !Number.isFinite(observedAtMs) || observedAtMs < cutoffMs;
    }).length,
  };
}

export function buildMarketChartProviderDiagnostics(
  database: AppDatabase,
  configuredTargetText: string | undefined,
  now = new Date(),
  responseSourceCounts?: ChartResponseSourceCounts,
  responseSourceRecentEvents?: ChartResponseSourceRecentEvent[],
) {
  const configuredTargets = parseMarketChartTargetConfig(configuredTargetText);
  const coinRows = database.db.select().from(coins).all();
  const chartRows = database.db.select().from(marketChartSourcePoints).all();

  const candidateKeys = new Set<string>();
  for (const target of configuredTargets) {
    candidateKeys.add(candidateKey(target.coinId, target.vsCurrency, target.interval));
  }
  for (const row of chartRows) {
    candidateKeys.add(candidateKey(row.coinId, row.vsCurrency, row.interval));
  }
  for (const coin of coinRows) {
    candidateKeys.add(candidateKey(coin.id, 'usd', '1d'));
  }

  const coinDiagnostics = [...candidateKeys].sort().map((key) => {
    const [coinId = '', vsCurrency = '', interval = ''] = key.split(':', 3);
    const configuredTarget = configuredTargets.find((target) =>
      target.coinId === coinId && target.vsCurrency === vsCurrency && target.interval === interval) ?? null;
    const coin = coinRows.find((row) => row.id === coinId) ?? null;
    const coinChartRows = chartRows.filter((row) =>
      row.coinId === coinId && row.vsCurrency === vsCurrency && row.interval === interval);
    const liveRows = coinChartRows.filter((row) => row.sourceKind === 'live');
    const replayRows = coinChartRows.filter((row) => row.sourceKind === 'replay');
    const coverage = buildCoverageDiagnostics(coinChartRows, interval, now);
    const status = liveRows.length > 0
      ? 'live_backed'
      : replayRows.length > 0
        ? 'replay_backed'
        : configuredTarget
          ? 'configured_pending'
          : coin
            ? 'fallback_only'
            : 'missing';
    const sourceProviders = [...new Set(coinChartRows
      .map((row) => row.sourceProvider)
      .filter((provider): provider is string => Boolean(provider)))].sort();

    return {
      coin_id: coinId,
      vs_currency: vsCurrency,
      interval,
      status,
      configured_provider: configuredTarget?.provider ?? null,
      source_providers: sourceProviders,
      row_counts: {
        total: coinChartRows.length,
        live: countSourceKind(coinChartRows, 'live'),
        replay: countSourceKind(coinChartRows, 'replay'),
      },
      latest_source_fetched_at: latestDate(coinChartRows)?.toISOString() ?? null,
      coverage,
    };
  });
  const configuredCoinDiagnostics = coinDiagnostics.filter((coin) => coin.configured_provider !== null);
  const sourceBackedTargetKeys = new Set(coinDiagnostics
    .filter((coin) => coin.status === 'live_backed' || coin.status === 'replay_backed')
    .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)));
  const responseSourceTargetSuggestions = responseSourceRecentEvents
    ? buildResponseSourceTargetSuggestions(responseSourceRecentEvents, sourceBackedTargetKeys, now)
    : null;

  return {
    configured_targets: configuredTargets.map((target) => ({
      provider: target.provider,
      coin_id: target.coinId,
      vs_currency: target.vsCurrency,
      interval: target.interval,
      source_provider: target.provider,
    })),
    summary: {
      configured_targets: configuredTargets.length,
      source_backed_configured_targets: configuredCoinDiagnostics
        .filter((coin) => coin.status === 'live_backed' || coin.status === 'replay_backed')
        .length,
      status_counts: countBy(
        configuredCoinDiagnostics.map((coin) => coin.status),
        ['configured_pending', 'live_backed', 'replay_backed', 'fallback_only', 'missing'],
      ),
      freshness_counts: countBy(
        configuredCoinDiagnostics.map((coin) => coin.coverage.freshness),
        ['fresh', 'stale', 'unknown'],
      ),
      depth_counts: countBy(
        configuredCoinDiagnostics.map((coin) => coin.coverage.depth),
        ['deep', 'shallow', 'empty'],
      ),
    },
    response_source_counts: responseSourceCounts ?? null,
    response_source_recent_events: responseSourceRecentEvents ?? null,
    response_source_recent_event_rollups: responseSourceRecentEvents
      ? buildResponseSourceRecentEventRollups(responseSourceRecentEvents)
      : null,
    response_source_target_suggestion_window: buildResponseSourceTargetSuggestionWindow(now, responseSourceRecentEvents),
    response_source_target_suggestion_summary: responseSourceRecentEvents
      ? buildResponseSourceTargetSuggestionSummary(
        responseSourceRecentEvents,
        sourceBackedTargetKeys,
        now,
        responseSourceTargetSuggestions?.length ?? 0,
      )
      : null,
    response_source_target_suggestion_exclusions: responseSourceRecentEvents
      ? buildResponseSourceTargetSuggestionExclusions(responseSourceRecentEvents, sourceBackedTargetKeys, now)
      : null,
    response_source_target_suggestions: responseSourceTargetSuggestions,
    coins: coinDiagnostics,
    gaps: {
      configured_without_source_rows: coinDiagnostics
        .filter((coin) => coin.configured_provider !== null && coin.latest_source_fetched_at === null)
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
      fallback_only_coins: coinDiagnostics
        .filter((coin) => coin.status === 'fallback_only')
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
      missing_coin_charts: coinDiagnostics
        .filter((coin) => coin.status === 'missing')
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
      stale_source_targets: coinDiagnostics
        .filter((coin) => coin.configured_provider !== null && coin.coverage.freshness === 'stale')
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
      shallow_source_targets: coinDiagnostics
        .filter((coin) => coin.configured_provider !== null && coin.coverage.depth === 'shallow')
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
    },
    notes: 'Configured market chart targets without source rows may be unsupported, failed, or not yet synced; stale or shallow source targets need a successful sync or deeper backfill before freshness claims; fallback-only market charts use seeded OHLCV/current snapshot blending and must not be advertised as live chart history.',
  };
}
