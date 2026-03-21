import type { MarketSnapshotRow } from '../db/schema';

export type SnapshotOwnership = 'seeded' | 'live';

export type MarketQuoteAccumulator = {
  priceTotal: number;
  priceCount: number;
  volumeTotal: number;
  volumeCount: number;
  changeTotal: number;
  changeCount: number;
  latestTimestamp: number;
  providers: Set<string>;
};

function scaleByPriceRatio(value: number | null, previousPrice: number | null | undefined, nextPrice: number) {
  if (value === null || previousPrice === null || previousPrice === undefined || previousPrice <= 0) {
    return null;
  }

  return value * (nextPrice / previousPrice);
}

export function createMarketQuoteAccumulator(): MarketQuoteAccumulator {
  return {
    priceTotal: 0,
    priceCount: 0,
    volumeTotal: 0,
    volumeCount: 0,
    changeTotal: 0,
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
  const price = accumulator.priceTotal / accumulator.priceCount;
  const previousPrice = previousSnapshot?.price ?? null;
  const ath = previousSnapshot?.ath === null || previousSnapshot?.ath === undefined
    ? price
    : Math.max(previousSnapshot.ath, price);
  const atl = previousSnapshot?.atl === null || previousSnapshot?.atl === undefined
    ? price
    : Math.min(previousSnapshot.atl, price);
  const priceChangePercentage24h = accumulator.changeCount === 0
    ? previousSnapshot?.priceChangePercentage24h ?? null
    : accumulator.changeTotal / accumulator.changeCount;
  const priceChange24h = priceChangePercentage24h === null || priceChangePercentage24h <= -100
    ? null
    : price - (price / (1 + (priceChangePercentage24h / 100)));

  return {
    coinId,
    vsCurrency,
    price,
    marketCap: previousSnapshot?.circulatingSupply
      ? price * previousSnapshot.circulatingSupply
      : scaleByPriceRatio(previousSnapshot?.marketCap ?? null, previousPrice, price),
    totalVolume: accumulator.volumeCount === 0 ? null : accumulator.volumeTotal / accumulator.volumeCount,
    marketCapRank: previousSnapshot?.marketCapRank ?? null,
    fullyDilutedValuation: previousSnapshot?.maxSupply
      ? price * previousSnapshot.maxSupply
      : previousSnapshot?.totalSupply
        ? price * previousSnapshot.totalSupply
        : scaleByPriceRatio(previousSnapshot?.fullyDilutedValuation ?? null, previousPrice, price),
    circulatingSupply: previousSnapshot?.circulatingSupply ?? null,
    totalSupply: previousSnapshot?.totalSupply ?? null,
    maxSupply: previousSnapshot?.maxSupply ?? null,
    ath,
    athChangePercentage: ath === 0 ? null : ((price - ath) / ath) * 100,
    athDate: ath === price ? now : previousSnapshot?.athDate ?? null,
    atl,
    atlChangePercentage: atl === 0 ? null : ((price - atl) / atl) * 100,
    atlDate: atl === price ? now : previousSnapshot?.atlDate ?? null,
    priceChange24h,
    priceChangePercentage24h,
    sourceProvidersJson: JSON.stringify([...accumulator.providers].sort()),
    sourceCount: accumulator.providers.size,
    updatedAt: now,
    lastUpdated: new Date(accumulator.latestTimestamp || now.getTime()),
  };
}
