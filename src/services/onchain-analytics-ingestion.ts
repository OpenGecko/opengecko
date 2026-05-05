import { and, eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import {
  onchainTokenHolderCounts,
  onchainTokenHolders,
  onchainTokenTraders,
} from '../db/schema';
import {
  type HoldersChartPoint,
  type OnchainHolderRecord,
  type OnchainTraderRecord,
  normalizeAddress,
} from '../modules/onchain/helpers';

export type RawOnchainAnalyticsReplay = {
  provider: string;
  captured_at: string;
  network_id: string;
  token_address: string;
  holders?: Array<{
    address: string;
    balance: number | string;
    share_of_supply: number | string;
    pnl_usd?: number | string | null;
    avg_buy_price_usd?: number | string | null;
    realized_pnl_usd?: number | string | null;
  }>;
  traders?: Array<{
    address: string;
    volume_usd: number | string;
    buy_volume_usd: number | string;
    sell_volume_usd: number | string;
    realized_pnl_usd?: number | string | null;
    trade_count: number | string;
    address_label?: string | null;
  }>;
  holders_chart?: Array<{
    timestamp: number | string;
    holder_count: number | string;
  }>;
};

export type OnchainAnalyticsSourceKind = 'replay' | 'live';

export type IngestOnchainAnalyticsOptions = {
  sourceKind?: OnchainAnalyticsSourceKind;
  sourceProvider?: string | null;
  sourceFetchedAt?: Date;
};

function parseFiniteNumber(value: number | string | null | undefined, field: string, defaultValue?: number) {
  if (value === null || value === undefined || value === '') {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing onchain analytics field: ${field}`);
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid onchain analytics field: ${field}`);
  }

  return parsed;
}

function parsePositiveInteger(value: number | string, field: string) {
  const parsed = Math.floor(parseFiniteNumber(value, field));
  if (parsed <= 0) {
    throw new Error(`Invalid onchain analytics field: ${field}`);
  }

  return parsed;
}

function parseCapturedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid onchain analytics captured_at timestamp: ${value}`);
  }

  return new Date(timestamp);
}

export function normalizeOnchainAnalyticsReplay(raw: RawOnchainAnalyticsReplay) {
  const networkId = raw.network_id.trim().toLowerCase();
  const tokenAddress = normalizeAddress(raw.token_address);

  return {
    networkId,
    tokenAddress,
    capturedAt: parseCapturedAt(raw.captured_at),
    holders: (raw.holders ?? []).map((holder) => ({
      networkId,
      tokenAddress,
      holderAddress: normalizeAddress(holder.address),
      balance: parseFiniteNumber(holder.balance, `holder.${holder.address}.balance`),
      shareOfSupply: parseFiniteNumber(holder.share_of_supply, `holder.${holder.address}.share_of_supply`),
      pnlUsd: parseFiniteNumber(holder.pnl_usd, `holder.${holder.address}.pnl_usd`, 0),
      avgBuyPriceUsd: parseFiniteNumber(holder.avg_buy_price_usd, `holder.${holder.address}.avg_buy_price_usd`, 0),
      realizedPnlUsd: parseFiniteNumber(holder.realized_pnl_usd, `holder.${holder.address}.realized_pnl_usd`, 0),
    })),
    traders: (raw.traders ?? []).map((trader) => ({
      networkId,
      tokenAddress,
      traderAddress: normalizeAddress(trader.address),
      volumeUsd: parseFiniteNumber(trader.volume_usd, `trader.${trader.address}.volume_usd`),
      buyVolumeUsd: parseFiniteNumber(trader.buy_volume_usd, `trader.${trader.address}.buy_volume_usd`),
      sellVolumeUsd: parseFiniteNumber(trader.sell_volume_usd, `trader.${trader.address}.sell_volume_usd`),
      realizedPnlUsd: parseFiniteNumber(trader.realized_pnl_usd, `trader.${trader.address}.realized_pnl_usd`, 0),
      tradeCount: parsePositiveInteger(trader.trade_count, `trader.${trader.address}.trade_count`),
      addressLabel: trader.address_label ?? null,
    })),
    holderCounts: (raw.holders_chart ?? []).map((point) => ({
      networkId,
      tokenAddress,
      timestamp: parsePositiveInteger(point.timestamp, 'holders_chart.timestamp'),
      holderCount: parsePositiveInteger(point.holder_count, 'holders_chart.holder_count'),
    })),
  };
}

export function ingestOnchainAnalytics(
  database: AppDatabase,
  raw: RawOnchainAnalyticsReplay,
  options: IngestOnchainAnalyticsOptions = {},
) {
  const normalized = normalizeOnchainAnalyticsReplay(raw);
  const sourceKind = options.sourceKind ?? 'replay';
  const sourceProvider = options.sourceProvider ?? (raw.provider.trim() || null);
  const sourceFetchedAt = options.sourceFetchedAt ?? normalized.capturedAt;

  for (const holder of normalized.holders) {
    database.db
      .insert(onchainTokenHolders)
      .values({
        ...holder,
        sourceKind,
        sourceProvider,
        sourceFetchedAt,
      })
      .onConflictDoUpdate({
        target: [onchainTokenHolders.networkId, onchainTokenHolders.tokenAddress, onchainTokenHolders.holderAddress],
        set: {
          balance: holder.balance,
          shareOfSupply: holder.shareOfSupply,
          pnlUsd: holder.pnlUsd,
          avgBuyPriceUsd: holder.avgBuyPriceUsd,
          realizedPnlUsd: holder.realizedPnlUsd,
          sourceKind,
          sourceProvider,
          sourceFetchedAt,
        },
      })
      .run();
  }

  for (const trader of normalized.traders) {
    database.db
      .insert(onchainTokenTraders)
      .values({
        ...trader,
        sourceKind,
        sourceProvider,
        sourceFetchedAt,
      })
      .onConflictDoUpdate({
        target: [onchainTokenTraders.networkId, onchainTokenTraders.tokenAddress, onchainTokenTraders.traderAddress],
        set: {
          volumeUsd: trader.volumeUsd,
          buyVolumeUsd: trader.buyVolumeUsd,
          sellVolumeUsd: trader.sellVolumeUsd,
          realizedPnlUsd: trader.realizedPnlUsd,
          tradeCount: trader.tradeCount,
          addressLabel: trader.addressLabel,
          sourceKind,
          sourceProvider,
          sourceFetchedAt,
        },
      })
      .run();
  }

  for (const point of normalized.holderCounts) {
    database.db
      .insert(onchainTokenHolderCounts)
      .values({
        ...point,
        sourceKind,
        sourceProvider,
        sourceFetchedAt,
      })
      .onConflictDoUpdate({
        target: [onchainTokenHolderCounts.networkId, onchainTokenHolderCounts.tokenAddress, onchainTokenHolderCounts.timestamp],
        set: {
          holderCount: point.holderCount,
          sourceKind,
          sourceProvider,
          sourceFetchedAt,
        },
      })
      .run();
  }

  return {
    network_id: normalized.networkId,
    token_address: normalized.tokenAddress,
    holders_written: normalized.holders.length,
    traders_written: normalized.traders.length,
    holder_counts_written: normalized.holderCounts.length,
    source_kind: sourceKind,
    source_provider: sourceProvider,
    source_fetched_at: sourceFetchedAt.toISOString(),
  };
}

export function ingestOnchainAnalyticsReplay(database: AppDatabase, raw: RawOnchainAnalyticsReplay) {
  return ingestOnchainAnalytics(database, raw, { sourceKind: 'replay' });
}

function resolveSourceKind(rows: Array<{ sourceKind: OnchainAnalyticsSourceKind }>): OnchainAnalyticsSourceKind | null {
  if (rows.some((row) => row.sourceKind === 'live')) {
    return 'live';
  }

  if (rows.some((row) => row.sourceKind === 'replay')) {
    return 'replay';
  }

  return null;
}

export function readOnchainTokenHolders(
  database: AppDatabase,
  networkId: string,
  tokenAddress: string,
): OnchainHolderRecord[] {
  return database.db
    .select()
    .from(onchainTokenHolders)
    .where(and(
      eq(onchainTokenHolders.networkId, networkId),
      eq(onchainTokenHolders.tokenAddress, normalizeAddress(tokenAddress)),
    ))
    .all()
    .map((holder) => ({
      address: holder.holderAddress,
      balance: holder.balance,
      shareOfSupply: holder.shareOfSupply,
      pnlUsd: holder.pnlUsd,
      avgBuyPriceUsd: holder.avgBuyPriceUsd,
      realizedPnlUsd: holder.realizedPnlUsd,
    }));
}

export function readOnchainTokenHolderSourceKind(
  database: AppDatabase,
  networkId: string,
  tokenAddress: string,
): OnchainAnalyticsSourceKind | null {
  return resolveSourceKind(database.db
    .select()
    .from(onchainTokenHolders)
    .where(and(
      eq(onchainTokenHolders.networkId, networkId),
      eq(onchainTokenHolders.tokenAddress, normalizeAddress(tokenAddress)),
    ))
    .all());
}

export function readOnchainTokenTraders(
  database: AppDatabase,
  networkId: string,
  tokenAddress: string,
): OnchainTraderRecord[] {
  return database.db
    .select()
    .from(onchainTokenTraders)
    .where(and(
      eq(onchainTokenTraders.networkId, networkId),
      eq(onchainTokenTraders.tokenAddress, normalizeAddress(tokenAddress)),
    ))
    .all()
    .map((trader) => ({
      address: trader.traderAddress,
      volumeUsd: trader.volumeUsd,
      buyVolumeUsd: trader.buyVolumeUsd,
      sellVolumeUsd: trader.sellVolumeUsd,
      realizedPnlUsd: trader.realizedPnlUsd,
      tradeCount: trader.tradeCount,
      addressLabel: trader.addressLabel,
    }));
}

export function readOnchainTokenTraderSourceKind(
  database: AppDatabase,
  networkId: string,
  tokenAddress: string,
): OnchainAnalyticsSourceKind | null {
  return resolveSourceKind(database.db
    .select()
    .from(onchainTokenTraders)
    .where(and(
      eq(onchainTokenTraders.networkId, networkId),
      eq(onchainTokenTraders.tokenAddress, normalizeAddress(tokenAddress)),
    ))
    .all());
}

export function readOnchainHoldersChart(
  database: AppDatabase,
  networkId: string,
  tokenAddress: string,
): HoldersChartPoint[] {
  return database.db
    .select()
    .from(onchainTokenHolderCounts)
    .where(and(
      eq(onchainTokenHolderCounts.networkId, networkId),
      eq(onchainTokenHolderCounts.tokenAddress, normalizeAddress(tokenAddress)),
    ))
    .all()
    .map((point) => ({
      timestamp: point.timestamp,
      holderCount: point.holderCount,
    }));
}

export function readOnchainHoldersChartSourceKind(
  database: AppDatabase,
  networkId: string,
  tokenAddress: string,
): OnchainAnalyticsSourceKind | null {
  return resolveSourceKind(database.db
    .select()
    .from(onchainTokenHolderCounts)
    .where(and(
      eq(onchainTokenHolderCounts.networkId, networkId),
      eq(onchainTokenHolderCounts.tokenAddress, normalizeAddress(tokenAddress)),
    ))
    .all());
}
