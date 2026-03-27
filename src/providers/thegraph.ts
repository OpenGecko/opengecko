import { loadConfig } from '../config/env';

const DEFAULT_TIMEOUT_MS = 15_000;
const UNISWAP_V3_ETHEREUM_SUBGRAPH_ID = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';

type TheGraphRequestOptions = {
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  subgraphId?: string;
};

type TheGraphPoolToken = {
  id: string;
  symbol: string | null;
  decimals: number | null;
};

export type TheGraphPoolDetails = {
  id: string;
  feeTier: string | null;
  liquidity: string | null;
  sqrtPrice: string | null;
  tick: string | null;
  token0: TheGraphPoolToken | null;
  token1: TheGraphPoolToken | null;
};

export type TheGraphSwapEvent = {
  id: string;
  amount0: string | null;
  amount1: string | null;
  amountUSD: string | null;
  timestamp: number | null;
  sender: string | null;
  recipient: string | null;
  transaction: {
    id: string;
    blockNumber: string | null;
  } | null;
  token0: TheGraphPoolToken | null;
  token1: TheGraphPoolToken | null;
};

const POOL_SWAPS_QUERY = `query PoolSwaps($poolId: String!, $first: Int!) {
  swaps(first: $first, orderBy: timestamp, orderDirection: desc, where: { pool: $poolId }) {
    id
    amount0
    amount1
    amountUSD
    timestamp
    sender
    recipient
    transaction {
      id
      blockNumber
    }
    token0 {
      id
      symbol
      decimals
    }
    token1 {
      id
      symbol
      decimals
    }
  }
}`;

export type TheGraphPoolSnapshot = {
  date: number | null;
  liquidity: string | null;
  sqrtPrice: string | null;
  token0Price: string | null;
  token1Price: string | null;
  volumeToken0: string | null;
  volumeToken1: string | null;
  volumeUSD: string | null;
  tvlUSD: string | null;
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

function resolveApiKey(explicitApiKey?: string | null) {
  if (explicitApiKey !== undefined) {
    return explicitApiKey;
  }

  return loadConfig().thegraphApiKey;
}

function buildEndpoint(apiKey: string, subgraphId: string) {
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
}

function normalizeToken(candidate: unknown): TheGraphPoolToken | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const value = candidate as Record<string, unknown>;

  return {
    id: typeof value.id === 'string' ? value.id : '',
    symbol: typeof value.symbol === 'string' ? value.symbol : null,
    decimals: typeof value.decimals === 'string'
      ? Number.parseInt(value.decimals, 10)
      : typeof value.decimals === 'number' && Number.isFinite(value.decimals)
        ? value.decimals
        : null,
  };
}

function asNullableString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function asNullableTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

async function postGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  options: TheGraphRequestOptions = {},
): Promise<T | null> {
  const apiKey = resolveApiKey(options.apiKey);

  if (!apiKey) {
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = options.signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS) : null;

  try {
    const response = await fetchImpl(buildEndpoint(apiKey, options.subgraphId ?? UNISWAP_V3_ETHEREUM_SUBGRAPH_ID), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables,
      }),
      signal: options.signal ?? controller?.signal,
    });

    if (!response.ok) {
      throw new Error(`The Graph request failed with status ${response.status}`);
    }

    const payload = await response.json() as GraphqlResponse<T>;

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(payload.errors.map((entry) => entry.message ?? 'Unknown GraphQL error').join('; '));
    }

    return payload.data ?? null;
  } catch (error) {
    console.error('Failed to fetch The Graph data', error);
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function fetchUniswapV3PoolDetails(
  poolAddress: string,
  options: TheGraphRequestOptions = {},
): Promise<TheGraphPoolDetails | null> {
  const data = await postGraphql<{ pool?: Record<string, unknown> | null }>(
    `query PoolDetails($poolId: ID!) {
      pool(id: $poolId) {
        id
        feeTier
        liquidity
        sqrtPrice
        tick
        token0 {
          id
          symbol
          decimals
        }
        token1 {
          id
          symbol
          decimals
        }
      }
    }`,
    { poolId: poolAddress.toLowerCase() },
    options,
  );

  if (!data?.pool) {
    return null;
  }

  return {
    id: typeof data.pool.id === 'string' ? data.pool.id : poolAddress.toLowerCase(),
    feeTier: asNullableString(data.pool.feeTier),
    liquidity: asNullableString(data.pool.liquidity),
    sqrtPrice: asNullableString(data.pool.sqrtPrice),
    tick: asNullableString(data.pool.tick),
    token0: normalizeToken(data.pool.token0),
    token1: normalizeToken(data.pool.token1),
  };
}

export async function fetchUniswapV3PoolSwaps(
  poolAddress: string,
  first = 50,
  options: TheGraphRequestOptions = {},
): Promise<TheGraphSwapEvent[] | null> {
  const data = await postGraphql<{ swaps?: Array<Record<string, unknown>> }>(
    POOL_SWAPS_QUERY,
    {
      poolId: poolAddress.toLowerCase(),
      first,
    },
    options,
  );

  if (!Array.isArray(data?.swaps)) {
    return null;
  }

  return data.swaps.map((swap) => ({
    id: typeof swap.id === 'string' ? swap.id : '',
    amount0: asNullableString(swap.amount0),
    amount1: asNullableString(swap.amount1),
    amountUSD: asNullableString(swap.amountUSD),
    timestamp: asNullableTimestamp(swap.timestamp),
    sender: asNullableString(swap.sender),
    recipient: asNullableString(swap.recipient),
    transaction: swap.transaction && typeof swap.transaction === 'object'
      ? {
          id: typeof (swap.transaction as Record<string, unknown>).id === 'string'
            ? (swap.transaction as Record<string, unknown>).id as string
            : '',
          blockNumber: asNullableString((swap.transaction as Record<string, unknown>).blockNumber),
        }
      : null,
    token0: normalizeToken(swap.token0),
    token1: normalizeToken(swap.token1),
  }));
}

export function getUniswapV3PoolSwapsQuery() {
  return POOL_SWAPS_QUERY;
}

export async function fetchUniswapV3PoolSnapshots(
  poolAddress: string,
  first = 30,
  options: TheGraphRequestOptions = {},
): Promise<TheGraphPoolSnapshot[] | null> {
  const data = await postGraphql<{ poolDayDatas?: Array<Record<string, unknown>> }>(
    `query PoolSnapshots($poolId: Bytes!, $first: Int!) {
      poolDayDatas(first: $first, orderBy: date, orderDirection: desc, where: { pool: $poolId }) {
        date
        liquidity
        sqrtPrice
        token0Price
        token1Price
        volumeToken0
        volumeToken1
        volumeUSD
        tvlUSD
      }
    }`,
    {
      poolId: poolAddress.toLowerCase(),
      first,
    },
    options,
  );

  if (!Array.isArray(data?.poolDayDatas)) {
    return null;
  }

  return data.poolDayDatas.map((snapshot) => ({
    date: asNullableTimestamp(snapshot.date),
    liquidity: asNullableString(snapshot.liquidity),
    sqrtPrice: asNullableString(snapshot.sqrtPrice),
    token0Price: asNullableString(snapshot.token0Price),
    token1Price: asNullableString(snapshot.token1Price),
    volumeToken0: asNullableString(snapshot.volumeToken0),
    volumeToken1: asNullableString(snapshot.volumeToken1),
    volumeUSD: asNullableString(snapshot.volumeUSD),
    tvlUSD: asNullableString(snapshot.tvlUSD),
  }));
}
