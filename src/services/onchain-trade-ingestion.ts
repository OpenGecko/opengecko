import { and, eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { onchainPoolTrades } from '../db/schema';
import type { LiveTradeRecord } from '../modules/onchain/helpers';
import { normalizeAddress } from '../modules/onchain/helpers';

export type OnchainTradeSourceKind = 'replay' | 'live';

export type RawOnchainTradeReplay = {
  provider: string;
  captured_at: string;
  network_id: string;
  pool_address: string;
  trades: Array<{
    id?: string | null;
    token_address: string;
    side: 'buy' | 'sell';
    volume_usd: number | string;
    price_usd: number | string;
    tx_hash: string;
    block_timestamp: number | string;
  }>;
};

export type IngestOnchainTradeOptions = {
  sourceKind?: OnchainTradeSourceKind;
  sourceProvider?: string | null;
  sourceFetchedAt?: Date;
};

function parseFiniteNumber(value: number | string | null | undefined, field: string) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Missing onchain trade field: ${field}`);
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid onchain trade field: ${field}`);
  }

  return parsed;
}

function parsePositiveInteger(value: number | string, field: string) {
  const parsed = Math.floor(parseFiniteNumber(value, field));
  if (parsed <= 0) {
    throw new Error(`Invalid onchain trade field: ${field}`);
  }

  return parsed;
}

function parseCapturedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid onchain trade captured_at timestamp: ${value}`);
  }

  return new Date(timestamp);
}

export function normalizeOnchainTradeReplay(raw: RawOnchainTradeReplay) {
  const networkId = raw.network_id.trim().toLowerCase();
  const poolAddress = normalizeAddress(raw.pool_address);
  const capturedAt = parseCapturedAt(raw.captured_at);

  return {
    networkId,
    poolAddress,
    capturedAt,
    trades: raw.trades.map((trade) => {
      const txHash = trade.tx_hash.trim();
      const blockTimestamp = parsePositiveInteger(trade.block_timestamp, `trade.${txHash}.block_timestamp`);

      if (!txHash) {
        throw new Error('Missing onchain trade field: tx_hash');
      }

      return {
        networkId,
        poolAddress,
        tradeId: trade.id?.trim() || `${txHash}:${blockTimestamp}`,
        tokenAddress: normalizeAddress(trade.token_address),
        side: trade.side,
        volumeUsd: parseFiniteNumber(trade.volume_usd, `trade.${txHash}.volume_usd`),
        priceUsd: parseFiniteNumber(trade.price_usd, `trade.${txHash}.price_usd`),
        txHash,
        blockTimestamp,
      };
    }),
  };
}

export function ingestOnchainTradeReplay(
  database: AppDatabase,
  raw: RawOnchainTradeReplay,
  options: IngestOnchainTradeOptions = {},
) {
  const normalized = normalizeOnchainTradeReplay(raw);
  const sourceKind = options.sourceKind ?? 'replay';
  const sourceProvider = options.sourceProvider ?? (raw.provider.trim() || null);
  const sourceFetchedAt = options.sourceFetchedAt ?? normalized.capturedAt;

  for (const trade of normalized.trades) {
    database.db
      .insert(onchainPoolTrades)
      .values({
        ...trade,
        sourceKind,
        sourceProvider,
        sourceFetchedAt,
      })
      .onConflictDoUpdate({
        target: [onchainPoolTrades.networkId, onchainPoolTrades.poolAddress, onchainPoolTrades.tradeId],
        set: {
          tokenAddress: trade.tokenAddress,
          side: trade.side,
          volumeUsd: trade.volumeUsd,
          priceUsd: trade.priceUsd,
          txHash: trade.txHash,
          blockTimestamp: trade.blockTimestamp,
          sourceKind,
          sourceProvider,
          sourceFetchedAt,
        },
      })
      .run();
  }

  return {
    network_id: normalized.networkId,
    pool_address: normalized.poolAddress,
    trades_written: normalized.trades.length,
    source_kind: sourceKind,
    source_provider: sourceProvider,
    source_fetched_at: sourceFetchedAt.toISOString(),
  };
}

function toTradeRecord(row: typeof onchainPoolTrades.$inferSelect): LiveTradeRecord {
  return {
    id: row.tradeId,
    networkId: row.networkId,
    poolAddress: row.poolAddress,
    tokenAddress: row.tokenAddress,
    side: row.side,
    volumeUsd: row.volumeUsd,
    priceUsd: row.priceUsd,
    txHash: row.txHash,
    blockTimestamp: row.blockTimestamp,
    source: row.sourceKind,
    sourceFetchedAt: row.sourceFetchedAt,
  };
}

function sortTrades(trades: LiveTradeRecord[]) {
  return [...trades].sort((left, right) => right.blockTimestamp - left.blockTimestamp || left.id.localeCompare(right.id));
}

export function readOnchainPoolTrades(
  database: AppDatabase,
  networkId: string,
  poolAddress: string,
): LiveTradeRecord[] {
  return sortTrades(database.db
    .select()
    .from(onchainPoolTrades)
    .where(and(
      eq(onchainPoolTrades.networkId, networkId),
      eq(onchainPoolTrades.poolAddress, normalizeAddress(poolAddress)),
    ))
    .all()
    .map(toTradeRecord));
}

export function readOnchainTokenTrades(
  database: AppDatabase,
  networkId: string,
  tokenAddress: string,
): LiveTradeRecord[] {
  return sortTrades(database.db
    .select()
    .from(onchainPoolTrades)
    .where(and(
      eq(onchainPoolTrades.networkId, networkId),
      eq(onchainPoolTrades.tokenAddress, normalizeAddress(tokenAddress)),
    ))
    .all()
    .map(toTradeRecord));
}
