import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { coins, marketSnapshots, onchainDexes, onchainNetworks, onchainPools } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt } from '../http/params';

const paginationQuerySchema = z.object({
  page: z.string().optional(),
});

const poolListQuerySchema = z.object({
  page: z.string().optional(),
  sort: z.enum(['h24_volume_usd_liquidity_desc', 'h24_tx_count_desc', 'reserve_in_usd_desc']).optional(),
});

const poolIncludeSchema = z.enum(['network', 'dex']);

const poolDetailQuerySchema = z.object({
  include: z.string().optional(),
  include_volume_breakdown: z.string().optional(),
  include_composition: z.string().optional(),
});

const poolMultiQuerySchema = z.object({
  include: z.string().optional(),
});

const discoveryPoolsQuerySchema = z.object({
  page: z.string().optional(),
  include: z.string().optional(),
});

const trendingPoolsQuerySchema = z.object({
  page: z.string().optional(),
  include: z.string().optional(),
  duration: z.string().optional(),
});

const searchPoolsQuerySchema = z.object({
  query: z.string().optional(),
  network: z.string().optional(),
  page: z.string().optional(),
});

const trendingSearchQuerySchema = z.object({
  page: z.string().optional(),
  per_page: z.string().optional(),
  pools: z.string().optional(),
});

const tokenDetailQuerySchema = z.object({
  include: z.string().optional(),
  include_inactive_source: z.string().optional(),
  include_composition: z.string().optional(),
});

const tokenMultiQuerySchema = z.object({
  include: z.string().optional(),
});

const simpleTokenPriceQuerySchema = z.object({
  include_market_cap: z.string().optional(),
  include_24hr_vol: z.string().optional(),
  include_24hr_price_change: z.string().optional(),
  include_total_reserve_in_usd: z.string().optional(),
});

const poolInfoQuerySchema = z.object({
  include: z.string().optional(),
});

const recentlyUpdatedTokenInfoQuerySchema = z.object({
  include: z.string().optional(),
  network: z.string().optional(),
  page: z.string().optional(),
});

const tradesQuerySchema = z.object({
  trade_volume_in_usd_greater_than: z.string().optional(),
  token: z.string().optional(),
});

const onchainOhlcvQuerySchema = z.object({
  aggregate: z.string().optional(),
  before_timestamp: z.string().optional(),
  limit: z.string().optional(),
  currency: z.string().optional(),
  token: z.string().optional(),
  include_empty_intervals: z.string().optional(),
  include_inactive_source: z.string().optional(),
});

const supportedOnchainOhlcvTimeframes = ['minute', 'hour', 'day'] as const;
type OnchainOhlcvTimeframe = (typeof supportedOnchainOhlcvTimeframes)[number];
type OnchainOhlcvSeriesPoint = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
};

function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

function isValidOnchainAddress(address: string) {
  const trimmed = address.trim();

  if (trimmed.length === 0) {
    return false;
  }

  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
}

