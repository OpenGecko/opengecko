import { z } from 'zod';

import { HttpError } from '../../http/errors';
import { parseCsvQuery } from '../../http/params';

export type LiveOnchainPoolPatch = {
  priceUsd: number | null;
  reserveUsd: number | null;
  volume24hUsd: number | null;
  source: 'live' | 'seed';
  dexId?: string;
  name?: string;
  baseTokenAddress?: string;
  baseTokenSymbol?: string;
  quoteTokenAddress?: string;
  quoteTokenSymbol?: string;
  networkId?: string;
};

export type NetworkDexMaps = {
  networksById: Map<string, unknown>;
  dexesByKey: Map<string, unknown>;
  now: Date;
};

export const supportedOnchainOhlcvTimeframes = ['minute', 'hour', 'day'] as const;
export type OnchainOhlcvTimeframe = (typeof supportedOnchainOhlcvTimeframes)[number];
export type OnchainOhlcvSeriesPoint = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
};

export type OnchainTradeRecord = {
  id: string;
  networkId: string;
  poolAddress: string;
  tokenAddress: string;
  side: 'buy' | 'sell';
  volumeUsd: number;
  priceUsd: number;
  txHash: string;
  blockTimestamp: number;
};

export type LiveTradeRecord = OnchainTradeRecord & {
  source: 'live' | 'fixture';
};

export type NormalizedSwapTradeShape = {
  id: string;
  amount0: string | null;
  amount1: string | null;
  amountUSD: string | null;
  timestamp: number | null;
  transaction: {
    id: string;
    blockNumber: string | null;
  } | null;
};

export type LiveSimpleTokenPrice = {
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  totalReserveUsd: number | null;
  priceChange24h: number | null;
};

export type OnchainHolderRecord = {
  address: string;
  balance: number;
  shareOfSupply: number;
  pnlUsd: number;
  avgBuyPriceUsd: number;
  realizedPnlUsd: number;
};

export type OnchainTraderRecord = {
  address: string;
  volumeUsd: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  realizedPnlUsd: number;
  tradeCount: number;
  addressLabel: string | null;
};

export type HoldersChartPoint = {
  timestamp: number;
  holderCount: number;
};

export type OnchainCategorySort = 'h24_volume_usd_desc' | 'reserve_in_usd_desc' | 'name_asc';
export type OnchainCategoryPoolSort = 'h24_volume_usd_desc' | 'reserve_in_usd_desc' | 'h24_tx_count_desc';
export type OnchainCategorySummary = {
  id: string;
  name: string;
  poolCount: number;
  reserveUsd: number;
  volume24hUsd: number;
  transactionCount24h: number;
  networks: string[];
  dexes: string[];
};

export const supportedTopTraderSorts = ['volume_usd_desc', 'realized_pnl_usd_desc'] as const;
export type TopTraderSort = (typeof supportedTopTraderSorts)[number];

export const megafilterSortValues = [
  'reserve_in_usd_desc',
  'reserve_in_usd_asc',
  'volume_usd_h24_desc',
  'volume_usd_h24_asc',
  'tx_count_h24_desc',
  'tx_count_h24_asc',
] as const;

export type MegafilterSort = (typeof megafilterSortValues)[number];

export const poolIncludeSchema = z.enum(['network', 'dex']);

export function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

export function slugifyOnchainId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

export function toDexName(slug: string) {
  return slug
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function generateDeterministicAddress(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `0x${hex.padEnd(40, '0')}`;
}

export function isValidOnchainAddress(address: string) {
  const trimmed = address.trim();

  if (trimmed.length === 0) {
    return false;
  }

  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
}

export function parseOnchainAddressList(addresses: string) {
  const parsed = addresses
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.length > 0);

  for (const address of parsed) {
    if (!isValidOnchainAddress(address)) {
      throw new HttpError(400, 'invalid_parameter', `Invalid onchain address: ${address}`);
    }
  }

  return parsed.map(normalizeAddress);
}

