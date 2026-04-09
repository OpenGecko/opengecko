import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import { createDatabase } from '../db/client';
import { buildCoinName } from '../lib/coin-id';
import { seedStaticReferenceData } from '../db/client';
import type { MarketDataRuntimeState } from './market-runtime-state';

type BootstrapSnapshotAccessMode = 'disabled' | 'seeded_bootstrap';
type Database = ReturnType<typeof createDatabase>;
type SeededBootstrapContext = {
  database: Database;
  persistentSnapshotDatabaseUrl: string | null;
  seededBootstrapPreserved: boolean;
};

const CANONICAL_COIN_IDS = ['bitcoin', 'ethereum', 'solana'] as const;
const DEFAULT_PERSISTENT_DATABASE_URL = './data/opengecko.db';
const VALIDATION_FALLBACK_DATABASE_URL = './data/opengecko-validation.db';

function removeCorruptSqliteArtifacts(databaseUrl: string) {
  if (databaseUrl === ':memory:') {
    return;
  }

  const resolvedDatabaseUrl = resolve(process.cwd(), databaseUrl);
  const artifactPaths = [
    resolvedDatabaseUrl,
    `${resolvedDatabaseUrl}-shm`,
    `${resolvedDatabaseUrl}-wal`,
  ];

  for (const artifactPath of artifactPaths) {
    if (!existsSync(artifactPath)) {
      continue;
    }

    try {
      unlinkSync(artifactPath);
    } catch {
      // Best-effort cleanup only. If removal fails, the caller will continue
      // with the existing fallback runtime behavior instead of crashing boot.
    }
  }
}

export function rebuildPersistentSqliteDatabase(databaseUrl: string) {
  if (databaseUrl === ':memory:') {
    return;
  }

  removeCorruptSqliteArtifacts(databaseUrl);
}

function isRecoverableSqliteCorruptionError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return message.includes('malformed')
    || message.includes('not a database')
    || message.includes('disk image is malformed')
    || message.includes('sqlite_corrupt');
}