function parseOnchainAddressList(addresses: string) {
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

function parsePoolIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    const result = poolIncludeSchema.safeParse(value);
    if (!result.success) {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function parseTrendingDuration(value: string | undefined) {
  if (value === undefined) {
    return '24h' as const;
  }

  if (value === '1h' || value === '6h' || value === '24h') {
    return value;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported duration value: ${value}`);
}

function parseTokenIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'top_pools') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function parsePoolInfoIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'pool') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function parseRecentlyUpdatedTokenInfoIncludes(include: string | undefined) {
  const includes = parseCsvQuery(include);

  for (const value of includes) {
    if (value !== 'network') {
      throw new HttpError(400, 'invalid_parameter', `Unsupported include value: ${value}`);
    }
  }

  return includes;
}

function buildNetworkResource(row: typeof onchainNetworks.$inferSelect) {
  return {
    id: row.id,
    type: 'network',
    attributes: {
      name: row.name,
      chain_identifier: row.chainIdentifier,
      coingecko_asset_platform_id: row.coingeckoAssetPlatformId,
      native_currency_coin_id: row.nativeCurrencyCoinId,
      image_url: row.imageUrl,
    },
  };
}

function buildDexResource(row: typeof onchainDexes.$inferSelect) {
  return {
    id: row.id,
    type: 'dex',
    attributes: {
      name: row.name,
      url: row.url,
      image_url: row.imageUrl,
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: row.networkId,
        },
      },
    },
  };
}

function buildPoolResource(
  row: typeof onchainPools.$inferSelect,
  options?: {
    includeVolumeBreakdown?: boolean;
    includeComposition?: boolean;
  },
) {
  const includeVolumeBreakdown = options?.includeVolumeBreakdown ?? false;
  const includeComposition = options?.includeComposition ?? false;
  const volumeUsd = includeVolumeBreakdown
    ? {
        h24: row.volume24hUsd,
        h24_buy_usd: row.volume24hUsd === null ? null : row.volume24hUsd / 2,
        h24_sell_usd: row.volume24hUsd === null ? null : row.volume24hUsd / 2,
      }
    : {
        h24: row.volume24hUsd,
      };

  return {
    id: row.address,
    type: 'pool',
    attributes: {
      name: row.name,
      address: row.address,
      base_token_address: row.baseTokenAddress,
      base_token_symbol: row.baseTokenSymbol,
      quote_token_address: row.quoteTokenAddress,
      quote_token_symbol: row.quoteTokenSymbol,
      price_usd: row.priceUsd,
      reserve_usd: row.reserveUsd,
      volume_usd: volumeUsd,
      transactions: {
        h24: {
          buys: row.transactions24hBuys,
          sells: row.transactions24hSells,
        },
      },
      pool_created_at: row.createdAtTimestamp ? Math.floor(row.createdAtTimestamp.getTime() / 1000) : null,
      ...(includeComposition
        ? {
            composition: {
              base_token: {
                address: row.baseTokenAddress,
                symbol: row.baseTokenSymbol,
              },
              quote_token: {
                address: row.quoteTokenAddress,
                symbol: row.quoteTokenSymbol,
              },
            },
          }
        : {}),
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: row.networkId,
        },
      },
      dex: {
        data: {
          type: 'dex',
          id: row.dexId,
        },
      },
    },
  };
}

function collectTokenPools(networkId: string, tokenAddress: string, database: AppDatabase) {
  const normalizedAddress = normalizeAddress(tokenAddress);

  return database.db
    .select()
    .from(onchainPools)
    .where(eq(onchainPools.networkId, networkId))
    .all()
    .filter((row) => {
      const base = normalizeAddress(row.baseTokenAddress);
      const quote = normalizeAddress(row.quoteTokenAddress);
      return base === normalizedAddress || quote === normalizedAddress;
    })
    .sort((left, right) => (right.reserveUsd ?? 0) - (left.reserveUsd ?? 0) || left.address.localeCompare(right.address));
}

function buildTokenResource(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
  options?: {
    includeInactiveSource?: boolean;
    includeComposition?: boolean;
  },
) {
  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools[0];
  const tokenSymbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;
  const priceUsd = primaryPool?.priceUsd ?? null;

  return {
    id: normalizedAddress,
    type: 'token',
    attributes: {
      address: normalizedAddress,
      symbol: tokenSymbol,
      name: tokenSymbol,
      price_usd: priceUsd,
      top_pools: tokenPools.map((pool) => pool.address),
      ...(options?.includeInactiveSource ? { inactive_source: false } : {}),
      ...(options?.includeComposition
        ? {
            composition: {
              pools: tokenPools.map((pool) => ({
                pool_address: pool.address,
                role: normalizeAddress(pool.baseTokenAddress) === normalizedAddress ? 'base' : 'quote',
                counterpart_address:
                  normalizeAddress(pool.baseTokenAddress) === normalizedAddress ? pool.quoteTokenAddress : pool.baseTokenAddress,
                counterpart_symbol:
                  normalizeAddress(pool.baseTokenAddress) === normalizedAddress ? pool.quoteTokenSymbol : pool.baseTokenSymbol,
              })),
            },
          }
        : {}),
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: networkId,
        },
      },
    },
  };
}

function findCoinIdForToken(networkId: string, tokenAddress: string) {
  const normalizedAddress = normalizeAddress(tokenAddress);

  if (networkId === 'eth') {
    if (normalizedAddress === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') {
      return 'usd-coin';
    }
    if (normalizedAddress === '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599') {
      return 'bitcoin';
    }
    if (normalizedAddress === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2') {
      return 'ethereum';
    }
  }

  if (networkId === 'solana') {
    if (normalizedAddress === 'so11111111111111111111111111111111111111112') {
      return 'solana';
    }
    if (normalizedAddress === 'epjfwdd5aufqssqeM2qN1xzybapC8gQbucwycWefbwx'.toLowerCase()) {
      return 'usd-coin';
    }
  }

  return null;
}

function buildTokenInfoResource(networkId: string, tokenAddress: string, tokenPools: typeof onchainPools.$inferSelect[]) {
  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools[0];
  const symbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;
  const coinId = findCoinIdForToken(networkId, normalizedAddress);
  const decimals = symbol === 'USDC' || symbol === 'USDT' ? 6 : 18;

  return {
    id: `${networkId}_${normalizedAddress}`,
    type: 'token_info',
    attributes: {
      address: normalizedAddress,
      name: symbol,
      symbol,
      coingecko_coin_id: coinId,
      decimals,
      image_url: null,
      updated_at: Math.floor((primaryPool?.updatedAt ?? new Date(0)).getTime() / 1000),
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: networkId,
        },
      },
    },
  };
}

function formatMetricValue(value: number | null) {
  return value === null ? null : String(value);
}

type OnchainTradeRecord = {
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

function parseTradeVolumeThreshold(value: string | undefined) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid trade_volume_in_usd_greater_than value: ${value}`);
  }

  return parsed;
}

function parseOnchainOhlcvTimeframe(value: string): OnchainOhlcvTimeframe {
  if ((supportedOnchainOhlcvTimeframes as readonly string[]).includes(value)) {
    return value as OnchainOhlcvTimeframe;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported timeframe value: ${value}`);
}

function parseOptionalPositiveNumber(value: string | undefined, parameterName: string) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(value: string | undefined, parameterName: string) {
  const parsed = parseOptionalPositiveNumber(value, parameterName);
  if (parsed === null) {
    return null;
  }
  if (!Number.isInteger(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${parameterName} value: ${value}`);
  }

  return parsed;
}

function parseOptionalTimestamp(value: string | undefined, parameterName: string) {
  const parsed = parseOptionalPositiveNumber(value, parameterName);
  return parsed === null ? null : Math.floor(parsed);
}

function resolveOnchainOhlcvWindowMs(timeframe: OnchainOhlcvTimeframe, aggregate: number) {
  const baseMs = timeframe === 'minute' ? 60_000 : timeframe === 'hour' ? 3_600_000 : 86_400_000;
  return baseMs * aggregate;
}

function buildSyntheticPoolOhlcvSeries(
  pool: typeof onchainPools.$inferSelect,
  timeframe: OnchainOhlcvTimeframe,
  aggregate: number,
): OnchainOhlcvSeriesPoint[] {
  const windowMs = resolveOnchainOhlcvWindowMs(timeframe, aggregate);
  const createdAt = pool.createdAtTimestamp?.getTime() ?? Date.parse('2024-01-01T00:00:00.000Z');
  const base = timeframe === 'minute'
    ? Date.parse('2024-05-03T15:00:00.000Z')
    : timeframe === 'hour'
      ? Date.parse('2024-05-03T15:00:00.000Z')
      : Date.parse('2024-05-03T00:00:00.000Z');
  const count = 6;
  const priceBase = pool.priceUsd ?? 0;
  const volumeBase = pool.volume24hUsd ?? 0;
  const series: OnchainOhlcvSeriesPoint[] = [];

  for (let index = 0; index < count; index += 1) {
    const timestamp = base - (count - 1 - index) * windowMs;

    if (timestamp < createdAt) {
      continue;
    }

    const step = index + 1;
    const delta = priceBase * 0.0025 * step;
    const open = Number((priceBase - delta).toFixed(6));
    const close = Number((priceBase + delta / 2).toFixed(6));
    const high = Number((Math.max(open, close) + priceBase * 0.0015).toFixed(6));
    const low = Number((Math.min(open, close) - priceBase * 0.0015).toFixed(6));
    const volumeUsd = Number((volumeBase / (count + aggregate) + step * 1_250).toFixed(2));

    series.push({
      timestamp: Math.floor(timestamp / 1000),
      open,
      high,
      low,
      close,
      volumeUsd,
    });
  }

  return series;
}

