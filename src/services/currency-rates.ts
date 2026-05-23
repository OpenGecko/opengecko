const CURRENCY_API_URL = 'https://latest.currency-api.pages.dev/v1/currencies/usdt.json';
const DEFAULT_CURRENCY_API_REFRESH_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_REASON_LENGTH = 160;

type CurrencyApiSnapshot = {
  date: string;
  usdt: Record<string, number>;
};

export type CurrencyRefreshDiagnostics = {
  status: 'ok' | 'error';
  at: Date;
  reason?: string;
};

export type RefreshCurrencyApiRatesOptions = {
  timeoutMs?: number;
};

const BOOTSTRAP_CURRENCY_API_SNAPSHOT: CurrencyApiSnapshot = {
  date: '2026-03-21',
  usdt: {
    usdt: 1,
    usd: 0.99996459,
    eur: 0.86266947,
    btc: 0.000014153253,
    eth: 0.00046463338,
  },
};

let currentSnapshot: CurrencyApiSnapshot = BOOTSTRAP_CURRENCY_API_SNAPSHOT;
let inFlightRefresh: Promise<void> | null = null;
let refreshGeneration = 0;
let lastRefreshDiagnostics: CurrencyRefreshDiagnostics = {
  status: 'ok',
  at: new Date(0),
};

function isValidCurrencyApiSnapshot(value: unknown): value is CurrencyApiSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const snapshot = value as Partial<CurrencyApiSnapshot>;

  if (typeof snapshot.date !== 'string' || !snapshot.usdt || typeof snapshot.usdt !== 'object') {
    return false;
  }

  const usdtRates = snapshot.usdt as Record<string, unknown>;

  if (!Object.values(usdtRates).some((rate) => typeof rate === 'number' && Number.isFinite(rate) && rate > 0)) {
    return false;
  }

  return ['usdt', 'usd', 'eur', 'btc', 'eth'].every((key) => {
    const rate = usdtRates[key];
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
  });
}

export function getCurrencyApiSnapshot() {
  return currentSnapshot;
}

export function getCurrencyRefreshDiagnostics(): CurrencyRefreshDiagnostics {
  return {
    ...lastRefreshDiagnostics,
    at: new Date(lastRefreshDiagnostics.at),
  };
}

export function getSupportedVsCurrencies() {
  return Object.entries(currentSnapshot.usdt)
    .filter(([, rate]) => Number.isFinite(rate) && rate > 0)
    .map(([currencyCode]) => currencyCode.toLowerCase())
    .sort();
}

export function resetCurrencyApiSnapshotForTests() {
  currentSnapshot = BOOTSTRAP_CURRENCY_API_SNAPSHOT;
  inFlightRefresh = null;
  refreshGeneration += 1;
  lastRefreshDiagnostics = {
    status: 'ok',
    at: new Date(0),
  };
}

function getRefreshTimeoutMs(options: RefreshCurrencyApiRatesOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CURRENCY_API_REFRESH_TIMEOUT_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_CURRENCY_API_REFRESH_TIMEOUT_MS;
  }

  return timeoutMs;
}

function createCurrencyRefreshTimeoutError(timeoutMs: number) {
  const error = new Error(`Currency API refresh timed out after ${timeoutMs}ms`);
  error.name = 'AbortError';
  return error;
}

function sanitizeDiagnosticText(value: string) {
  let text = value.split(/\r?\n/u)[0] ?? '';

  text = text
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[redacted]')
    .replace(/\b[a-z0-9.-]*currency-api\.pages\.dev\b[^\s"'<>]*/giu, '[redacted]')
    .replace(/[?&][^\s"'<>]+/giu, '[redacted]')
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/giu, 'authorization=[redacted]')
    .replace(/\b(authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\b((?:request|response)\s+body|body)\s*[:=]?\s*\{[^}]*\}/giu, '$1=[redacted]')
    .replace(/\bat\s+[^\s()]+\s+\([^)]*\)/giu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();

  for (const envValue of Object.values(process.env)) {
    if (envValue && envValue.length >= 8) {
      text = text.split(envValue).join('[redacted]');
    }
  }

  if (text.length > MAX_DIAGNOSTIC_REASON_LENGTH) {
    return `${text.slice(0, MAX_DIAGNOSTIC_REASON_LENGTH - 3)}...`;
  }

  return text;
}

function sanitizeRefreshFailureReason(error: unknown) {
  const name = error instanceof Error && error.name ? sanitizeDiagnosticText(error.name) : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = sanitizeDiagnosticText(message);
  const safeName = name && /^[A-Za-z][A-Za-z0-9_.-]{0,49}$/u.test(name) ? name : 'Error';

  return `${safeName}: ${sanitizedMessage || 'Currency API refresh failed'}`;
}

async function fetchCurrencyApiSnapshot(fetchImpl: typeof fetch, timeoutMs: number) {
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<CurrencyApiSnapshot>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(createCurrencyRefreshTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      (async () => {
        const response = await Promise.resolve().then(() => fetchImpl(CURRENCY_API_URL, { signal: abortController.signal }));

        if (!response.ok) {
          throw new Error(`Currency API request failed with status ${response.status}`);
        }

        const payload = await response.json();

        if (!isValidCurrencyApiSnapshot(payload)) {
          throw new Error('Currency API response shape was invalid');
        }

        return payload;
      })(),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

export async function refreshCurrencyApiRatesOnce(fetchImpl: typeof fetch = fetch, options: RefreshCurrencyApiRatesOptions = {}) {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  const timeoutMs = getRefreshTimeoutMs(options);
  const generation = refreshGeneration;
  const refreshPromise = (async () => {
    try {
      const payload = await fetchCurrencyApiSnapshot(fetchImpl, timeoutMs);

      if (generation === refreshGeneration) {
        currentSnapshot = payload;
      }

      lastRefreshDiagnostics = {
        status: 'ok',
        at: new Date(),
      };
    } catch (error) {
      lastRefreshDiagnostics = {
        status: 'error',
        at: new Date(),
        reason: sanitizeRefreshFailureReason(error),
      };
    }
    // Keep the bootstrap or prior snapshot when the remote source is unavailable.
  })().finally(() => {
    if (inFlightRefresh === refreshPromise) {
      inFlightRefresh = null;
    }
  });

  inFlightRefresh = refreshPromise;

  return inFlightRefresh;
}
