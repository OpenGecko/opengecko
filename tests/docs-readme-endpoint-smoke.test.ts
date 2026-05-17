import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import * as defillamaProvider from '../src/providers/defillama';
import * as sqdProvider from '../src/providers/sqd';
import { resetCurrencyApiSnapshotForTests } from '../src/services/currency-rates';
import { extractReadmeApiCoverageGetRoutes } from './helpers/readme-routes';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
  ]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([
    { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: 1773964800000, raw: {} as never },
    { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: 1773964800000, raw: {} as never },
    { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: 1773964800000, raw: {} as never },
  ]),
  fetchExchangeDerivativeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

const usdcContractAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ethUsdcPoolAddress = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const chartRange = 'from=1773446400&to=1773964800';

const readmeRouteSmokeRequests: Record<string, string> = {
  '/ping': '/ping',
  '/simple/price': '/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
  '/simple/token_price/{param}': `/simple/token_price/ethereum?contract_addresses=${usdcContractAddress}&vs_currencies=usd`,
  '/simple/supported_vs_currencies': '/simple/supported_vs_currencies',
  '/asset_platforms': '/asset_platforms',
  '/exchange_rates': '/exchange_rates',
  '/search': '/search?query=bitcoin',
  '/search/trending': '/search/trending',
  '/global': '/global',
  '/global/decentralized_finance_defi': '/global/decentralized_finance_defi',
  '/global/market_cap_chart': '/global/market_cap_chart?days=7',
  '/token_lists/{param}/all.json': '/token_lists/ethereum/all.json',
  '/coins/list': '/coins/list',
  '/coins/list/new': '/coins/list/new',
  '/coins/markets': '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&page=1&per_page=2&sparkline=false',
  '/coins/top_gainers_losers': '/coins/top_gainers_losers?vs_currency=usd&duration=24h',
  '/coins/{param}': '/coins/bitcoin?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false',
  '/coins/{param}/history': '/coins/bitcoin/history?date=20-03-2026',
  '/coins/{param}/market_chart': '/coins/bitcoin/market_chart?vs_currency=usd&days=7',
  '/coins/{param}/market_chart/range': `/coins/bitcoin/market_chart/range?vs_currency=usd&${chartRange}`,
  '/coins/{param}/ohlc': '/coins/bitcoin/ohlc?vs_currency=usd&days=7',
  '/coins/{param}/ohlc/range': `/coins/bitcoin/ohlc/range?vs_currency=usd&${chartRange}`,
  '/coins/{param}/tickers': '/coins/bitcoin/tickers',
  '/coins/{param}/circulating_supply_chart': '/coins/bitcoin/circulating_supply_chart?days=7',
  '/coins/{param}/circulating_supply_chart/range': `/coins/bitcoin/circulating_supply_chart/range?${chartRange}`,
  '/coins/{param}/total_supply_chart': '/coins/bitcoin/total_supply_chart?days=7',
  '/coins/{param}/total_supply_chart/range': `/coins/bitcoin/total_supply_chart/range?${chartRange}`,
  '/coins/categories': '/coins/categories',
  '/coins/categories/list': '/coins/categories/list',
  '/coins/{param}/contract/{param}': `/coins/ethereum/contract/${usdcContractAddress}`,
  '/coins/{param}/contract/{param}/market_chart': `/coins/ethereum/contract/${usdcContractAddress}/market_chart?vs_currency=usd&days=7`,
  '/coins/{param}/contract/{param}/market_chart/range': `/coins/ethereum/contract/${usdcContractAddress}/market_chart/range?vs_currency=usd&${chartRange}`,
  '/exchanges/list': '/exchanges/list',
  '/exchanges': '/exchanges?page=1&per_page=10',
  '/exchanges/{param}': '/exchanges/binance',
  '/exchanges/{param}/tickers': '/exchanges/binance/tickers',
  '/exchanges/{param}/volume_chart': '/exchanges/binance/volume_chart?days=7',
  '/exchanges/{param}/volume_chart/range': `/exchanges/binance/volume_chart/range?${chartRange}`,
  '/derivatives/exchanges/list': '/derivatives/exchanges/list',
  '/derivatives/exchanges': '/derivatives/exchanges',
  '/derivatives/exchanges/{param}': '/derivatives/exchanges/binance_futures',
  '/derivatives/exchanges/{param}/tickers': '/derivatives/exchanges/binance_futures/tickers',
  '/derivatives': '/derivatives',
  '/entities/list': '/entities/list',
  '/{param}/public_treasury/{param}': '/companies/public_treasury/bitcoin',
  '/public_treasury/{param}': '/public_treasury/strategy',
  '/public_treasury/{param}/{param}/holding_chart': '/public_treasury/strategy/bitcoin/holding_chart?days=7',
  '/public_treasury/{param}/transaction_history': '/public_treasury/strategy/transaction_history',
  '/onchain/networks': '/onchain/networks',
  '/onchain/networks/{param}/dexes': '/onchain/networks/eth/dexes',
  '/onchain/networks/{param}/pools': '/onchain/networks/eth/pools',
  '/onchain/networks/{param}/dexes/{param}/pools': '/onchain/networks/eth/dexes/uniswap_v3/pools',
  '/onchain/networks/{param}/new_pools': '/onchain/networks/eth/new_pools',
  '/onchain/networks/new_pools': '/onchain/networks/new_pools',
  '/onchain/networks/{param}/trending_pools': '/onchain/networks/eth/trending_pools',
  '/onchain/networks/{param}/pools/{param}': `/onchain/networks/eth/pools/${ethUsdcPoolAddress}`,
  '/onchain/networks/{param}/pools/multi/{param}': `/onchain/networks/eth/pools/multi/${ethUsdcPoolAddress}`,
  '/onchain/networks/{param}/pools/{param}/info': `/onchain/networks/eth/pools/${ethUsdcPoolAddress}/info`,
  '/onchain/networks/{param}/tokens/{param}': `/onchain/networks/eth/tokens/${usdcContractAddress}`,
  '/onchain/networks/{param}/tokens/{param}/pools': `/onchain/networks/eth/tokens/${usdcContractAddress}/pools`,
  '/onchain/networks/{param}/tokens/multi/{param}': `/onchain/networks/eth/tokens/multi/${usdcContractAddress}`,
  '/onchain/networks/{param}/tokens/{param}/info': `/onchain/networks/eth/tokens/${usdcContractAddress}/info`,
  '/onchain/networks/{param}/tokens/{param}/top_holders': `/onchain/networks/eth/tokens/${usdcContractAddress}/top_holders`,
  '/onchain/networks/{param}/tokens/{param}/top_traders': `/onchain/networks/eth/tokens/${usdcContractAddress}/top_traders`,
  '/onchain/networks/{param}/tokens/{param}/holders_chart': `/onchain/networks/eth/tokens/${usdcContractAddress}/holders_chart`,
  '/onchain/networks/{param}/tokens/{param}/ohlcv/{param}': `/onchain/networks/eth/tokens/${usdcContractAddress}/ohlcv/hour`,
  '/onchain/networks/{param}/tokens/{param}/trades': `/onchain/networks/eth/tokens/${usdcContractAddress}/trades`,
  '/onchain/networks/{param}/pools/{param}/trades': `/onchain/networks/eth/pools/${ethUsdcPoolAddress}/trades`,
  '/onchain/networks/{param}/pools/{param}/ohlcv/{param}': `/onchain/networks/eth/pools/${ethUsdcPoolAddress}/ohlcv/hour`,
  '/onchain/simple/networks/{param}/token_price/{param}': `/onchain/simple/networks/eth/token_price/${usdcContractAddress}`,
  '/onchain/networks/trending_pools': '/onchain/networks/trending_pools',
  '/onchain/search/pools': '/onchain/search/pools?query=usdc',
  '/onchain/pools/megafilter': '/onchain/pools/megafilter?networks=eth',
  '/onchain/pools/trending_search': `/onchain/pools/trending_search?pools=${ethUsdcPoolAddress}`,
  '/onchain/tokens/info_recently_updated': '/onchain/tokens/info_recently_updated?network=eth',
  '/onchain/categories': '/onchain/categories',
  '/onchain/categories/{param}/pools': '/onchain/categories/stablecoins/pools',
};

describe('README-listed endpoint smoke coverage', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-readme-smoke-'));
    resetCurrencyApiSnapshotForTests();
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);
    vi.spyOn(sqdProvider, 'fetchEthereumPoolSwapLogs').mockResolvedValue(null);
    app = buildApp({
      config: {
        host: '127.0.0.1',
        port: 3102,
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
        ccxtExchanges: ['binance'],
        providerFanoutConcurrency: 1,
        startupPrewarmBudgetMs: 0,
        disableRemoteCurrencyRefresh: true,
      },
      startBackgroundJobs: false,
    });
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns non-5xx for every CoinGecko-compatible endpoint listed in README API Coverage', async () => {
    const readmeRoutes = extractReadmeApiCoverageGetRoutes();
    const missingSmokeRequests = readmeRoutes.filter((route) => !readmeRouteSmokeRequests[route]);

    expect(missingSmokeRequests).toEqual([]);

    const failures: string[] = [];

    for (const route of readmeRoutes) {
      const url = readmeRouteSmokeRequests[route];
      const response = await app.inject({ method: 'GET', url });

      if (response.statusCode >= 500) {
        failures.push(`${route} -> ${url} returned ${response.statusCode}: ${response.body}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, 20_000);
});
