export type MarketSortKey = 'rank' | 'price' | 'change24h' | 'volume' | 'marketCap' | 'fdv';
export type MarketSortDirection = 'asc' | 'desc';

export type MarketSortableCoin = {
  id: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  fully_diluted_valuation: number | null;
  total_volume: number | null;
  price_change_percentage_24h: number | null;
};

function safeNumber(value: number | null | undefined, fallback: number) {
  return value == null || Number.isNaN(value) ? fallback : value;
}

export function nullableMarketSortValue(coin: MarketSortableCoin, key: MarketSortKey) {
  switch (key) {
    case 'price':
      return coin.current_price;
    case 'change24h':
      return coin.price_change_percentage_24h;
    case 'volume':
      return coin.total_volume;
    case 'marketCap':
      return coin.market_cap;
    case 'fdv':
      return coin.fully_diluted_valuation;
    case 'rank':
    default:
      return coin.market_cap_rank;
  }
}

export function compareMarketRows(
  left: MarketSortableCoin,
  right: MarketSortableCoin,
  key: MarketSortKey,
  direction: MarketSortDirection
) {
  const modifier = direction === 'asc' ? 1 : -1;
  const leftValue = nullableMarketSortValue(left, key);
  const rightValue = nullableMarketSortValue(right, key);

  if (leftValue == null && rightValue != null) return 1;
  if (rightValue == null && leftValue != null) return -1;
  if (leftValue != null && rightValue != null && leftValue !== rightValue) {
    return (leftValue - rightValue) * modifier;
  }

  return (
    safeNumber(left.market_cap_rank, 999999) - safeNumber(right.market_cap_rank, 999999)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id)
  );
}

export function sortMarketRows<T extends MarketSortableCoin>(
  rows: readonly T[],
  key: MarketSortKey,
  direction: MarketSortDirection
) {
  return [...rows].sort((left, right) => compareMarketRows(left, right, key, direction));
}
