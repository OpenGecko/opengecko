import {
  finishProviderAttempt,
  getProviderAttemptDiagnosticsState,
  getProviderFaultControl,
  startProviderAttempt,
  type MarketDataRuntimeState,
  type ProviderAttemptFamily,
  type ProviderAttemptOutcome,
} from './market-runtime-state';
import type { MetricsRegistry, ProviderStabilityOutcome } from './metrics';
import {
  canAttemptProvider,
  classifyProviderFailure,
  createProviderBreakerState,
  recordProviderFailure,
  recordProviderSuccess,
  summarizeProviderBreakerState,
} from './provider-breaker';
import { runBudgetedProviderFanout } from './provider-readiness-coordinator';

type ProviderFanoutValidationOptions = {
  providers: string[];
  family?: Extract<ProviderAttemptFamily, 'ticker'>;
  concurrency: number;
  budgetMs?: number;
  allowBreakerProbe?: boolean;
  now?: number;
};

type ProviderFanoutValidationResult = {
  validation_path: {
    route: string;
    method: 'POST';
    description: string;
    cache_independent: true;
    scheduler_independent: true;
    public_route_read_required: false;
  };
  family: 'ticker';
  providers: string[];
  concurrency: number;
  budget_ms: number | null;
  allow_breaker_probe: boolean;
  results: Array<{
    provider: string;
    status: 'fulfilled' | 'rejected';
    outcome: ProviderAttemptOutcome;
    reason: string | null;
  }>;
  metric_deltas: Array<{
    metric: string;
    provider: string;
    family?: string;
    outcome?: string;
    delta: number;
  }>;
  provider_attempts: {
    in_flight_count: number;
    recent_outcomes: ReturnType<typeof getProviderAttemptDiagnosticsState>['recentOutcomes'];
    outcome_counts: Array<{
      provider: string;
      family: string;
      outcome: string;
      before: number;
      after: number;
      delta: number;
    }>;
  };
  breaker_summary: ReturnType<typeof summarizeProviderBreakerState>;
};

function buildAbortError(provider: string) {
  const error = new Error(`${provider} ticker validation probe canceled by validator fault control`);
  error.name = 'AbortError';
  return error;
}

function buildTimeoutError(provider: string, budgetMs: number) {
  const error = new Error(`${provider} ticker validation probe timed out after ${budgetMs}ms`);
  error.name = 'ExchangeTickerTimeoutError';
  return error;
}

function toProviderAttemptOutcome(error: Error): ProviderAttemptOutcome {
  if (error.name === 'ProviderFanoutBudgetSkipped') {
    return 'skipped';
  }

  if (error.name === 'AbortError' || /cancell?ed|aborted/i.test(error.message)) {
    return 'canceled';
  }

  if (error.name === 'ExchangeTickerTimeoutError' || /timed?\s*out|timeout|budget exceeded/i.test(error.message)) {
    return 'timed_out';
  }

  const classified = classifyProviderFailure(error);
  if (classified.kind === 'regional_block' || classified.kind === 'provider_unavailable') {
    return 'blocked_unavailable';
  }

  return 'failed';
}

function toMetricOutcome(outcome: ProviderAttemptOutcome): ProviderStabilityOutcome {
  return outcome;
}

function providerOutcomeCountKey(provider: string, family: ProviderAttemptFamily, outcome: ProviderAttemptOutcome) {
  return `${family}:${provider}:${outcome}`;
}

function snapshotProviderOutcomeCounts(
  runtimeState: MarketDataRuntimeState,
  providers: string[],
  family: ProviderAttemptFamily,
) {
  const state = getProviderAttemptDiagnosticsState(runtimeState);
  const counts = new Map<string, number>();
  for (const provider of providers) {
    for (const outcome of [
      'successful',
      'timed_out',
      'canceled',
      'failed',
      'breaker_open',
      'blocked_unavailable',
      'skipped',
      'recovered',
    ] as const) {
      const key = providerOutcomeCountKey(provider, family, outcome);
      counts.set(key, state.outcomeCounts[key] ?? 0);
    }
  }
  return counts;
}

