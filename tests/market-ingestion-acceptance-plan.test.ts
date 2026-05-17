import { describe, expect, it } from 'vitest';

import type { ExchangeTickerSnapshot } from '../src/providers/ccxt';
import type { MarketQuoteSample } from '../src/services/market-snapshots';
import {
  buildAcceptedIngestionPlan,
  normalizeMarketTickerCandidate,
} from '../src/services/market-ingestion-acceptance-plan';

function ticker(overrides: Partial<ExchangeTickerSnapshot>): ExchangeTickerSnapshot {
  return {
    exchangeId: 'binance',
    symbol: 'BTC/USD',
    base: 'BTC',
    quote: 'USD',
    last: 90_000,
    bid: 89_990,
    ask: 90_010,
    high: null,
    low: null,
    baseVolume: 10,
    quoteVolume: 900_000,
    percentage: 1.5,
    timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
    raw: {} as never,
    ...overrides,
  };
}

describe('market ingestion acceptance plan', () => {
  it('preserves accepted and rejected market ticker normalization decisions with stable reason codes', () => {
    const nowMs = Date.parse('2026-03-21T00:01:00.000Z');
    const cases = [
      {
        name: 'finite current ticker',
        input: ticker({}),
        expected: {
          accepted: true,
          timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
          baseVolume: 10,
          quoteVolume: 900_000,
          percentage: 1.5,
        },
      },
      {
        name: 'unsupported symbol shape',
        input: ticker({ symbol: 'BTC/USD/PERP' }),
        expected: { accepted: false, reason: 'malformed_ticker_candidate' },
      },
      {
        name: 'symbol and assets mismatch',
        input: ticker({ symbol: 'BTC/USD', base: 'ETH' }),
        expected: { accepted: false, reason: 'malformed_ticker_candidate' },
      },
      {
        name: 'non-finite price',
        input: ticker({ last: Number.NaN }),
        expected: { accepted: false, reason: 'malformed_ticker_candidate' },
      },
      {
        name: 'non-positive price',
        input: ticker({ last: 0 }),
        expected: { accepted: false, reason: 'malformed_ticker_candidate' },
      },
      {
        name: 'invalid timestamp',
        input: ticker({ timestamp: Date.parse('2009-12-31T23:59:59.000Z') }),
        expected: { accepted: false, reason: 'malformed_ticker_candidate' },
      },
      {
        name: 'bad bid ask ordering',
        input: ticker({ bid: 90_010, ask: 89_990 }),
        expected: { accepted: false, reason: 'malformed_ticker_candidate' },
      },
      {
        name: 'provider anomaly flag',
        input: ticker({ raw: { is_anomaly: true } as never }),
        expected: { accepted: false, reason: 'malformed_ticker_candidate' },
      },
      {
        name: 'provider stale flag',
        input: ticker({ raw: { isStale: true } as never }),
        expected: { accepted: false, reason: 'malformed_ticker_candidate' },
      },
    ];

    for (const candidate of cases) {
      const result = normalizeMarketTickerCandidate(candidate.input, nowMs);
      expect(result, candidate.name).toMatchObject(candidate.expected);
    }
  });

  it('builds one accepted plan for snapshots, quotes, exchange volume, tickers, and diagnostics', () => {
    const acceptedBinance: MarketQuoteSample = {
      provider: 'binance',
      price: 90_000,
      quoteVolume: 900_000,
      changePercentage24h: 1,
      timestamp: Date.parse('2026-03-21T00:00:00.000Z'),
    };
    const acceptedCoinbase: MarketQuoteSample = {
      provider: 'coinbase',
      price: 90_100,
      quoteVolume: 901_000,
      changePercentage24h: 2,
      timestamp: Date.parse('2026-03-21T00:01:00.000Z'),
    };
    const consensusOutlier: MarketQuoteSample = {
      provider: 'kraken',
      price: 9_000_000,
      quoteVolume: 9_000_000,
      changePercentage24h: 50,
      timestamp: Date.parse('2026-03-21T00:02:00.000Z'),
    };
    const malformedHealthyPeer: MarketQuoteSample = {
      provider: 'bybit',
      price: Number.NaN,
      quoteVolume: Number.POSITIVE_INFINITY,
      changePercentage24h: Number.NaN,
      timestamp: Date.parse('2026-03-21T00:03:00.000Z'),
    };

    const plan = buildAcceptedIngestionPlan({
      marketSamples: new Map([
        ['bitcoin:usd', {
          coinId: 'bitcoin',
          vsCurrency: 'usd',
          samples: [
            acceptedBinance,
            acceptedCoinbase,
            consensusOutlier,
            malformedHealthyPeer,
          ],
        }],
      ]),
      pendingQuoteSnapshots: [
        { id: 'binance-quote', marketSample: acceptedBinance },
        { id: 'coinbase-quote', marketSample: acceptedCoinbase },
        { id: 'kraken-quote', marketSample: consensusOutlier },
      ],
      pendingCoinTickers: [
        { id: 'binance-ticker', marketSample: acceptedBinance, exchangeId: 'binance', quoteVolume: 900_000 },
        { id: 'coinbase-ticker', marketSample: acceptedCoinbase, exchangeId: 'coinbase', quoteVolume: 901_000 },
        { id: 'kraken-ticker', marketSample: consensusOutlier, exchangeId: 'kraken', quoteVolume: 9_000_000 },
      ],
    });

    expect(plan.acceptedSamples.has(acceptedBinance)).toBe(true);
    expect(plan.acceptedSamples.has(acceptedCoinbase)).toBe(true);
    expect(plan.acceptedSamples.has(consensusOutlier)).toBe(false);
    expect(plan.acceptedSamples.has(malformedHealthyPeer)).toBe(false);
    expect(plan.acceptedMarketSamples.get('bitcoin:usd')?.samples).toEqual([
      acceptedBinance,
      acceptedCoinbase,
    ]);
    expect(plan.acceptedQuoteSnapshots.map((snapshot) => snapshot.id)).toEqual([
      'binance-quote',
      'coinbase-quote',
    ]);
    expect(plan.acceptedCoinTickers.map((pendingTicker) => pendingTicker.id)).toEqual([
      'binance-ticker',
      'coinbase-ticker',
    ]);
    expect([...plan.exchangeQuoteVolumes]).toEqual([
      ['binance', 900_000],
      ['coinbase', 901_000],
    ]);
  });
});
