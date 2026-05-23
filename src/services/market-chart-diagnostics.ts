import type { AppDatabase } from '../db/client';
import { coins, marketChartSourcePoints, ohlcvSyncTargets } from '../db/schema';
import type { ChartResponseSourceCounts, ChartResponseSourceRecentEvent } from './chart-response-source-diagnostics';
import { parseMarketChartTargetConfig } from './market-chart-sync';
import { DEFAULT_OHLCV_LEASE_TTL_MS, isOhlcvLeaseExpired } from './ohlcv-scheduling-policy';

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
const DAILY_PRODUCTION_FRESHNESS_THRESHOLD_SECONDS = 2 * 60 * 60;
const INTRADAY_PRODUCTION_FRESHNESS_THRESHOLD_SECONDS = 5 * 60;
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

function productionFreshnessThresholdSeconds(interval: string) {
  return interval === '1m' ? INTRADAY_PRODUCTION_FRESHNESS_THRESHOLD_SECONDS : DAILY_PRODUCTION_FRESHNESS_THRESHOLD_SECONDS;
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
  const productionFreshnessThreshold = productionFreshnessThresholdSeconds(interval);
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
    production_freshness_threshold_seconds: productionFreshnessThreshold,
    production_freshness: latestFetchedAt === null
      ? 'unknown'
      : sourceAgeSeconds !== null && sourceAgeSeconds <= productionFreshnessThreshold
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

function emptyOhlcvStatusCounts() {
  return {
    idle: 0,
    running: 0,
    failed: 0,
  };
}

function buildOhlcvSyncDiagnosticsForTarget(
  rows: Array<typeof ohlcvSyncTargets.$inferSelect>,
  interval: string,
  now: Date,
) {
  const statusCounts = emptyOhlcvStatusCounts();
  let activeLeaseCount = 0;
  let staleLeaseCount = 0;
  let recoveredStaleTotal = 0;
  let latestSyncedAt: Date | null = null;
  let oldestSyncedAt: Date | null = null;

  for (const row of rows) {
    statusCounts[row.status] += 1;
    if (row.status === 'running') {
      if (isOhlcvLeaseExpired(row, now)) {
        staleLeaseCount += 1;
      } else {
        activeLeaseCount += 1;
      }
    }
    recoveredStaleTotal += row.leaseRecoveryCount;
    if (row.latestSyncedAt && (!latestSyncedAt || row.latestSyncedAt.getTime() > latestSyncedAt.getTime())) {
      latestSyncedAt = row.latestSyncedAt;
    }
    if (row.oldestSyncedAt && (!oldestSyncedAt || row.oldestSyncedAt.getTime() < oldestSyncedAt.getTime())) {
      oldestSyncedAt = row.oldestSyncedAt;
    }
  }

  const freshnessThreshold = freshnessThresholdSeconds(interval);
  const latestAgeSeconds = latestSyncedAt
    ? Math.max(0, Math.floor((now.getTime() - latestSyncedAt.getTime()) / 1_000))
    : null;

  return {
    target_count: rows.length,
    status_counts: statusCounts,
    active_leases: activeLeaseCount,
    stale_leases: staleLeaseCount,
    recovered_stale_total: recoveredStaleTotal,
    latest_synced_at: latestSyncedAt?.toISOString() ?? null,
    oldest_synced_at: oldestSyncedAt?.toISOString() ?? null,
    latest_age_seconds: latestAgeSeconds,
    freshness_threshold_seconds: freshnessThreshold,
    freshness: latestAgeSeconds === null
      ? 'unknown'
      : latestAgeSeconds <= freshnessThreshold
        ? 'fresh'
        : 'stale',
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

function buildRoutePressure(routes: Record<ResponseSourceRecentEventRoute, Record<ResponseSourceRecentEventSource, number>>) {
  const totals = Object.fromEntries(RESPONSE_SOURCE_EVENT_ROUTES.map((route) => [
    route,
    routes[route].provider_filled + routes[route].empty,
  ])) as Record<ResponseSourceRecentEventRoute, number>;
  const dominantRoute = RESPONSE_SOURCE_EVENT_ROUTES
    .filter((route) => totals[route] > 0)
    .sort((left, right) =>
      totals[right] - totals[left]
      || RESPONSE_SOURCE_EVENT_ROUTES.indexOf(left) - RESPONSE_SOURCE_EVENT_ROUTES.indexOf(right))[0] ?? null;

  return {
    dominant_route: dominantRoute,
    totals,
  };
}

function emptyRequestKindPressure() {
  return {
    days: 0,
    range: 0,
  };
}

function buildRequestKindPressure(requestKinds: Record<'days' | 'range', number>) {
  const dominantKind = requestKinds.days === 0 && requestKinds.range === 0
    ? null
    : requestKinds.days >= requestKinds.range
      ? 'days'
      : 'range';

  return {
    dominant_kind: dominantKind,
    totals: {
      days: requestKinds.days,
      range: requestKinds.range,
    },
  };
}

type RangeSpanBucket = 'intraday' | 'single_day' | 'multi_day';

function emptyRangeSpanPressure() {
  return {
    range_requests: 0,
    buckets: {
      intraday: 0,
      single_day: 0,
      multi_day: 0,
    } satisfies Record<RangeSpanBucket, number>,
    min_span_seconds: null as number | null,
    max_span_seconds: null as number | null,
  };
}

function rangeSpanBucket(event: ChartResponseSourceRecentEvent, spanSeconds: number): RangeSpanBucket {
  const interval = targetIntervalFromEvent(event);
  if (interval === '1m' && spanSeconds < 24 * 60 * 60) {
    return 'intraday';
  }

  return spanSeconds <= 24 * 60 * 60 ? 'single_day' : 'multi_day';
}

function recordRangeSpan(
  pressure: ReturnType<typeof emptyRangeSpanPressure>,
  event: ChartResponseSourceRecentEvent,
) {
  if (event.request.kind !== 'range' || event.request.from === null || event.request.to === null) {
    return;
  }

  const fromMs = Date.parse(event.request.from);
  const toMs = Date.parse(event.request.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return;
  }

  const spanSeconds = Math.max(0, Math.floor((toMs - fromMs) / 1_000));
  pressure.range_requests += 1;
  pressure.buckets[rangeSpanBucket(event, spanSeconds)] += 1;
  pressure.min_span_seconds = pressure.min_span_seconds === null
    ? spanSeconds
    : Math.min(pressure.min_span_seconds, spanSeconds);
  pressure.max_span_seconds = pressure.max_span_seconds === null
    ? spanSeconds
    : Math.max(pressure.max_span_seconds, spanSeconds);
}

function buildRangeSpanPressure(pressure: ReturnType<typeof emptyRangeSpanPressure>) {
  const bucketOrder: RangeSpanBucket[] = ['intraday', 'single_day', 'multi_day'];
  const dominantBucket = bucketOrder
    .filter((bucket) => pressure.buckets[bucket] > 0)
    .sort((left, right) =>
      pressure.buckets[right] - pressure.buckets[left]
      || bucketOrder.indexOf(left) - bucketOrder.indexOf(right))[0] ?? null;

  return {
    dominant_bucket: dominantBucket,
    range_requests: pressure.range_requests,
    buckets: pressure.buckets,
    min_span_seconds: pressure.min_span_seconds,
    max_span_seconds: pressure.max_span_seconds,
  };
}

function buildCoverageTargetHint(
  interval: '1d' | '1m',
  requestKindPressure: ReturnType<typeof buildRequestKindPressure>,
  rangeSpanPressure: ReturnType<typeof buildRangeSpanPressure>,
) {
  const targetHistory = interval === '1m' ? 'intraday_history' : 'daily_history';

  return {
    target_history: targetHistory,
    suggested_action: interval === '1m' ? 'expand_intraday_history' : 'expand_daily_history',
    request_pattern: requestKindPressure.dominant_kind,
    range_window: rangeSpanPressure.dominant_bucket,
  };
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
    request_kinds: Record<'days' | 'range', number>;
    range_spans: ReturnType<typeof emptyRangeSpanPressure>;
    latest_observed_at: string | null;
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
      request_kinds: emptyRequestKindPressure(),
      range_spans: emptyRangeSpanPressure(),
      latest_observed_at: null,
      sample_requests: [],
    };

    existing.event_counts.total += 1;
    existing.event_counts[event.source] += 1;
    existing.routes[event.route][event.source] += 1;
    existing.request_kinds[event.request.kind] += 1;
    recordRangeSpan(existing.range_spans, event);
    existing.latest_observed_at = existing.latest_observed_at === null
      || observedAtMs > Date.parse(existing.latest_observed_at)
      ? event.observed_at
      : existing.latest_observed_at;
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
      route_pressure: buildRoutePressure(suggestion.routes),
      request_kind_pressure: buildRequestKindPressure(suggestion.request_kinds),
      range_span_pressure: buildRangeSpanPressure(suggestion.range_spans),
      sample_requests: suggestion.sample_requests
        .sort(sortSuggestionSampleRequests)
        .slice(0, RESPONSE_SOURCE_TARGET_SUGGESTION_SAMPLE_LIMIT),
    }))
    .sort((left, right) =>
      right.event_counts.total - left.event_counts.total
      || right.event_counts.provider_filled - left.event_counts.provider_filled
      || right.event_counts.empty - left.event_counts.empty
      || Date.parse(right.latest_observed_at ?? '') - Date.parse(left.latest_observed_at ?? '')
      || left.coin_id.localeCompare(right.coin_id)
      || left.vs_currency.localeCompare(right.vs_currency)
      || left.interval.localeCompare(right.interval))
    .slice(0, RESPONSE_SOURCE_TARGET_SUGGESTION_LIMIT)
    .map((suggestion, index) => ({
      coin_id: suggestion.coin_id,
      vs_currency: suggestion.vs_currency,
      interval: suggestion.interval,
      target_template: suggestion.target_template,
      reason: suggestion.reason,
      event_counts: suggestion.event_counts,
      routes: suggestion.routes,
      route_pressure: suggestion.route_pressure,
      request_kind_pressure: suggestion.request_kind_pressure,
      range_span_pressure: suggestion.range_span_pressure,
      coverage_target_hint: buildCoverageTargetHint(
        suggestion.interval,
        suggestion.request_kind_pressure,
        suggestion.range_span_pressure,
      ),
      sample_requests: suggestion.sample_requests,
      priority: {
        rank: index + 1,
        pressure_score: suggestion.event_counts.total,
        latest_observed_at: suggestion.latest_observed_at,
      },
    }));
}

