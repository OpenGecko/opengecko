import { and, eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { coinHistorySnapshots, type MarketSnapshotRow } from '../db/schema';

export type CoinHistorySourceKind = 'replay' | 'live';

export type RawCoinHistoryReplay = {
  provider: string;
  captured_at: string;
  coin_id: string;
  date: string;
  vs_currency?: string;
  market_data: {
    current_price: number | string;
    market_cap?: number | string | null;
    total_volume?: number | string | null;
    market_cap_rank?: number | string | null;
    fully_diluted_valuation?: number | string | null;
    circulating_supply?: number | string | null;
    total_supply?: number | string | null;
    max_supply?: number | string | null;
    ath?: number | string | null;
    ath_change_percentage?: number | string | null;
    ath_date?: string | null;
    atl?: number | string | null;
    atl_change_percentage?: number | string | null;
    atl_date?: string | null;
    price_change_24h?: number | string | null;
    price_change_percentage_24h?: number | string | null;
    last_updated?: string | null;
  };
};

export type IngestCoinHistoryOptions = {
  sourceKind?: CoinHistorySourceKind;
  sourceProvider?: string | null;
  sourceFetchedAt?: Date;
};

function parseRequiredNumber(value: number | string | null | undefined, field: string) {
  const parsed = parseOptionalNumber(value, field);

  if (parsed === null) {
    throw new Error(`Missing coin history field: ${field}`);
  }

  return parsed;
}

function parseOptionalNumber(value: number | string | null | undefined, field: string) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid coin history field: ${field}`);
  }

  return parsed;
}

function parseOptionalInteger(value: number | string | null | undefined, field: string) {
  const parsed = parseOptionalNumber(value, field);

  if (parsed === null) {
    return null;
  }

  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid coin history integer field: ${field}`);
  }

  return parsed;
}

function parseTimestamp(value: string | null | undefined, field: string) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid coin history timestamp: ${field}`);
  }

  return new Date(timestamp);
}

function parseRequiredTimestamp(value: string, field: string) {
  const timestamp = parseTimestamp(value, field);

  if (!timestamp) {
    throw new Error(`Missing coin history field: ${field}`);
  }

  return timestamp;
}

function parseSnapshotDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    throw new Error(`Invalid coin history date: ${value}`);
  }

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid coin history date: ${value}`);
  }

  return date;
}

export function normalizeCoinHistoryReplay(raw: RawCoinHistoryReplay) {
  const coinId = raw.coin_id.trim().toLowerCase();
  const vsCurrency = (raw.vs_currency ?? 'usd').trim().toLowerCase();
  const capturedAt = parseRequiredTimestamp(raw.captured_at, 'captured_at');
  const snapshotAt = parseSnapshotDate(raw.date);

  if (!coinId) {
    throw new Error('Missing coin history field: coin_id');
  }

  if (!vsCurrency) {
    throw new Error('Missing coin history field: vs_currency');
  }

  return {
    coinId,
    vsCurrency,
    snapshotAt,
    capturedAt,
    price: parseRequiredNumber(raw.market_data.current_price, 'market_data.current_price'),
    marketCap: parseOptionalNumber(raw.market_data.market_cap, 'market_data.market_cap'),
    totalVolume: parseOptionalNumber(raw.market_data.total_volume, 'market_data.total_volume'),
    marketCapRank: parseOptionalInteger(raw.market_data.market_cap_rank, 'market_data.market_cap_rank'),
    fullyDilutedValuation: parseOptionalNumber(raw.market_data.fully_diluted_valuation, 'market_data.fully_diluted_valuation'),
    circulatingSupply: parseOptionalNumber(raw.market_data.circulating_supply, 'market_data.circulating_supply'),
    totalSupply: parseOptionalNumber(raw.market_data.total_supply, 'market_data.total_supply'),
    maxSupply: parseOptionalNumber(raw.market_data.max_supply, 'market_data.max_supply'),
    ath: parseOptionalNumber(raw.market_data.ath, 'market_data.ath'),
    athChangePercentage: parseOptionalNumber(raw.market_data.ath_change_percentage, 'market_data.ath_change_percentage'),
    athDate: parseTimestamp(raw.market_data.ath_date, 'market_data.ath_date'),
    atl: parseOptionalNumber(raw.market_data.atl, 'market_data.atl'),
    atlChangePercentage: parseOptionalNumber(raw.market_data.atl_change_percentage, 'market_data.atl_change_percentage'),
    atlDate: parseTimestamp(raw.market_data.atl_date, 'market_data.atl_date'),
    priceChange24h: parseOptionalNumber(raw.market_data.price_change_24h, 'market_data.price_change_24h'),
    priceChangePercentage24h: parseOptionalNumber(raw.market_data.price_change_percentage_24h, 'market_data.price_change_percentage_24h'),
    lastUpdated: parseTimestamp(raw.market_data.last_updated, 'market_data.last_updated') ?? snapshotAt,
  };
}