function buildOutcomeCountDeltas(
  runtimeState: MarketDataRuntimeState,
  beforeCounts: Map<string, number>,
  providers: string[],
  family: ProviderAttemptFamily,
) {
  const state = getProviderAttemptDiagnosticsState(runtimeState);
  const deltas: ProviderFanoutValidationResult['provider_attempts']['outcome_counts'] = [];

  for (const provider of providers) {
    for (const outcome of [
      'successful',
      'timed_out',
      'canceled',
      'failed',
      'breaker_open',
      'blocked_unavailable',
      'skipped',
      'recovered',
    ] as const) {
      const key = providerOutcomeCountKey(provider, family, outcome);
      const before = beforeCounts.get(key) ?? 0;
      const after = state.outcomeCounts[key] ?? 0;
      const delta = after - before;
      if (delta === 0) {
        continue;
      }
      deltas.push({ provider, family, outcome, before, after, delta });
    }
  }

  return deltas;
}

function maybeOpenBreakerForFailure(
  runtimeState: MarketDataRuntimeState,
  provider: string,
  now: number,
  error: Error,
) {
  runtimeState.providerBreakers ??= createProviderBreakerState([provider]);
  recordProviderFailure(runtimeState.providerBreakers, provider, now, error.message);
}

function maybeRecordProviderRecovery(
  runtimeState: MarketDataRuntimeState,
  metrics: Pick<MetricsRegistry, 'recordProviderRecovery'>,
  provider: string,
  now: number,
) {
  runtimeState.providerBreakers ??= createProviderBreakerState([provider]);
  const entry = runtimeState.providerBreakers.providers[provider];
  const hadFailure = entry
    ? entry.failureCount > 0 || entry.status !== 'closed' || entry.lastFailureAt !== null
    : false;

  recordProviderSuccess(runtimeState.providerBreakers, provider, now);

  if (hadFailure) {
    metrics.recordProviderRecovery(provider);
    return true;
  }

  return false;
}

