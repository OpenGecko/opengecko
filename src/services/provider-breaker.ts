export type ProviderBreakerStatus = 'closed' | 'open' | 'half_open';

export type ProviderBreakerEntry = {
  id: string;
  status: ProviderBreakerStatus;
  failureCount: number;
  openedUntil: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
};

export type ProviderBreakerState = {
  providers: Record<string, ProviderBreakerEntry>;
  options: {
    baseBackoffMs: number;
    maxBackoffMs: number;
    multiplier: number;
    jitterRatio: number;
    jitter: (providerId: string, failureCount: number) => number;
  };
};

export type ProviderBreakerOptions = Partial<ProviderBreakerState['options']>;

const DEFAULT_BASE_BACKOFF_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_JITTER_RATIO = 0.1;

function deterministicJitter(providerId: string, failureCount: number) {
  let hash = 2166136261;
  const input = `${providerId}:${failureCount}`;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 0xffffffff;
}

function normalizeOptions(options: ProviderBreakerOptions = {}): ProviderBreakerState['options'] {
  return {
    baseBackoffMs: options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    multiplier: options.multiplier ?? DEFAULT_MULTIPLIER,
    jitterRatio: options.jitterRatio ?? DEFAULT_JITTER_RATIO,
    jitter: options.jitter ?? deterministicJitter,
  };
}

function createEntry(providerId: string): ProviderBreakerEntry {
  return {
    id: providerId,
    status: 'closed',
    failureCount: 0,
    openedUntil: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
  };
}

function getOrCreateEntry(state: ProviderBreakerState, providerId: string) {
  state.providers[providerId] ??= createEntry(providerId);
  return state.providers[providerId];
}

export function createProviderBreakerState(
  providerIds: string[] = [],
  options?: ProviderBreakerOptions,
): ProviderBreakerState {
  return {
    providers: Object.fromEntries(providerIds.map((providerId) => [providerId, createEntry(providerId)])),
    options: normalizeOptions(options),
  };
}

export function canAttemptProvider(state: ProviderBreakerState, providerId: string, now = Date.now()) {
  const entry = getOrCreateEntry(state, providerId);

  if (entry.status !== 'open') {
    return true;
  }

  if (entry.openedUntil !== null && entry.openedUntil > now) {
    return false;
  }

  entry.status = 'half_open';
  return true;
}

export function recordProviderSuccess(state: ProviderBreakerState, providerId: string, now = Date.now()) {
  const entry = getOrCreateEntry(state, providerId);
  entry.status = 'closed';
  entry.failureCount = 0;
  entry.openedUntil = null;
  entry.lastSuccessAt = now;
  entry.lastFailureReason = null;
}

function computeBackoffMs(state: ProviderBreakerState, providerId: string, failureCount: number) {
  const { baseBackoffMs, maxBackoffMs, multiplier, jitterRatio, jitter } = state.options;
  const exponent = Math.max(0, failureCount - 1);
  const backoffWithoutJitter = Math.min(maxBackoffMs, baseBackoffMs * (multiplier ** exponent));
  const jitterValue = Math.max(0, Math.min(1, jitter(providerId, failureCount)));
  const jitterMs = Math.round(backoffWithoutJitter * jitterRatio * jitterValue);

  return Math.min(maxBackoffMs, backoffWithoutJitter + jitterMs);
}

export function recordProviderFailure(
  state: ProviderBreakerState,
  providerId: string,
  now = Date.now(),
  reason?: string,
) {
  const entry = getOrCreateEntry(state, providerId);
  entry.failureCount += 1;
  entry.status = 'open';
  entry.lastFailureAt = now;
  entry.lastFailureReason = reason ?? null;
  entry.openedUntil = now + computeBackoffMs(state, providerId, entry.failureCount);
}

export function summarizeProviderBreakerState(state: ProviderBreakerState, now = Date.now()) {
  return Object.values(state.providers)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => ({
      id: entry.id,
      status: entry.status === 'open' && entry.openedUntil !== null && entry.openedUntil <= now
        ? 'half_open' as const
        : entry.status,
      failure_count: entry.failureCount,
      opened_until: entry.openedUntil,
      last_success_at: entry.lastSuccessAt,
      last_failure_at: entry.lastFailureAt,
      last_failure_reason: entry.lastFailureReason,
      retry_in_ms: entry.status === 'open' && entry.openedUntil !== null
        ? Math.max(0, entry.openedUntil - now)
        : 0,
    }));
}