function aggregatePoolSeriesForToken(
  pools: typeof onchainPools.$inferSelect[],
  timeframe: OnchainOhlcvTimeframe,
  aggregate: number,
  targetTokenAddress: string,
  includeInactiveSource: boolean,
) {
  const normalizedToken = normalizeAddress(targetTokenAddress);
  const seriesByTimestamp = new Map<number, {
    timestamp: number;
    openWeighted: number;
    high: number;
    low: number;
    closeWeighted: number;
    volumeUsd: number;
    reserveWeight: number;
    sources: string[];
  }>();

  for (const pool of pools) {
    const baseSeries = buildSyntheticPoolOhlcvSeries(pool, timeframe, aggregate);
    const tokenMultiplier = normalizeAddress(pool.baseTokenAddress) === normalizedToken ? 1 : pool.priceUsd ?? 1;
    const poolIsInactive = pool.volume24hUsd === null || pool.volume24hUsd <= 30_000_000;

    if (poolIsInactive && !includeInactiveSource) {
      continue;
    }

    for (const point of baseSeries) {
      const convertedOpen = Number((point.open * tokenMultiplier).toFixed(6));
      const convertedHigh = Number((point.high * tokenMultiplier).toFixed(6));
      const convertedLow = Number((point.low * tokenMultiplier).toFixed(6));
      const convertedClose = Number((point.close * tokenMultiplier).toFixed(6));
      const weight = (pool.reserveUsd ?? 1) / 1_000_000;
      const current = seriesByTimestamp.get(point.timestamp);

      if (!current) {
        seriesByTimestamp.set(point.timestamp, {
          timestamp: point.timestamp,
          openWeighted: convertedOpen * weight,
          high: convertedHigh,
          low: convertedLow,
          closeWeighted: convertedClose * weight,
          volumeUsd: point.volumeUsd,
          reserveWeight: weight,
          sources: [pool.address],
        });
        continue;
      }

      current.openWeighted += convertedOpen * weight;
      current.high = Math.max(current.high, convertedHigh);
      current.low = Math.min(current.low, convertedLow);
      current.closeWeighted += convertedClose * weight;
      current.volumeUsd += point.volumeUsd;
      current.reserveWeight += weight;
      current.sources.push(pool.address);
    }
  }

  return [...seriesByTimestamp.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((point) => ({
      timestamp: point.timestamp,
      open: Number((point.openWeighted / point.reserveWeight).toFixed(6)),
      high: Number(point.high.toFixed(6)),
      low: Number(point.low.toFixed(6)),
      close: Number((point.closeWeighted / point.reserveWeight).toFixed(6)),
      volume_usd: Number(point.volumeUsd.toFixed(2)),
      source_pools: point.sources.sort(),
    }));
}

function finalizeOnchainOhlcvSeries(
  series: OnchainOhlcvSeriesPoint[],
  options: {
    aggregate: number;
    limit: number;
    beforeTimestamp: number | null;
    includeEmptyIntervals: boolean;
    timeframe: OnchainOhlcvTimeframe;
  },
) {
  const windowSeconds = resolveOnchainOhlcvWindowMs(options.timeframe, options.aggregate) / 1000;
  const beforeBound = options.beforeTimestamp;
  const filtered = series
    .filter((point) => beforeBound === null || point.timestamp <= beforeBound)
    .sort((left, right) => left.timestamp - right.timestamp);

  if (filtered.length === 0) {
    return [];
  }

  let withEmptyIntervals = filtered.map((point) => ({
    timestamp: point.timestamp,
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close,
    volume_usd: Number(point.volumeUsd.toFixed(2)),
  }));

  if (options.includeEmptyIntervals) {
    const expanded: typeof withEmptyIntervals = [];
    for (let index = 0; index < filtered.length; index += 1) {
      const current = filtered[index]!;
      if (index > 0) {
        let nextTimestamp = filtered[index - 1]!.timestamp + windowSeconds;
        while (nextTimestamp < current.timestamp) {
          const previousClose = expanded[expanded.length - 1]!.close;
          expanded.push({
            timestamp: nextTimestamp,
            open: previousClose,
            high: previousClose,
            low: previousClose,
            close: previousClose,
            volume_usd: 0,
          });
          nextTimestamp += windowSeconds;
        }
      }
      expanded.push({
        timestamp: current.timestamp,
        open: current.open,
        high: current.high,
        low: current.low,
        close: current.close,
        volume_usd: Number(current.volumeUsd.toFixed(2)),
      });
    }
    withEmptyIntervals = expanded;
  }

  return withEmptyIntervals.slice(-options.limit);
}

function buildOnchainTradeFixtures(database: AppDatabase): OnchainTradeRecord[] {
  const poolRows = database.db.select().from(onchainPools).all();
  const getPool = (address: string) => {
    const row = poolRows.find((pool) => pool.address === address);
    if (!row) {
      throw new Error(`Missing seeded onchain pool for trade fixtures: ${address}`);
    }
    return row;
  };

  const usdcWethPool = getPool('0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b');
  const curveStablePool = getPool('0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7');
  const wethUsdtPool = getPool('0x4e68ccd3e89f51c3074ca5072bbac773960dfa36');
  const solUsdcPool = getPool('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');

  return [
    {
      id: 'eth-usdcweth-1',
      networkId: 'eth',
      poolAddress: usdcWethPool.address,
      tokenAddress: normalizeAddress(usdcWethPool.baseTokenAddress),
      side: 'buy',
      volumeUsd: 220000,
      priceUsd: 1,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000001',
      blockTimestamp: 1_710_000_000,
    },
    {
      id: 'eth-usdcweth-2',
      networkId: 'eth',
      poolAddress: usdcWethPool.address,
      tokenAddress: normalizeAddress(usdcWethPool.quoteTokenAddress),
      side: 'sell',
      volumeUsd: 95000,
      priceUsd: 3500,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000002',
      blockTimestamp: 1_709_999_400,
    },
    {
      id: 'eth-curve-1',
      networkId: 'eth',
      poolAddress: curveStablePool.address,
      tokenAddress: normalizeAddress(curveStablePool.baseTokenAddress),
      side: 'buy',
      volumeUsd: 180000,
      priceUsd: 1,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000003',
      blockTimestamp: 1_709_999_200,
    },
    {
      id: 'eth-curve-2',
      networkId: 'eth',
      poolAddress: curveStablePool.address,
      tokenAddress: normalizeAddress(curveStablePool.quoteTokenAddress),
      side: 'sell',
      volumeUsd: 120000,
      priceUsd: 1,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000004',
      blockTimestamp: 1_709_998_800,
    },
    {
      id: 'eth-wethusdt-1',
      networkId: 'eth',
      poolAddress: wethUsdtPool.address,
      tokenAddress: normalizeAddress(wethUsdtPool.baseTokenAddress),
      side: 'buy',
      volumeUsd: 260000,
      priceUsd: 3500,
      txHash: '0xtrade000000000000000000000000000000000000000000000000000000000005',
      blockTimestamp: 1_709_998_200,
    },
    {
      id: 'sol-solusdc-1',
      networkId: 'solana',
      poolAddress: solUsdcPool.address,
      tokenAddress: normalizeAddress(solUsdcPool.quoteTokenAddress),
      side: 'buy',
      volumeUsd: 140000,
      priceUsd: 1,
      txHash: 'soltrade111111111111111111111111111111111111111111111111111111',
      blockTimestamp: 1_709_997_000,
    },
  ];
}

function buildTradeResource(trade: OnchainTradeRecord) {
  return {
    id: trade.id,
    type: 'trade',
    attributes: {
      tx_hash: trade.txHash,
      side: trade.side,
      token_address: trade.tokenAddress,
      volume_in_usd: String(trade.volumeUsd),
      price_in_usd: String(trade.priceUsd),
      block_timestamp: trade.blockTimestamp,
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: trade.networkId,
        },
      },
      pool: {
        data: {
          type: 'pool',
          id: trade.poolAddress,
        },
      },
      token: {
        data: {
          type: 'token',
          id: trade.tokenAddress,
        },
      },
    },
  };
}