export async function runProviderFanoutValidationTrigger(
  runtimeState: MarketDataRuntimeState,
  metrics: Pick<MetricsRegistry, 'recordProviderAttemptStart' | 'recordProviderAttemptEnd' | 'recordProviderBlockedByBreaker' | 'recordProviderRecovery'>,
  options: ProviderFanoutValidationOptions,
): Promise<ProviderFanoutValidationResult> {
  const family = options.family ?? 'ticker';
  const providers = [...new Set(options.providers)];
  const now = options.now ?? Date.now();
  const budgetMs = options.budgetMs;
  const allowBreakerProbe = options.allowBreakerProbe === true;

  runtimeState.providerBreakers ??= createProviderBreakerState(providers);
  for (const provider of providers) {
    runtimeState.providerBreakers.providers[provider] ??= createProviderBreakerState([provider]).providers[provider];
    if (allowBreakerProbe) {
      const entry = runtimeState.providerBreakers.providers[provider];
      if (entry.status === 'open') {
        entry.openedUntil = Math.min(entry.openedUntil ?? now, now);
      }
    }
  }

  const beforeCounts = snapshotProviderOutcomeCounts(runtimeState, providers, family);
  const attemptedProviders = providers.filter((provider) => canAttemptProvider(runtimeState.providerBreakers!, provider, now));
  const blockedProviders = providers.filter((provider) => !attemptedProviders.includes(provider));
  const results: ProviderFanoutValidationResult['results'] = [];

  for (const provider of blockedProviders) {
    metrics.recordProviderBlockedByBreaker(provider);
    metrics.recordProviderAttemptEnd(provider, family, 'breaker_open', 0);
    finishProviderAttempt(runtimeState, provider, family, 'breaker_open', 'provider breaker open', now, 0);
    results.push({
      provider,
      status: 'rejected',
      outcome: 'breaker_open',
      reason: 'provider breaker open',
    });
  }

  const settled = await runBudgetedProviderFanout({
    items: attemptedProviders,
    concurrency: options.concurrency,
    budgetMs,
    buildBudgetError: (provider, _index, effectiveBudgetMs) => buildTimeoutError(provider, effectiveBudgetMs),
    reportBudgetFailure: true,
    run: async (provider, _index, signal) => {
      const faultControl = getProviderFaultControl(runtimeState, provider, family);
      if (signal.aborted) {
        throw buildAbortError(provider);
      }
      if (faultControl?.mode === 'failure') {
        throw new Error(faultControl.reason ?? 'validator controlled provider failure');
      }
      if (faultControl?.mode === 'blocked_unavailable') {
        throw new Error(faultControl.reason ?? '403 Forbidden validator controlled provider unavailable');
      }
      if (faultControl?.mode === 'canceled') {
        throw buildAbortError(provider);
      }
      if (faultControl?.mode === 'timeout') {
        throw buildTimeoutError(provider, budgetMs ?? 0);
      }

      return {
        provider,
        ok: true,
      };
    },
    onStart: (provider) => {
      startProviderAttempt(runtimeState, provider, family, now);
      metrics.recordProviderAttemptStart(provider, family);
    },
    onComplete: (provider, _index, durationMs) => {
      const recovered = maybeRecordProviderRecovery(runtimeState, metrics, provider, now + durationMs);
      const outcome: ProviderAttemptOutcome = recovered ? 'recovered' : 'successful';
      finishProviderAttempt(runtimeState, provider, family, outcome, null, now + durationMs, durationMs);
      metrics.recordProviderAttemptEnd(provider, family, toMetricOutcome(outcome), durationMs);
    },
    onFailure: (provider, _index, error, durationMs) => {
      const outcome = toProviderAttemptOutcome(error);
      const classified = classifyProviderFailure(error);
      const reason = outcome === 'skipped'
        ? error.message
        : outcome === 'canceled'
          ? 'provider request canceled'
          : classified.reason;
      if (outcome !== 'skipped' && outcome !== 'breaker_open') {
        maybeOpenBreakerForFailure(runtimeState, provider, now + durationMs, error);
      }
      finishProviderAttempt(runtimeState, provider, family, outcome, reason, now + durationMs, durationMs);
      metrics.recordProviderAttemptEnd(provider, family, toMetricOutcome(outcome), durationMs);
    },
  });

  for (let index = 0; index < attemptedProviders.length; index++) {
    const provider = attemptedProviders[index];
    const result = settled[index];
    if (result?.status === 'fulfilled') {
      const recentOutcome = getProviderAttemptDiagnosticsState(runtimeState).recentOutcomes.find(
        (record) => record.provider === provider && record.family === family,
      );
      results.push({
        provider,
        status: 'fulfilled',
        outcome: recentOutcome?.outcome ?? 'successful',
        reason: null,
      });
      continue;
    }

    const error = result?.status === 'rejected'
      ? (result.reason instanceof Error ? result.reason : new Error(String(result.reason)))
      : buildTimeoutError(provider, budgetMs ?? 0);
    const outcome = toProviderAttemptOutcome(error);
    const recentOutcome = getProviderAttemptDiagnosticsState(runtimeState).recentOutcomes.find(
      (record) => record.provider === provider && record.family === family && record.outcome === outcome,
    );
    results.push({
      provider,
      status: 'rejected',
      outcome,
      reason: recentOutcome?.reason ?? classifyProviderFailure(error).reason,
    });
  }

  const outcomeCountDeltas = buildOutcomeCountDeltas(runtimeState, beforeCounts, providers, family);
  const metricDeltas: ProviderFanoutValidationResult['metric_deltas'] = outcomeCountDeltas.map((delta) => ({
    metric: 'opengecko_provider_attempts_total',
    provider: delta.provider,
    family: delta.family,
    outcome: delta.outcome,
    delta: delta.delta,
  }));
  for (const result of results) {
    if (result.outcome === 'breaker_open') {
      metricDeltas.push({
        metric: 'provider_blocked_by_breaker_total',
        provider: result.provider,
        delta: 1,
      });
    }
    if (result.outcome === 'recovered') {
      metricDeltas.push({
        metric: 'provider_recovery_total',
        provider: result.provider,
        delta: 1,
      });
    }
  }

  const providerAttemptState = getProviderAttemptDiagnosticsState(runtimeState);

  return {
    validation_path: {
      route: '/diagnostics/runtime/provider_fanout_validation',
      method: 'POST',
      description: 'Deterministically triggers ticker provider fanout against validation-control fault modes without reading cached public routes or waiting for scheduler ticks.',
      cache_independent: true,
      scheduler_independent: true,
      public_route_read_required: false,
    },
    family,
    providers,
    concurrency: options.concurrency,
    budget_ms: budgetMs ?? null,
    allow_breaker_probe: allowBreakerProbe,
    results: results.sort((left, right) => left.provider.localeCompare(right.provider)),
    metric_deltas: metricDeltas.sort((left, right) => (
      left.metric.localeCompare(right.metric)
      || left.provider.localeCompare(right.provider)
      || (left.outcome ?? '').localeCompare(right.outcome ?? '')
    )),
    provider_attempts: {
      in_flight_count: Object.keys(providerAttemptState.inFlight).length,
      recent_outcomes: providerAttemptState.recentOutcomes,
      outcome_counts: outcomeCountDeltas,
    },
    breaker_summary: summarizeProviderBreakerState(runtimeState.providerBreakers, now),
  };
}