export function ingestCoinHistoryReplay(
  database: AppDatabase,
  raw: RawCoinHistoryReplay,
  options: IngestCoinHistoryOptions = {},
) {
  const normalized = normalizeCoinHistoryReplay(raw);
  const sourceKind = options.sourceKind ?? 'replay';
  const sourceProvider = options.sourceProvider ?? (raw.provider.trim() || 'unknown');
  const sourceFetchedAt = options.sourceFetchedAt ?? normalized.capturedAt;
  const rawPayloadJson = JSON.stringify(raw);

  database.db
    .insert(coinHistorySnapshots)
    .values({
      ...normalized,
      sourceKind,
      sourceProvider,
      sourceFetchedAt,
      rawPayloadJson,
      updatedAt: sourceFetchedAt,
    })
    .onConflictDoUpdate({
      target: [
        coinHistorySnapshots.coinId,
        coinHistorySnapshots.vsCurrency,
        coinHistorySnapshots.snapshotAt,
        coinHistorySnapshots.sourceKind,
        coinHistorySnapshots.sourceProvider,
      ],
      set: {
        price: normalized.price,
        marketCap: normalized.marketCap,
        totalVolume: normalized.totalVolume,
        marketCapRank: normalized.marketCapRank,
        fullyDilutedValuation: normalized.fullyDilutedValuation,
        circulatingSupply: normalized.circulatingSupply,
        totalSupply: normalized.totalSupply,
        maxSupply: normalized.maxSupply,
        ath: normalized.ath,
        athChangePercentage: normalized.athChangePercentage,
        athDate: normalized.athDate,
        atl: normalized.atl,
        atlChangePercentage: normalized.atlChangePercentage,
        atlDate: normalized.atlDate,
        priceChange24h: normalized.priceChange24h,
        priceChangePercentage24h: normalized.priceChangePercentage24h,
        sourceFetchedAt,
        rawPayloadJson,
        updatedAt: sourceFetchedAt,
        lastUpdated: normalized.lastUpdated,
      },
    })
    .run();

  return {
    coin_id: normalized.coinId,
    vs_currency: normalized.vsCurrency,
    snapshot_at: normalized.snapshotAt.toISOString(),
    snapshots_written: 1,
    source_kind: sourceKind,
    source_provider: sourceProvider,
    source_fetched_at: sourceFetchedAt.toISOString(),
  };
}

function toMarketSnapshotRow(row: typeof coinHistorySnapshots.$inferSelect): MarketSnapshotRow {
  return {
    coinId: row.coinId,
    vsCurrency: row.vsCurrency,
    price: row.price,
    marketCap: row.marketCap,
    totalVolume: row.totalVolume,
    marketCapRank: row.marketCapRank,
    fullyDilutedValuation: row.fullyDilutedValuation,
    circulatingSupply: row.circulatingSupply,
    totalSupply: row.totalSupply,
    maxSupply: row.maxSupply,
    ath: row.ath,
    athChangePercentage: row.athChangePercentage,
    athDate: row.athDate,
    atl: row.atl,
    atlChangePercentage: row.atlChangePercentage,
    atlDate: row.atlDate,
    priceChange24h: row.priceChange24h,
    priceChangePercentage24h: row.priceChangePercentage24h,
    sourceProvidersJson: JSON.stringify([row.sourceProvider]),
    sourceCount: 1,
    updatedAt: row.updatedAt,
    lastUpdated: row.lastUpdated,
  };
}

export function getSourceBackedCoinHistorySnapshot(
  database: AppDatabase,
  coinId: string,
  targetDate: number,
  vsCurrency = 'usd',
) {
  const rows = database.db
    .select()
    .from(coinHistorySnapshots)
    .where(and(
      eq(coinHistorySnapshots.coinId, coinId),
      eq(coinHistorySnapshots.vsCurrency, vsCurrency),
      eq(coinHistorySnapshots.snapshotAt, new Date(targetDate)),
    ))
    .all();
  const row = rows.sort((left, right) => {
    const sourceRankDelta = (right.sourceKind === 'live' ? 1 : 0) - (left.sourceKind === 'live' ? 1 : 0);

    if (sourceRankDelta !== 0) {
      return sourceRankDelta;
    }

    return (right.sourceFetchedAt?.getTime() ?? 0) - (left.sourceFetchedAt?.getTime() ?? 0);
  })[0];

  return row ? toMarketSnapshotRow(row) : null;
}