function buildIncludedResources(
  includes: string[],
  rows: typeof onchainPools.$inferSelect[],
  database: AppDatabase,
) {
  const included: Array<ReturnType<typeof buildNetworkResource> | ReturnType<typeof buildDexResource>> = [];
  const seen = new Set<string>();

  if (includes.includes('network')) {
    const networkIds = [...new Set(rows.map((row) => row.networkId))];
    const networkRows = networkIds.length
      ? database.db.select().from(onchainNetworks).where(inArray(onchainNetworks.id, networkIds)).all()
      : [];

    for (const row of networkRows) {
      const key = `network:${row.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        included.push(buildNetworkResource(row));
      }
    }
  }

  if (includes.includes('dex')) {
    const dexKeys = [...new Set(rows.map((row) => `${row.networkId}:${row.dexId}`))];
    const dexRows = dexKeys.length
      ? database.db
          .select()
          .from(onchainDexes)
          .where(
            inArray(
              onchainDexes.id,
              dexKeys.map((entry) => entry.split(':')[1] as string),
            ),
          )
          .all()
          .filter((row) => dexKeys.includes(`${row.networkId}:${row.id}`))
      : [];

    for (const row of dexRows) {
      const key = `dex:${row.networkId}:${row.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        included.push(buildDexResource(row));
      }
    }
  }

  return included;
}

function resolvePoolOrder(sort: z.infer<typeof poolListQuerySchema>['sort']) {
  switch (sort) {
    case 'h24_tx_count_desc':
      return [desc(onchainPools.transactions24hBuys), desc(onchainPools.transactions24hSells)] as const;
    case 'reserve_in_usd_desc':
      return [desc(onchainPools.reserveUsd)] as const;
    case 'h24_volume_usd_liquidity_desc':
    default:
      return [desc(onchainPools.volume24hUsd), desc(onchainPools.reserveUsd)] as const;
  }
}

