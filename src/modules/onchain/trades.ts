import type { AppDatabase } from '../../db/client';
import { onchainPools } from '../../db/schema';
import { fetchEthereumPoolSwapLogs, resolveAddressLabel } from '../../providers/sqd';
import {
  type HoldersChartPoint,
  type LiveTradeRecord,
  type NormalizedSwapTradeShape,
  type OnchainHolderRecord,
  type OnchainOhlcvSeriesPoint,
  type OnchainOhlcvTimeframe,
  type OnchainTradeRecord,
  type OnchainTraderRecord,
  normalizeAddress,
  resolveOnchainOhlcvWindowMs,
} from './helpers';

export function deriveLivePoolTrades(
  pool: typeof onchainPools.$inferSelect,
  swaps: ReadonlyArray<NormalizedSwapTradeShape> | null,
): LiveTradeRecord[] | null {
  if (!Array.isArray(swaps) || swaps.length === 0) {
    return null;
  }

  const normalizedBase = normalizeAddress(pool.baseTokenAddress);
  const normalizedQuote = normalizeAddress(pool.quoteTokenAddress);
  const sorted = [...swaps]
    .filter((swap) => swap.transaction?.id && swap.timestamp !== null)
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0) || left.id.localeCompare(right.id));

  const liveTrades: LiveTradeRecord[] = [];

  for (const swap of sorted) {
    const amount0 = swap.amount0 ? Number(swap.amount0) : NaN;
    const amount1 = swap.amount1 ? Number(swap.amount1) : NaN;
    const amountUsd = swap.amountUSD ? Number(swap.amountUSD) : (
      (() => {
        const absAmount0 = Math.abs(amount0);
        const absAmount1 = Math.abs(amount1);
        const quoteIsStable = ['USDC', 'USDT', 'DAI'].includes(pool.quoteTokenSymbol.toUpperCase());
        const baseIsStable = ['USDC', 'USDT', 'DAI'].includes(pool.baseTokenSymbol.toUpperCase());

        if (quoteIsStable && Number.isFinite(absAmount1) && absAmount1 > 0) {
          return absAmount1;
        }

        if (baseIsStable && Number.isFinite(absAmount0) && absAmount0 > 0) {
          return absAmount0;
        }

        const tokenAmount = amount0 <= 0 ? absAmount0 : absAmount1;
        const fallbackPrice = pool.priceUsd ?? 0;
        return tokenAmount > 0 && fallbackPrice > 0 ? tokenAmount * fallbackPrice : NaN;
      })()
    );

    if (!Number.isFinite(amount0) || !Number.isFinite(amount1) || !Number.isFinite(amountUsd) || amountUsd < 0) {
      continue;
    }

    const tokenAddress = amount0 <= 0 ? normalizedBase : normalizedQuote;
    const tokenAmount = tokenAddress === normalizedBase ? Math.abs(amount0) : Math.abs(amount1);
    const priceUsd = tokenAmount > 0 ? Number((amountUsd / tokenAmount).toFixed(6)) : pool.priceUsd ?? 0;

    liveTrades.push({
      id: swap.id || `${pool.address}:${swap.transaction?.id}:${swap.timestamp}`,
      networkId: pool.networkId,
      poolAddress: pool.address,
      tokenAddress,
      side: amount0 <= 0 ? 'buy' : 'sell',
      volumeUsd: Number(amountUsd.toFixed(2)),
      priceUsd,
      txHash: swap.transaction?.id ?? '',
      blockTimestamp: swap.timestamp ?? 0,
      source: 'live',
    });
  }

  return liveTrades.length > 0 ? liveTrades : null;
}

