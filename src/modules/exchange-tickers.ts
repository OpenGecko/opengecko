import { and, asc, eq, inArray } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { coinTickers, coins, exchanges, marketSnapshots, type ExchangeRow } from '../db/schema';
import { HttpError } from '../http/errors';
import { getConversionRates } from '../lib/conversion';
import { parseJsonObject, sortNumber } from '../lib/shared';
import type { MarketDataRuntimeState } from '../services/market-runtime-state';
import { getCoinById } from './catalog';
import { getSnapshotAccessPolicy } from './market-freshness';

type ExchangeTickerRow = {
  coin_tickers: typeof coinTickers.$inferSelect;
  exchanges: ExchangeRow;
};

export function formatTickerAsset(database: AppDatabase, symbol: string, coinId: string | null, dexPairFormat: string) {
  if (dexPairFormat !== 'contract_address' || !coinId) {
    return symbol;
  }

  const coin = getCoinById(database, coinId);

  if (!coin) {
    return symbol;
  }

  return Object.values(parseJsonObject<Record<string, string>>(coin.platformsJson))[0] ?? symbol;
}

export function resolveTargetCoinId(database: AppDatabase, targetSymbol: string) {
  const normalizedTarget = targetSymbol.trim().toLowerCase();

  if (normalizedTarget.length === 0) {
    return null;
  }

  const canonicalStablecoinOverrides: Record<string, string> = {
    usdt: 'tether',
    usdc: 'usd-coin',
    usd1: 'usd1',
  };

  const canonicalFiatTargets = new Set([
    'usd',
    'eur',
    'jpy',
    'gbp',
    'brl',
    'try',
    'idr',
    'aud',
    'cad',
    'uah',
    'zar',
    'ngn',
    'rub',
    'ars',
    'mxn',
    'pln',
    'czk',
    'chf',
    'sek',
    'nok',
    'dkk',
    'hkd',
    'sgd',
    'inr',
    'krw',
    'cny',
    'twd',
    'aed',
    'sar',
    'thb',
    'vnd',
    'php',
    'myr',
  ]);

  const override = canonicalStablecoinOverrides[normalizedTarget];

  if (override) {
    return override;
  }

  if (canonicalFiatTargets.has(normalizedTarget)) {
    return null;
  }

  const coin = database.db.select().from(coins).where(eq(coins.symbol, normalizedTarget)).orderBy(asc(coins.marketCapRank), asc(coins.id)).limit(1).get();

  return coin?.id ?? null;
}

function resolveCoinMarketCapUsd(database: AppDatabase, coinId: string | null) {
  if (!coinId) {
    return null;
  }

  const rows = database.db.select().from(marketSnapshots).where(and(eq(marketSnapshots.coinId, coinId), eq(marketSnapshots.vsCurrency, 'usd'))).all();

  return rows[0]?.marketCap ?? null;
}

function buildCoinTickerIdentity(row: ExchangeTickerRow) {
  return `${row.coin_tickers.exchangeId}:${row.coin_tickers.base}:${row.coin_tickers.target}`;
}

function dedupeExchangeTickerRows(rows: ExchangeTickerRow[]) {
  const rowsByIdentity = new Map<string, ExchangeTickerRow>();

  for (const row of rows) {
    const identity = buildCoinTickerIdentity(row);
    const existing = rowsByIdentity.get(identity);

    if (!existing) {
      rowsByIdentity.set(identity, row);
      continue;
    }

    const existingCoinRank = sortNumber(existing.coin_tickers.convertedVolumeUsd, -1);
    const currentCoinRank = sortNumber(row.coin_tickers.convertedVolumeUsd, -1);

    if (currentCoinRank > existingCoinRank) {
      rowsByIdentity.set(identity, row);
      continue;
    }

    if (currentCoinRank === existingCoinRank && row.coin_tickers.coinId.localeCompare(existing.coin_tickers.coinId) < 0) {
      rowsByIdentity.set(identity, row);
    }
  }

  return [...rowsByIdentity.values()];
}

export function getRawExchangeTickerRows(database: AppDatabase, exchangeId: string, coinIds?: string[]): ExchangeTickerRow[] {
  const whereCondition = coinIds?.length
    ? and(eq(coinTickers.exchangeId, exchangeId), inArray(coinTickers.coinId, coinIds))
    : eq(coinTickers.exchangeId, exchangeId);

  return database.db
    .select()
    .from(coinTickers)
    .innerJoin(exchanges, eq(exchanges.id, coinTickers.exchangeId))
    .where(whereCondition)
    .all();
}

function getExchangeTickerRows(database: AppDatabase, exchangeId: string, coinIds?: string[]): ExchangeTickerRow[] {
  return dedupeExchangeTickerRows(getRawExchangeTickerRows(database, exchangeId, coinIds));
}

