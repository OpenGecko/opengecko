type CounterKey = string;

type CounterSample = {
  key: CounterKey;
  name: string;
  labels: Record<string, string>;
  value: number;
};

type HistogramSample = {
  key: CounterKey;
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
};

type GaugeSample = {
  key: CounterKey;
  name: string;
  labels: Record<string, string>;
  value: number;
};

function normalizeLabels(labels: Record<string, string>) {
  return Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
}

function buildKey(name: string, labels: Record<string, string>) {
  return `${name}:${JSON.stringify(normalizeLabels(labels))}`;
}

function formatLabels(labels: Record<string, string>) {
  const entries = normalizeLabels(labels);

  if (entries.length === 0) {
    return '';
  }

  const formatted = entries
    .map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`)
    .join(',');

  return `{${formatted}}`;
}

function metricBlock(header: 'counter' | 'gauge' | 'histogram', name: string, lines: string[]) {
  return [`# TYPE ${name} ${header}`, ...lines];
}

export type MetricsRegistry = {
  incrementCounter: (name: string, labels?: Record<string, string>, value?: number) => void;
  observeHistogram: (name: string, labels: Record<string, string>, value: number) => void;
  setGauge: (name: string, labels: Record<string, string>, value: number) => void;
  recordRequest: (route: string, method: string, statusCode: number, durationMs: number) => void;
  recordCacheHit: (surface: string) => void;
  recordCacheMiss: (surface: string) => void;
  recordProviderRefresh: (outcome: 'success' | 'partial_failure' | 'cooldown_skip' | 'forced_failure' | 'failure', exchangeCount: number, failedExchangeCount: number) => void;
  renderPrometheus: () => string;
};

export function createMetricsRegistry(): MetricsRegistry {
  const counters = new Map<CounterKey, CounterSample>();
  const histograms = new Map<CounterKey, HistogramSample>();
  const gauges = new Map<CounterKey, GaugeSample>();

  function incrementCounter(name: string, labels: Record<string, string> = {}, value = 1) {
    const key = buildKey(name, labels);
    const existing = counters.get(key);

    if (existing) {
      existing.value += value;
      return;
    }

    counters.set(key, {
      key,
      name,
      labels,
      value,
    });
  }

  function observeHistogram(name: string, labels: Record<string, string>, value: number) {
    const key = buildKey(name, labels);
    const existing = histograms.get(key);

    if (existing) {
      existing.count += 1;
      existing.sum += value;
      return;
    }

    histograms.set(key, {
      key,
      name,
      labels,
      count: 1,
      sum: value,
    });
  }

  function setGauge(name: string, labels: Record<string, string>, value: number) {
    const key = buildKey(name, labels);
    gauges.set(key, {
      key,
      name,
      labels,
      value,
    });
  }

  function recordRequest(route: string, method: string, statusCode: number, durationMs: number) {
    const labels = {
      route,
      method: method.toUpperCase(),
      status_code: String(statusCode),
    };

    incrementCounter('opengecko_http_requests_total', labels);
    observeHistogram('opengecko_http_request_duration_ms', labels, durationMs);
  }

  function recordCacheHit(surface: string) {
    incrementCounter('opengecko_cache_events_total', {
      surface,
      outcome: 'hit',
    });
  }

  function recordCacheMiss(surface: string) {
    incrementCounter('opengecko_cache_events_total', {
      surface,
      outcome: 'miss',
    });
  }

  function recordProviderRefresh(
    outcome: 'success' | 'partial_failure' | 'cooldown_skip' | 'forced_failure' | 'failure',
    exchangeCount: number,
    failedExchangeCount: number,
  ) {
    incrementCounter('opengecko_provider_refresh_total', {
      outcome,
    });
    setGauge('opengecko_provider_exchange_count', {}, exchangeCount);
    setGauge('opengecko_provider_failed_exchange_count', {}, failedExchangeCount);
  }

  function renderPrometheus() {
    const blocks = new Map<string, string[]>();

    for (const sample of counters.values()) {
      const lines = blocks.get(sample.name) ?? [];
      lines.push(`${sample.name}${formatLabels(sample.labels)} ${sample.value}`);
      blocks.set(sample.name, metricBlock('counter', sample.name, lines));
    }

    for (const sample of histograms.values()) {
      const lines = blocks.get(sample.name) ?? [];
      lines.push(`${sample.name}_count${formatLabels(sample.labels)} ${sample.count}`);
      lines.push(`${sample.name}_sum${formatLabels(sample.labels)} ${sample.sum}`);
      blocks.set(sample.name, metricBlock('histogram', sample.name, lines));
    }

    for (const sample of gauges.values()) {
      const lines = blocks.get(sample.name) ?? [];
      lines.push(`${sample.name}${formatLabels(sample.labels)} ${sample.value}`);
      blocks.set(sample.name, metricBlock('gauge', sample.name, lines));
    }

    return [...blocks.keys()].sort().flatMap((name) => blocks.get(name) ?? []).join('\n').concat('\n');
  }

  return {
    incrementCounter,
    observeHistogram,
    setGauge,
    recordRequest,
    recordCacheHit,
    recordCacheMiss,
    recordProviderRefresh,
    renderPrometheus,
  };
}