export function derivePoolOhlcvFromTrades(
  trades: LiveTradeRecord[],
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

export async function fetchLivePoolTrades(pool: typeof onchainPools.$inferSelect) {
  if (pool.networkId !== 'eth') {
    return null;
  }

  const canUseSqd = process.env.VITEST !== 'true';

  if (canUseSqd) {
    const sqdSwaps = await fetchEthereumPoolSwapLogs(pool.address, {
      toBlock: undefined,
      maxResults: 128,
    });
    if (sqdSwaps && sqdSwaps.length > 0) {
      const normalized: NormalizedSwapTradeShape[] = sqdSwaps.map((swap) => ({
        id: `${swap.txHash}:${swap.blockNumber}`,
        amount0: swap.amount0,
        amount1: swap.amount1,
        amountUSD: null,
        timestamp: swap.blockTimestamp,
        transaction: {
          id: swap.txHash,
          blockNumber: String(swap.blockNumber),
        },
      }));

      return deriveLivePoolTrades(pool, normalized);
    }

    console.warn('SQD-backed onchain pool trades unavailable; falling back to alternate providers/fixtures', {
      network: pool.networkId,
      poolAddress: pool.address,
      sqdResult: sqdSwaps === null ? 'null' : 'empty',
    });
  }

  return null;
}

export function buildOnchainTradeFixtures(database: AppDatabase): OnchainTradeRecord[] {
  const poolRows = database.db.select().from(onchainPools).all();
  const getPool = (address: string) => {
    const row = poolRows.find((pool) => pool.address === address);
    if (!row) {
      throw new Error(`Missing seeded onchain pool for trade fixtures: ${address}`);
    }
    return row;
  };

  const usdcWethPool = getPool('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
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

export function buildTradeResource(trade: OnchainTradeRecord, label?: string | null) {
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
      ...(label ? { address_label: label } : {}),
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

export function buildTopHolderFixtures(networkId: string, tokenAddress: string): OnchainHolderRecord[] {
  const normalizedAddress = normalizeAddress(tokenAddress);

  if (networkId === 'eth' && normalizedAddress === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') {
    return [
      {
        address: '0xholder000000000000000000000000000000000003',
        balance: 200_000_000,
        shareOfSupply: 0.2,
        pnlUsd: 2_000_000,
        avgBuyPriceUsd: 0.98,
        realizedPnlUsd: 700_000,
      },
      {
        address: '0xholder000000000000000000000000000000000002',
        balance: 150_000_000,
        shareOfSupply: 0.15,
        pnlUsd: 1_000_000,
        avgBuyPriceUsd: 0.99,
        realizedPnlUsd: 300_000,
      },
      {
        address: '0xholder000000000000000000000000000000000001',
        balance: 100_000_000,
        shareOfSupply: 0.1,
        pnlUsd: 500_000,
        avgBuyPriceUsd: 0.995,
        realizedPnlUsd: 125_000,
      },
    ];
  }

  return [];
}

export function buildTopTraderFixtures(networkId: string, tokenAddress: string): OnchainTraderRecord[] {
  const normalizedAddress = normalizeAddress(tokenAddress);

  if (networkId === 'eth' && normalizedAddress === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') {
    return [
      {
        address: '0xtrader000000000000000000000000000000000001',
        volumeUsd: 9_000_000,
        buyVolumeUsd: 5_100_000,
        sellVolumeUsd: 3_900_000,
        realizedPnlUsd: 450_000,
        tradeCount: 120,
        addressLabel: 'Whale One',
      },
      {
        address: '0xtrader000000000000000000000000000000000002',
        volumeUsd: 12_500_000,
        buyVolumeUsd: 7_400_000,
        sellVolumeUsd: 5_100_000,
        realizedPnlUsd: 200_000,
        tradeCount: 145,
        addressLabel: 'MM Desk',
      },
      {
        address: '0xtrader000000000000000000000000000000000003',
        volumeUsd: 4_000_000,
        buyVolumeUsd: 2_200_000,
        sellVolumeUsd: 1_800_000,
        realizedPnlUsd: 300_000,
        tradeCount: 80,
        addressLabel: 'Arb Bot',
      },
    ];
  }

  return [];
}

export function buildHoldersChartFixtures(networkId: string, tokenAddress: string): HoldersChartPoint[] {
  const normalizedAddress = normalizeAddress(tokenAddress);

  if (networkId === 'eth' && normalizedAddress === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') {
    return [
      { timestamp: 1_710_028_800, holderCount: 181_200 },
      { timestamp: 1_710_633_600, holderCount: 184_500 },
      { timestamp: 1_711_238_400, holderCount: 188_900 },
      { timestamp: 1_711_843_200, holderCount: 193_400 },
    ];
  }

  return [];
}

export function buildTopHolderResource(holder: OnchainHolderRecord, includePnlDetails: boolean) {
  return {
    id: holder.address,
    type: 'holder',
    attributes: {
      address: holder.address,
      balance: String(holder.balance),
      share_of_supply: String(holder.shareOfSupply),
      ...(includePnlDetails
        ? {
            pnl_usd: String(holder.pnlUsd),
            avg_buy_price_usd: String(holder.avgBuyPriceUsd),
            realized_pnl_usd: String(holder.realizedPnlUsd),
          }
        : {}),
    },
  };
}

export function buildTopTraderResource(trader: OnchainTraderRecord, includeAddressLabel: boolean) {
  const whaleVolumeThresholdUsd = 10_000_000;

  return {
    id: trader.address,
    type: 'trader',
    attributes: {
      address: trader.address,
      volume_usd: String(trader.volumeUsd),
      buy_volume_usd: String(trader.buyVolumeUsd),
      sell_volume_usd: String(trader.sellVolumeUsd),
      realized_pnl_usd: String(trader.realizedPnlUsd),
      trade_count: trader.tradeCount,
      is_whale: trader.volumeUsd >= whaleVolumeThresholdUsd,
      ...(includeAddressLabel ? { address_label: trader.addressLabel } : {}),
    },
  };
}

export function buildHoldersChartResource(point: HoldersChartPoint) {
  return {
    id: String(point.timestamp),
    type: 'holders_chart_point',
    attributes: {
      timestamp: point.timestamp,
      holder_count: point.holderCount,
    },
  };
}
