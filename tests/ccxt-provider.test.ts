import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadMarkets = vi.fn(async function loadMarkets(this: { marketsLoaded?: boolean }) {
  this.marketsLoaded = true;
});
const fetchTicker = vi.fn(async (symbol: string) => ({
  symbol,
  last: 10,
  bid: 9,
  ask: 11,
  high: 12,
  low: 8,
  baseVolume: 100,
  quoteVolume: 1000,
  percentage: 1,
  timestamp: 123,
}));
const close = vi.fn(async () => {});
const exchangeConstructor = vi.fn().mockImplementation(() => ({
  has: { fetchTickers: false, fetchOHLCV: false },
  markets: { 'BTC/USDT': { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true } },
  currencies: { BTC: { name: 'Bitcoin' } },
  loadMarkets,
  fetchTicker,
  close,
}));

vi.mock('ccxt', () => ({
  default: {
    exchanges: ['binance'],
    binance: exchangeConstructor,
  },
}));

describe('ccxt provider pooling', () => {
  beforeEach(() => {
    exchangeConstructor.mockClear();
    loadMarkets.mockClear();
    fetchTicker.mockClear();
    close.mockClear();
  });

  afterEach(async () => {
    const { closeExchangePool } = await import('../src/providers/ccxt');
    await closeExchangePool();
  });

  it('reuses an exchange instance for repeated requests', async () => {
    const { fetchExchangeTicker } = await import('../src/providers/ccxt');

    await fetchExchangeTicker('binance', 'BTC/USDT');
    await fetchExchangeTicker('binance', 'BTC/USDT');

    expect(exchangeConstructor).toHaveBeenCalledTimes(1);
    expect(fetchTicker).toHaveBeenCalledTimes(2);
  });

  it('closes pooled exchanges when requested', async () => {
    const { fetchExchangeTicker, closeExchangePool } = await import('../src/providers/ccxt');

    await fetchExchangeTicker('binance', 'BTC/USDT');
    await closeExchangePool();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