function buildResponseSourceTargetSuggestionOperatorSummary(
  suggestions: ReturnType<typeof buildResponseSourceTargetSuggestions>,
) {
  const targetHistoryCounts = {
    daily_history: 0,
    intraday_history: 0,
  };
  const suggestedActionCounts = {
    expand_daily_history: 0,
    expand_intraday_history: 0,
  };
  const requestPatternCounts = {
    days: 0,
    range: 0,
    none: 0,
  };
  const rangeWindowCounts = {
    intraday: 0,
    single_day: 0,
    multi_day: 0,
    none: 0,
  };

  for (const suggestion of suggestions) {
    const targetHistory = suggestion.coverage_target_hint.target_history as keyof typeof targetHistoryCounts;
    const suggestedAction = suggestion.coverage_target_hint.suggested_action as keyof typeof suggestedActionCounts;
    const requestPattern = (suggestion.coverage_target_hint.request_pattern ?? 'none') as keyof typeof requestPatternCounts;
    const rangeWindow = (suggestion.coverage_target_hint.range_window ?? 'none') as keyof typeof rangeWindowCounts;

    targetHistoryCounts[targetHistory] += 1;
    suggestedActionCounts[suggestedAction] += 1;
    requestPatternCounts[requestPattern] += 1;
    rangeWindowCounts[rangeWindow] += 1;
  }

  return {
    total_suggestions: suggestions.length,
    target_history_counts: targetHistoryCounts,
    suggested_action_counts: suggestedActionCounts,
    request_pattern_counts: requestPatternCounts,
    range_window_counts: rangeWindowCounts,
  };
}

