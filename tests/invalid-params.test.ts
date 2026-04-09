import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import * as defillamaProvider from '../src/providers/defillama';
import errorFixtures from './fixtures/error-fixtures.json';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
  ]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

function collectCamelCasePaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectCamelCasePaths(entry, `${path}[${index}]`));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const nextPath = `${path}.${key}`;
      const ownHit = /[a-z][A-Z]/.test(key) ? [nextPath] : [];
      return [...ownHit, ...collectCamelCasePaths(entry, nextPath)];
    });
  }

  return [];
}

describe('OpenGecko invalid parameter handling', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-errors-'));
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
      },
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects simple price requests without a lookup selector', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/simple/price?vs_currencies=usd',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.simplePriceMissingLookup);
  });

  it('rejects invalid precision values', async () => {
    const [simplePriceResponse, coinMarketsResponse, chartResponse, ohlcResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd&precision=not-a-number',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&precision=not-a-number',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&precision=not-a-number',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/ohlc?vs_currency=usd&days=7&precision=not-a-number',
      }),
    ]);

    for (const response of [simplePriceResponse, coinMarketsResponse, chartResponse, ohlcResponse]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject(errorFixtures.simplePriceBadPrecision);
    }
  });

  it('rejects invalid boolean values parsed by zod', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/coins/list?include_platform=maybe',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.coinsListBadIncludePlatform);
  });

  it('rejects invalid history dates', async () => {
    const [response, malformedFormatResponse, missingDateResponse, unknownCoinResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/history?date=invalid-date',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/history?date=2026-01-01',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/history',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/not-a-coin/history?date=20-03-2026',
      }),
    ]);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.coinHistoryBadDate);
    expect(malformedFormatResponse.statusCode).toBe(400);
    expect(malformedFormatResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid history date: 2026-01-01',
    });
    expect(missingDateResponse.statusCode).toBe(400);
    expect(missingDateResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });
    expect(unknownCoinResponse.statusCode).toBe(404);
    expect(unknownCoinResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });
  });

  it('rejects invalid paging values', async () => {
    const [response, clampedResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&per_page=0',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&per_page=300&page=1',
      }),
    ]);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.coinMarketsBadPerPage);
    expect(clampedResponse.statusCode).toBe(200);
    expect(clampedResponse.json()).toHaveLength(8);
  });

  it('rejects unsupported market ordering values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=unsupported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.coinMarketsBadOrder);
  });

  it('rejects unsupported coin ticker ordering values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/tickers?order=unsupported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.coinTickersBadOrder);
  });

  it('rejects invalid chart day values', async () => {
    const [badValueResponse, zeroResponse, negativeResponse, missingDaysResponse, missingVsCurrencyResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart?vs_currency=usd&days=bad',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart?vs_currency=usd&days=0',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart?vs_currency=usd&days=-1',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart?vs_currency=usd',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/bitcoin/market_chart?days=7',
      }),
    ]);

    expect(badValueResponse.statusCode).toBe(400);
    expect(badValueResponse.json()).toMatchObject(errorFixtures.coinChartBadDays);
    expect(zeroResponse.statusCode).toBe(400);
    expect(zeroResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid days value: 0',
    });
    expect(negativeResponse.statusCode).toBe(400);
    expect(negativeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid days value: -1',
    });

    expect(missingDaysResponse.statusCode).toBe(400);
    expect(missingDaysResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });

    expect(missingVsCurrencyResponse.statusCode).toBe(400);
    expect(missingVsCurrencyResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });
  });

  it('rejects unsupported chart interval values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=monthly',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.coinChartBadInterval);
  });

  it('rejects invalid chart range values', async () => {
    const badFromResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=bad&to=1773964800',
    });
    const badBoundsResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/market_chart/range?vs_currency=usd&from=1773964800&to=1773446400',
    });

    expect(badFromResponse.statusCode).toBe(400);
    expect(badFromResponse.json()).toMatchObject(errorFixtures.coinChartRangeBadFrom);

    expect(badBoundsResponse.statusCode).toBe(400);
    expect(badBoundsResponse.json()).toMatchObject(errorFixtures.coinChartRangeBadBounds);
  });

  it('rejects invalid ranged ohlc values', async () => {
    const badFromResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=bad&to=1773964800',
    });
    const badBoundsResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773964800&to=1773446400',
    });
    const badIntervalResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc/range?vs_currency=usd&from=1773446400&to=1773964800&interval=monthly',
    });

    expect(badFromResponse.statusCode).toBe(400);
    expect(badFromResponse.json()).toMatchObject(errorFixtures.coinChartRangeBadFrom);

    expect(badBoundsResponse.statusCode).toBe(400);
    expect(badBoundsResponse.json()).toMatchObject(errorFixtures.coinChartRangeBadBounds);

    expect(badIntervalResponse.statusCode).toBe(400);
    expect(badIntervalResponse.json()).toMatchObject(errorFixtures.coinChartBadInterval);
  });

  it('rejects invalid supply chart params explicitly', async () => {
    const badRollingDaysResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/circulating_supply_chart?days=bad',
    });
    const badRollingIntervalResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/total_supply_chart?days=30&interval=monthly',
    });
    const badRangeFromResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/circulating_supply_chart/range?from=bad&to=1773964800',
    });
    const badRangeBoundsResponse = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin/total_supply_chart/range?from=1773964800&to=1773446400',
    });

    expect(badRollingDaysResponse.statusCode).toBe(400);
    expect(badRollingDaysResponse.json()).toMatchObject(errorFixtures.coinChartBadDays);

    expect(badRollingIntervalResponse.statusCode).toBe(400);
    expect(badRollingIntervalResponse.json()).toMatchObject(errorFixtures.coinChartBadInterval);

    expect(badRangeFromResponse.statusCode).toBe(400);
    expect(badRangeFromResponse.json()).toMatchObject(errorFixtures.coinChartRangeBadFrom);

    expect(badRangeBoundsResponse.statusCode).toBe(400);
    expect(badRangeBoundsResponse.json()).toMatchObject(errorFixtures.coinChartRangeBadBounds);
  });

  it('rejects unsupported dex pair formats on coin detail routes', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/coins/bitcoin?dex_pair_format=bad',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.coinDetailBadDexPairFormat);
  });

  it('rejects unsupported category ordering values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/coins/categories?order=unsupported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.coinCategoriesBadOrder);
  });

  it('rejects blank search queries', async () => {
    const [blankResponse, missingResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/search?query=%20%20',
      }),
      app!.inject({
        method: 'GET',
        url: '/search',
      }),
    ]);

    expect(blankResponse.statusCode).toBe(400);
    expect(blankResponse.json()).toMatchObject(errorFixtures.searchBlankQuery);

    expect(missingResponse.statusCode).toBe(400);
    expect(missingResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'query Required',
    });
  });

  it('preserves VAL-CATALOG invalid-parameter semantics for simple, search, and category ordering surfaces', async () => {
    const [
      simplePriceMissingSelectorResponse,
      simplePriceMissingVsCurrenciesResponse,
      tokenPriceMissingContractsResponse,
      tokenPriceMissingVsCurrenciesResponse,
      searchBlankResponse,
      searchMissingResponse,
      categoriesBadOrderResponse,
    ] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/simple/price?vs_currencies=usd',
      }),
      app!.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=',
      }),
      app!.inject({
        method: 'GET',
        url: '/simple/token_price/ethereum?contract_addresses=&vs_currencies=usd',
      }),
      app!.inject({
        method: 'GET',
        url: '/simple/token_price/ethereum?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=',
      }),
      app!.inject({
        method: 'GET',
        url: '/search?query=%20%20',
      }),
      app!.inject({
        method: 'GET',
        url: '/search',
      }),
      app!.inject({
        method: 'GET',
        url: '/coins/categories?order=bad_order',
      }),
    ]);

    expect(simplePriceMissingSelectorResponse.statusCode).toBe(400);
    expect(simplePriceMissingSelectorResponse.json()).toMatchObject(errorFixtures.simplePriceMissingLookup);

    expect(simplePriceMissingVsCurrenciesResponse.statusCode).toBe(400);
    expect(simplePriceMissingVsCurrenciesResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'At least one vs_currency must be provided.',
    });

    expect(tokenPriceMissingContractsResponse.statusCode).toBe(400);
    expect(tokenPriceMissingContractsResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'At least one contract address must be provided.',
    });

    expect(tokenPriceMissingVsCurrenciesResponse.statusCode).toBe(400);
    expect(tokenPriceMissingVsCurrenciesResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'At least one vs_currency must be provided.',
    });

    expect(searchBlankResponse.statusCode).toBe(400);
    expect(searchBlankResponse.json()).toMatchObject(errorFixtures.searchBlankQuery);

    expect(searchMissingResponse.statusCode).toBe(400);
    expect(searchMissingResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'query Required',
    });

    expect(categoriesBadOrderResponse.statusCode).toBe(400);
    expect(categoriesBadOrderResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'Unsupported order value: bad_order',
    });
  });

  it('rejects invalid trending show_max values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/search/trending?show_max=bad',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.searchTrendingBadShowMax);
  });

  it('returns not found for unknown token list platforms', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/token_lists/not-a-platform/all.json',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Asset platform not found: not-a-platform',
    });
  });

  it('rejects unsupported include and duration values on onchain discovery routes explicitly', async () => {
    const badTrendingIncludeResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/trending_pools?include=tokens',
    });
    const badTrendingDurationResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/trending_pools?duration=2h',
    });
    const badNewPoolsIncludeResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/new_pools?include=tokens',
    });

    expect(badTrendingIncludeResponse.statusCode).toBe(400);
    expect(badTrendingIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: tokens',
    });

    expect(badTrendingDurationResponse.statusCode).toBe(400);
    expect(badTrendingDurationResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported duration value: 2h',
    });

    expect(badNewPoolsIncludeResponse.statusCode).toBe(400);
    expect(badNewPoolsIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: tokens',
    });
  });


  it('rejects malformed filters and invalid sort values on onchain megafilter explicitly', async () => {
    const malformedNumericResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/pools/megafilter?min_reserve_in_usd=abc',
    });
    const invalidSortResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/pools/megafilter?sort=unsupported',
    });
    const invalidNetworkResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/pools/megafilter?networks=bitcoin',
    });
    const invalidIncludeResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/pools/megafilter?include=network',
    });

    expect(malformedNumericResponse.statusCode).toBe(400);
    expect(malformedNumericResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid min_reserve_in_usd value: abc',
    });

    expect(invalidSortResponse.statusCode).toBe(400);
    expect(invalidSortResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported sort value: unsupported',
    });

    expect(invalidNetworkResponse.statusCode).toBe(400);
    expect(invalidNetworkResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unknown onchain network: bitcoin',
    });

    expect(invalidIncludeResponse.statusCode).toBe(400);
    expect(invalidIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: network',
    });
  });

  it('rejects invalid holder and trader analytics params explicitly', async () => {
    const badHoldersCountResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_holders?holders=0',
    });
    const badHoldersFlagResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_holders?include_pnl_details=yes',
    });
    const badHoldersIncludeResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_holders?include=dex',
    });
    const badTradersCountResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_traders?traders=bad',
    });
    const badTradersSortResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_traders?sort=unsupported',
    });
    const badTradersLabelResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/top_traders?include_address_label=maybe',
    });
    const badHoldersChartDaysResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/holders_chart?days=0',
    });

    expect(badHoldersCountResponse.statusCode).toBe(400);
    expect(badHoldersCountResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid holders value: 0',
    });

    expect(badHoldersFlagResponse.statusCode).toBe(400);
    expect(badHoldersFlagResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid boolean query value: yes',
    });

    expect(badHoldersIncludeResponse.statusCode).toBe(400);
    expect(badHoldersIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported include value: dex',
    });

    expect(badTradersCountResponse.statusCode).toBe(400);
    expect(badTradersCountResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid traders value: bad',
    });

    expect(badTradersSortResponse.statusCode).toBe(400);
    expect(badTradersSortResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported sort value: unsupported',
    });

    expect(badTradersLabelResponse.statusCode).toBe(400);
    expect(badTradersLabelResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid boolean query value: maybe',
    });

    expect(badHoldersChartDaysResponse.statusCode).toBe(400);
    expect(badHoldersChartDaysResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid days value: 0',
    });
  });

  it('rejects invalid exchange volume chart day values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart?days=bad',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid days value: bad',
    });
  });

  it('rejects invalid exchange volume chart ranges explicitly', async () => {
    const badFromResponse = await app!.inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart/range?from=bad&to=1774310400',
    });
    const badBoundsResponse = await app!.inject({
      method: 'GET',
      url: '/exchanges/binance/volume_chart/range?from=1774310400&to=1774224000',
    });

    expect(badFromResponse.statusCode).toBe(400);
    expect(badFromResponse.json()).toMatchObject(errorFixtures.coinChartRangeBadFrom);

    expect(badBoundsResponse.statusCode).toBe(400);
    expect(badBoundsResponse.json()).toMatchObject(errorFixtures.coinChartRangeBadBounds);
  });

  it('rejects unsupported exchange ticker ordering values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/exchanges/binance/tickers?order=unsupported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.exchangeTickersBadOrder);
  });

  it('rejects unsupported exchange dex pair formats', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/exchanges/binance?dex_pair_format=bad',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.exchangeBadDexPairFormat);
  });

  it('rejects unsupported derivatives exchange ordering values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/derivatives/exchanges?order=unsupported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.derivativesExchangesBadOrder);
  });

  it('rejects invalid derivatives exchange detail ticker flags', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/derivatives/exchanges/binance_futures?include_tickers=maybe',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_parameter',
      message: "include_tickers Invalid enum value. Expected 'true' | 'false', received 'maybe'",
    });
  });

  it('rejects unsupported treasury ordering values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/companies/public_treasury/bitcoin?order=unsupported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.treasuryBadOrder);
  });

  it('rejects unsupported treasury transaction ordering values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/public_treasury/strategy/transaction_history?order=unsupported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.treasuryBadOrder);
  });

  it('rejects unsupported treasury holding-chart days values', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/public_treasury/strategy/bitcoin/holding_chart?days=bad',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(errorFixtures.treasuryHoldingChartBadDays);
  });

  it('preserves exchange, treasury, and onchain contract guards for VAL-EXT negative-path assertions', async () => {
    const [
      exchangeStatusResponse,
      exchangeTickerOrderResponse,
      exchangeVolumeDaysResponse,
      exchangeVolumeRangeResponse,
      entityTypeResponse,
      treasuryUnknownEntityResponse,
      treasuryHoldingDaysResponse,
      onchainUnknownNetworkResponse,
      onchainTradesTokenFormatResponse,
      onchainTradesTokenConstituentResponse,
      onchainOhlcvCurrencyResponse,
    ] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/exchanges/list?status=paused',
      }),
      app!.inject({
        method: 'GET',
        url: '/exchanges/binance/tickers?order=price_desc',
      }),
      app!.inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart?days=0',
      }),
      app!.inject({
        method: 'GET',
        url: '/exchanges/binance/volume_chart/range?from=200&to=100',
      }),
      app!.inject({
        method: 'GET',
        url: '/entities/list?entity_type=funds',
      }),
      app!.inject({
        method: 'GET',
        url: '/public_treasury/unknown-entity',
      }),
      app!.inject({
        method: 'GET',
        url: '/public_treasury/strategy/bitcoin/holding_chart?days=15',
      }),
      app!.inject({
        method: 'GET',
        url: '/onchain/networks/notreal/pools',
      }),
      app!.inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?token=bad',
      }),
      app!.inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?token=0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
      }),
      app!.inject({
        method: 'GET',
        url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/minute?currency=eur',
      }),
    ]);

    for (const response of [
      exchangeStatusResponse,
      exchangeTickerOrderResponse,
      exchangeVolumeDaysResponse,
      exchangeVolumeRangeResponse,
      entityTypeResponse,
      treasuryHoldingDaysResponse,
      onchainTradesTokenFormatResponse,
      onchainTradesTokenConstituentResponse,
      onchainOhlcvCurrencyResponse,
    ]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'invalid_parameter',
      });
    }

    expect(exchangeVolumeDaysResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid days value: 0',
    });
    expect(exchangeVolumeRangeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid time range: from must be less than or equal to to.',
    });
    expect(treasuryHoldingDaysResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid days value: 15',
    });
    expect(onchainTradesTokenFormatResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid onchain address: bad',
    });
    expect(onchainTradesTokenConstituentResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Token is not a constituent of pool: 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });
    expect(onchainOhlcvCurrencyResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported currency value: eur',
    });

    expect(treasuryUnknownEntityResponse.statusCode).toBe(404);
    expect(treasuryUnknownEntityResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Treasury entity not found: unknown-entity',
    });
    expect(onchainUnknownNetworkResponse.statusCode).toBe(404);
    expect(onchainUnknownNetworkResponse.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain network not found: notreal',
    });
  });

  it('returns not found for unknown exchanges', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/exchanges/not-an-exchange',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Exchange not found: not-an-exchange',
    });
  });

  it('returns not found for unknown treasury entities', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/public_treasury/not-an-entity',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Treasury entity not found: not-an-entity',
    });
  });

  it('returns not found for unknown derivatives exchanges', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/derivatives/exchanges/not-a-venue',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Derivatives exchange not found: not-a-venue',
    });
  });

  it('uses a compatible error envelope for equivalent negative cases across core, exchange/derivatives, and onchain families', async () => {
    const [coreResponse, exchangeResponse, derivativesResponse, onchainResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/coins/not-a-coin',
      }),
      app!.inject({
        method: 'GET',
        url: '/exchanges/not-an-exchange',
      }),
      app!.inject({
        method: 'GET',
        url: '/derivatives/exchanges/not-a-venue',
      }),
      app!.inject({
        method: 'GET',
        url: '/onchain/networks/not-a-network/dexes',
      }),
    ]);

    for (const response of [coreResponse, exchangeResponse, derivativesResponse, onchainResponse]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: 'not_found',
        message: expect.any(String),
      });
    }
  });

  it('uses a compatible validation envelope for equivalent bad paging across representative families', async () => {
    const [coinMarketsResponse, exchangesResponse, exchangeTickersResponse, derivativesResponse, entitiesResponse, onchainNetworksResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&page=0',
      }),
      app!.inject({
        method: 'GET',
        url: '/exchanges?page=0',
      }),
      app!.inject({
        method: 'GET',
        url: '/exchanges/binance/tickers?page=0',
      }),
      app!.inject({
        method: 'GET',
        url: '/derivatives/exchanges?page=0',
      }),
      app!.inject({
        method: 'GET',
        url: '/entities/list?page=0',
      }),
      app!.inject({
        method: 'GET',
        url: '/onchain/networks?page=0',
      }),
    ]);

    for (const response of [coinMarketsResponse, exchangesResponse, exchangeTickersResponse, derivativesResponse, entitiesResponse, onchainNetworksResponse]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'invalid_parameter',
        message: 'Invalid integer value: 0',
      });
    }
  });

  it('rejects page boundary values uniformly across paginated endpoint families', async () => {
    const urls = [
      '/coins/markets?vs_currency=usd&page=-1',
      '/coins/markets?vs_currency=usd&page=abc',
      '/exchanges?page=-1',
      '/exchanges?page=abc',
      '/exchanges/binance/tickers?page=-1',
      '/exchanges/binance/tickers?page=abc',
      '/derivatives/exchanges?page=-1',
      '/derivatives/exchanges?page=abc',
      '/entities/list?page=-1',
      '/entities/list?page=abc',
      '/onchain/networks?page=-1',
      '/onchain/networks?page=abc',
    ];

    const responses = await Promise.all(urls.map((url) => app!.inject({ method: 'GET', url })));

    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'invalid_parameter',
        message: expect.stringMatching(/^Invalid integer value: /),
      });
    }
  });

  it('returns not found for unknown treasury holding-chart coins', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/public_treasury/strategy/not-a-coin/holding_chart',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });
  });

  it('returns not found for unknown onchain networks', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/not-a-network/dexes',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain network not found: not-a-network',
    });
  });

  it('rejects invalid onchain network page values explicitly', async () => {
    const zeroPageResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks?page=0',
    });
    const negativePageResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks?page=-1',
    });
    const nonIntegerPageResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks?page=abc',
    });

    for (const response of [zeroPageResponse, negativePageResponse, nonIntegerPageResponse]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'invalid_parameter',
      });
      expect(response.json().message).toMatch(/^Invalid integer value:/);
    }
  });

  it('returns not found for unknown onchain pools', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/not-a-pool',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain pool not found: not-a-pool',
    });
  });

  it('returns not found for unknown onchain dex pools', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/dexes/not-a-dex/pools',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Onchain dex not found: not-a-dex',
    });
  });

  it('rejects unsupported onchain pool include, toggle, and sort parameters explicitly', async () => {
    const invalidIncludeResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640?include=token',
    });
    const invalidToggleResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640?include_volume_breakdown=yes',
    });
    const invalidSortResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools?sort=market_cap_desc',
    });

    expect(invalidIncludeResponse.statusCode).toBe(400);
    expect(invalidIncludeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
    });

    expect(invalidToggleResponse.statusCode).toBe(400);
    expect(invalidToggleResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid boolean query value: yes',
    });

    expect(invalidSortResponse.statusCode).toBe(400);
    expect(invalidSortResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: "sort Invalid enum value. Expected 'h24_volume_usd_liquidity_desc' | 'h24_tx_count_desc' | 'reserve_in_usd_desc', received 'market_cap_desc'",
    });
  });

  it('rejects invalid onchain OHLCV timeframe and numeric parameters explicitly', async () => {
    const invalidPoolTimeframeResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/week',
    });
    const invalidPoolNumericResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?aggregate=abc',
    });
    const invalidPoolLimitResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?limit=0',
    });
    const invalidPoolTimestampResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?before_timestamp=bad',
    });
    const invalidPoolCurrencyResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?currency=eur',
    });
    const invalidPoolTokenResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/ohlcv/hour?token=0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });
    const invalidTokenTimeframeResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/ohlcv/week',
    });
    const invalidTokenNumericResponse = await app!.inject({
      method: 'GET',
      url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/ohlcv/hour?aggregate=abc',
    });

    expect(invalidPoolTimeframeResponse.statusCode).toBe(400);
    expect(invalidPoolTimeframeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported timeframe value: week',
    });

    expect(invalidPoolNumericResponse.statusCode).toBe(400);
    expect(invalidPoolNumericResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid aggregate value: abc',
    });

    expect(invalidPoolLimitResponse.statusCode).toBe(400);
    expect(invalidPoolLimitResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid limit value: 0',
    });

    expect(invalidPoolTimestampResponse.statusCode).toBe(400);
    expect(invalidPoolTimestampResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid before_timestamp value: bad',
    });

    expect(invalidPoolCurrencyResponse.statusCode).toBe(400);
    expect(invalidPoolCurrencyResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported currency value: eur',
    });

    expect(invalidPoolTokenResponse.statusCode).toBe(400);
    expect(invalidPoolTokenResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Token is not a constituent of pool: 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    });

    expect(invalidTokenTimeframeResponse.statusCode).toBe(400);
    expect(invalidTokenTimeframeResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Unsupported timeframe value: week',
    });

    expect(invalidTokenNumericResponse.statusCode).toBe(400);
    expect(invalidTokenNumericResponse.json()).toMatchObject({
      error: 'invalid_parameter',
      message: 'Invalid aggregate value: abc',
    });
  });

  it('returns not found for unknown exchange tickers', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/exchanges/not-an-exchange/tickers',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Exchange not found: not-an-exchange',
    });
  });

  it('returns not found for unknown coin tickers', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/coins/not-a-coin/tickers',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'Coin not found: not-a-coin',
    });
  });

  it('enforces snake_case keys across representative family responses', async () => {
    const defillamaPriceSpy = vi
      .spyOn(defillamaProvider, 'fetchDefillamaTokenPrices')
      .mockResolvedValue(null);
    const labeledRequests = [
      { label: 'simple', request: app!.inject({ method: 'GET', url: '/simple/supported_vs_currencies' }) },
      { label: 'assets', request: app!.inject({ method: 'GET', url: '/asset_platforms' }) },
      { label: 'coins_markets', request: app!.inject({ method: 'GET', url: '/coins/markets?vs_currency=usd&per_page=1&page=1&sparkline=true' }) },
      { label: 'coins_detail', request: app!.inject({ method: 'GET', url: '/coins/bitcoin?localization=false' }) },
      { label: 'exchange_detail', request: app!.inject({ method: 'GET', url: '/exchanges/binance' }) },
      { label: 'derivatives_detail', request: app!.inject({ method: 'GET', url: '/derivatives/exchanges/binance_futures?include_tickers=true' }) },
      { label: 'treasury_detail', request: app!.inject({ method: 'GET', url: '/public_treasury/strategy' }) },
      { label: 'onchain_pool', request: app!.inject({ method: 'GET', url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' }) },
      { label: 'onchain_token_info', request: app!.inject({ method: 'GET', url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info' }) },
      { label: 'global', request: app!.inject({ method: 'GET', url: '/global' }) },
    ] as const;
    const labeledResponses = await Promise.all(
      labeledRequests.map(async ({ label, request }) => ({ label, response: await request })),
    );

    for (const { label, response } of labeledResponses) {
      expect(response.statusCode, label).toBe(200);
      expect(collectCamelCasePaths(response.json()), label).toEqual([]);
    }

    expect(defillamaPriceSpy).toHaveBeenCalledTimes(1);
  });

});
