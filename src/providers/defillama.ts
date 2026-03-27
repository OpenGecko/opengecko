import { loadConfig } from '../config/env';

const DEFAULT_TIMEOUT_MS = 15_000;

type DefillamaRequestOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

type DefillamaProtocol = {
  id?: string | number;
  slug?: string;
  name?: string;
  category?: string;
  chains?: string[];
  tvl?: number | null;
};

type DefillamaYieldPool = {
  chain?: string;
  project?: string;
  symbol?: string;
  pool?: string;
  tvlUsd?: number | null;
  volumeUsd1d?: number | null;
  volumeUsd7d?: number | null;
  underlyingTokens?: string[];
};

type DefillamaDexOverviewEntry = {
  name?: string;
  displayName?: string;
  disabled?: boolean;
  chains?: string[];
  total24h?: number | null;
  total48hto24h?: number | null;
  total7d?: number | null;
  total30d?: number | null;
  totalAllTime?: number | null;
  change_1d?: number | null;
  change_7d?: number | null;
  change_1m?: number | null;
};

type DefillamaPriceEntry = {
  price?: number;
  symbol?: string;
  decimals?: number;
  confidence?: number;
  timestamp?: number;
};

export type DefillamaPoolData = {
  protocols: DefillamaProtocol[];
  pools: DefillamaYieldPool[];
};

export type DefillamaTokenPrices = Record<string, DefillamaPriceEntry>;

export type DefillamaDexVolumes = {
  protocols: DefillamaDexOverviewEntry[];
  total24h: number | null;
  total7d: number | null;
  total30d: number | null;
  totalAllTime: number | null;
};

function resolveBaseUrl(baseUrl?: string) {
  return (baseUrl ?? loadConfig().defillamaBaseUrl).replace(/\/+$/, '');
}

async function fetchJson<T>(path: string, options: DefillamaRequestOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${resolveBaseUrl(options.baseUrl)}${path}`;
  const controller = options.signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS) : null;

  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
      },
      signal: options.signal ?? controller?.signal,
    });

    if (!response.ok) {
      throw new Error(`DeFiLlama request failed with status ${response.status} for ${path}`);
    }

    return await response.json() as T;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function toOptionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeProtocol(item: unknown): DefillamaProtocol | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as Record<string, unknown>;

  return {
    id: typeof candidate.id === 'string' || typeof candidate.id === 'number' ? candidate.id : undefined,
    slug: typeof candidate.slug === 'string' ? candidate.slug : undefined,
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    category: typeof candidate.category === 'string' ? candidate.category : undefined,
    chains: Array.isArray(candidate.chains) ? candidate.chains.filter((value): value is string => typeof value === 'string') : undefined,
    tvl: toOptionalNumber(candidate.tvl),
  };
}

function normalizeYieldPool(item: unknown): DefillamaYieldPool | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as Record<string, unknown>;

  return {
    chain: typeof candidate.chain === 'string' ? candidate.chain : undefined,
    project: typeof candidate.project === 'string' ? candidate.project : undefined,
    symbol: typeof candidate.symbol === 'string' ? candidate.symbol : undefined,
    pool: typeof candidate.pool === 'string' ? candidate.pool : undefined,
    tvlUsd: toOptionalNumber(candidate.tvlUsd),
    volumeUsd1d: toOptionalNumber(candidate.volumeUsd1d),
    volumeUsd7d: toOptionalNumber(candidate.volumeUsd7d),
    underlyingTokens: Array.isArray(candidate.underlyingTokens)
      ? candidate.underlyingTokens.filter((value): value is string => typeof value === 'string')
      : undefined,
  };
}

function normalizeDexOverview(item: unknown): DefillamaDexOverviewEntry | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as Record<string, unknown>;

  return {
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    displayName: typeof candidate.displayName === 'string' ? candidate.displayName : undefined,
    disabled: typeof candidate.disabled === 'boolean' ? candidate.disabled : undefined,
    chains: Array.isArray(candidate.chains) ? candidate.chains.filter((value): value is string => typeof value === 'string') : undefined,
    total24h: toOptionalNumber(candidate.total24h),
    total48hto24h: toOptionalNumber(candidate.total48hto24h),
    total7d: toOptionalNumber(candidate.total7d),
    total30d: toOptionalNumber(candidate.total30d),
    totalAllTime: toOptionalNumber(candidate.totalAllTime),
    change_1d: toOptionalNumber(candidate.change_1d),
    change_7d: toOptionalNumber(candidate.change_7d),
    change_1m: toOptionalNumber(candidate.change_1m),
  };
}

function sumTotals(entries: DefillamaDexOverviewEntry[], field: keyof Pick<DefillamaDexOverviewEntry, 'total24h' | 'total7d' | 'total30d' | 'totalAllTime'>) {
  const numbers = entries.map((entry) => entry[field]).filter((value): value is number => typeof value === 'number');
  return numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

export async function fetchDefillamaPoolData(options: DefillamaRequestOptions = {}): Promise<DefillamaPoolData | null> {
  try {
    const [protocolsResponse, poolsResponse] = await Promise.all([
      fetchJson<unknown[]>('/protocols', options),
      fetchJson<{ data?: unknown[] }>('/pools', options),
    ]);

    return {
      protocols: protocolsResponse.map(normalizeProtocol).filter((value): value is DefillamaProtocol => value !== null),
      pools: (Array.isArray(poolsResponse.data) ? poolsResponse.data : [])
        .map(normalizeYieldPool)
        .filter((value): value is DefillamaYieldPool => value !== null),
    };
  } catch (error) {
    console.error('Failed to fetch DeFiLlama pool data', error);
    return null;
  }
}

export async function fetchDefillamaTokenPrices(coins: string[], options: DefillamaRequestOptions = {}): Promise<DefillamaTokenPrices | null> {
  if (coins.length === 0) {
    return {};
  }

  try {
    const encodedCoins = coins.map((coin) => encodeURIComponent(coin)).join(',');
    const response = await fetchJson<{ coins?: Record<string, DefillamaPriceEntry> }>(`/prices/current/${encodedCoins}`, options);

    return response.coins ?? {};
  } catch (error) {
    console.error('Failed to fetch DeFiLlama token prices', error);
    return null;
  }
}

export async function fetchDefillamaDexVolumes(chain?: string, options: DefillamaRequestOptions = {}): Promise<DefillamaDexVolumes | null> {
  try {
    const suffix = chain ? `/${encodeURIComponent(chain)}` : '';
    const response = await fetchJson<{ protocols?: unknown[] }>(`/overview/dexs${suffix}`, options);
    const protocols = (Array.isArray(response.protocols) ? response.protocols : [])
      .map(normalizeDexOverview)
      .filter((value): value is DefillamaDexOverviewEntry => value !== null);

    return {
      protocols,
      total24h: sumTotals(protocols, 'total24h'),
      total7d: sumTotals(protocols, 'total7d'),
      total30d: sumTotals(protocols, 'total30d'),
      totalAllTime: sumTotals(protocols, 'totalAllTime'),
    };
  } catch (error) {
    console.error('Failed to fetch DeFiLlama dex volumes', error);
    return null;
  }
}