export function parsePoolIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    const result = poolIncludeSchema.safeParse(value);
    if (!result.success) {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

export function parseTrendingDuration(value: string | undefined) {
  if (value === undefined) {
    return '24h' as const;
  }

  if (value === '1h' || value === '6h' || value === '24h') {
    return value;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported duration value: ${value}`);
}

export function parseTokenIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'top_pools') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

export function parsePoolInfoIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'pool') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

export function parseRecentlyUpdatedTokenInfoIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'network') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

export function parseMegafilterIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'base_token' && value !== 'quote_token') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

export function parseTopHoldersIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'token' && value !== 'network') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

export function formatMetricValue(value: number | null) {
  return value === null ? null : String(value);
}

export function parseTradeVolumeThreshold(value: string | undefined) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid trade_volume_in_usd_greater_than value: ${value}`);
  }

  return parsed;
}

export function parseAnalyticsCount(value: string | undefined, parameterName: 'holders' | 'traders', defaultValue: number) {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return Math.min(parsed, 100);
}

export function parseTopTraderSort(value: string | undefined): TopTraderSort {
  if (value === undefined) {
    return 'volume_usd_desc';
  }

  if ((supportedTopTraderSorts as readonly string[]).includes(value)) {
    return value as TopTraderSort;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported sort value: ${value}`);
}

export function parseHoldersChartDays(value: string | undefined) {
  if (value === undefined) {
    return 30;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${value}`);
  }

  return parsed;
}

export function parseOnchainOhlcvTimeframe(value: string): OnchainOhlcvTimeframe {
  if ((supportedOnchainOhlcvTimeframes as readonly string[]).includes(value)) {
    return value as OnchainOhlcvTimeframe;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported timeframe value: ${value}`);
}

export function parseOptionalPositiveNumber(value: string | undefined, parameterName: string) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return parsed;
}

export function parseOptionalPositiveInteger(value: string | undefined, parameterName: string) {
  const parsed = parseOptionalPositiveNumber(value, parameterName);
  if (parsed === null) {
    return null;
  }
  if (!Number.isInteger(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return parsed;
}

export function parseOptionalTimestamp(value: string | undefined, parameterName: string) {
  const parsed = parseOptionalPositiveNumber(value, parameterName);
  return parsed === null ? null : Math.floor(parsed);
}

export function resolveOnchainOhlcvWindowMs(timeframe: OnchainOhlcvTimeframe, aggregate: number) {
  const baseMs = timeframe === 'minute' ? 60_000 : timeframe === 'hour' ? 3_600_000 : 86_400_000;
  return baseMs * aggregate;
}

export function parseOnchainCategorySort(value: string | undefined): OnchainCategorySort {
  if (value === undefined) {
    return 'reserve_in_usd_desc';
  }

  if (value === 'h24_volume_usd_desc' || value === 'reserve_in_usd_desc' || value === 'name_asc') {
    return value;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported sort value: ${value}`);
}

export function parseOnchainCategoryPoolSort(value: string | undefined): OnchainCategoryPoolSort {
  if (value === undefined) {
    return 'h24_volume_usd_desc';
  }

  if (value === 'h24_volume_usd_desc' || value === 'reserve_in_usd_desc' || value === 'h24_tx_count_desc') {
    return value;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported sort value: ${value}`);
}

export function parseMegafilterSort(value: string | undefined): MegafilterSort {
  if (value === undefined) {
    return 'volume_usd_h24_desc';
  }

  if ((megafilterSortValues as readonly string[]).includes(value)) {
    return value as MegafilterSort;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported sort value: ${value}`);
}

export function parseOptionalFiniteNumber(value: string | undefined, parameterName: string) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return parsed;
}

export function buildPaginationMeta(page: number, perPage: number, totalCount: number) {
  return {
    page,
    per_page: perPage,
    total_pages: Math.ceil(totalCount / perPage),
    total_count: totalCount,
  };
}
