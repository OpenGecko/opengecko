import BigNumber from 'bignumber.js';

import type { MarketSnapshotRow } from '../db/schema';

export type SnapshotOwnership = 'seeded' | 'live';

const SECOND_TIMESTAMP_CUTOFF = 10_000_000_000;
const MIN_PLAUSIBLE_MARKET_TIMESTAMP_MS = Date.parse('2010-01-01T00:00:00.000Z');
const MAX_FUTURE_MARKET_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;
const MAX_MARKET_PRICE_OUTLIER_RATIO = 1.25;

export type MarketQuoteSample = {
  price: number;
  quoteVolume: number | null;
  changePercentage24h: number | null;
  timestamp: number;
  provider: string;
};

export type MarketQuoteAccumulator = {
  priceTotal: BigNumber;
  priceCount: number;
  volumeTotal: BigNumber;
  volumeCount: number;
  changeTotal: BigNumber;
  changeCount: number;
  latestTimestamp: number;
  providers: Set<string>;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function median(values: number[]) {
  const sortedValues = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 1) {
    return sortedValues[midpoint]!;
  }

  return new BigNumber(sortedValues[midpoint - 1]!)
    .plus(sortedValues[midpoint]!)
    .dividedBy(2)
    .toNumber();
}

export function normalizeMarketTimestamp(value: unknown, nowMs = Date.now()) {
  let timestampMs: number | null = null;

  if (value === null || value === undefined) {
    timestampMs = nowMs;
  } else if (value instanceof Date) {
    timestampMs = value.getTime();
  } else if (typeof value === 'string' && value.trim().length > 0) {
    const parsedNumber = Number(value);
    timestampMs = Number.isFinite(parsedNumber) ? parsedNumber : Date.parse(value);
  } else if (isFiniteNumber(value)) {
    timestampMs = value;
  }

  if (!isFiniteNumber(timestampMs)) {
    return null;
  }

  const normalizedTimestampMs = timestampMs > 0 && timestampMs < SECOND_TIMESTAMP_CUTOFF
    ? timestampMs * 1_000
    : timestampMs;

  if (
    !Number.isSafeInteger(Math.round(normalizedTimestampMs))
    || normalizedTimestampMs < MIN_PLAUSIBLE_MARKET_TIMESTAMP_MS
    || normalizedTimestampMs > nowMs + MAX_FUTURE_MARKET_TIMESTAMP_DRIFT_MS
  ) {
    return null;
  }

  return Math.round(normalizedTimestampMs);
}

function isPriceSampleWithinConsensus(sample: MarketQuoteSample, consensusPrice: number) {
  const larger = Math.max(sample.price, consensusPrice);
  const smaller = Math.min(sample.price, consensusPrice);

  return smaller > 0 && larger / smaller <= MAX_MARKET_PRICE_OUTLIER_RATIO;
}

export function filterMarketQuoteSamplesForConsensus(samples: MarketQuoteSample[]) {
  const finiteSamples = samples.filter((sample) =>
    Number.isFinite(sample.price)
    && sample.price > 0
    && Number.isFinite(sample.timestamp)
    && sample.timestamp > 0
    && (sample.quoteVolume === null || (Number.isFinite(sample.quoteVolume) && sample.quoteVolume >= 0))
    && (sample.changePercentage24h === null || Number.isFinite(sample.changePercentage24h)),
  );

  if (finiteSamples.length === 0) {
    return [];
  }

  const providerCount = new Set(finiteSamples.map((sample) => sample.provider)).size;
  if (providerCount <= 1) {
    return finiteSamples;
  }

  const consensusPrice = median(finiteSamples.map((sample) => sample.price));
  return finiteSamples.length === 1
    ? finiteSamples
    : finiteSamples.filter((sample) => isPriceSampleWithinConsensus(sample, consensusPrice));
}

export function buildMarketQuoteAccumulator(samples: MarketQuoteSample[]) {
  const acceptedSamples = filterMarketQuoteSamplesForConsensus(samples);

  if (acceptedSamples.length === 0) {
    return createMarketQuoteAccumulator();
  }

  const accumulator = createMarketQuoteAccumulator();

  for (const sample of acceptedSamples) {
    accumulator.priceTotal = accumulator.priceTotal.plus(sample.price);
    accumulator.priceCount += 1;

    if (sample.quoteVolume !== null) {
      accumulator.volumeTotal = accumulator.volumeTotal.plus(sample.quoteVolume);
      accumulator.volumeCount += 1;
    }

    if (sample.changePercentage24h !== null && sample.changePercentage24h > -100) {
      accumulator.changeTotal = accumulator.changeTotal.plus(sample.changePercentage24h);
      accumulator.changeCount += 1;
    }

    accumulator.latestTimestamp = Math.max(accumulator.latestTimestamp, sample.timestamp);
    accumulator.providers.add(sample.provider);
  }

  return accumulator;
}

