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
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeMarkets, fetchExchangeTickers, fetchExchangeOHLCV } from '../src/providers/ccxt';

const mockedFetchExchangeMarkets = fetchExchangeMarkets as ReturnType<typeof vi.fn>;
const mockedFetchExchangeTickers = fetchExchangeTickers as ReturnType<typeof vi.fn>;
const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;

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

describe('frontend contract verification script', () => {
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

  it('passes frontend minimum contract checks for markets, detail, and chart endpoints', async () => {
    const address = app.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('expected Fastify to listen on an ephemeral TCP port');
    }

    const result = await runScript('scripts/modules/mr-market-frontend/mr-market-frontend.sh', {
      BASE_URL: `http://127.0.0.1:${address.port}`,
    });

    if (result.code !== 0) {
      throw new Error(`frontend contract script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OpenGecko Mr.Market Frontend Contract Checks');
    expect(result.stdout).toContain('markets returns frontend-required list fields');
    expect(result.stdout).toContain('coin detail returns frontend-required header and info fields');
    expect(result.stdout).toContain('market chart returns frontend-required prices series');
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
});
