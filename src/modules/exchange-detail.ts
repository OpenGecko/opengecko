import { eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { exchanges, type ExchangeRow } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseJsonArray } from '../lib/shared';

const EXCHANGE_ID_ALIASES: Record<string, string> = {
  bybit: 'bybit_spot',
  coinbase: 'gdax',
  okx: 'okex',
};

export function resolveExchangeRouteId(database: AppDatabase, exchangeId: string) {
  const normalizedExchangeId = exchangeId.trim().toLowerCase();
  const exactExchange = database.db.select().from(exchanges).where(eq(exchanges.id, normalizedExchangeId)).limit(1).get();

  if (exactExchange) {
    return exactExchange.id;
  }

  const aliasedExchangeId = EXCHANGE_ID_ALIASES[normalizedExchangeId];
  if (!aliasedExchangeId) {
    return normalizedExchangeId;
  }

  const aliasedExchange = database.db.select().from(exchanges).where(eq(exchanges.id, aliasedExchangeId)).limit(1).get();

  return aliasedExchange?.id ?? normalizedExchangeId;
}

export function buildExchangeSummary(row: ExchangeRow) {
  return {
    id: row.id,
    name: row.name,
    year_established: row.yearEstablished,
    country: row.country,
    description: row.description,
    url: row.url,
    image: row.imageUrl,
    has_trading_incentive: row.hasTradingIncentive,
    trust_score: row.trustScore,
    trust_score_rank: row.trustScoreRank,
    trade_volume_24h_btc: row.tradeVolume24hBtc,
    trade_volume_24h_btc_normalized: row.tradeVolume24hBtcNormalized,
    updated_at: row.updatedAt.toISOString(),
    source: row.updatedAt.getTime() > Date.parse('2026-03-20T00:00:00.000Z') ? 'live' : 'fixture',
  };
}

export function buildExchangeDetail(row: ExchangeRow) {
  return {
    id: row.id,
    name: row.name,
    year_established: row.yearEstablished,
    country: row.country,
    description: row.description,
    url: row.url,
    image: row.imageUrl,
    facebook_url: row.facebookUrl,
    reddit_url: row.redditUrl,
    telegram_url: row.telegramUrl,
    slack_url: row.slackUrl,
    other_url_1: parseJsonArray<string>(row.otherUrlJson)[0] ?? null,
    other_url_2: parseJsonArray<string>(row.otherUrlJson)[1] ?? null,
    twitter_handle: row.twitterHandle,
    has_trading_incentive: row.hasTradingIncentive,
    centralized: row.centralised,
    public_notice: row.publicNotice,
    alert_notice: row.alertNotice,
    trust_score: row.trustScore,
    trust_score_rank: row.trustScoreRank,
    coins: null,
    pairs: null,
    trade_volume_24h_btc: row.tradeVolume24hBtc,
    trade_volume_24h_btc_normalized: row.tradeVolume24hBtcNormalized,
    status_updates: [],
    updated_at: row.updatedAt.toISOString(),
    source: row.updatedAt.getTime() > Date.parse('2026-03-20T00:00:00.000Z') ? 'live' : 'fixture',
  };
}

export function getExchangeOrThrow(database: AppDatabase, exchangeId: string) {
  const resolvedExchangeId = resolveExchangeRouteId(database, exchangeId);
  const exchange = database.db.select().from(exchanges).where(eq(exchanges.id, resolvedExchangeId)).limit(1).get();

  if (!exchange) {
    throw new HttpError(404, 'not_found', `Exchange not found: ${exchangeId}`);
  }

  return exchange;
}