function scaleByPriceRatio(value: number | null, previousPrice: number | null | undefined, nextPrice: number) {
  if (value === null || previousPrice === null || previousPrice === undefined || previousPrice <= 0) {
    return null;
  }

  return new BigNumber(value)
    .multipliedBy(new BigNumber(nextPrice).dividedBy(previousPrice))
    .toNumber();
}

export function createMarketQuoteAccumulator(): MarketQuoteAccumulator {
  return {
    priceTotal: new BigNumber(0),
    priceCount: 0,
    volumeTotal: new BigNumber(0),
    volumeCount: 0,
    changeTotal: new BigNumber(0),
    changeCount: 0,
    latestTimestamp: 0,
    providers: new Set<string>(),
  };
}

export function getSnapshotOwnership(snapshot: Pick<MarketSnapshotRow, 'sourceCount'>): SnapshotOwnership {
  return snapshot.sourceCount > 0 ? 'live' : 'seeded';
}

export function buildLiveSnapshotValue(
  coinId: string,
  accumulator: MarketQuoteAccumulator,
  previousSnapshot: Pick<
    MarketSnapshotRow,
    | 'price'
    | 'marketCap'
    | 'marketCapRank'
    | 'fullyDilutedValuation'
    | 'circulatingSupply'
    | 'totalSupply'
    | 'maxSupply'
    | 'ath'
    | 'athDate'
    | 'atl'
    | 'atlDate'
    | 'priceChangePercentage24h'
  > | null,
  vsCurrency: string,
  now: Date,
) {
  const price = accumulator.priceTotal.dividedBy(accumulator.priceCount).toNumber();
  const previousPrice = previousSnapshot?.price ?? null;
  const ath = previousSnapshot?.ath === null || previousSnapshot?.ath === undefined
    ? null
    : Math.max(previousSnapshot.ath, price);
  const atl = previousSnapshot?.atl === null || previousSnapshot?.atl === undefined
    ? null
    : Math.min(previousSnapshot.atl, price);
  const priceChangePercentage24h = accumulator.changeCount === 0
    ? previousSnapshot?.priceChangePercentage24h ?? null
    : accumulator.changeTotal.dividedBy(accumulator.changeCount).toNumber();
  const priceChange24h = priceChangePercentage24h === null || priceChangePercentage24h <= -100
    ? null
    : new BigNumber(price)
      .minus(
        new BigNumber(price).dividedBy(
          new BigNumber(1).plus(new BigNumber(priceChangePercentage24h).dividedBy(100)),
        ),
      )
      .toNumber();

  return {
    coinId,
    vsCurrency,
    price,
    marketCap: previousSnapshot?.circulatingSupply
      ? new BigNumber(price).multipliedBy(previousSnapshot.circulatingSupply).toNumber()
      : scaleByPriceRatio(previousSnapshot?.marketCap ?? null, previousPrice, price),
    totalVolume: accumulator.volumeCount === 0 ? null : accumulator.volumeTotal.dividedBy(accumulator.volumeCount).toNumber(),
    marketCapRank: previousSnapshot?.marketCapRank ?? null,
    fullyDilutedValuation: previousSnapshot?.maxSupply
      ? new BigNumber(price).multipliedBy(previousSnapshot.maxSupply).toNumber()
      : previousSnapshot?.totalSupply
        ? new BigNumber(price).multipliedBy(previousSnapshot.totalSupply).toNumber()
        : scaleByPriceRatio(previousSnapshot?.fullyDilutedValuation ?? null, previousPrice, price),
    circulatingSupply: previousSnapshot?.circulatingSupply ?? null,
    totalSupply: previousSnapshot?.totalSupply ?? null,
    maxSupply: previousSnapshot?.maxSupply ?? null,
    ath,
    athChangePercentage: ath === null || ath === 0
      ? null
      : new BigNumber(price).minus(ath).dividedBy(ath).multipliedBy(100).toNumber(),
    athDate: ath !== null && ath === price ? now : previousSnapshot?.athDate ?? null,
    atl,
    atlChangePercentage: atl === null || atl === 0
      ? null
      : new BigNumber(price).minus(atl).dividedBy(atl).multipliedBy(100).toNumber(),
    atlDate: atl !== null && atl === price ? now : previousSnapshot?.atlDate ?? null,
    priceChange24h,
    priceChangePercentage24h,
    sourceProvidersJson: JSON.stringify([...accumulator.providers].sort()),
    sourceCount: accumulator.providers.size,
    updatedAt: now,
    lastUpdated: new Date(accumulator.latestTimestamp || now.getTime()),
  };
}