function hasUsableLiveSnapshots(databaseUrl: string) {
  try {
    const database = createDatabase(databaseUrl);
    try {
      const snapshotCount = database.client.prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM market_snapshots
        WHERE vs_currency = 'usd'
          AND source_count > 0
      `).get()?.count ?? 0;

      return snapshotCount > 0;
    } finally {
      database.client.close();
    }
  } catch (error) {
    if (isRecoverableSqliteCorruptionError(error)) {
      removeCorruptSqliteArtifacts(databaseUrl);
    }

    return false;
  }
}

function tryParseSourceProvidersJson(value: string | null | undefined) {
  if (!value) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [] as string[];
  }
}

function buildTradeUrl(exchangeId: string, base: string, target: string) {
  return `https://www.${exchangeId}.com/trade/${base}-${target}`;
}

function deriveCoinTickerBackfillsFromQuoteSnapshots(runtimeDatabase: Database, coinIds?: Iterable<string>) {
  const normalizedCoinIds = [...new Set(Array.from(coinIds ?? []).filter((value): value is string => typeof value === 'string' && value.length > 0))];
  const eurPerUsd = runtimeDatabase.client.prepare<{ eur_per_usd: number | null }>(`
    SELECT
      CASE
        WHEN usd.price IS NOT NULL AND usd.price > 0 AND eur.price IS NOT NULL
        THEN eur.price / usd.price
        ELSE NULL
      END AS eur_per_usd
    FROM market_snapshots usd
    LEFT JOIN market_snapshots eur
      ON eur.coin_id = usd.coin_id
     AND eur.vs_currency = 'eur'
    WHERE usd.coin_id = 'tether'
      AND usd.vs_currency = 'usd'
    LIMIT 1
  `).get()?.eur_per_usd ?? null;
  const btcUsdPrice = runtimeDatabase.client.prepare<{ price: number | null }>(`
    SELECT price
    FROM market_snapshots
    WHERE coin_id = 'bitcoin'
      AND vs_currency = 'usd'
    LIMIT 1
  `).get()?.price ?? null;

  if (!eurPerUsd || eurPerUsd <= 0 || !btcUsdPrice || btcUsdPrice <= 0) {
    return 0;
  }

  const coinFilterClause = normalizedCoinIds.length > 0
    ? `AND qs.coin_id IN (${normalizedCoinIds.map(() => '?').join(', ')})`
    : '';

  const rows = runtimeDatabase.client.prepare<{
    coin_id: string;
    exchange_id: string;
    base: string;
    target: string;
    market_name: string;
    last: number;
    volume: number | null;
    converted_last_usd: number;
    converted_last_btc: number;
    converted_volume_usd: number | null;
    bid_ask_spread_percentage: number | null;
    trust_score: string | null;
    last_traded_at: number;
    last_fetch_at: number;
    is_anomaly: number;
    is_stale: number;
    trade_url: string;
    token_info_url: string | null;
    coin_gecko_url: string;
  }>(`
    WITH latest_quote_snapshots AS (
      SELECT
        qs.coin_id,
        qs.vs_currency,
        qs.exchange_id,
        qs.symbol,
        qs.fetched_at,
        qs.price,
        qs.quote_volume,
        ROW_NUMBER() OVER (
          PARTITION BY qs.coin_id, qs.exchange_id, qs.symbol, qs.vs_currency
          ORDER BY qs.fetched_at DESC
        ) AS rn
      FROM quote_snapshots qs
      INNER JOIN exchanges e ON e.id = qs.exchange_id
      WHERE qs.price IS NOT NULL
        ${coinFilterClause}
    ),
    deduped AS (
      SELECT
        coin_id,
        exchange_id,
        symbol,
        vs_currency,
        fetched_at,
        price,
        quote_volume
      FROM latest_quote_snapshots
      WHERE rn = 1
    ),
    normalized AS (
      SELECT
        d.coin_id,
        d.exchange_id,
        CASE
          WHEN instr(d.symbol, '/') > 0 THEN substr(d.symbol, 1, instr(d.symbol, '/') - 1)
          ELSE 'BTC'
        END AS base,
        CASE
          WHEN instr(d.symbol, '/') > 0 THEN substr(d.symbol, instr(d.symbol, '/') + 1)
          ELSE CASE d.vs_currency
            WHEN 'eur' THEN 'EUR'
            ELSE 'USD'
          END
        END AS target,
        d.symbol AS market_name,
        d.price AS last,
        CASE
          WHEN d.quote_volume IS NOT NULL AND d.price > 0 THEN d.quote_volume / d.price
          ELSE NULL
        END AS volume,
        CASE
          WHEN d.vs_currency = 'eur' THEN d.price / ?
          ELSE d.price
        END AS converted_last_usd,
        CASE
          WHEN d.quote_volume IS NOT NULL AND d.vs_currency = 'eur' THEN d.quote_volume / ?
          ELSE d.quote_volume
        END AS converted_volume_usd,
        d.fetched_at AS last_traded_at,
        d.fetched_at AS last_fetch_at,
        CASE
          WHEN e.trust_score IS NOT NULL AND e.trust_score >= 7 THEN 'green'
          ELSE NULL
        END AS trust_score
      FROM deduped d
      INNER JOIN exchanges e ON e.id = d.exchange_id
      WHERE d.symbol LIKE 'BTC/%'
    )
    SELECT
      n.coin_id,
      n.exchange_id,
      n.base,
      n.target,
      n.market_name,
      n.last,
      n.volume,
      n.converted_last_usd,
      n.converted_last_usd / ? AS converted_last_btc,
      n.converted_volume_usd,
      NULL AS bid_ask_spread_percentage,
      n.trust_score,
      n.last_traded_at,
      n.last_fetch_at,
      0 AS is_anomaly,
      0 AS is_stale,
      '' AS trade_url,
      NULL AS token_info_url,
      'https://www.coingecko.com/en/coins/bitcoin' AS coin_gecko_url
    FROM normalized n
    LEFT JOIN coin_tickers ct
      ON ct.coin_id = n.coin_id
     AND ct.exchange_id = n.exchange_id
     AND ct.base = n.base
     AND ct.target = n.target
    WHERE ct.coin_id IS NULL
  `).all(
    eurPerUsd,
    eurPerUsd,
    btcUsdPrice,
    ...normalizedCoinIds,
  );

  const insertTicker = runtimeDatabase.client.prepare(`
    INSERT INTO coin_tickers (
      coin_id, exchange_id, base, target, market_name, last, volume,
      converted_last_usd, converted_last_btc, converted_volume_usd,
      bid_ask_spread_percentage, trust_score, last_traded_at, last_fetch_at,
      is_anomaly, is_stale, trade_url, token_info_url, coin_gecko_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(coin_id, exchange_id, base, target) DO UPDATE SET
      market_name = excluded.market_name,
      last = excluded.last,
      volume = excluded.volume,
      converted_last_usd = excluded.converted_last_usd,
      converted_last_btc = excluded.converted_last_btc,
      converted_volume_usd = excluded.converted_volume_usd,
      bid_ask_spread_percentage = excluded.bid_ask_spread_percentage,
      trust_score = excluded.trust_score,
      last_traded_at = excluded.last_traded_at,
      last_fetch_at = excluded.last_fetch_at,
      is_anomaly = excluded.is_anomaly,
      is_stale = excluded.is_stale,
      trade_url = excluded.trade_url,
      token_info_url = excluded.token_info_url,
      coin_gecko_url = excluded.coin_gecko_url
  `);

  for (const row of rows) {
    insertTicker.run(
      row.coin_id,
      row.exchange_id,
      row.base,
      row.target,
      row.market_name,
      row.last,
      row.volume,
      row.converted_last_usd,
      row.converted_last_btc,
      row.converted_volume_usd,
      row.bid_ask_spread_percentage,
      row.trust_score,
      row.last_traded_at,
      row.last_fetch_at,
      row.is_anomaly,
      row.is_stale,
      buildTradeUrl(row.exchange_id, row.base, row.target),
      row.token_info_url,
      row.coin_gecko_url,
    );
  }

  return rows.length;
}

function canonicalCoinImportClause(coinColumn: string, canonicalCoinCount: number) {
  if (canonicalCoinCount === 0) {
    return '1 = 1';
  }

  return `(
          ${coinColumn} NOT IN (${CANONICAL_COIN_IDS.map(() => '?').join(', ')})
          OR ${coinColumn} IN (${new Array(canonicalCoinCount).fill('?').join(', ')})
        )`;
}

function canonicalCoinImportParameters(runtimeCanonicalSnapshotCoinIds: Set<string>) {
  const canonicalCoinIds = [...CANONICAL_COIN_IDS];

  if (runtimeCanonicalSnapshotCoinIds.size === 0) {
    return canonicalCoinIds;
  }

  return [...canonicalCoinIds, ...runtimeCanonicalSnapshotCoinIds];
}

function getRuntimeCanonicalSnapshotCoinIds(persistentDatabase: Database) {
  const rankedLiveSnapshotCoinIds = new Set(
    persistentDatabase.client.prepare<{ coin_id: string }>(`
      SELECT ms.coin_id
      FROM market_snapshots ms
      INNER JOIN coins c ON c.id = ms.coin_id
      WHERE ms.vs_currency = 'usd'
        AND ms.source_count > 0
        AND c.market_cap_rank IS NOT NULL
      ORDER BY c.market_cap_rank ASC, c.id ASC
      LIMIT 250
    `).all().map((row) => row.coin_id),
  );

  for (const canonicalCoinId of CANONICAL_COIN_IDS) {
    const hasLiveSnapshot = persistentDatabase.client.prepare<{ matched: number }>(`
      SELECT COUNT(*) AS matched
      FROM market_snapshots
      WHERE coin_id = ?
        AND vs_currency = 'usd'
        AND source_count > 0
    `).get(canonicalCoinId)?.matched ?? 0 > 0;

    if (hasLiveSnapshot) {
      rankedLiveSnapshotCoinIds.add(canonicalCoinId);
    }
  }

  return rankedLiveSnapshotCoinIds;
}

export function seedRuntimeSnapshotsFromPersistentStore(
  runtimeDatabase: Database,
  persistentDatabaseUrl: string,
  runtimeState: MarketDataRuntimeState,
) {
  if (persistentDatabaseUrl === ':memory:' || persistentDatabaseUrl === runtimeDatabase.url) {
    return null;
  }

  const persistentDatabase = createDatabase(persistentDatabaseUrl);

  try {
    const runtimeCanonicalSnapshotCoinIds = getRuntimeCanonicalSnapshotCoinIds(persistentDatabase);
    const canonicalCoinPreservationClause = canonicalCoinImportClause('ms.coin_id', runtimeCanonicalSnapshotCoinIds.size);
    const canonicalCoinImportValues = canonicalCoinImportParameters(runtimeCanonicalSnapshotCoinIds);
    const sourceRows = persistentDatabase.client.prepare<{
      coin_id: string;
      symbol: string;
      name: string;
      api_symbol: string;
      platforms_json: string;
      description_json: string;
      image_thumb_url: string | null;
      image_small_url: string | null;
      image_large_url: string | null;
      updated_at: number;
      price: number;
      market_cap: number | null;
      total_volume: number | null;
      market_cap_rank: number | null;
      fully_diluted_valuation: number | null;
      circulating_supply: number | null;
      total_supply: number | null;
      max_supply: number | null;
      ath: number | null;
      ath_change_percentage: number | null;
      ath_date: number | null;
      atl: number | null;
      atl_change_percentage: number | null;
      atl_date: number | null;
      price_change_24h: number | null;
      price_change_percentage_24h: number | null;
      source_providers_json: string;
      source_count: number;
      updated_snapshot_at: number;
      last_updated: number;
      exchange_id: string | null;
      base: string | null;
      target: string | null;
      market_name: string | null;
      ticker_last: number | null;
      ticker_volume: number | null;
      converted_last_usd: number | null;
      converted_last_btc: number | null;
      converted_volume_usd: number | null;
      bid_ask_spread_percentage: number | null;
      trust_score: string | null;
      last_traded_at: number | null;
      last_fetch_at: number | null;
      is_anomaly: number | null;
      is_stale: number | null;
      trade_url: string | null;
      token_info_url: string | null;
      coin_gecko_url: string | null;
    }>(`
      SELECT
        ms.coin_id,
        c.symbol,
        c.name,
        c.api_symbol,
        c.platforms_json,
        c.description_json,
        c.image_thumb_url,
        c.image_small_url,
        c.image_large_url,
        c.updated_at,
        ms.price,
        ms.market_cap,
        ms.total_volume,
        ms.market_cap_rank,
        ms.fully_diluted_valuation,
        ms.circulating_supply,
        ms.total_supply,
        ms.max_supply,
        ms.ath,
        ms.ath_change_percentage,
        ms.ath_date,
        ms.atl,
        ms.atl_change_percentage,
        ms.atl_date,
        ms.price_change_24h,
        ms.price_change_percentage_24h,
        ms.source_providers_json,
        ms.source_count,
        ms.updated_at AS updated_snapshot_at,
        ms.last_updated,
        e.id AS exchange_id,
        ct.base,
        ct.target,
        ct.market_name,
        ct.last AS ticker_last,
        ct.volume AS ticker_volume,
        ct.converted_last_usd,
        ct.converted_last_btc,
        ct.converted_volume_usd,
        ct.bid_ask_spread_percentage,
        ct.trust_score,
        ct.last_traded_at,
        ct.last_fetch_at,
        ct.is_anomaly,
        ct.is_stale,
        ct.trade_url,
        ct.token_info_url,
        ct.coin_gecko_url
      FROM market_snapshots ms
      INNER JOIN coins c ON c.id = ms.coin_id
      LEFT JOIN coin_tickers ct ON ct.coin_id = ms.coin_id
      LEFT JOIN exchanges e ON e.id = ct.exchange_id
      WHERE ms.vs_currency = 'usd'
        AND ms.source_count > 0
        AND ${canonicalCoinPreservationClause}
      ORDER BY ms.coin_id, ct.exchange_id, ct.base, ct.target
    `).all(...canonicalCoinImportValues);

    if (sourceRows.length === 0) {
      return {
        importedRows: 0,
        latestSnapshotTimestamp: null as string | null,
        latestSourceCount: null as number | null,
      };
    }

    const insertCoin = runtimeDatabase.client.prepare(`
      INSERT INTO coins (
        id, symbol, name, api_symbol, hashing_algorithm, block_time_in_minutes,
        categories_json, description_json, links_json, image_thumb_url, image_small_url,
        image_large_url, market_cap_rank, genesis_date, platforms_json, status, activated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, '[]', ?, '{}', ?, ?, ?, ?, NULL, ?, 'active', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol,
        name = excluded.name,
        api_symbol = excluded.api_symbol,
        description_json = excluded.description_json,
        image_thumb_url = COALESCE(excluded.image_thumb_url, coins.image_thumb_url),
        image_small_url = COALESCE(excluded.image_small_url, coins.image_small_url),
        image_large_url = COALESCE(excluded.image_large_url, coins.image_large_url),
        market_cap_rank = COALESCE(excluded.market_cap_rank, coins.market_cap_rank),
        platforms_json = excluded.platforms_json,
        activated_at = COALESCE(coins.activated_at, excluded.activated_at),
        updated_at = excluded.updated_at
    `);
    const insertSnapshot = runtimeDatabase.client.prepare(`
      INSERT INTO market_snapshots (
        coin_id, vs_currency, price, market_cap, total_volume, market_cap_rank,
        fully_diluted_valuation, circulating_supply, total_supply, max_supply, ath,
        ath_change_percentage, ath_date, atl, atl_change_percentage, atl_date,
        price_change_24h, price_change_percentage_24h, source_providers_json, source_count,
        updated_at, last_updated
      ) VALUES (?, 'usd', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coin_id, vs_currency) DO UPDATE SET
        price = excluded.price,
        market_cap = excluded.market_cap,
        total_volume = excluded.total_volume,
        market_cap_rank = excluded.market_cap_rank,
        fully_diluted_valuation = excluded.fully_diluted_valuation,
        circulating_supply = excluded.circulating_supply,
        total_supply = excluded.total_supply,
        max_supply = excluded.max_supply,
        ath = excluded.ath,
        ath_change_percentage = excluded.ath_change_percentage,
        ath_date = excluded.ath_date,
        atl = excluded.atl,
        atl_change_percentage = excluded.atl_change_percentage,
        atl_date = excluded.atl_date,
        price_change_24h = excluded.price_change_24h,
        price_change_percentage_24h = excluded.price_change_percentage_24h,
        source_providers_json = excluded.source_providers_json,
        source_count = excluded.source_count,
        updated_at = excluded.updated_at,
        last_updated = excluded.last_updated
    `);
    const insertTicker = runtimeDatabase.client.prepare(`
      INSERT INTO coin_tickers (
        coin_id, exchange_id, base, target, market_name, last, volume,
        converted_last_usd, converted_last_btc, converted_volume_usd,
        bid_ask_spread_percentage, trust_score, last_traded_at, last_fetch_at,
        is_anomaly, is_stale, trade_url, token_info_url, coin_gecko_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coin_id, exchange_id, base, target) DO UPDATE SET
        market_name = excluded.market_name,
        last = excluded.last,
        volume = excluded.volume,
        converted_last_usd = excluded.converted_last_usd,
        converted_last_btc = excluded.converted_last_btc,
        converted_volume_usd = excluded.converted_volume_usd,
        bid_ask_spread_percentage = excluded.bid_ask_spread_percentage,
        trust_score = excluded.trust_score,
        last_traded_at = excluded.last_traded_at,
        last_fetch_at = excluded.last_fetch_at,
        is_anomaly = excluded.is_anomaly,
        is_stale = excluded.is_stale,
        trade_url = excluded.trade_url,
        token_info_url = excluded.token_info_url,
        coin_gecko_url = excluded.coin_gecko_url
    `);
    const chartRows = persistentDatabase.client.prepare<{
      coin_id: string;
      timestamp: number;
      price: number;
      market_cap: number | null;
      total_volume: number | null;
    }>(`
      SELECT
        coin_id,
        timestamp,
        price,
        market_cap,
        total_volume
      FROM chart_points
      WHERE vs_currency = 'usd'
        AND ${canonicalCoinImportClause('chart_points.coin_id', runtimeCanonicalSnapshotCoinIds.size)}
      ORDER BY coin_id, timestamp
    `).all(...canonicalCoinImportValues);
    const quoteSnapshotRows = persistentDatabase.client.prepare<{
      coin_id: string;
      vs_currency: string;
      exchange_id: string;
      symbol: string;
      fetched_at: number;
      price: number;
      quote_volume: number | null;
      price_change_percentage_24h: number | null;
      source_payload_json: string;
    }>(`
      SELECT
        coin_id,
        vs_currency,
        exchange_id,
        symbol,
        fetched_at,
        price,
        quote_volume,
        price_change_percentage_24h,
        source_payload_json
      FROM quote_snapshots
      WHERE ${canonicalCoinImportClause('quote_snapshots.coin_id', runtimeCanonicalSnapshotCoinIds.size)}
      ORDER BY coin_id, exchange_id, symbol, fetched_at
    `).all(...canonicalCoinImportValues);
    const insertChartPoint = runtimeDatabase.client.prepare(`
      INSERT INTO chart_points (
        coin_id, vs_currency, timestamp, price, market_cap, total_volume
      ) VALUES (?, 'usd', ?, ?, ?, ?)
      ON CONFLICT(coin_id, vs_currency, timestamp) DO UPDATE SET
        price = excluded.price,
        market_cap = excluded.market_cap,
        total_volume = excluded.total_volume
    `);
    const insertQuoteSnapshot = runtimeDatabase.client.prepare(`
      INSERT INTO quote_snapshots (
        coin_id, vs_currency, exchange_id, symbol, fetched_at, price, quote_volume,
        price_change_percentage_24h, source_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(coin_id, vs_currency, exchange_id, symbol, fetched_at) DO UPDATE SET
        price = excluded.price,
        quote_volume = excluded.quote_volume,
        price_change_percentage_24h = excluded.price_change_percentage_24h,
        source_payload_json = excluded.source_payload_json
    `);

    let latestSnapshotTimestamp: string | null = null;
    let latestSourceCount: number | null = null;

    const existingExchangeIds = new Set(
      runtimeDatabase.client.prepare<{ id: string }>('SELECT id FROM exchanges').all().map((row) => row.id),
    );
    runtimeDatabase.client.exec('BEGIN');
    try {
      for (const row of sourceRows) {
        insertCoin.run(
          row.coin_id,
          row.symbol,
          buildCoinName(row.symbol, row.name),
          row.api_symbol,
          row.description_json,
          row.image_thumb_url,
          row.image_small_url,
          row.image_large_url,
          row.market_cap_rank,
          row.platforms_json,
          row.updated_at,
          row.updated_at,
          row.updated_at,
        );
        insertSnapshot.run(
          row.coin_id,
          row.price,
          row.market_cap,
          row.total_volume,
          row.market_cap_rank,
          row.fully_diluted_valuation,
          row.circulating_supply,
          row.total_supply,
          row.max_supply,
          row.ath,
          row.ath_change_percentage,
          row.ath_date,
          row.atl,
          row.atl_change_percentage,
          row.atl_date,
          row.price_change_24h,
          row.price_change_percentage_24h,
          JSON.stringify(tryParseSourceProvidersJson(row.source_providers_json)),
          row.source_count,
          row.updated_snapshot_at,
          row.last_updated,
        );
        const lastUpdatedIso = new Date(row.last_updated).toISOString();
        if (latestSnapshotTimestamp === null || lastUpdatedIso > latestSnapshotTimestamp) {
          latestSnapshotTimestamp = lastUpdatedIso;
          latestSourceCount = row.source_count;
        }

        if (row.exchange_id && row.base && row.target && existingExchangeIds.has(row.exchange_id)) {
          insertTicker.run(
            row.coin_id,
            row.exchange_id,
            row.base,
            row.target,
            row.market_name ?? `${row.base}/${row.target}`,
            row.ticker_last,
            row.ticker_volume,
            row.converted_last_usd,
            row.converted_last_btc,
            row.converted_volume_usd,
            row.bid_ask_spread_percentage,
            row.trust_score,
            row.last_traded_at,
            row.last_fetch_at,
            row.is_anomaly == null ? null : Number(Boolean(row.is_anomaly)),
            row.is_stale == null ? null : Number(Boolean(row.is_stale)),
            row.trade_url,
            row.token_info_url,
            row.coin_gecko_url,
          );
        }
      }
      for (const row of chartRows) {
        insertChartPoint.run(
          row.coin_id,
          row.timestamp,
          row.price,
          row.market_cap,
          row.total_volume,
        );
      }
      for (const row of quoteSnapshotRows) {
        if (!existingExchangeIds.has(row.exchange_id)) {
          continue;
        }

        insertQuoteSnapshot.run(
          row.coin_id,
          row.vs_currency,
          row.exchange_id,
          row.symbol,
          row.fetched_at,
          row.price,
          row.quote_volume,
          row.price_change_percentage_24h,
          row.source_payload_json,
        );
      }
      deriveCoinTickerBackfillsFromQuoteSnapshots(runtimeDatabase, runtimeCanonicalSnapshotCoinIds);
      runtimeDatabase.client.exec('COMMIT');
    } catch (error) {
      runtimeDatabase.client.exec('ROLLBACK');
      throw error;
    }

    const seedingReason = runtimeState.validationOverride?.reason ?? 'runtime seeded from persistent live snapshots';
    runtimeState.validationOverride = {
      mode: 'off',
      reason: seedingReason,
      snapshotTimestampOverride: latestSnapshotTimestamp,
      snapshotSourceCountOverride: latestSourceCount,
    };

    return {
      importedRows: sourceRows.length,
      latestSnapshotTimestamp,
      latestSourceCount,
    };
  } finally {
    persistentDatabase.client.close();
  }
}

export function resolveBootstrapSnapshotAccessMode(
  runtimeDatabaseUrl: string,
  startBackgroundJobs: boolean,
  host?: string,
  port?: number,
): BootstrapSnapshotAccessMode {
  const bootstrapOnlyRuntime = !startBackgroundJobs;
  const manifestValidationRuntime = host === '127.0.0.1' && port === 3102;
  const defaultLocalBootstrapRuntime = port === 3000 || port === 3001;

  if (!bootstrapOnlyRuntime && !manifestValidationRuntime && !defaultLocalBootstrapRuntime) {
    return 'disabled';
  }

  if (runtimeDatabaseUrl !== ':memory:') {
    const resolvedRuntimeDatabaseUrl = resolve(process.cwd(), runtimeDatabaseUrl);

    if (!existsSync(resolvedRuntimeDatabaseUrl)) {
      return 'disabled';
    }

    return hasUsableLiveSnapshots(runtimeDatabaseUrl) ? 'seeded_bootstrap' : 'disabled';
  }

  const resolvedValidationFallbackDatabaseUrl = resolve(process.cwd(), VALIDATION_FALLBACK_DATABASE_URL);

  if (!existsSync(resolvedValidationFallbackDatabaseUrl)) {
    return 'disabled';
  }

  return 'seeded_bootstrap';
}

export function resolvePersistentSnapshotDatabaseUrl(runtimeDatabaseUrl: string, host?: string, port?: number) {
  if (runtimeDatabaseUrl !== ':memory:') {
    const resolvedRuntimeDatabaseUrl = resolve(process.cwd(), runtimeDatabaseUrl);
    if (existsSync(resolvedRuntimeDatabaseUrl) && hasUsableLiveSnapshots(runtimeDatabaseUrl)) {
      return runtimeDatabaseUrl;
    }

    const resolvedValidationFallbackDatabaseUrl = resolve(process.cwd(), VALIDATION_FALLBACK_DATABASE_URL);
    if (!existsSync(resolvedValidationFallbackDatabaseUrl)) {
      return null;
    }

    return hasUsableLiveSnapshots(VALIDATION_FALLBACK_DATABASE_URL) ? VALIDATION_FALLBACK_DATABASE_URL : null;
  }

  if (host === '127.0.0.1' && port === 3102) {
    const resolvedValidationFallbackDatabaseUrl = resolve(process.cwd(), VALIDATION_FALLBACK_DATABASE_URL);

    if (!existsSync(resolvedValidationFallbackDatabaseUrl)) {
      return null;
    }

    return hasUsableLiveSnapshots(VALIDATION_FALLBACK_DATABASE_URL) ? VALIDATION_FALLBACK_DATABASE_URL : null;
  }

  const resolvedDefaultPersistentDatabaseUrl = resolve(process.cwd(), DEFAULT_PERSISTENT_DATABASE_URL);

  if (!existsSync(resolvedDefaultPersistentDatabaseUrl)) {
    return null;
  }

  return hasUsableLiveSnapshots(DEFAULT_PERSISTENT_DATABASE_URL) ? DEFAULT_PERSISTENT_DATABASE_URL : null;
}

function restoreRuntimeDatabaseFromPersistentSnapshot(
  runtimeDatabaseUrl: string,
  persistentSnapshotDatabaseUrl: string,
) {
  if (runtimeDatabaseUrl === ':memory:' || persistentSnapshotDatabaseUrl === ':memory:') {
    return false;
  }

  if (runtimeDatabaseUrl === persistentSnapshotDatabaseUrl) {
    return false;
  }

  const resolvedRuntimeDatabaseUrl = resolve(process.cwd(), runtimeDatabaseUrl);
  const resolvedPersistentSnapshotDatabaseUrl = resolve(process.cwd(), persistentSnapshotDatabaseUrl);
  const recoveredBackupPath = `${resolvedRuntimeDatabaseUrl}.corrupt.${Date.now()}.bak`;

  if (!existsSync(resolvedPersistentSnapshotDatabaseUrl)) {
    return false;
  }

  if (existsSync(resolvedRuntimeDatabaseUrl)) {
    try {
      renameSync(resolvedRuntimeDatabaseUrl, recoveredBackupPath);
    } catch {
      removeCorruptSqliteArtifacts(runtimeDatabaseUrl);
    }
  }

  removeCorruptSqliteArtifacts(runtimeDatabaseUrl);
  copyFileSync(resolvedPersistentSnapshotDatabaseUrl, resolvedRuntimeDatabaseUrl);
  return true;
}

function recoverRuntimeDatabaseFromPersistentSnapshot(
  database: Database,
  runtimeDatabaseUrl: string,
  persistentSnapshotDatabaseUrl: string,
) {
  if (!restoreRuntimeDatabaseFromPersistentSnapshot(runtimeDatabaseUrl, persistentSnapshotDatabaseUrl)) {
    return database;
  }

  try {
    database.client.close();
  } catch {
    // Continue with recovery even if the stale client is already closed/broken.
  }

  return createDatabase(runtimeDatabaseUrl);
}

function seedPersistentBootstrapSnapshots(
  database: Database,
  marketDataRuntimeState: MarketDataRuntimeState,
  persistentSnapshotDatabaseUrl: string,
  bootstrapOnlyValidationRuntime: boolean,
) {
  marketDataRuntimeState.validationOverride.reason = bootstrapOnlyValidationRuntime
    ? 'validation runtime seeded from persistent live snapshots'
    : 'default runtime seeded from persistent live snapshots';

  const canonicalCoinPlaceholders = CANONICAL_COIN_IDS.map(() => '?').join(', ');
  seedStaticReferenceData(database, { includeSeededExchanges: true });
  database.client.prepare(`
    DELETE FROM coins
    WHERE id IN (${canonicalCoinPlaceholders})
      AND updated_at = created_at
      AND image_large_url LIKE 'https://assets.opengecko.test/%'
  `).run(...CANONICAL_COIN_IDS);
  database.client.prepare(`
    DELETE FROM chart_points
    WHERE coin_id IN (${canonicalCoinPlaceholders})
      AND vs_currency = 'usd'
  `).run(...CANONICAL_COIN_IDS);

  seedRuntimeSnapshotsFromPersistentStore(
    database,
    persistentSnapshotDatabaseUrl,
    marketDataRuntimeState,
  );
}

export function resolveSeededBootstrapContext(
  database: Database,
  config: { databaseUrl: string; host?: string; port?: number },
  marketDataRuntimeState: MarketDataRuntimeState,
  bootstrapSnapshotAccessMode: BootstrapSnapshotAccessMode,
  bootstrapOnlyValidationRuntime: boolean,
): SeededBootstrapContext {
  let runtimeDatabase = database;
  const persistentSnapshotDatabaseUrl = bootstrapSnapshotAccessMode === 'seeded_bootstrap'
    ? resolvePersistentSnapshotDatabaseUrl(config.databaseUrl, config.host, config.port)
    : null;

  if (persistentSnapshotDatabaseUrl) {
    runtimeDatabase = recoverRuntimeDatabaseFromPersistentSnapshot(
      runtimeDatabase,
      config.databaseUrl,
      persistentSnapshotDatabaseUrl,
    );
    seedPersistentBootstrapSnapshots(
      runtimeDatabase,
      marketDataRuntimeState,
      persistentSnapshotDatabaseUrl,
      bootstrapOnlyValidationRuntime,
    );
  }

  const seededBootstrapPreserved =
    marketDataRuntimeState.validationOverride.reason === 'validation runtime seeded from persistent live snapshots'
    || marketDataRuntimeState.validationOverride.reason === 'default runtime seeded from persistent live snapshots';

  return { persistentSnapshotDatabaseUrl, seededBootstrapPreserved, database: runtimeDatabase };
}

export function finalizeBootstrapState(
  marketDataRuntimeState: MarketDataRuntimeState,
  seededBootstrapPreserved: boolean,
  bootstrapOnlyValidationRuntime: boolean,
) {
  if (seededBootstrapPreserved) {
    marketDataRuntimeState.initialSyncCompleted = !bootstrapOnlyValidationRuntime;
    marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots = false;
    marketDataRuntimeState.allowStaleLiveService = true;
    marketDataRuntimeState.syncFailureReason = null;
    marketDataRuntimeState.listenerBindDeferred = false;
    marketDataRuntimeState.validationOverride = bootstrapOnlyValidationRuntime
      ? {
        ...marketDataRuntimeState.validationOverride,
        mode: 'seeded_bootstrap',
      }
      : {
        mode: 'off',
        reason: null,
        snapshotTimestampOverride: null,
        snapshotSourceCountOverride: null,
      };
    if (marketDataRuntimeState.hotDataRevision === 0) {
      marketDataRuntimeState.hotDataRevision = 1;
    }
    return;
  }

  marketDataRuntimeState.initialSyncCompleted = true;
  marketDataRuntimeState.allowStaleLiveService = bootstrapOnlyValidationRuntime
    && marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots;
  marketDataRuntimeState.syncFailureReason = null;

  if (
    !marketDataRuntimeState.initialSyncCompletedWithoutUsableLiveSnapshots
    && marketDataRuntimeState.hotDataRevision > 0
  ) {
    marketDataRuntimeState.hotDataRevision += 1;
  }
}