function buildResponseSourceTargetSuggestionOverflow(
  events: ChartResponseSourceRecentEvent[],
  sourceBackedTargetKeys: Set<string>,
  now: Date,
  suggestions: ReturnType<typeof buildResponseSourceTargetSuggestions>,
) {
  const cutoffMs = responseSourceTargetSuggestionCutoffMs(now);
  const eligibleTargets = new Map<string, {
    target_history: 'daily_history' | 'intraday_history';
  }>();
  const targetHistoryCounts = {
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
  };

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

    eligibleTargets.set(key, {
      target_history: interval === '1m' ? 'intraday_history' : 'daily_history',
    });
  }

  for (const target of eligibleTargets.values()) {
    targetHistoryCounts[target.target_history].eligible_targets += 1;
  }

  for (const suggestion of suggestions) {
    const targetHistory = suggestion.coverage_target_hint.target_history as keyof typeof targetHistoryCounts;
    targetHistoryCounts[targetHistory].returned_suggestions += 1;
  }

  for (const targetHistory of Object.keys(targetHistoryCounts) as Array<keyof typeof targetHistoryCounts>) {
    targetHistoryCounts[targetHistory].omitted_by_suggestion_cap = Math.max(
      0,
      targetHistoryCounts[targetHistory].eligible_targets - targetHistoryCounts[targetHistory].returned_suggestions,
    );
  }

  return {
    basis: 'eligible_unique_targets_after_stale_and_source_backed_filtering',
    suggestions_limit: RESPONSE_SOURCE_TARGET_SUGGESTION_LIMIT,
    eligible_targets: eligibleTargets.size,
    returned_suggestions: suggestions.length,
    omitted_by_suggestion_cap: Math.max(0, eligibleTargets.size - suggestions.length),
    target_history_counts: targetHistoryCounts,
  };
}