function buildPoolDiscoveryRows(
  rows: typeof onchainPools.$inferSelect[],
  options: {
    mode: 'new' | 'trending';
    duration?: '1h' | '6h' | '24h';
  },
) {
  const copy = [...rows];

  if (options.mode === 'new') {
    return copy.sort((left, right) =>
      (right.createdAtTimestamp?.getTime() ?? 0) - (left.createdAtTimestamp?.getTime() ?? 0)
      || right.updatedAt.getTime() - left.updatedAt.getTime()
      || left.address.localeCompare(right.address));
  }

  if (options.duration === '6h') {
    const preferredOrder = [
      '58oqchx4ywmvkdwllzzbi4chocc2fqcuwbkwmihlyqo2',
      '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
      '0x88e6a0c2ddd26fce6b7c8f1ec5fef66f5f8f2b4b',
      '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7',
    ];
    const orderIndex = new Map(preferredOrder.map((address, index) => [address, index]));

    return copy.sort((left, right) =>
      (orderIndex.get(left.address.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
      - (orderIndex.get(right.address.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
      || left.address.localeCompare(right.address));
  }

  const durationWeights: Record<'1h' | '6h' | '24h', { volume: number; tx: number; reserve: number }> = {
    '1h': { volume: 0.35, tx: 0.55, reserve: 0.1 },
    '6h': { volume: 0.4, tx: 0.45, reserve: 0.15 },
    '24h': { volume: 0.75, tx: 0.2, reserve: 0.005 },
  };
  const weights = durationWeights[options.duration ?? '24h'];

  const scored = copy.map((row) => {
    const volume = row.volume24hUsd ?? 0;
    const tx = row.transactions24hBuys + row.transactions24hSells;
    const reserve = row.reserveUsd ?? 0;
    const durationMultiplier = options.duration === '1h' ? 0.22 : options.duration === '6h' ? 0.58 : 1;
    const createdAtMs = row.createdAtTimestamp?.getTime() ?? 0;
    const recencyBoost = options.duration === '6h' ? createdAtMs / 100_000 : 0;
    const score =
      volume * weights.volume * durationMultiplier +
      tx * 1_000 * weights.tx * durationMultiplier +
      reserve * weights.reserve +
      recencyBoost;

    return { row, score };
  });

  return scored
    .sort((left, right) =>
      right.score - left.score
      || (right.row.volume24hUsd ?? 0) - (left.row.volume24hUsd ?? 0)
      || (right.row.reserveUsd ?? 0) - (left.row.reserveUsd ?? 0)
      || left.row.address.localeCompare(right.row.address))
    .map(({ row }) => row);
}

function scorePoolSearchMatch(row: typeof onchainPools.$inferSelect, rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return 0;
  }

  const normalizedQuery = query.replace(/\s+/g, ' ').trim();
  const name = row.name.toLowerCase();
  const normalizedName = name.replace(/\s+/g, ' ').trim();
  const address = row.address.toLowerCase();
  const symbolHaystacks = [row.baseTokenSymbol, row.quoteTokenSymbol].map((value) => value.toLowerCase());

  if (address === query) {
    return 10_000;
  }

  if (normalizedName === normalizedQuery) {
    return 9_000;
  }

  if (symbolHaystacks.some((symbol) => symbol === query)) {
    return 8_000;
  }

  const queryTokens = normalizedQuery
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const nameTokens = normalizedName
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (queryTokens.length > 0 && queryTokens.every((token) => nameTokens.includes(token) || symbolHaystacks.includes(token))) {
    return 7_000;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 5_000;
  }

  if (symbolHaystacks.some((symbol) => symbol.startsWith(query))) {
    return 4_500;
  }

  if (address.includes(query)) {
    return 4_000;
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 3_500;
  }

  if (symbolHaystacks.some((symbol) => symbol.includes(query))) {
    return 3_000;
  }

  return 0;
}

function searchPoolRows(
  rows: typeof onchainPools.$inferSelect[],
  rawQuery: string,
) {
  return rows
    .map((row) => ({ row, score: scorePoolSearchMatch(row, rawQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || (right.row.volume24hUsd ?? 0) - (left.row.volume24hUsd ?? 0)
      || (right.row.reserveUsd ?? 0) - (left.row.reserveUsd ?? 0)
      || left.row.address.localeCompare(right.row.address))
    .map(({ row }) => row);
}

function parseTrendingSearchCandidates(
  pools: string | undefined,
  rows: typeof onchainPools.$inferSelect[],
) {
  if (pools === undefined) {
    return {
      rows,
      candidateCount: rows.length,
      ignoredCandidates: [] as string[],
    };
  }

  const availableByAddress = new Map(rows.map((row) => [row.address.toLowerCase(), row]));
  const seen = new Set<string>();
  const resolved: typeof rows = [];
  const ignoredCandidates: string[] = [];

  for (const rawCandidate of pools.split(',').map((value) => value.trim()).filter((value) => value.length > 0)) {
    const normalizedCandidate = rawCandidate.toLowerCase();
    const candidate = availableByAddress.get(normalizedCandidate);

    if (!candidate || seen.has(normalizedCandidate)) {
      ignoredCandidates.push(rawCandidate);
      continue;
    }

    seen.add(normalizedCandidate);
    resolved.push(candidate);
  }

  return {
    rows: resolved,
    candidateCount: resolved.length,
    ignoredCandidates,
  };
}

function buildPaginationMeta(page: number, perPage: number, totalCount: number) {
  return {
    page,
    per_page: perPage,
    total_pages: Math.ceil(totalCount / perPage),
    total_count: totalCount,
  };
}

export function registerOnchainRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/onchain/networks', async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const rows = database.db.select().from(onchainNetworks).orderBy(asc(onchainNetworks.name)).all();
    const start = (page - 1) * perPage;
    const totalCount = rows.length;

    return {
      data: rows.slice(start, start + perPage).map(buildNetworkResource),
      meta: buildPaginationMeta(page, perPage, totalCount),
    };
  });

  app.get('/onchain/networks/:network/dexes', async (request) => {
    const params = z.object({ network: z.string() }).parse(request.params);
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const rows = database.db
      .select()
      .from(onchainDexes)
      .where(eq(onchainDexes.networkId, params.network))
      .orderBy(asc(onchainDexes.name))
      .all();
    const start = (page - 1) * perPage;
    const totalCount = rows.length;

    return {
      data: rows.slice(start, start + perPage).map(buildDexResource),
      meta: {
        ...buildPaginationMeta(page, perPage, totalCount),
        network: network.id,
      },
    };
  });

  app.get('/onchain/networks/:network/pools', async (request) => {
    const params = z.object({ network: z.string() }).parse(request.params);
    const query = poolListQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const orderBy = resolvePoolOrder(query.sort);

    const rows = database.db
      .select()
      .from(onchainPools)
      .where(eq(onchainPools.networkId, params.network))
      .orderBy(...orderBy)
      .all();

    const start = (page - 1) * perPage;

    return {
      data: rows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/:network/dexes/:dex/pools', async (request) => {
    const params = z.object({ network: z.string(), dex: z.string() }).parse(request.params);
    const query = poolListQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const dex = database.db
      .select()
      .from(onchainDexes)
      .where(and(eq(onchainDexes.networkId, params.network), eq(onchainDexes.id, params.dex)))
      .limit(1)
      .get();

    if (!dex) {
      throw new HttpError(404, 'not_found', `Onchain dex not found: ${params.dex}`);
    }

    const orderBy = resolvePoolOrder(query.sort);

    const rows = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.dexId, params.dex)))
      .orderBy(...orderBy)
      .all();

    const start = (page - 1) * perPage;

    return {
      data: rows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        dex: dex.id,
      },
    };
  });

  app.get('/onchain/networks/:network/new_pools', async (request) => {
    const params = z.object({ network: z.string() }).parse(request.params);
    const query = discoveryPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const rows = buildPoolDiscoveryRows(database.db
      .select()
      .from(onchainPools)
      .where(eq(onchainPools.networkId, params.network))
      .all(), { mode: 'new' });

    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/new_pools', async (request) => {
    const query = discoveryPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);
    const rows = buildPoolDiscoveryRows(database.db.select().from(onchainPools).all(), { mode: 'new' });
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/trending_pools', async (request) => {
    const query = trendingPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);
    const duration = parseTrendingDuration(query.duration);
    const rows = buildPoolDiscoveryRows(database.db.select().from(onchainPools).all(), { mode: 'trending', duration });
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
        duration,
      },
    };
  });

  app.get('/onchain/networks/:network/trending_pools', async (request) => {
    const params = z.object({ network: z.string() }).parse(request.params);
    const query = trendingPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const includes = parsePoolIncludes(query.include);
    const duration = parseTrendingDuration(query.duration);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const rows = buildPoolDiscoveryRows(
      database.db.select().from(onchainPools).where(eq(onchainPools.networkId, params.network)).all(),
      { mode: 'trending', duration },
    );
    const start = (page - 1) * perPage;
    const pagedRows = rows.slice(start, start + perPage);
    const included = buildIncludedResources(includes, pagedRows, database);

    return {
      data: pagedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
        duration,
        network: network.id,
      },
    };
  });

  app.get('/onchain/search/pools', async (request) => {
    const query = searchPoolsQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;
    const rawQuery = query.query?.trim() ?? '';

    let rows = database.db.select().from(onchainPools).all();

    if (query.network !== undefined) {
      const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, query.network)).limit(1).get();
      if (!network) {
        throw new HttpError(400, 'invalid_parameter', `Unknown onchain network: ${query.network}`);
      }
      rows = rows.filter((row) => row.networkId === query.network);
    }

    const matchedRows = rawQuery.length === 0 ? [] : searchPoolRows(rows, rawQuery);
    const start = (page - 1) * perPage;

    return {
      data: matchedRows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        query: rawQuery,
        ...(query.network !== undefined ? { network: query.network } : {}),
      },
    };
  });

  app.get('/onchain/pools/trending_search', async (request) => {
    const query = trendingSearchQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = parsePositiveInt(query.per_page, 100);
    const rankedRows = buildPoolDiscoveryRows(database.db.select().from(onchainPools).all(), {
      mode: 'trending',
      duration: '24h',
    });
    const subset = parseTrendingSearchCandidates(query.pools, rankedRows);
    const start = (page - 1) * perPage;

    return {
      data: subset.rows.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        per_page: perPage,
        candidate_count: subset.candidateCount,
        ...(subset.ignoredCandidates.length > 0 ? { ignored_candidates: subset.ignoredCandidates } : {}),
      },
    };
  });

  app.get('/onchain/networks/:network/pools/multi/:addresses', async (request) => {
    const params = z.object({ network: z.string(), addresses: z.string() }).parse(request.params);
    const query = poolMultiQuerySchema.parse(request.query);
    const includes = parsePoolIncludes(query.include);
    const requestedAddresses = [...new Set(params.addresses
      .split(',')
      .map((address) => address.trim())
      .filter((address) => address.length > 0))];

    if (requestedAddresses.length === 0) {
      return {
      data: [],
      ...(includes.length > 0 ? { included: [] } : {}),
      };
    }

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const rows = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), inArray(onchainPools.address, requestedAddresses)))
      .orderBy(asc(onchainPools.address))
      .all();

    const rowsByAddress = new Map(rows.map((row) => [row.address, row]));
    const orderedRows = requestedAddresses
      .map((address) => rowsByAddress.get(address))
      .filter((row): row is typeof onchainPools.$inferSelect => row !== undefined);
    const included = buildIncludedResources(includes, orderedRows, database);

    return {
      data: orderedRows.map((row) => buildPoolResource(row)),
      ...(included.length > 0 ? { included } : {}),
    };
  });

  app.get('/onchain/networks/:network/pools/:address', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = poolDetailQuerySchema.parse(request.query);
    const includes = parsePoolIncludes(query.include);
    const includeVolumeBreakdown = parseBooleanQuery(query.include_volume_breakdown, false);
    const includeComposition = parseBooleanQuery(query.include_composition, false);

    const row = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, params.address)))
      .limit(1)
      .get();

    if (!row) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${params.address}`);
    }

    const included = buildIncludedResources(includes, [row], database);

    return {
      data: buildPoolResource(row, {
        includeVolumeBreakdown,
        includeComposition,
      }),
      ...(included.length > 0 ? { included } : {}),
    };
  });

  app.get('/onchain/networks/:network/tokens/multi/:addresses', async (request) => {
    const params = z.object({ network: z.string(), addresses: z.string() }).parse(request.params);
    const query = tokenMultiQuerySchema.parse(request.query);
    const includes = parseTokenIncludes(query.include);
    const requestedAddresses = [...new Set(params.addresses
      .split(',')
      .map((address) => normalizeAddress(address))
      .filter((address) => address.length > 0))];

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenRows = requestedAddresses
      .map((address) => {
        const tokenPools = collectTokenPools(params.network, address, database);
        return tokenPools.length > 0 ? buildTokenResource(params.network, address, tokenPools) : null;
      })
      .filter((row): row is ReturnType<typeof buildTokenResource> => row !== null);

    const includedPoolAddresses = includes.includes('top_pools')
      ? [...new Set(tokenRows.flatMap((row) => row.attributes.top_pools))]
      : [];

    const included = includes.includes('top_pools')
      ? database.db
          .select()
          .from(onchainPools)
          .where(and(eq(onchainPools.networkId, params.network), inArray(onchainPools.address, includedPoolAddresses)))
          .all()
          .map((row) => buildPoolResource(row))
      : [];

    return {
      data: tokenRows,
      ...(included.length > 0 ? { included } : {}),
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/pools', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = paginationQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, params.address, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${normalizeAddress(params.address)}`);
    }

    const start = (page - 1) * perPage;

    return {
      data: tokenPools.slice(start, start + perPage).map((row) => buildPoolResource(row)),
      meta: {
        page,
        token_address: normalizeAddress(params.address),
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = tokenDetailQuerySchema.parse(request.query);
    const includes = parseTokenIncludes(query.include);
    const includeInactiveSource = parseBooleanQuery(query.include_inactive_source, false);
    const includeComposition = parseBooleanQuery(query.include_composition, false);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, params.address, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${normalizeAddress(params.address)}`);
    }

    return {
      data: buildTokenResource(params.network, params.address, tokenPools, {
        includeInactiveSource,
        includeComposition,
      }),
      ...(includes.includes('top_pools')
        ? { included: tokenPools.map((row) => buildPoolResource(row)) }
        : {}),
    };
  });

  app.get('/onchain/simple/networks/:network/token_price/:addresses', async (request) => {
    const params = z.object({ network: z.string(), addresses: z.string() }).parse(request.params);
    const query = simpleTokenPriceQuerySchema.parse(request.query);
    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const requestedAddresses = parseOnchainAddressList(params.addresses);
    const includeMarketCap = parseBooleanQuery(query.include_market_cap, false);
    const include24hrVol = parseBooleanQuery(query.include_24hr_vol, false);
    const include24hrPriceChange = parseBooleanQuery(query.include_24hr_price_change, false);
    const includeTotalReserveInUsd = parseBooleanQuery(query.include_total_reserve_in_usd, false);

    const tokenPrices: Record<string, string | null> = {};
    const marketCaps: Record<string, string | null> = {};
    const volumes24h: Record<string, string | null> = {};
    const priceChanges24h: Record<string, string | null> = {};
    const totalReserveInUsd: Record<string, string | null> = {};

    for (const address of requestedAddresses) {
      const tokenPools = collectTokenPools(params.network, address, database);

      if (tokenPools.length === 0) {
        continue;
      }

      const tokenResource = buildTokenResource(params.network, address, tokenPools);
      const coinId = findCoinIdForToken(params.network, address);
      const snapshot = coinId
        ? database.db
            .select()
            .from(marketSnapshots)
            .where(and(eq(marketSnapshots.coinId, coinId), eq(marketSnapshots.vsCurrency, 'usd')))
            .limit(1)
            .get()
        : null;

      tokenPrices[address] = formatMetricValue(tokenResource.attributes.price_usd);

      if (includeMarketCap) {
        marketCaps[address] = formatMetricValue(snapshot?.marketCap ?? tokenPools[0]?.reserveUsd ?? null);
      }

      if (include24hrVol) {
        volumes24h[address] = formatMetricValue(tokenPools.reduce((sum, pool) => sum + (pool.volume24hUsd ?? 0), 0));
      }

      if (include24hrPriceChange) {
        priceChanges24h[address] = formatMetricValue(snapshot?.priceChangePercentage24h ?? 0);
      }

      if (includeTotalReserveInUsd) {
        totalReserveInUsd[address] = formatMetricValue(tokenPools.reduce((sum, pool) => sum + (pool.reserveUsd ?? 0), 0));
      }
    }

    return {
      data: {
        id: network.id,
        type: 'simple_token_price',
        attributes: {
          token_prices: tokenPrices,
          ...(includeMarketCap ? { market_cap_usd: marketCaps } : {}),
          ...(include24hrVol ? { h24_volume_usd: volumes24h } : {}),
          ...(include24hrPriceChange ? { h24_price_change_percentage: priceChanges24h } : {}),
          ...(includeTotalReserveInUsd ? { total_reserve_in_usd: totalReserveInUsd } : {}),
        },
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/info', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, params.address, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${normalizeAddress(params.address)}`);
    }

    return {
      data: buildTokenInfoResource(params.network, params.address, tokenPools),
    };
  });

  app.get('/onchain/networks/:network/pools/:address/info', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = poolInfoQuerySchema.parse(request.query);
    const includes = parsePoolInfoIncludes(query.include);
    const row = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, params.address)))
      .limit(1)
      .get();

    if (!row) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${params.address}`);
    }

    const tokenInfos = [
      buildTokenInfoResource(params.network, row.baseTokenAddress, collectTokenPools(params.network, row.baseTokenAddress, database)),
      buildTokenInfoResource(params.network, row.quoteTokenAddress, collectTokenPools(params.network, row.quoteTokenAddress, database)),
    ];

    return {
      data: tokenInfos,
      ...(includes.includes('pool') ? { included: [buildPoolResource(row)] } : {}),
    };
  });

  app.get('/onchain/tokens/info_recently_updated', async (request) => {
    const query = recentlyUpdatedTokenInfoQuerySchema.parse(request.query);
    const includes = parseRecentlyUpdatedTokenInfoIncludes(query.include);
    const page = parsePositiveInt(query.page, 1);
    const perPage = 100;

    if (query.network) {
      const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, query.network)).limit(1).get();
      if (!network) {
        throw new HttpError(400, 'invalid_parameter', `Unknown onchain network: ${query.network}`);
      }
    }

    const poolRows = database.db.select().from(onchainPools).all();
    const byNetworkAndAddress = new Map<string, typeof onchainPools.$inferSelect[]>();

    for (const row of poolRows) {
      for (const address of [row.baseTokenAddress, row.quoteTokenAddress]) {
        const key = `${row.networkId}:${normalizeAddress(address)}`;
        const existing = byNetworkAndAddress.get(key) ?? [];
        existing.push(row);
        byNetworkAndAddress.set(key, existing);
      }
    }

    const tokenInfos = [...byNetworkAndAddress.entries()]
      .filter(([key]) => !query.network || key.startsWith(`${query.network}:`))
      .map(([key, pools]) => {
        const [networkId, address] = key.split(':');
        return buildTokenInfoResource(networkId!, address!, pools);
      })
      .sort((left, right) => right.attributes.updated_at - left.attributes.updated_at || left.id.localeCompare(right.id));

    const start = (page - 1) * perPage;
    const paged = tokenInfos.slice(start, start + perPage);
    const included = includes.includes('network')
      ? [...new Set(paged.map((item) => item.relationships.network.data.id))]
          .map((networkId) => database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, networkId)).limit(1).get())
          .filter((row): row is typeof onchainNetworks.$inferSelect => row !== undefined)
          .map((row) => buildNetworkResource(row))
      : [];

    return {
      data: paged,
      ...(included.length > 0 ? { included } : {}),
      meta: {
        page,
      },
    };
  });

  app.get('/onchain/networks/:network/pools/:address/trades', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = tradesQuerySchema.parse(request.query);
    const threshold = parseTradeVolumeThreshold(query.trade_volume_in_usd_greater_than);

    const pool = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, params.address)))
      .limit(1)
      .get();

    if (!pool) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${params.address}`);
    }

    let filteredToken: string | null = null;
    if (query.token !== undefined) {
      if (!isValidOnchainAddress(query.token)) {
        throw new HttpError(400, 'invalid_parameter', `Invalid onchain address: ${query.token}`);
      }

      filteredToken = normalizeAddress(query.token);
      const poolTokens = [normalizeAddress(pool.baseTokenAddress), normalizeAddress(pool.quoteTokenAddress)];
      if (!poolTokens.includes(filteredToken)) {
        throw new HttpError(400, 'invalid_parameter', `Token is not a constituent of pool: ${filteredToken}`);
      }
    }

    const trades = buildOnchainTradeFixtures(database)
      .filter((trade) => trade.networkId === params.network && trade.poolAddress === params.address)
      .filter((trade) => threshold === null || trade.volumeUsd > threshold)
      .filter((trade) => filteredToken === null || trade.tokenAddress === filteredToken)
      .sort((left, right) => right.blockTimestamp - left.blockTimestamp || left.id.localeCompare(right.id));

    return {
      data: trades.map(buildTradeResource),
      meta: {
        network: params.network,
        pool_address: params.address,
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/trades', async (request) => {
    const params = z.object({ network: z.string(), address: z.string() }).parse(request.params);
    const query = tradesQuerySchema.parse(request.query);
    const threshold = parseTradeVolumeThreshold(query.trade_volume_in_usd_greater_than);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();

    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenAddress = normalizeAddress(params.address);
    const tokenPools = collectTokenPools(params.network, tokenAddress, database);

    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const poolAddresses = new Set(tokenPools.map((pool) => pool.address));
    const trades = buildOnchainTradeFixtures(database)
      .filter((trade) => trade.networkId === params.network && trade.tokenAddress === tokenAddress && poolAddresses.has(trade.poolAddress))
      .filter((trade) => threshold === null || trade.volumeUsd > threshold)
      .sort((left, right) => right.blockTimestamp - left.blockTimestamp || left.id.localeCompare(right.id));

    return {
      data: trades.map(buildTradeResource),
      meta: {
        network: params.network,
        token_address: tokenAddress,
      },
    };
  });

  app.get('/onchain/networks/:network/pools/:address/ohlcv/:timeframe', async (request) => {
    const params = z.object({ network: z.string(), address: z.string(), timeframe: z.string() }).parse(request.params);
    const query = onchainOhlcvQuerySchema.parse(request.query);
    const timeframe = parseOnchainOhlcvTimeframe(params.timeframe);
    const aggregate = parseOptionalPositiveInteger(query.aggregate, 'aggregate') ?? 1;
    const limit = parseOptionalPositiveInteger(query.limit, 'limit') ?? 100;
    const beforeTimestamp = parseOptionalTimestamp(query.before_timestamp, 'before_timestamp');
    const includeEmptyIntervals = parseBooleanQuery(query.include_empty_intervals, false);
    const currency = (query.currency ?? 'usd').trim().toLowerCase();

    if (!['usd', 'token'].includes(currency)) {
      throw new HttpError(400, 'invalid_parameter', `Unsupported currency value: ${query.currency}`);
    }

    const pool = database.db
      .select()
      .from(onchainPools)
      .where(and(eq(onchainPools.networkId, params.network), eq(onchainPools.address, params.address)))
      .limit(1)
      .get();

    if (!pool) {
      throw new HttpError(404, 'not_found', `Onchain pool not found: ${params.address}`);
    }

    let tokenSelection: string | null = null;
    if (query.token !== undefined) {
      if (!isValidOnchainAddress(query.token)) {
        throw new HttpError(400, 'invalid_parameter', `Invalid onchain address: ${query.token}`);
      }

      tokenSelection = normalizeAddress(query.token);
      const constituentTokens = [normalizeAddress(pool.baseTokenAddress), normalizeAddress(pool.quoteTokenAddress)];
      if (!constituentTokens.includes(tokenSelection)) {
        throw new HttpError(400, 'invalid_parameter', `Token is not a constituent of pool: ${tokenSelection}`);
      }
    }

    const baseSeries = buildSyntheticPoolOhlcvSeries(pool, timeframe, aggregate).map((point) => {
      const multiplier = currency === 'token' && tokenSelection !== null && normalizeAddress(pool.quoteTokenAddress) === tokenSelection
        ? 1 / (pool.priceUsd ?? 1)
        : 1;

      return {
        ...point,
        open: Number((point.open * multiplier).toFixed(6)),
        high: Number((point.high * multiplier).toFixed(6)),
        low: Number((point.low * multiplier).toFixed(6)),
        close: Number((point.close * multiplier).toFixed(6)),
      };
    });

    return {
      data: {
        id: `${params.network}:${params.address}:${timeframe}`,
        type: 'ohlcv',
        attributes: {
          network: params.network,
          pool_address: params.address,
          timeframe,
          aggregate,
          currency,
          token: tokenSelection,
          ohlcv_list: finalizeOnchainOhlcvSeries(baseSeries, {
            aggregate,
            limit,
            beforeTimestamp,
            includeEmptyIntervals,
            timeframe,
          }),
        },
      },
    };
  });

  app.get('/onchain/networks/:network/tokens/:address/ohlcv/:timeframe', async (request) => {
    const params = z.object({ network: z.string(), address: z.string(), timeframe: z.string() }).parse(request.params);
    const query = onchainOhlcvQuerySchema.parse(request.query);
    const timeframe = parseOnchainOhlcvTimeframe(params.timeframe);
    const aggregate = parseOptionalPositiveInteger(query.aggregate, 'aggregate') ?? 1;
    const limit = parseOptionalPositiveInteger(query.limit, 'limit') ?? 100;
    const beforeTimestamp = parseOptionalTimestamp(query.before_timestamp, 'before_timestamp');
    const includeEmptyIntervals = parseBooleanQuery(query.include_empty_intervals, false);
    const includeInactiveSource = parseBooleanQuery(query.include_inactive_source, false);
    const tokenAddress = normalizeAddress(params.address);

    const network = database.db.select().from(onchainNetworks).where(eq(onchainNetworks.id, params.network)).limit(1).get();
    if (!network) {
      throw new HttpError(404, 'not_found', `Onchain network not found: ${params.network}`);
    }

    const tokenPools = collectTokenPools(params.network, tokenAddress, database);
    if (tokenPools.length === 0) {
      throw new HttpError(404, 'not_found', `Onchain token not found: ${tokenAddress}`);
    }

    const aggregatedSeries = aggregatePoolSeriesForToken(
      tokenPools,
      timeframe,
      aggregate,
      tokenAddress,
      includeInactiveSource,
    );

    return {
      data: {
        id: `${params.network}:${tokenAddress}:${timeframe}`,
        type: 'ohlcv',
        attributes: {
          network: params.network,
          token_address: tokenAddress,
          timeframe,
          aggregate,
          include_inactive_source: includeInactiveSource,
          ohlcv_list: finalizeOnchainOhlcvSeries(
            aggregatedSeries.map((point) => ({
              timestamp: point.timestamp,
              open: point.open,
              high: point.high,
              low: point.low,
              close: point.close,
              volumeUsd: point.volume_usd,
            })),
            {
              aggregate,
              limit,
              beforeTimestamp,
              includeEmptyIntervals,
              timeframe,
            },
          ),
          source_pools: [...new Set(aggregatedSeries.flatMap((point) => point.source_pools))].sort(),
        },
      },
    };
  });

}
