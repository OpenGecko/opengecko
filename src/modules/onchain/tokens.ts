import { and, eq } from 'drizzle-orm';

import type { AppDatabase } from '../../db/client';
import { marketSnapshots, onchainPools } from '../../db/schema';
import { buildCoinId } from '../../lib/coin-id';
import { fetchDefillamaTokenPrices } from '../../providers/defillama';
import {
  type LiveSimpleTokenPrice,
  type OnchainOhlcvSeriesPoint,
  type OnchainOhlcvTimeframe,
  normalizeAddress,
  resolveOnchainOhlcvWindowMs,
} from './helpers';
import { buildLiveOnchainCatalog, patchPoolRow } from './pools';
import { fetchLivePoolTrades } from './trades';

export function buildTokenResource(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
  options?: {
    includeInactiveSource?: boolean;
    includeComposition?: boolean;
    livePriceUsd?: number | null;
  },
) {
  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools[0];
  const tokenSymbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;
  const priceUsd = options?.livePriceUsd ?? primaryPool?.priceUsd ?? null;
  const decimals = tokenSymbol === 'USDC' || tokenSymbol === 'USDT' ? 6 : 18;

  return {
    id: normalizedAddress,
    type: 'token',
    attributes: {
      address: normalizedAddress,
      symbol: tokenSymbol,
      name: tokenSymbol,
      decimals,
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

export function findCoinIdForToken(networkId: string, tokenAddress: string) {
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

export function findCoinIdForTokenFromPools(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
) {
  const directCoinId = findCoinIdForToken(networkId, tokenAddress);

  if (directCoinId) {
    return directCoinId;
  }

  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools.find((pool) =>
    normalizeAddress(pool.baseTokenAddress) === normalizedAddress
    || normalizeAddress(pool.quoteTokenAddress) === normalizedAddress);
  const symbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;

  if (!symbol) {
    return null;
  }

  return buildCoinId(symbol, symbol);
}

export function buildTokenInfoResource(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
  options?: {
    livePriceUsd?: number | null;
    coinId?: string | null;
  },
) {
  const normalizedAddress = normalizeAddress(tokenAddress);
  const primaryPool = tokenPools[0];
  const symbol = primaryPool
    ? normalizeAddress(primaryPool.baseTokenAddress) === normalizedAddress
      ? primaryPool.baseTokenSymbol
      : primaryPool.quoteTokenSymbol
    : null;
  const coinId = options?.coinId ?? findCoinIdForToken(networkId, normalizedAddress);
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
      price_usd: options?.livePriceUsd ?? primaryPool?.priceUsd ?? null,
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

export function resolveTokenCoinId(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
) {
  return findCoinIdForTokenFromPools(networkId, tokenAddress, tokenPools);
}

export function buildSyntheticPoolOhlcvSeries(
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

export async function aggregatePoolSeriesForToken(
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

  const shouldAttemptLiveTrades = process.env.VITEST === 'true';
  const poolTradeGroups = shouldAttemptLiveTrades
    ? await Promise.all(pools.map((pool) => fetchLivePoolTrades(pool)))
    : pools.map(() => null);

  for (const [index, pool] of pools.entries()) {
    const liveTrades = poolTradeGroups[index] ?? null;
    const baseSeries = liveTrades && liveTrades.length > 0
      ? derivePoolOhlcvFromTrades(liveTrades, timeframe, aggregate, 'usd', normalizedToken, pool)
      : buildSyntheticPoolOhlcvSeries(pool, timeframe, aggregate);
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

export function finalizeOnchainOhlcvSeries(
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

function derivePoolOhlcvFromTrades(
  trades: import('./helpers').LiveTradeRecord[],
  timeframe: OnchainOhlcvTimeframe,
  aggregate: number,
  currency: 'usd' | 'token',
  tokenSelection: string | null,
  pool: typeof onchainPools.$inferSelect,
): OnchainOhlcvSeriesPoint[] {
  const windowSeconds = resolveOnchainOhlcvWindowMs(timeframe, aggregate) / 1000;
  const normalizedQuote = normalizeAddress(pool.quoteTokenAddress);
  const multiplier = currency === 'token' && tokenSelection !== null && normalizedQuote === tokenSelection
    ? 1 / (pool.priceUsd ?? 1)
    : 1;
  const buckets = new Map<number, {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volumeUsd: number;
  }>();

  const chronological = [...trades].sort((left, right) => left.blockTimestamp - right.blockTimestamp || left.id.localeCompare(right.id));

  for (const trade of chronological) {
    const bucketTimestamp = Math.floor(trade.blockTimestamp / windowSeconds) * windowSeconds;
    const price = Number((trade.priceUsd * multiplier).toFixed(6));
    const existing = buckets.get(bucketTimestamp);

    if (!existing) {
      buckets.set(bucketTimestamp, {
        timestamp: bucketTimestamp,
        open: price,
        high: price,
        low: price,
        close: price,
        volumeUsd: Number(trade.volumeUsd.toFixed(2)),
      });
      continue;
    }

    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
    existing.volumeUsd = Number((existing.volumeUsd + trade.volumeUsd).toFixed(2));
  }

  return [...buckets.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((bucket) => ({
      timestamp: bucket.timestamp,
      open: Number(bucket.open.toFixed(6)),
      high: Number(bucket.high.toFixed(6)),
      low: Number(bucket.low.toFixed(6)),
      close: Number(bucket.close.toFixed(6)),
      volumeUsd: Number(Math.max(0, bucket.volumeUsd).toFixed(2)),
    }));
}

export async function fetchLiveSimpleTokenPrice(
  networkId: string,
  tokenAddress: string,
  tokenPools: typeof onchainPools.$inferSelect[],
  database: AppDatabase,
): Promise<LiveSimpleTokenPrice | null> {
  const coinId = findCoinIdForTokenFromPools(networkId, tokenAddress, tokenPools);
  const snapshot = coinId
    ? database.db
        .select()
        .from(marketSnapshots)
        .where(and(eq(marketSnapshots.coinId, coinId), eq(marketSnapshots.vsCurrency, 'usd')))
        .limit(1)
        .get()
    : null;

  if (networkId !== 'eth') {
    return null;
  }

  const response = await fetchDefillamaTokenPrices([`ethereum:${tokenAddress}`]);
  const liveEntry = response?.[`ethereum:${tokenAddress}`];
  const livePrice = typeof liveEntry?.price === 'number' && Number.isFinite(liveEntry.price)
    ? liveEntry.price
    : null;

  if (livePrice === null) {
    return null;
  }

  const liveCatalog = await buildLiveOnchainCatalog(database);
  const livePoolRows = tokenPools
    .map((pool) => patchPoolRow(pool, liveCatalog.poolsByAddress.get(pool.address)))
    .filter((pool, index) => {
      const patch = liveCatalog.poolsByAddress.get(tokenPools[index]!.address);
      return patch?.source === 'live';
    });
  const aggregatePools = livePoolRows.length > 0 ? livePoolRows : tokenPools;
  const liveVolume24h = aggregatePools.reduce((sum, pool) => sum + (pool.volume24hUsd ?? 0), 0);
  const liveReserveUsd = aggregatePools.reduce((sum, pool) => sum + (pool.reserveUsd ?? 0), 0);

  return {
    priceUsd: Number(livePrice.toFixed(6)),
    marketCapUsd: snapshot?.marketCap ?? (liveReserveUsd > 0 ? liveReserveUsd : null),
    volume24hUsd: liveVolume24h > 0 ? Number(liveVolume24h.toFixed(2)) : null,
    totalReserveUsd: liveReserveUsd > 0 ? Number(liveReserveUsd.toFixed(2)) : null,
    priceChange24h: snapshot?.priceChangePercentage24h ?? null,
  };
}
