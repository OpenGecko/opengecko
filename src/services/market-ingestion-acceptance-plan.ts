import BigNumber from 'bignumber.js';

import type { ExchangeTickerSnapshot } from '../providers/ccxt';
import {
  filterMarketQuoteSamplesForConsensus,
  normalizeMarketTimestamp,
  type MarketQuoteSample,
} from './market-snapshots';

type MarketSampleEntry = {
  coinId: string;
  vsCurrency: string;
  samples: MarketQuoteSample[];
};

type PendingQuoteSnapshotLike = {
  marketSample: MarketQuoteSample;
};

type PendingCoinTickerLike = {
  marketSample: MarketQuoteSample;
  exchangeId: string;
  quoteVolume: number | null;
};

export type AcceptedIngestionPlan<
  TQuoteSnapshot extends PendingQuoteSnapshotLike,
  TCoinTicker extends PendingCoinTickerLike,
> = {
  acceptedSamples: Set<MarketQuoteSample>;
  acceptedMarketSamples: Map<string, MarketSampleEntry>;
  acceptedQuoteSnapshots: TQuoteSnapshot[];
  acceptedCoinTickers: TCoinTicker[];
  exchangeQuoteVolumes: Map<string, number>;
};

export type NormalizedMarketTickerCandidate = {
  accepted: true;
  timestamp: number;
  baseVolume: number | null;
  quoteVolume: number | null;
  percentage: number | null;
} | {
  accepted: false;
  reason: 'malformed_ticker_candidate';
};

function toFiniteNullableNonNegative(value: number | null) {
  if (value === null) {
    return null;
  }

  return Number.isFinite(value) && value >= 0 ? value : null;
}

function toFiniteNullablePercentage(value: number | null) {
  if (value === null) {
    return null;
  }

  return Number.isFinite(value) ? value : null;
}

function hasValidBidAskPair(bid: number | null, ask: number | null) {
  const hasBid = bid !== null;
  const hasAsk = ask !== null;

  if (!hasBid && !hasAsk) {
    return true;
  }

  if ((hasBid && (!Number.isFinite(bid) || bid < 0)) || (hasAsk && (!Number.isFinite(ask) || ask <= 0))) {
    return false;
  }

  if (hasBid && hasAsk && bid > ask) {
    return false;
  }

  return true;
}

function tickerSymbolMatchesAssets(ticker: ExchangeTickerSnapshot) {
  const [symbolBase, symbolQuote, ...extraParts] = ticker.symbol.split('/');

  if (!symbolBase || !symbolQuote || extraParts.length > 0) {
    return false;
  }

  return symbolBase.trim().toUpperCase() === ticker.base.trim().toUpperCase()
    && symbolQuote.trim().toUpperCase() === ticker.quote.trim().toUpperCase();
}

function hasTruthyQualityFlag(ticker: ExchangeTickerSnapshot, flagNames: string[]) {
  const tickerRecord = ticker as unknown as Record<string, unknown>;
  const rawRecord = ticker.raw && typeof ticker.raw === 'object'
    ? ticker.raw as unknown as Record<string, unknown>
    : {};

  return flagNames.some((flagName) =>
    tickerRecord[flagName] === true
    || rawRecord[flagName] === true
    || rawRecord[flagName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] === true,
  );
}

export function normalizeMarketTickerCandidate(
  ticker: ExchangeTickerSnapshot,
  nowMs = Date.now(),
): NormalizedMarketTickerCandidate {
  const timestamp = normalizeMarketTimestamp(ticker.timestamp, nowMs);

  if (
    timestamp === null
    || typeof ticker.symbol !== 'string'
    || ticker.symbol.trim().length === 0
    || typeof ticker.base !== 'string'
    || ticker.base.trim().length === 0
    || typeof ticker.quote !== 'string'
    || ticker.quote.trim().length === 0
    || !tickerSymbolMatchesAssets(ticker)
    || ticker.last === null
    || !Number.isFinite(ticker.last)
    || ticker.last <= 0
    || !hasValidBidAskPair(ticker.bid, ticker.ask)
    || hasTruthyQualityFlag(ticker, ['isAnomaly', 'isStale'])
  ) {
    return {
      accepted: false,
      reason: 'malformed_ticker_candidate',
    };
  }

  return {
    accepted: true,
    timestamp,
    baseVolume: toFiniteNullableNonNegative(ticker.baseVolume),
    quoteVolume: toFiniteNullableNonNegative(ticker.quoteVolume),
    percentage: toFiniteNullablePercentage(ticker.percentage),
  };
}

function recordExchangeQuoteVolume(exchangeQuoteVolumes: Map<string, number>, exchangeId: string, quoteVolume: number | null) {
  if (quoteVolume === null) {
    return;
  }

  exchangeQuoteVolumes.set(
    exchangeId,
    new BigNumber(exchangeQuoteVolumes.get(exchangeId) ?? 0).plus(quoteVolume).toNumber(),
  );
}

export function buildAcceptedIngestionPlan<
  TQuoteSnapshot extends PendingQuoteSnapshotLike,
  TCoinTicker extends PendingCoinTickerLike,
>(input: {
  marketSamples: Map<string, MarketSampleEntry>;
  pendingQuoteSnapshots: TQuoteSnapshot[];
  pendingCoinTickers: TCoinTicker[];
}): AcceptedIngestionPlan<TQuoteSnapshot, TCoinTicker> {
  const acceptedSamples = new Set<MarketQuoteSample>();
  const acceptedMarketSamples = new Map<string, MarketSampleEntry>();

  for (const [key, entry] of input.marketSamples) {
    const acceptedEntrySamples = filterMarketQuoteSamplesForConsensus(entry.samples);

    if (acceptedEntrySamples.length === 0) {
      continue;
    }

    acceptedMarketSamples.set(key, {
      ...entry,
      samples: acceptedEntrySamples,
    });

    for (const sample of acceptedEntrySamples) {
      acceptedSamples.add(sample);
    }
  }

  const acceptedQuoteSnapshots = input.pendingQuoteSnapshots.filter((pendingSnapshot) =>
    acceptedSamples.has(pendingSnapshot.marketSample),
  );
  const acceptedCoinTickers = input.pendingCoinTickers.filter((pendingTicker) =>
    acceptedSamples.has(pendingTicker.marketSample),
  );
  const exchangeQuoteVolumes = new Map<string, number>();

  for (const pendingTicker of acceptedCoinTickers) {
    recordExchangeQuoteVolume(exchangeQuoteVolumes, pendingTicker.exchangeId, pendingTicker.quoteVolume);
  }

  return {
    acceptedSamples,
    acceptedMarketSamples,
    acceptedQuoteSnapshots,
    acceptedCoinTickers,
    exchangeQuoteVolumes,
  };
}
