import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

const COINS_BASELINE_ROUTES = [
  {
    fixture: 'coins-list.json',
    url: '/coins/list?include_platform=true',
  },
  {
    fixture: 'coins-markets.json',
    url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
  },
  {
    fixture: 'coin-detail.json',
    url: '/coins/bitcoin?localization=false&tickers=true&market_data=true&community_data=true&developer_data=true&sparkline=false',
  },
  {
    fixture: 'coin-market-chart.json',
    url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily',
  },
  {
    fixture: 'coin-ohlc.json',
    url: '/coins/bitcoin/ohlc?vs_currency=usd&days=14&interval=daily',
  },
  {
    fixture: 'coin-tickers.json',
    url: '/coins/bitcoin/tickers?exchange_ids=binance,coinbase&include_exchange_logo=true&depth=true&page=1&per_page=5',
  },
] as const;

describe('coins route byte baselines', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: [],
        logLevel: 'silent',
        disableRemoteCurrencyRefresh: true,
      },
      startBackgroundJobs: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(COINS_BASELINE_ROUTES)('keeps $url byte-identical to its pre-split baseline', async ({ fixture, url }) => {
    const expectedBody = await readFile(
      join(process.cwd(), 'tests/fixtures/coins-baselines', fixture),
      'utf8',
    );
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(expectedBody);
  });
});
