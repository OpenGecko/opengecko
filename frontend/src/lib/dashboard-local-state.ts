export type Segment = 'all' | 'gainers' | 'losers' | 'watchlist';

export const compareSelectionLimit = 4;
export const rowLimitOptions = [25, 50, 100] as const;

export type RowsPerPage = (typeof rowLimitOptions)[number];

export type DashboardControlsState = {
  compareIds: string[];
  selectedCoinId: string | null;
  rowsPerPage: RowsPerPage;
  segment: Segment;
};

export type DashboardStorageKeys = {
  watchlist: string;
  holdings: string;
  controls: string;
};

export type RestoredDashboardState = {
  watchlistIds: string[];
  holdings: Record<string, number>;
  controls: DashboardControlsState;
  repairedKeys: string[];
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const validSegments = new Set<Segment>(['all', 'gainers', 'losers', 'watchlist']);
const defaultControls: DashboardControlsState = {
  compareIds: [],
  selectedCoinId: null,
  rowsPerPage: 25,
  segment: 'all'
};

function safeStorageGet(storage: StorageLike, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safePersistJson(storage: StorageLike, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function readJson(raw: string | null): { ok: true; value: unknown } | { ok: false; value: null } {
  if (raw == null) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, value: null };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeId(value: unknown) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 160 || /[\u0000-\u001f]/.test(id)) return null;
  return id;
}

export function sanitizeIdList(value: unknown, limit = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const id = normalizeId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }

  return ids;
}

export function sanitizeHoldings(value: unknown) {
  if (!isPlainRecord(value)) return {};
  const holdings: Record<string, number> = {};

  for (const [rawId, rawAmount] of Object.entries(value)) {
    const id = normalizeId(rawId);
    const amount = typeof rawAmount === 'number' ? rawAmount : typeof rawAmount === 'string' ? Number(rawAmount) : Number.NaN;
    if (!id || !Number.isFinite(amount) || amount <= 0) continue;
    holdings[id] = amount;
  }

  return holdings;
}

function sanitizeRowsPerPage(value: unknown): RowsPerPage {
  const numericValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return rowLimitOptions.includes(numericValue as RowsPerPage) ? (numericValue as RowsPerPage) : defaultControls.rowsPerPage;
}

function sanitizeSegment(value: unknown): Segment {
  return typeof value === 'string' && validSegments.has(value as Segment) ? (value as Segment) : defaultControls.segment;
}

export function sanitizeControls(value: unknown): DashboardControlsState {
  if (!isPlainRecord(value)) return { ...defaultControls };
  return {
    compareIds: sanitizeIdList(value.compareIds, compareSelectionLimit),
    selectedCoinId: normalizeId(value.selectedCoinId) ?? null,
    rowsPerPage: sanitizeRowsPerPage(value.rowsPerPage),
    segment: sanitizeSegment(value.segment)
  };
}

function normalizeStoredKey(storage: StorageLike, key: string, raw: string | null, parsedOk: boolean, value: unknown) {
  const normalized = JSON.stringify(value);
  if (raw == null) return;
  if (!parsedOk || raw !== normalized) safePersistJson(storage, key, value);
}

export function restoreDashboardLocalState(storage: StorageLike, keys: DashboardStorageKeys): RestoredDashboardState {
  const repairedKeys: string[] = [];

  const watchlistRaw = safeStorageGet(storage, keys.watchlist);
  const watchlistJson = readJson(watchlistRaw);
  const watchlistIds = sanitizeIdList(watchlistJson.value);
  const watchlistNormalized = JSON.stringify(watchlistIds);
  if (watchlistRaw != null && (!watchlistJson.ok || watchlistRaw !== watchlistNormalized)) {
    repairedKeys.push('watchlist');
    safePersistJson(storage, keys.watchlist, watchlistIds);
  }

  const holdingsRaw = safeStorageGet(storage, keys.holdings);
  const holdingsJson = readJson(holdingsRaw);
  const holdings = sanitizeHoldings(holdingsJson.value);
  const holdingsNormalized = JSON.stringify(holdings);
  if (holdingsRaw != null && (!holdingsJson.ok || holdingsRaw !== holdingsNormalized)) {
    repairedKeys.push('portfolio holdings');
    safePersistJson(storage, keys.holdings, holdings);
  }

  const controlsRaw = safeStorageGet(storage, keys.controls);
  const controlsJson = readJson(controlsRaw);
  const controls = sanitizeControls(controlsJson.value);
  const controlsNormalized = JSON.stringify(controls);
  if (controlsRaw != null && (!controlsJson.ok || controlsRaw !== controlsNormalized)) {
    repairedKeys.push('dashboard controls');
    normalizeStoredKey(storage, keys.controls, controlsRaw, controlsJson.ok, controls);
  }

  return {
    watchlistIds,
    holdings,
    controls,
    repairedKeys
  };
}
