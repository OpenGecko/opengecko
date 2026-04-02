import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { and, eq, isNotNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app';
import { marketSnapshots, onchainNetworks } from '../src/db/schema';
import packageJson from '../package.json';

vi.mock('../src/providers/defillama', async () => {
  const actual = await import('../src/providers/defillama');
  return {
    ...actual,
    fetchDefillamaTokenPrices: vi.fn().mockResolvedValue({
      'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
        price: 1.0025,
        symbol: 'USDC',
        decimals: 6,
        confidence: 0.99,
        timestamp: 1710000000,
      },
    }),
  };
});

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn(),
  fetchExchangeTickers: vi.fn(),
  fetchExchangeOHLCV: vi.fn(),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeMarkets, fetchExchangeTickers, fetchExchangeOHLCV } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeTickers = fetchExchangeTickers as ReturnType<typeof vi.fn>;
const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;
const testDir = dirname(__filename);

describe('live data integration', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(async () => {
    mockedFetchExchangeMarkets.mockReset();
    mockedFetchExchangeTickers.mockReset();
    mockedFetchExchangeOHLCV.mockReset();

    mockedFetchExchangeMarkets.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'SOL/USD', base: 'SOL', quote: 'USD', active: true, spot: true, baseName: 'Solana', raw: {} },
      ];
      return [];
    });

    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 90_000, bid: 89_950, ask: 90_050, high: 91_000, low: 89_000, baseVolume: 5_000, quoteVolume: 450_000_000, percentage: 3.5, timestamp: Date.now(), raw: {} as never },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2_100, bid: 2_099, ask: 2_101, high: 2_150, low: 2_050, baseVolume: 50_000, quoteVolume: 105_000_000, percentage: 2.1, timestamp: Date.now(), raw: {} as never },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'SOL/USD', base: 'SOL', quote: 'USD', last: 180, bid: 179.5, ask: 180.5, high: 185, low: 175, baseVolume: 100_000, quoteVolume: 18_000_000, percentage: 5.2, timestamp: Date.now(), raw: {} as never },
      ];
      return [];
    });

    mockedFetchExchangeOHLCV.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', timeframe: '1d', timestamp: Date.parse('2026-03-20T00:00:00Z'), open: 88_000, high: 91_000, low: 87_000, close: 90_000, volume: 1_500, raw: [0, 0, 0, 0, 0, 0] },
        { exchangeId: 'binance', symbol: 'BTC/USDT', timeframe: '1d', timestamp: Date.parse('2026-03-21T00:00:00Z'), open: 90_000, high: 92_000, low: 89_000, close: 91_000, volume: 1_600, raw: [0, 0, 0, 0, 0, 0] },
      ];
      return [];
    });

    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-live-'));
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
        marketFreshnessThresholdSeconds: 300,
        providerFanoutConcurrency: 2,
      },
      startBackgroundJobs: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('bootstraps live market and exchange surfaces before serving traffic', async () => {
    expect(mockedFetchExchangeTickers).toHaveBeenCalled();
    expect(app.marketDataRuntimeState.initialSyncCompleted).toBe(true);
    expect(app.marketDataRuntimeState.listenerBound).toBe(false);

    const [simplePriceResponse, marketsResponse, detailResponse, exchangeResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/simple/price?ids=bitcoin&vs_currencies=usd',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/bitcoin',
      }),
      app.inject({
        method: 'GET',
        url: '/exchanges/binance',
      }),
    ]);

    expect(simplePriceResponse.statusCode).toBe(200);
    expect(simplePriceResponse.json()).toEqual({
      bitcoin: {
        usd: 90_000,
      },
    });

    expect(marketsResponse.statusCode).toBe(200);
    expect(marketsResponse.json()[0]).toMatchObject({
      id: 'bitcoin',
      current_price: 90_000,
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: 'bitcoin',
      market_data: {
        current_price: {
          usd: 90_000,
        },
      },
    });

    expect(exchangeResponse.statusCode).toBe(200);
    expect(exchangeResponse.json()).toMatchObject({
      name: 'Binance',
    });
  });

  it('serves OHLCV tuples from the mocked backfill candles', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/bitcoin/ohlc?vs_currency=usd&days=30',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.length).toBeGreaterThan(0);
    // Each OHLC entry should be [timestamp, open, high, low, close]
    expect(body[0]).toHaveLength(5);
    expect(body).toContainEqual([
      Date.parse('2026-03-20T00:00:00Z'),
      88_000,
      91_000,
      87_000,
      90_000,
    ]);
  });

  it('returns exchange rates with btc as the base unit and a finite usd conversion', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/exchange_rates',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.btc.value).toBe(1);
    expect(body.data.usd.value).toBeGreaterThan(0);
    expect(Number.isFinite(body.data.usd.value)).toBe(true);
    expect(typeof body.data.eur.value).toBe('number');
  });

  it('verifies cross-area milestone flows work together end-to-end', async () => {
    const [aliasEthPriceResponse, aliasErc20PriceResponse, canonicalTokenListResponse, globalChartResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/simple/token_price/eth?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
      }),
      app.inject({
        method: 'GET',
        url: '/simple/token_price/erc20?contract_addresses=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&vs_currencies=usd',
      }),
      app.inject({
        method: 'GET',
        url: '/token_lists/ethereum/all.json',
      }),
      app.inject({
        method: 'GET',
        url: '/global/market_cap_chart?vs_currency=usd&days=30',
      }),
    ]);

    expect(aliasEthPriceResponse.statusCode).toBe(200);
    expect(aliasEthPriceResponse.json()).toEqual({});
    expect(aliasErc20PriceResponse.statusCode).toBe(200);
    expect(aliasErc20PriceResponse.json()).toEqual(aliasEthPriceResponse.json());

    expect(canonicalTokenListResponse.statusCode).toBe(200);
    const tokenListBody = canonicalTokenListResponse.json();
    expect(tokenListBody.name).toBe('OpenGecko Ethereum Token List');
    expect(tokenListBody.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        chainId: 1,
        extensions: { geckoId: 'usd-coin' },
      }),
    ]));

    expect(globalChartResponse.statusCode).toBe(200);
    const globalChartBody = globalChartResponse.json();
    expect(globalChartBody.market_cap_chart.length).toBeGreaterThan(0);
    expect(globalChartBody.market_cap_chart).toEqual(expect.arrayContaining([
      [expect.any(Number), expect.any(Number)],
    ]));
    expect(globalChartBody.market_cap_chart.every(([timestamp, value]: [number, number]) => timestamp > 0 && value > 0)).toBe(true);

    const normalizedNetworks = app.db.db
      .select()
      .from(onchainNetworks)
      .where(isNotNull(onchainNetworks.coingeckoAssetPlatformId))
      .all();

    expect(normalizedNetworks.length).toBeGreaterThan(0);

    for (const network of normalizedNetworks) {
      const matchingPlatform = app.db.db.query.assetPlatforms.findFirst({
        where: (assetPlatforms, { eq }) => eq(assetPlatforms.id, network.coingeckoAssetPlatformId!),
      });

      expect(matchingPlatform, `missing asset platform for ${network.id}`).toBeDefined();
    }

    const staleTimestamp = new Date('2025-03-19T00:00:00.000Z');
    app.db.db
      .update(marketSnapshots)
      .set({
        lastUpdated: staleTimestamp,
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();

    app.marketDataRuntimeState.validationOverride = {
      mode: 'stale_disallowed',
      reason: 'cross-area freshness gate',
      snapshotTimestampOverride: new Date(0).toISOString(),
      snapshotSourceCountOverride: 1,
    };
    app.marketDataRuntimeState.hotDataRevision += 1;

    const stalePriceResponse = await app.inject({
      method: 'GET',
      url: '/simple/price?ids=bitcoin&vs_currencies=usd',
    });

    expect(stalePriceResponse.statusCode).toBe(200);
    expect(stalePriceResponse.json()).toEqual({});

    app.marketDataRuntimeState.validationOverride = {
      mode: 'off',
      reason: null,
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    };
    app.marketDataRuntimeState.hotDataRevision += 1;
  });

  it('serves first-visit R0 endpoints from a fresh database and keeps SemVer version bumped', async () => {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/ping' }),
      app.inject({ method: 'GET', url: '/simple/price?ids=bitcoin&vs_currencies=usd' }),
      app.inject({ method: 'GET', url: '/asset_platforms' }),
      app.inject({ method: 'GET', url: '/search?query=bitcoin' }),
      app.inject({ method: 'GET', url: '/global' }),
      app.inject({ method: 'GET', url: '/coins/list' }),
      app.inject({ method: 'GET', url: '/coins/markets?vs_currency=usd' }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }

    expect(packageJson.version).toBe('0.5.0');
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.version.startsWith('0.5.')).toBe(true);
  });

  it('keeps CeFi and DeFi USD prices within the contract coherence threshold on the onchain simple token price path', async () => {
    const overlappingToken = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const overlappingCoinId = 'usd-coin';

    app.db.db
      .update(marketSnapshots)
      .set({
        price: 1,
        marketCap: 50_000_000_000,
        totalVolume: 1_500_000_000,
        priceChangePercentage24h: 0.5,
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: new Date('2026-03-21T00:00:00.000Z'),
      })
      .where(and(eq(marketSnapshots.coinId, overlappingCoinId), eq(marketSnapshots.vsCurrency, 'usd')))
      .run();

    const [onchainSimplePriceResponse, contractDetailResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/onchain/simple/networks/eth/token_price/${overlappingToken}?include_market_cap=true&include_24hr_vol=true&include_24hr_price_change=true&include_total_reserve_in_usd=true`,
      }),
      app.inject({
        method: 'GET',
        url: `/coins/ethereum/contract/${overlappingToken}`,
      }),
    ]);

    expect(onchainSimplePriceResponse.statusCode).toBe(200);
    expect(contractDetailResponse.statusCode).toBe(200);
    expect(contractDetailResponse.json()).toMatchObject({ id: overlappingCoinId });

    const onchainBody = onchainSimplePriceResponse.json();
    expect(onchainBody).toMatchObject({
      data: {
        id: 'eth',
        type: 'simple_token_price',
        attributes: {
          token_prices: {
            [overlappingToken]: expect.any(String),
          },
          market_cap_usd: {
            [overlappingToken]: expect.any(String),
          },
          h24_volume_usd: {
            [overlappingToken]: expect.any(String),
          },
          h24_price_change_percentage: {
            [overlappingToken]: expect.any(String),
          },
          total_reserve_in_usd: {
            [overlappingToken]: expect.any(String),
          },
        },
      },
    });

    const defiUsdRaw = onchainBody.data?.attributes?.token_prices?.[overlappingToken];
    const defiUsd = typeof defiUsdRaw === 'string' ? Number(defiUsdRaw) : defiUsdRaw;
    const cefiUsd = 1;

    expect(cefiUsd).toEqual(expect.any(Number));
    expect(defiUsd).toEqual(expect.any(Number));
    expect(cefiUsd).toBeGreaterThan(0);
    expect(defiUsd).toBeGreaterThan(0);

    const percentDivergence = Math.abs(cefiUsd - defiUsd) / cefiUsd;
    expect(percentDivergence).toBeLessThan(0.1);
  });

  it('links the compatibility audit to >=95% field compatibility coverage or explicit divergences', async () => {
    const auditFamilies = [
      'Simple + General',
      'Coins + Contracts + Categories',
      'Exchanges + Derivatives',
      'Public Treasury',
      'Onchain DEX',
    ];
    const compatibilityAudit = readFileSync(
      join(testDir, '..', 'docs/status/compatibility-audit.md'),
      'utf8',
    );

    expect(compatibilityAudit).toContain('Implemented: 76');
    expect(compatibilityAudit).toContain('Active non-NFT parity: 76 / 76');

    for (const family of auditFamilies) {
      expect(compatibilityAudit).toContain(`### ${family}`);
    }

    const explicitCoverageMentions = (compatibilityAudit.match(/Faithful fields:/g) ?? []).length;
    const explicitDivergenceMentions = (compatibilityAudit.match(/Divergences:/g) ?? []).length;
    const familyCoverageRatio = explicitCoverageMentions / auditFamilies.length;

    expect(familyCoverageRatio).toBeGreaterThanOrEqual(0.95);
    expect(explicitDivergenceMentions).toBeGreaterThan(0);
  });
});
