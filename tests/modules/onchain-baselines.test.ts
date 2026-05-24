import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app';
import * as defillamaProvider from '../../src/providers/defillama';
import { resetCurrencyApiSnapshotForTests } from '../../src/services/currency-rates';

vi.mock('../../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockResolvedValue([]),
  fetchExchangeTickers: vi.fn().mockResolvedValue([]),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

vi.mock('../../src/providers/sqd', () => ({
  fetchEthereumPoolSwapLogs: vi.fn().mockResolvedValue(null),
  resolveAddressLabel: vi.fn((address: string) => ({
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap Universal Router',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router 2',
    '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640': 'Uniswap V3: USDC-WETH',
    '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7': 'Curve: FRAX-USDC',
  })[address.toLowerCase()] ?? null),
}));

type BaselineFixture = {
  statusCode: number;
  payload: string;
};

const baselineDir = join(process.cwd(), 'tests/fixtures/onchain-baselines');
const updateBaselines = process.env.UPDATE_ONCHAIN_BASELINES === '1';

const representativeOnchainRequests = [
  {
    name: 'networks',
    url: '/onchain/networks',
  },
  {
    name: 'dex',
    url: '/onchain/networks/eth/dexes',
  },
  {
    name: 'pool-detail',
    url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640?include=network,dex&include_volume_breakdown=true',
  },
  {
    name: 'token-detail',
    url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48?include=top_pools',
  },
  {
    name: 'trades',
    url: '/onchain/networks/eth/pools/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640/trades?limit=2',
  },
  {
    name: 'info',
    url: '/onchain/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/info',
  },
  {
    name: 'megafilter',
    url: '/onchain/pools/megafilter?networks=eth&include=base_token,quote_token&per_page=2',
  },
] as const;

function fixturePath(name: string) {
  return join(baselineDir, `${name}.json`);
}

function readFixture(name: string): BaselineFixture {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as BaselineFixture;
}

function writeFixture(name: string, fixture: BaselineFixture) {
  mkdirSync(dirname(fixturePath(name)), { recursive: true });
  writeFileSync(fixturePath(name), `${JSON.stringify(fixture, null, 2)}\n`);
}

describe('onchain route decomposition baselines', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-onchain-baseline-'));
    vi.restoreAllMocks();
    resetCurrencyApiSnapshotForTests();
    vi.spyOn(defillamaProvider, 'fetchDefillamaPoolData').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDexVolumes').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaDiscoveredPools').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokenPrices').mockResolvedValue(null);
    vi.spyOn(defillamaProvider, 'fetchDefillamaTokens').mockResolvedValue(null);

    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        ccxtExchanges: ['binance'],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  for (const request of representativeOnchainRequests) {
    it(`matches the pre-split ${request.name} onchain baseline`, async () => {
      if (!app) {
        throw new Error('Test app was not initialized.');
      }

      const response = await app.inject({
        method: 'GET',
        url: request.url,
      });
      const actual: BaselineFixture = {
        statusCode: response.statusCode,
        payload: response.payload,
      };

      if (updateBaselines || !existsSync(fixturePath(request.name))) {
        writeFixture(request.name, actual);
      }

      expect(actual).toEqual(readFixture(request.name));
    });
  }
});