function buildResponseSourceTargetSuggestionBatchPreviews(
  suggestions: ReturnType<typeof buildResponseSourceTargetSuggestions>,
) {
  const groups = {
    daily_history: {
      target_history: 'daily_history',
      suggested_action: 'expand_daily_history',
      target_count: 0,
      target_templates: [] as string[],
      market_chart_targets_template: null as string | null,
    },
    intraday_history: {
      target_history: 'intraday_history',
      suggested_action: 'expand_intraday_history',
      target_count: 0,
      target_templates: [] as string[],
      market_chart_targets_template: null as string | null,
    },
  };

  for (const suggestion of suggestions) {
    const targetHistory = suggestion.coverage_target_hint.target_history as keyof typeof groups;
    groups[targetHistory].target_templates.push(suggestion.target_template);
  }

  for (const group of Object.values(groups)) {
    group.target_count = group.target_templates.length;
    group.market_chart_targets_template = group.target_templates.length > 0
      ? group.target_templates.join(',')
      : null;
  }

  return {
    provider_placeholder: '<provider>',
    total_suggestions: suggestions.length,
    cap: {
      preview_source: 'response_source_target_suggestions',
      suggestions_returned: suggestions.length,
      suggestions_limit: RESPONSE_SOURCE_TARGET_SUGGESTION_LIMIT,
    },
    groups,
  };
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

function buildMarketChartFallbackAlertStatus(
  summary: ReturnType<typeof buildResponseSourceTargetSuggestionSummary>,
) {
  if (summary.recent_events_total === 0) {
    return {
      status: 'clear',
      reason: 'no_recent_fallback_events',
      recent_events_total: summary.recent_events_total,
      events_eligible_for_suggestion: summary.events_eligible_for_suggestion,
      suggestions_returned: summary.suggestions_returned,
      stale_events_ignored: summary.stale_events_ignored,
      source_backed_events_suppressed: summary.source_backed_events_suppressed,
    };
  }

  if (summary.suggestions_returned > 0 || summary.events_eligible_for_suggestion > 0) {
    return {
      status: 'action_needed',
      reason: 'unresolved_recent_fallback_pressure',
      recent_events_total: summary.recent_events_total,
      events_eligible_for_suggestion: summary.events_eligible_for_suggestion,
      suggestions_returned: summary.suggestions_returned,
      stale_events_ignored: summary.stale_events_ignored,
      source_backed_events_suppressed: summary.source_backed_events_suppressed,
    };
  }

  if (summary.source_backed_events_suppressed > 0) {
    return {
      status: 'watch',
      reason: 'source_backed_fallback_pressure_suppressed',
      recent_events_total: summary.recent_events_total,
      events_eligible_for_suggestion: summary.events_eligible_for_suggestion,
      suggestions_returned: summary.suggestions_returned,
      stale_events_ignored: summary.stale_events_ignored,
      source_backed_events_suppressed: summary.source_backed_events_suppressed,
    };
  }

  return {
    status: 'watch',
    reason: 'stale_fallback_pressure_only',
    recent_events_total: summary.recent_events_total,
    events_eligible_for_suggestion: summary.events_eligible_for_suggestion,
    suggestions_returned: summary.suggestions_returned,
    stale_events_ignored: summary.stale_events_ignored,
    source_backed_events_suppressed: summary.source_backed_events_suppressed,
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
  const syncTargetRows = database.db.select().from(ohlcvSyncTargets).all();

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
    const coinSyncTargetRows = syncTargetRows.filter((row) =>
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
      ohlcv_sync: buildOhlcvSyncDiagnosticsForTarget(coinSyncTargetRows, interval, now),
    };
  });
  const configuredCoinDiagnostics = coinDiagnostics.filter((coin) => coin.configured_provider !== null);
  const sourceBackedTargetKeys = new Set(coinDiagnostics
    .filter((coin) => coin.status === 'live_backed')
    .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)));
  const responseSourceTargetSuggestions = responseSourceRecentEvents
    ? buildResponseSourceTargetSuggestions(responseSourceRecentEvents, sourceBackedTargetKeys, now)
    : null;
  const responseSourceTargetSuggestionSummary = responseSourceRecentEvents
    ? buildResponseSourceTargetSuggestionSummary(
      responseSourceRecentEvents,
      sourceBackedTargetKeys,
      now,
      responseSourceTargetSuggestions?.length ?? 0,
    )
    : null;
  const configuredOhlcvSyncDiagnostics = configuredCoinDiagnostics.map((coin) => coin.ohlcv_sync);

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
        .filter((coin) => coin.status === 'live_backed')
        .length,
      live_backed_configured_targets: configuredCoinDiagnostics
        .filter((coin) => coin.status === 'live_backed')
        .length,
      replay_backed_configured_targets: configuredCoinDiagnostics
        .filter((coin) => coin.status === 'replay_backed')
        .length,
      status_counts: countBy(
        configuredCoinDiagnostics.map((coin) => coin.status),
        ['configured_pending', 'live_backed', 'replay_backed', 'fallback_only', 'missing'],
      ),
      freshness_counts: countBy(
        configuredCoinDiagnostics.map((coin) => coin.coverage.freshness),
        ['fresh', 'stale', 'unknown'],
      ),
      production_freshness_counts: countBy(
        configuredCoinDiagnostics.map((coin) => coin.coverage.production_freshness),
        ['fresh', 'stale', 'unknown'],
      ),
      depth_counts: countBy(
        configuredCoinDiagnostics.map((coin) => coin.coverage.depth),
        ['deep', 'shallow', 'empty'],
      ),
      ohlcv_sync: {
        target_count: configuredOhlcvSyncDiagnostics.reduce((total, sync) => total + sync.target_count, 0),
        active_leases: configuredOhlcvSyncDiagnostics.reduce((total, sync) => total + sync.active_leases, 0),
        stale_leases: configuredOhlcvSyncDiagnostics.reduce((total, sync) => total + sync.stale_leases, 0),
        recovered_stale_total: configuredOhlcvSyncDiagnostics.reduce((total, sync) => total + sync.recovered_stale_total, 0),
        stale_targets: configuredCoinDiagnostics
          .filter((coin) => coin.ohlcv_sync.freshness === 'stale' || coin.ohlcv_sync.stale_leases > 0)
          .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
        recovered_targets: configuredCoinDiagnostics
          .filter((coin) => coin.ohlcv_sync.recovered_stale_total > 0)
          .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
        lease_ttl_seconds: Math.floor(DEFAULT_OHLCV_LEASE_TTL_MS / 1000),
      },
    },
    response_source_counts: responseSourceCounts ?? null,
    response_source_recent_events: responseSourceRecentEvents ?? null,
    response_source_recent_event_rollups: responseSourceRecentEvents
      ? buildResponseSourceRecentEventRollups(responseSourceRecentEvents)
      : null,
    response_source_target_suggestion_window: buildResponseSourceTargetSuggestionWindow(now, responseSourceRecentEvents),
    response_source_target_suggestion_summary: responseSourceTargetSuggestionSummary,
    response_source_fallback_alert: responseSourceTargetSuggestionSummary
      ? buildMarketChartFallbackAlertStatus(responseSourceTargetSuggestionSummary)
      : null,
    response_source_target_suggestion_operator_summary: responseSourceTargetSuggestions
      ? buildResponseSourceTargetSuggestionOperatorSummary(responseSourceTargetSuggestions)
      : null,
    response_source_target_suggestion_overflow: responseSourceRecentEvents && responseSourceTargetSuggestions
      ? buildResponseSourceTargetSuggestionOverflow(responseSourceRecentEvents, sourceBackedTargetKeys, now, responseSourceTargetSuggestions)
      : null,
    response_source_target_suggestion_batch_previews: responseSourceTargetSuggestions
      ? buildResponseSourceTargetSuggestionBatchPreviews(responseSourceTargetSuggestions)
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
      production_stale_source_targets: coinDiagnostics
        .filter((coin) => coin.configured_provider !== null && coin.coverage.production_freshness === 'stale')
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
      shallow_source_targets: coinDiagnostics
        .filter((coin) => coin.configured_provider !== null && coin.coverage.depth === 'shallow')
        .map((coin) => candidateKey(coin.coin_id, coin.vs_currency, coin.interval)),
    },
    notes: 'Configured market chart targets without source rows may be unsupported, failed, or not yet synced; stale or shallow source targets need a successful sync or deeper backfill before freshness claims; fallback-only market charts use seeded OHLCV/current snapshot blending and must not be advertised as live chart history.',
  };
}
