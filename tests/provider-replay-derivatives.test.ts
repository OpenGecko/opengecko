import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { derivativeTickers } from '../src/db/schema';
import { ingestDerivativeTickerReplayBatch } from '../src/services/derivatives-ingestion';
import {
  normalizeDerivativeTickerReplayBatch,
  type RawDerivativeTickerReplay,
} from '../src/services/derivatives-normalizer';
import { syncDerivativeTickers } from '../src/services/derivatives-sync';

type CcxtDerivativesReplayFixture = {
  provider: string;
  exchange_id: string;
  captured_at: string;
  tickers: RawDerivativeTickerReplay[];
};

function loadFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/ccxt-derivatives/binance-futures-tickers.json'),
    'utf8',
  )) as CcxtDerivativesReplayFixture;
}

function loadFundingOpenInterestFixture() {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/provider-replay/ccxt-derivatives/binance-funding-open-interest.json'),
    'utf8',
  )) as CcxtDerivativesReplayFixture;
}

describe('derivatives provider replay fixtures', () => {
  it('normalizes raw futures ticker snapshots into derivative rows and public derivatives responses', async () => {
    const fixture = loadFixture();
    const normalizedRows = normalizeDerivativeTickerReplayBatch(fixture.tickers);

    expect(normalizedRows).toEqual([
      {
        exchangeId: 'binance_futures',
        symbol: 'BTC/USDT:USDT',
        market: 'BTCUSDT',
        indexId: 'BTC',
        price: 64000.25,
        pricePercentageChange24h: 2.4,
        contractType: 'perpetual',
        indexValue: 63990.5,
        basis: 9.75,
        spread: 0.002344,
        fundingRate: 0.0001,
        openInterestBtc: 182500,
        tradeVolume24hBtc: 912000,
        lastTradedAt: new Date('2026-05-05T00:00:00.000Z'),
        expiredAt: null,
      },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      app.db.db.delete(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, fixture.exchange_id))
        .run();
      const ingestionOptions = {
        sourceProvider: `${fixture.provider}.${fixture.exchange_id}`,
        sourceFetchedAt: new Date(fixture.captured_at),
      };
      expect(ingestDerivativeTickerReplayBatch(app.db, fixture.tickers, ingestionOptions)).toEqual({
        tickers_written: 1,
        exchange_ids: ['binance_futures'],
        symbols: ['BTC/USDT:USDT'],
        source_kind: 'replay',
        source_provider: 'ccxt.binance_futures',
        source_fetched_at: '2026-05-05T00:00:00.000Z',
      });
      expect(ingestDerivativeTickerReplayBatch(app.db, fixture.tickers, ingestionOptions)).toEqual({
        tickers_written: 1,
        exchange_ids: ['binance_futures'],
        symbols: ['BTC/USDT:USDT'],
        source_kind: 'replay',
        source_provider: 'ccxt.binance_futures',
        source_fetched_at: '2026-05-05T00:00:00.000Z',
      });
      expect(app.db.db.select().from(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, fixture.exchange_id))
        .all()).toHaveLength(1);

      const derivativesResponse = await app.inject({
        method: 'GET',
        url: '/derivatives',
      });
      const exchangeDetailResponse = await app.inject({
        method: 'GET',
        url: '/derivatives/exchanges/binance_futures?include_tickers=true',
      });
      const coverageMatrixResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/coverage_matrix',
      });

      expect(derivativesResponse.statusCode).toBe(200);
      expect(derivativesResponse.json()).toMatchObject({
        data: expect.arrayContaining([
          {
            market: 'Binance Futures',
            market_id: 'binance_futures',
            symbol: 'BTC/USDT:USDT',
            index_id: 'BTC',
            price: 64000.25,
            price_percentage_change_24h: 2.4,
            contract_type: 'perpetual',
            index: 63990.5,
            basis: 9.75,
            spread: 0.002344,
            funding_rate: 0.0001,
            open_interest_btc: 182500,
            trade_volume_24h_btc: 912000,
            last_traded_at: '2026-05-05T00:00:00.000Z',
            expired_at: null,
          },
        ]),
        meta: {
          fixture: false,
          source: 'ccxt_derivatives',
          source_backed_tickers: 1,
          latest_source_fetched_at: '2026-05-05T00:00:00.000Z',
        },
      });
      expect(exchangeDetailResponse.statusCode).toBe(200);
      expect(exchangeDetailResponse.json()).toMatchObject({
        data: {
          id: 'binance_futures',
          tickers: [
            expect.objectContaining({
              symbol: 'BTC/USDT:USDT',
              funding_rate: 0.0001,
            }),
          ],
        },
      });
      expect(coverageMatrixResponse.statusCode).toBe(200);
      expect(coverageMatrixResponse.json().data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          family: 'derivatives',
          ownership_class: 'fixture',
          last_successful_refresh_at: '2026-05-05T00:00:00.000Z',
          evidence: expect.objectContaining({
            notes: expect.stringContaining('replay rows do not promote production coverage'),
          }),
        }),
      ]));
    } finally {
      await app.close();
    }
  });

  it('replays funding-rate and open-interest provider rows without changing public derivatives shape', async () => {
    const fixture = loadFundingOpenInterestFixture();
    const normalizedRows = normalizeDerivativeTickerReplayBatch(fixture.tickers);

    expect(normalizedRows).toEqual([
      {
        exchangeId: 'binance_futures',
        symbol: 'ETH/USDT:USDT',
        market: 'ETHUSDT',
        indexId: 'ETH',
        price: 3200.5,
        pricePercentageChange24h: -0.8,
        contractType: 'perpetual',
        indexValue: 3199.75,
        basis: 0.75,
        spread: 0.015623,
        fundingRate: 0.000075,
        openInterestBtc: 195250.5,
        tradeVolume24hBtc: 875000,
        lastTradedAt: new Date('2026-05-05T00:01:00.000Z'),
        expiredAt: null,
      },
    ]);

    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
        derivativesCcxtExchanges: 'binance_futures=binanceusdm',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      app.db.db.delete(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, fixture.exchange_id))
        .run();

      const ingestionOptions = {
        sourceProvider: `${fixture.provider}.${fixture.exchange_id}.funding_open_interest`,
        sourceFetchedAt: new Date(fixture.captured_at),
      };
      expect(ingestDerivativeTickerReplayBatch(app.db, fixture.tickers, ingestionOptions)).toEqual({
        tickers_written: 1,
        exchange_ids: ['binance_futures'],
        symbols: ['ETH/USDT:USDT'],
        source_kind: 'replay',
        source_provider: 'ccxt.binance_futures.funding_open_interest',
        source_fetched_at: '2026-05-05T00:01:00.000Z',
      });
      expect(ingestDerivativeTickerReplayBatch(app.db, fixture.tickers, ingestionOptions)).toMatchObject({
        tickers_written: 1,
        symbols: ['ETH/USDT:USDT'],
      });

      const rows = app.db.db.select().from(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, fixture.exchange_id))
        .all();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        symbol: 'ETH/USDT:USDT',
        fundingRate: 0.000075,
        openInterestBtc: 195250.5,
        sourceKind: 'replay',
        sourceProvider: 'ccxt.binance_futures.funding_open_interest',
        sourceFetchedAt: new Date('2026-05-05T00:01:00.000Z'),
      });

      const derivativesResponse = await app.inject({
        method: 'GET',
        url: '/derivatives',
      });
      const diagnosticsResponse = await app.inject({
        method: 'GET',
        url: '/diagnostics/derivatives',
      });

      expect(derivativesResponse.statusCode).toBe(200);
      const ticker = derivativesResponse.json().data.find((entry: { symbol: string }) => entry.symbol === 'ETH/USDT:USDT');
      expect(Object.keys(ticker).sort()).toEqual([
        'basis',
        'contract_type',
        'expired_at',
        'funding_rate',
        'index',
        'index_id',
        'last_traded_at',
        'market',
        'market_id',
        'open_interest_btc',
        'price',
        'price_percentage_change_24h',
        'spread',
        'symbol',
        'trade_volume_24h_btc',
      ]);
      expect(ticker).toMatchObject({
        market: 'Binance Futures',
        market_id: 'binance_futures',
        symbol: 'ETH/USDT:USDT',
        funding_rate: 0.000075,
        open_interest_btc: 195250.5,
        trade_volume_24h_btc: 875000,
      });

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data).toMatchObject({
        exchanges: expect.arrayContaining([
          expect.objectContaining({
            exchange_id: 'binance_futures',
            status: 'source_backed',
            ticker_counts: {
              total: 1,
              source_backed: 1,
              fixture: 0,
            },
            latest_source_fetched_at: '2026-05-05T00:01:00.000Z',
          }),
        ]),
        gaps: expect.objectContaining({
          configured_without_source_rows: [],
        }),
      });
    } finally {
      await app.close();
    }
  });

  it('runs the optional derivatives sync path through source-attributed ingestion', async () => {
    const fixture = loadFixture();
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      app.db.db.delete(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, fixture.exchange_id))
        .run();

      const result = await syncDerivativeTickers(app.db, {
        venues: [{ exchangeId: fixture.exchange_id, providerExchangeId: 'binanceusdm' }],
        now: new Date(fixture.captured_at),
        fetcher: async (_providerExchangeId, exchangeId) => fixture.tickers.map((ticker) => ({
          ...ticker,
          exchangeId,
        })),
      });

      expect(result).toMatchObject({
        venues_attempted: 1,
        tickers_fetched: 1,
        tickers_written: 1,
        rowsWritten: 1,
        partialFailures: [],
        source_fetched_at: '2026-05-05T00:00:00.000Z',
        results: [{
          exchange_id: 'binance_futures',
          provider_exchange_id: 'binanceusdm',
          status: 'success',
          tickers_fetched: 1,
          tickers_written: 1,
          last_error: null,
        }],
      });

      const rows = app.db.db.select().from(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, fixture.exchange_id))
        .all();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        symbol: 'BTC/USDT:USDT',
        sourceKind: 'live',
        sourceProvider: 'ccxt.binanceusdm',
        sourceFetchedAt: new Date('2026-05-05T00:00:00.000Z'),
      });
    } finally {
      await app.close();
    }
  });

  it('defaults replay ingestion provenance when source options are omitted', async () => {
    const fixture = loadFixture();
    const app = buildApp({
      config: {
        databaseUrl: ':memory:',
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      await app.ready();
      app.db.db.delete(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, fixture.exchange_id))
        .run();

      expect(ingestDerivativeTickerReplayBatch(app.db, fixture.tickers)).toMatchObject({
        source_kind: 'replay',
        source_provider: null,
        source_fetched_at: null,
      });

      const rows = app.db.db.select().from(derivativeTickers)
        .where(eq(derivativeTickers.exchangeId, fixture.exchange_id))
        .all();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sourceKind: 'replay',
        sourceProvider: null,
        sourceFetchedAt: null,
      });
    } finally {
      await app.close();
    }
  });
});
