import { describe, expect, it } from 'vitest';

import { sortMarketRows, type MarketSortableCoin, type MarketSortKey } from '../frontend/src/lib/market-sort';

const coins: MarketSortableCoin[] = [
  {
    id: 'alpha',
    name: 'Alpha',
    current_price: 4,
    market_cap: 400,
    market_cap_rank: 3,
    fully_diluted_valuation: 450,
    total_volume: 40,
    price_change_percentage_24h: -2
  },
  {
    id: 'bravo',
    name: 'Bravo',
    current_price: 10,
    market_cap: 1000,
    market_cap_rank: 1,
    fully_diluted_valuation: 1200,
    total_volume: 100,
    price_change_percentage_24h: 6
  },
  {
    id: 'charlie',
    name: 'Charlie',
    current_price: 1,
    market_cap: 700,
    market_cap_rank: 2,
    fully_diluted_valuation: 800,
    total_volume: 70,
    price_change_percentage_24h: 1
  }
];

describe('dashboard market sorting', () => {
  it.each([
    ['rank', ['bravo', 'charlie', 'alpha'], ['alpha', 'charlie', 'bravo']],
    ['price', ['charlie', 'alpha', 'bravo'], ['bravo', 'alpha', 'charlie']],
    ['change24h', ['alpha', 'charlie', 'bravo'], ['bravo', 'charlie', 'alpha']],
    ['volume', ['alpha', 'charlie', 'bravo'], ['bravo', 'charlie', 'alpha']],
    ['marketCap', ['alpha', 'charlie', 'bravo'], ['bravo', 'charlie', 'alpha']],
    ['fdv', ['alpha', 'charlie', 'bravo'], ['bravo', 'charlie', 'alpha']]
  ] as Array<[MarketSortKey, string[], string[]]>)(
    'orders visible rows by %s in both directions before callers slice',
    (key, ascending, descending) => {
      expect(sortMarketRows(coins, key, 'asc').map((coin) => coin.id)).toEqual(ascending);
      expect(sortMarketRows(coins, key, 'desc').map((coin) => coin.id)).toEqual(descending);
    }
  );

  it('keeps null metric values last in ascending and descending sorts', () => {
    const rows = [
      ...coins,
      {
        id: 'no-price',
        name: 'No Price',
        current_price: null,
        market_cap: null,
        market_cap_rank: 4,
        fully_diluted_valuation: null,
        total_volume: null,
        price_change_percentage_24h: null
      }
    ];

    expect(sortMarketRows(rows, 'price', 'asc').map((coin) => coin.id).at(-1)).toBe('no-price');
    expect(sortMarketRows(rows, 'price', 'desc').map((coin) => coin.id).at(-1)).toBe('no-price');
  });

  it('does not mutate the loaded market rows when producing sorted rows', () => {
    const originalOrder = coins.map((coin) => coin.id);
    const sorted = sortMarketRows(coins, 'price', 'desc').slice(0, 2);

    expect(sorted.map((coin) => coin.id)).toEqual(['bravo', 'alpha']);
    expect(coins.map((coin) => coin.id)).toEqual(originalOrder);
  });
});