function sortExchangeTickerRows(
  rows: ReturnType<typeof getExchangeTickerRows>,
  order: string | undefined,
) {
  const normalizedOrder = (order ?? 'volume_desc').toLowerCase();
  const sortableRows = [...rows];
  const compareByTimestampDesc = (left: ExchangeTickerRow, right: ExchangeTickerRow) => {
    const lastTradeDelta = sortNumber(right.coin_tickers.lastTradedAt?.getTime(), -1) - sortNumber(left.coin_tickers.lastTradedAt?.getTime(), -1);

    if (lastTradeDelta !== 0) {
      return lastTradeDelta;
    }

    return `${left.coin_tickers.base}/${left.coin_tickers.target}`.localeCompare(`${right.coin_tickers.base}/${right.coin_tickers.target}`);
  };
  const compareByVolumeDesc = (left: ExchangeTickerRow, right: ExchangeTickerRow) => {
    const volumeDelta = sortNumber(right.coin_tickers.convertedVolumeUsd, -1) - sortNumber(left.coin_tickers.convertedVolumeUsd, -1);

    if (volumeDelta !== 0) {
      return volumeDelta;
    }

    const lastTradeDelta = sortNumber(right.coin_tickers.lastTradedAt?.getTime(), -1) - sortNumber(left.coin_tickers.lastTradedAt?.getTime(), -1);

    if (lastTradeDelta !== 0) {
      return lastTradeDelta;
    }

    return `${left.coin_tickers.base}/${left.coin_tickers.target}`.localeCompare(`${right.coin_tickers.base}/${right.coin_tickers.target}`);
  };

  switch (normalizedOrder) {
    case 'trust_score_desc':
      return sortableRows.sort(compareByTimestampDesc);
    case 'volume_desc':
      return sortableRows.sort(compareByVolumeDesc);
    case 'volume_asc':
      return sortableRows.sort((left, right) => sortNumber(left.coin_tickers.convertedVolumeUsd, Number.MAX_SAFE_INTEGER) - sortNumber(right.coin_tickers.convertedVolumeUsd, Number.MAX_SAFE_INTEGER));
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported order value: ${order}`);
  }
}

function buildExchangeTickerPayload(
  database: AppDatabase,
  row: ReturnType<typeof getExchangeTickerRows>[number],
  conversionRates: ReturnType<typeof getConversionRates>,
  options: {
    includeExchangeLogo: boolean;
    includeDepth: boolean;
    dexPairFormat: string;
  },
) {
  return {
    base: formatTickerAsset(database, row.coin_tickers.base, row.coin_tickers.coinId, options.dexPairFormat),
    target: row.coin_tickers.target,
    market: {
      name: row.exchanges.name,
      identifier: row.exchanges.id,
      has_trading_incentive: row.exchanges.hasTradingIncentive,
      ...(options.includeExchangeLogo ? { logo: row.exchanges.imageUrl } : {}),
    },
    last: row.coin_tickers.last,
    volume: row.coin_tickers.volume,
    converted_last: {
      btc: row.coin_tickers.convertedLastUsd === null ? null : row.coin_tickers.convertedLastUsd * conversionRates.btc,
      usd: row.coin_tickers.convertedLastUsd,
      eth: row.coin_tickers.convertedLastUsd === null ? null : row.coin_tickers.convertedLastUsd * conversionRates.eth,
    },
    converted_volume: {
      btc: row.coin_tickers.convertedVolumeUsd === null ? null : row.coin_tickers.convertedVolumeUsd * conversionRates.btc,
      usd: row.coin_tickers.convertedVolumeUsd,
      eth: row.coin_tickers.convertedVolumeUsd === null ? null : row.coin_tickers.convertedVolumeUsd * conversionRates.eth,
    },
    trust_score: row.coin_tickers.trustScore,
    bid_ask_spread_percentage: row.coin_tickers.bidAskSpreadPercentage,
    timestamp: row.coin_tickers.lastTradedAt?.getTime() ?? null,
    last_traded_at: row.coin_tickers.lastTradedAt?.toISOString() ?? null,
    last_fetch_at: row.coin_tickers.lastFetchAt?.toISOString() ?? null,
    is_anomaly: row.coin_tickers.isAnomaly,
    is_stale: row.coin_tickers.isStale,
    trade_url: row.coin_tickers.tradeUrl,
    token_info_url: row.coin_tickers.tokenInfoUrl,
    ...(options.includeDepth
      ? {
          cost_to_move_up_usd: row.coin_tickers.convertedVolumeUsd === null ? null : Number((row.coin_tickers.convertedVolumeUsd * 0.001).toFixed(2)),
          cost_to_move_down_usd: row.coin_tickers.convertedVolumeUsd === null ? null : Number((row.coin_tickers.convertedVolumeUsd * 0.0008).toFixed(2)),
        }
      : {}),
    coin_id: row.coin_tickers.coinId,
    target_coin_id: resolveTargetCoinId(database, row.coin_tickers.target),
    coin_mcap_usd: resolveCoinMarketCapUsd(database, row.coin_tickers.coinId),
  };
}

export function getExchangeTickers(
  database: AppDatabase,
  exchangeId: string,
  options: {
    coinIds?: string[];
    includeExchangeLogo: boolean;
    includeDepth: boolean;
    page: number;
    order?: string;
    dexPairFormat: string;
    marketFreshnessThresholdSeconds: number;
    runtimeState: MarketDataRuntimeState;
  },
) {
  const perPage = 100;
  const rows = sortExchangeTickerRows(getExchangeTickerRows(database, exchangeId, options.coinIds), options.order);
  const start = (options.page - 1) * perPage;
  const conversionRates = getConversionRates(
    database,
    options.marketFreshnessThresholdSeconds,
    getSnapshotAccessPolicy(options.runtimeState),
  );

  return rows.slice(start, start + perPage).map((row) => buildExchangeTickerPayload(database, row, conversionRates, {
    includeExchangeLogo: options.includeExchangeLogo,
    includeDepth: options.includeDepth,
    dexPairFormat: options.dexPairFormat,
  }));
}
