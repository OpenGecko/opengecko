import { vi } from 'vitest';

vi.mock('../src/providers/ccxt', () => ({
  fetchExchangeMarkets: vi.fn().mockImplementation(async (exchangeId: string) => {
    if (exchangeId === 'binance') return [
      { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, spot: true, baseName: 'Ethereum', raw: {} },
      { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', active: true, spot: true, baseName: 'Ripple', raw: {} },
      { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, spot: true, baseName: 'Solana', raw: {} },
      { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', active: true, spot: true, baseName: 'Dogecoin', raw: {} },
      { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', active: true, spot: true, baseName: 'Cardano', raw: {} },
      { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', active: true, spot: true, baseName: 'Chainlink', raw: {} },
      { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', active: true, spot: true, baseName: 'USD Coin', raw: {} },
    ];
    if (exchangeId === 'coinbase') return [
      { exchangeId: 'coinbase', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
      { exchangeId: 'coinbase', symbol: 'ETH/USD', base: 'ETH', quote: 'USD', active: true, spot: true, baseName: 'Ethereum', raw: {} },
    ];
    if (exchangeId === 'kraken') return [
      { exchangeId: 'kraken', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', active: true, spot: true, baseName: 'Bitcoin', raw: {} },
    ];
    return [];
  }),
  fetchExchangeTickers: vi.fn().mockImplementation(async (exchangeId: string) => {
    if (exchangeId === 'binance') return [
      { exchangeId: 'binance', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', last: 85000, bid: 84950, ask: 85050, high: 86000, low: 84000, baseVolume: 5000, quoteVolume: 425000000, percentage: 1.8, timestamp: Date.now(), raw: {} as never },
      { exchangeId: 'binance', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', last: 2000, bid: 1999, ask: 2001, high: 2050, low: 1950, baseVolume: 50000, quoteVolume: 100000000, percentage: 2.56, timestamp: Date.now(), raw: {} as never },
      { exchangeId: 'binance', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', last: 2.5, bid: 2.49, ask: 2.51, high: 2.55, low: 2.45, baseVolume: 1000000, quoteVolume: 2500000, percentage: 3.0, timestamp: Date.now(), raw: {} as never },
      { exchangeId: 'binance', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', last: 175, bid: 174.5, ask: 175.5, high: 180, low: 170, baseVolume: 100000, quoteVolume: 17500000, percentage: 4.0, timestamp: Date.now(), raw: {} as never },
      { exchangeId: 'binance', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', last: 0.28, bid: 0.279, ask: 0.281, high: 0.29, low: 0.27, baseVolume: 10000000, quoteVolume: 2800000, percentage: 5.0, timestamp: Date.now(), raw: {} as never },
      { exchangeId: 'binance', symbol: 'ADA/USDT', base: 'ADA', quote: 'USDT', last: 1.05, bid: 1.049, ask: 1.051, high: 1.08, low: 1.02, baseVolume: 5000000, quoteVolume: 5250000, percentage: 2.0, timestamp: Date.now(), raw: {} as never },
      { exchangeId: 'binance', symbol: 'LINK/USDT', base: 'LINK', quote: 'USDT', last: 24, bid: 23.9, ask: 24.1, high: 25, low: 23, baseVolume: 500000, quoteVolume: 12000000, percentage: 3.5, timestamp: Date.now(), raw: {} as never },
      { exchangeId: 'binance', symbol: 'USDC/USDT', base: 'USDC', quote: 'USDT', last: 1.0, bid: 0.9999, ask: 1.0001, high: 1.001, low: 0.999, baseVolume: 10000000, quoteVolume: 10000000, percentage: 0.01, timestamp: Date.now(), raw: {} as never },
    ];
    if (exchangeId === 'coinbase') return [
      { exchangeId: 'coinbase', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', last: 85100, bid: 85050, ask: 85150, high: 86100, low: 84100, baseVolume: 2000, quoteVolume: 170200000, percentage: 1.7, timestamp: Date.now(), raw: {} as never },
      { exchangeId: 'coinbase', symbol: 'ETH/USD', base: 'ETH', quote: 'USD', last: 2010, bid: 2009, ask: 2011, high: 2060, low: 1960, baseVolume: 20000, quoteVolume: 40200000, percentage: 2.4, timestamp: Date.now(), raw: {} as never },
    ];
    if (exchangeId === 'kraken') return [
      { exchangeId: 'kraken', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', last: 84900, bid: 84850, ask: 84950, high: 85900, low: 83900, baseVolume: 1000, quoteVolume: 84900000, percentage: 1.9, timestamp: Date.now(), raw: {} as never },
    ];
    return [];
  }),
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx', 'gate', 'mexc', 'bitget'].includes(value),
}));
