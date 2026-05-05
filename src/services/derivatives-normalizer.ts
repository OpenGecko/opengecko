import type { derivativeTickers } from '../db/schema';

export type RawDerivativeTickerReplay = {
  exchangeId: string;
  symbol: string;
  market?: string | null;
  base?: string | null;
  quote?: string | null;
  indexId?: string | null;
  price?: number | string | null;
  markPrice?: number | string | null;
  last?: number | string | null;
  percentage?: number | string | null;
  contractType?: string | null;
  index?: number | string | null;
  indexPrice?: number | string | null;
  basis?: number | string | null;
  spread?: number | string | null;
  bid?: number | string | null;
  ask?: number | string | null;
  fundingRate?: number | string | null;
  openInterestBtc?: number | string | null;
  tradeVolume24hBtc?: number | string | null;
  timestamp?: number | null;
  expiredAt?: number | string | null;
  info?: Record<string, unknown>;
};

function optionalNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function optionalTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
  }

  return null;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeContractType(value: unknown) {
  const normalized = optionalString(value)?.toLowerCase().replace(/[_\s-]+/g, '_') ?? '';

  if (normalized === 'swap' || normalized === 'perpetual' || normalized === 'perpetual_swap') {
    return 'perpetual';
  }

  if (normalized === 'future' || normalized === 'futures' || normalized === 'dated_future') {
    return 'future';
  }

  return normalized || 'unknown';
}

function deriveSpread(raw: RawDerivativeTickerReplay) {
  const directSpread = optionalNumber(raw.spread ?? raw.info?.spread);
  if (directSpread !== null) {
    return directSpread;
  }

  const bid = optionalNumber(raw.bid ?? raw.info?.bid);
  const ask = optionalNumber(raw.ask ?? raw.info?.ask);
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;

  if (bid === null || ask === null || mid === null || mid === 0) {
    return null;
  }

  return Number((((ask - bid) / mid) * 100).toFixed(6));
}

export function normalizeDerivativeTickerReplay(raw: RawDerivativeTickerReplay): typeof derivativeTickers.$inferInsert {
  const base = optionalString(raw.base ?? raw.info?.base);
  const quote = optionalString(raw.quote ?? raw.info?.quote);
  const indexId = optionalString(raw.indexId ?? raw.info?.indexId)
    ?? (base && quote ? `${base}/${quote}` : null);

  return {
    exchangeId: raw.exchangeId,
    symbol: raw.symbol,
    market: optionalString(raw.market ?? raw.info?.market) ?? raw.symbol,
    indexId,
    price: optionalNumber(raw.price ?? raw.markPrice ?? raw.last ?? raw.info?.markPrice ?? raw.info?.lastPrice),
    pricePercentageChange24h: optionalNumber(raw.percentage ?? raw.info?.priceChangePercent),
    contractType: normalizeContractType(raw.contractType ?? raw.info?.contractType),
    indexValue: optionalNumber(raw.index ?? raw.indexPrice ?? raw.info?.indexPrice),
    basis: optionalNumber(raw.basis ?? raw.info?.basis),
    spread: deriveSpread(raw),
    fundingRate: optionalNumber(raw.fundingRate ?? raw.info?.fundingRate),
    openInterestBtc: optionalNumber(raw.openInterestBtc ?? raw.info?.openInterestBtc),
    tradeVolume24hBtc: optionalNumber(raw.tradeVolume24hBtc ?? raw.info?.tradeVolume24hBtc),
    lastTradedAt: optionalTimestamp(raw.timestamp ?? raw.info?.timestamp),
    expiredAt: optionalTimestamp(raw.expiredAt ?? raw.info?.expiredAt),
  };
}

export function normalizeDerivativeTickerReplayBatch(rawRows: RawDerivativeTickerReplay[]) {
  return rawRows.map(normalizeDerivativeTickerReplay);
}
