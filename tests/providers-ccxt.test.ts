import { describe, expect, it, vi } from 'vitest';

const binanceFetchTickers = vi.fn();
const binanceFetchTicker = vi.fn();
const bigoneFetchTickers = vi.fn();
const nofetchFetchTicker = vi.fn();

vi.mock('ccxt', () => {
  class BinanceExchange {
    id = 'binance';
    markets = {
      'BTC/USDT': { symbol: 'BTC/USDT' },
      'ETH/USDT': { symbol: 'ETH/USDT' },
      'SOL/USDT': { symbol: 'SOL/USDT' },
      'BTC/USDT:USDT': {
        symbol: 'BTC/USDT:USDT',
        id: 'BTCUSDT',
        base: 'BTC',
        quote: 'USDT',
        contract: true,
        swap: true,
        future: false,
      },
    };
    has = { fetchTickers: true };

    async loadMarkets() {
      return this.markets;
    }

    async fetchTickers(symbols?: string[]) {
      return binanceFetchTickers(symbols);
    }

    async fetchTicker(symbol: string) {
      return binanceFetchTicker(symbol);
    }

    async close() {
      return undefined;
    }
  }

  class BigoneExchange {
    id = 'bigone';
    markets = Object.fromEntries(Array.from({ length: 120 }, (_, index) => {
      const symbol = `COIN${index}/USDT`;
      return [symbol, { symbol }];
    }));
    has = { fetchTickers: true };

    async loadMarkets() {
      return this.markets;
    }

    async fetchTickers(symbols?: string[]) {
      return bigoneFetchTickers(symbols);
    }

    async close() {
      return undefined;
    }
  }

  class NofetchExchange {
    id = 'nofetch';
    markets = {
      'BTC/USDT:USDT': {
        symbol: 'BTC/USDT:USDT',
        id: 'BTCUSDT',
        base: 'BTC',
        quote: 'USDT',
        contract: true,
        swap: false,
        future: true,
        expiry: 1782547200000,
      },
      'ETH/USDT': {
        symbol: 'ETH/USDT',
        id: 'ETHUSDT',
        base: 'ETH',
        quote: 'USDT',
        contract: false,
        spot: true,
      },
    };
    has = { fetchTickers: false };

    async loadMarkets() {
      return this.markets;
    }

    async fetchTicker(symbol: string) {
      return nofetchFetchTicker(symbol);
    }

    async close() {
      return undefined;
    }
  }

  const ccxtModule = {
    exchanges: ['binance', 'bigone', 'nofetch'],
    binance: BinanceExchange,
    bigone: BigoneExchange,
    nofetch: NofetchExchange,
  };

  return {
    default: ccxtModule,
    exchanges: ccxtModule.exchanges,
  };
});

