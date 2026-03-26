import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app';

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
const REPRESENTATIVE_FRONTEND_CRITICAL_IDS = ['bitcoin', 'ethereum', 'solana', 'ripple', 'dogecoin'] as const;

function runScript(command: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('bash', [command], {
      cwd: '/home/whoami/dev/openGecko',
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('module contract verification scripts', () => {
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
        { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
        { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      ];
      return [];
    });

    mockedFetchExchangeTickers.mockImplementation(async (exchangeId) => {
      if (exchangeId === 'binance') return [
        { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
        { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
        { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp: Date.now(), raw: {} as never },
        { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
      ];
      if (exchangeId === 'coinbase') return [
        { exchangeId: 'coinbase', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', last: 85100, bid: 85050, ask: 85150, high: 86100, low: 84100, baseVolume: 3000, quoteVolume: 255300000, percentage: 1.7, timestamp: Date.now(), raw: {} as never },
      ];
      return [];
    });

    mockedFetchExchangeOHLCV.mockResolvedValue([]);

    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-frontend-contract-'));
    app = buildApp({
      config: {
        databaseUrl: join(tempDir, 'test.db'),
        logLevel: 'silent',
        marketFreshnessThresholdSeconds: 300,
      },
      startBackgroundJobs: true,
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function expectScriptToPass(command: string, title: string, checks: string[]) {
    const address = app.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('expected Fastify to listen on an ephemeral TCP port');
    }

    const result = await runScript(command, {
      BASE_URL: `http://127.0.0.1:${address.port}`,
    });

    if (result.code !== 0) {
      throw new Error(`module contract script failed (${command})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(title);

    for (const check of checks) {
      expect(result.stdout).toContain(check);
    }
  }

  it('passes frontend minimum contract checks for markets, detail, and chart endpoints', async () => {
    await expectScriptToPass(
      'scripts/modules/mr-market-frontend/mr-market-frontend.sh',
      'OpenGecko Mr.Market Frontend Contract Checks',
      [
        'markets returns frontend-required list fields',
        'coin detail returns frontend-required header and info fields',
        'market chart returns frontend-required prices series',
      ],
    );
  });

  it('passes exchanges contract checks for spot and derivatives endpoints', async () => {
    await expectScriptToPass(
      'scripts/modules/exchanges/exchanges.sh',
      'OpenGecko Exchanges Module Checks',
      [
        'exchange list returns exchange identifiers',
        'exchange detail returns overview fields and ticker array',
        'derivatives exchange detail can include ticker payloads',
      ],
    );
  });

  it('passes global contract checks for aggregate market endpoints', async () => {
    await expectScriptToPass(
      'scripts/modules/global/global.sh',
      'OpenGecko Global Module Checks',
      [
        'global response returns aggregate market fields',
        'market cap chart returns timestamp/value pairs',
        'defi response returns aggregate defi fields',
      ],
    );
  });

  it('passes search contract checks for query and trending endpoints', async () => {
    await expectScriptToPass(
      'scripts/modules/search/search.sh',
      'OpenGecko Search Module Checks',
      [
        'search response groups results by resource family',
        'search query bitcoin returns at least one coin hit',
        'trending show_max limits both coin and category groups',
      ],
    );
  });

  it('passes assets contract checks for platforms and token lists', async () => {
    await expectScriptToPass(
      'scripts/modules/assets/assets.sh',
      'OpenGecko Assets Module Checks',
      [
        'asset platforms include ethereum',
        'token list returns uniswap-style metadata envelope',
        'ethereum token list includes the seeded USDC contract',
      ],
    );
  });

  it('passes coins contract checks for registry, market, and chart endpoints', async () => {
    await expectScriptToPass(
      'scripts/modules/coins/coins.sh',
      'OpenGecko Coins Module Checks',
      [
        'coin list includes platform data when requested',
        'coin detail includes market data and ticker arrays by default',
        'circulating supply chart range returns named series envelopes',
        'total supply chart returns named series envelopes',
        'contract route resolves the seeded USDC contract',
      ],
    );
  });

  it('passes broad endpoint smoke checks for current endpoint families', { timeout: 20000 }, async () => {
    await expectScriptToPass(
      'scripts/test-endpoints.sh',
      'OpenGecko Endpoint Tester',
      [
        'GET /exchange_rates',
        'GET /coins/bitcoin/ohlc?days=30',
        'GET /derivatives/exchanges/list',
        'GET /public_treasury/strategy/transaction_history?order=date_desc',
        'GET /onchain/networks/eth/new_pools',
        'GET /diagnostics/chain_coverage',
      ],
    );
  });

  it('returns the frontend minimum detail fields directly from /coins/:id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/bitcoin',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      id: string;
      symbol: string;
      name: string;
      description: { en: string };
      image: { thumb: string | null };
      genesis_date: string | null;
      tickers: unknown[];
      market_data: { current_price: { usd: number | null } } | null;
    };

    expect(body.id).toBe('bitcoin');
    expect(body.symbol).toBe('btc');
    expect(body.name).toBe('Bitcoin');
    expect(body.description.en).toEqual(expect.any(String));
    expect(body.description.en.trim().length).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(body.image, 'thumb')).toBe(true);
    expect(body.image.thumb === null || typeof body.image.thumb === 'string').toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, 'genesis_date')).toBe(true);
    expect(body.genesis_date === null || typeof body.genesis_date === 'string').toBe(true);
    expect(Array.isArray(body.tickers)).toBe(true);
    expect(body.market_data).not.toBeNull();
    expect(body.market_data?.current_price.usd).toBeTypeOf('number');
  });

  it('keeps frontend-critical market and detail images usable for representative assets', async () => {
    const marketsResponse = await app.inject({
      method: 'GET',
      url: `/coins/markets?vs_currency=usd&ids=${REPRESENTATIVE_FRONTEND_CRITICAL_IDS.join(',')}`,
    });

    expect(marketsResponse.statusCode).toBe(200);

    const marketsBody = marketsResponse.json() as Array<{ id: string; image: string | null }>;
    const representativeRows = marketsBody.filter((row) => REPRESENTATIVE_FRONTEND_CRITICAL_IDS.includes(row.id as typeof REPRESENTATIVE_FRONTEND_CRITICAL_IDS[number]));

    expect(representativeRows).toHaveLength(REPRESENTATIVE_FRONTEND_CRITICAL_IDS.length);
    expect(representativeRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bitcoin', image: expect.any(String) }),
      expect.objectContaining({ id: 'ethereum', image: expect.any(String) }),
      expect.objectContaining({ id: 'solana', image: expect.any(String) }),
      expect.objectContaining({ id: 'ripple', image: expect.any(String) }),
      expect.objectContaining({ id: 'dogecoin', image: expect.any(String) }),
    ]));
    for (const row of representativeRows) {
      expect(row.image).not.toBeNull();
      expect(row.image?.trim().length).toBeGreaterThan(0);
    }

    for (const coinId of REPRESENTATIVE_FRONTEND_CRITICAL_IDS) {
      const detailResponse = await app.inject({
        method: 'GET',
        url: `/coins/${coinId}`,
      });

      expect(detailResponse.statusCode).toBe(200);

      const detailBody = detailResponse.json() as {
        image: { thumb: string | null; small: string | null; large: string | null };
      };

      expect(detailBody.image.thumb).toEqual(expect.any(String));
      expect(detailBody.image.small).toEqual(expect.any(String));
      expect(detailBody.image.large).toEqual(expect.any(String));
      expect(detailBody.image.thumb?.trim().length).toBeGreaterThan(0);
      expect(detailBody.image.small?.trim().length).toBeGreaterThan(0);
      expect(detailBody.image.large?.trim().length).toBeGreaterThan(0);
    }
  });
});