describe('ccxt provider adapter', () => {
  it('recognizes known exchange ids from the ccxt exchange name list', async () => {
    const { getValidExchangeIds, isValidExchangeId } = await import('../src/providers/ccxt');

    expect(isValidExchangeId('binance')).toBe(true);
    expect(isValidExchangeId('bigone')).toBe(true);
    expect(isValidExchangeId('coinbase')).toBe(false);
    expect(getValidExchangeIds()).toEqual(['binance', 'bigone', 'nofetch']);
  });

  it('creates known exchange clients from the ccxt module export', async () => {
    binanceFetchTickers.mockReset();
    binanceFetchTicker.mockReset();
    bigoneFetchTickers.mockReset();

    binanceFetchTickers.mockResolvedValue({
      'BTC/USDT': {
        symbol: 'BTC/USDT',
        last: 90000,
        bid: 89900,
        ask: 90100,
        high: 91000,
        low: 89000,
        baseVolume: 100,
        quoteVolume: 9000000,
        percentage: 1.2,
        timestamp: 1774191714871,
      },
    });

    const { fetchExchangeTickers } = await import('../src/providers/ccxt');

    const rows = await fetchExchangeTickers('binance', ['BTC/USDT']);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      exchangeId: 'binance',
      symbol: 'BTC/USDT',
      last: 90000,
    });
  });

  it('falls back to smaller ticker requests when binance bulk fetch fails', async () => {
    binanceFetchTickers.mockReset();
    binanceFetchTicker.mockReset();
    bigoneFetchTickers.mockReset();

    binanceFetchTickers.mockRejectedValueOnce(new TypeError("Cannot use 'in' operator to search for 'time' in <"));
    binanceFetchTicker.mockImplementation(async (symbol: string) => ({
      symbol,
      last: symbol === 'BTC/USDT' ? 90000 : 2000,
      bid: 1,
      ask: 1,
      high: 1,
      low: 1,
      baseVolume: 1,
      quoteVolume: 1,
      percentage: 1,
      timestamp: 1774191714871,
    }));

    const { fetchExchangeTickers } = await import('../src/providers/ccxt');

    const rows = await fetchExchangeTickers('binance', ['BTC/USDT', 'ETH/USDT']);

    expect(rows.map((row) => row.symbol)).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(binanceFetchTickers).toHaveBeenCalledTimes(1);
    expect(binanceFetchTicker).toHaveBeenCalledTimes(2);
  });

  it('chunks bigone spot ticker fetches to avoid oversized requests', async () => {
    binanceFetchTickers.mockReset();
    binanceFetchTicker.mockReset();
    bigoneFetchTickers.mockReset();

    bigoneFetchTickers.mockImplementation(async (symbols?: string[]) => Object.fromEntries((symbols ?? []).map((symbol) => [symbol, {
      symbol,
      last: 1,
      bid: 1,
      ask: 1,
      high: 1,
      low: 1,
      baseVolume: 1,
      quoteVolume: 1,
      percentage: 1,
      timestamp: 1774191714871,
    }])));

    const { fetchExchangeTickers } = await import('../src/providers/ccxt');

    const symbols = Array.from({ length: 120 }, (_, index) => `COIN${index}/USDT`);
    const rows = await fetchExchangeTickers('bigone', symbols);

    expect(rows).toHaveLength(120);
    expect(bigoneFetchTickers.mock.calls.length).toBeGreaterThan(1);
    expect(bigoneFetchTickers.mock.calls.every(([chunk]) => Array.isArray(chunk) && chunk.length <= 50)).toBe(true);
  });

  it('fetches only derivative market tickers for configured futures venues', async () => {
    binanceFetchTickers.mockReset();
    binanceFetchTicker.mockReset();
    bigoneFetchTickers.mockReset();

    binanceFetchTickers.mockImplementation(async (symbols?: string[]) => Object.fromEntries((symbols ?? []).map((symbol) => [symbol, {
      symbol,
      last: 64000.25,
      bid: 63999.5,
      ask: 64001,
      percentage: 2.4,
      timestamp: 1777939200000,
      info: {
        markPrice: '64000.25',
        indexPrice: '63990.5',
        fundingRate: '0.0001',
        openInterestBtc: '182500',
        tradeVolume24hBtc: '912000',
      },
    }])));

    const { fetchExchangeDerivativeTickers } = await import('../src/providers/ccxt');

    const rows = await fetchExchangeDerivativeTickers('binance', 'binance_futures');

    expect(binanceFetchTickers).toHaveBeenCalledWith(['BTC/USDT:USDT']);
    expect(rows).toEqual([
      expect.objectContaining({
        exchangeId: 'binance_futures',
        symbol: 'BTC/USDT:USDT',
        market: 'BTCUSDT',
        contractType: 'perpetual',
        markPrice: 64000.25,
        fundingRate: 0.0001,
        openInterestBtc: 182500,
        tradeVolume24hBtc: 912000,
      }),
    ]);
  });

  it('falls back to single derivative ticker fetches when bulk derivative fetch is unsupported', async () => {
    nofetchFetchTicker.mockReset();
    nofetchFetchTicker.mockImplementation(async (symbol: string) => ({
      symbol,
      last: 85840,
      bid: 85800,
      ask: 85880,
      percentage: 1.1,
      timestamp: 1777939200000,
      info: {},
    }));

    const { fetchExchangeDerivativeTickers } = await import('../src/providers/ccxt');

    const rows = await fetchExchangeDerivativeTickers('nofetch', 'bybit');

    expect(nofetchFetchTicker).toHaveBeenCalledWith('BTC/USDT:USDT');
    expect(rows).toEqual([
      expect.objectContaining({
        exchangeId: 'bybit',
        symbol: 'BTC/USDT:USDT',
        contractType: 'future',
        expiredAt: 1782547200000,
      }),
    ]);
  });

  it('returns no derivative tickers when configured symbols are unsupported', async () => {
    binanceFetchTickers.mockReset();

    const { fetchExchangeDerivativeTickers } = await import('../src/providers/ccxt');

    await expect(fetchExchangeDerivativeTickers('binance', 'binance_futures', ['DOGE/USDT:USDT'])).resolves.toEqual([]);
    expect(binanceFetchTickers).not.toHaveBeenCalled();
  });
});
