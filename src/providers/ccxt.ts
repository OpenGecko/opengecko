import ccxt, { type Exchange, type OHLCV, type Ticker } from 'ccxt';

export type SupportedExchangeId = 'binance' | 'coinbase' | 'kraken';
export const SUPPORTED_EXCHANGE_IDS: SupportedExchangeId[] = ['binance', 'coinbase', 'kraken'];

export type ExchangeTickerSnapshot = {
  exchangeId: SupportedExchangeId;
  symbol: string;
  base: string;
  quote: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  high: number | null;
  low: number | null;
  baseVolume: number | null;
  quoteVolume: number | null;
  percentage: number | null;
  timestamp: number | null;
  raw: Ticker;
};

export type ExchangeOhlcvSnapshot = {
  exchangeId: SupportedExchangeId;
  symbol: string;
  timeframe: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  raw: OHLCV;
};

export function isSupportedExchangeId(value: string): value is SupportedExchangeId {
  return SUPPORTED_EXCHANGE_IDS.includes(value as SupportedExchangeId);
}

function createExchange(exchangeId: SupportedExchangeId): Exchange {
  const options = {
    enableRateLimit: true,
  };

  switch (exchangeId) {
    case 'binance':
      return new ccxt.binance(options);
    case 'coinbase':
      return new ccxt.coinbase(options);
    case 'kraken':
      return new ccxt.kraken(options);
  }
}

function deriveBaseQuote(symbol: string) {
  const [base = '', quote = ''] = symbol.split('/');

  return {
    base,
    quote,
  };
}

function getSupportedSymbols(exchange: Exchange, symbols?: string[]) {
  if (!symbols?.length) {
    return undefined;
  }

  return symbols.filter((symbol) => symbol in exchange.markets);
}

function toTickerSnapshot(exchangeId: SupportedExchangeId, ticker: Ticker): ExchangeTickerSnapshot {
  const { base, quote } = deriveBaseQuote(ticker.symbol);

  return {
    exchangeId,
    symbol: ticker.symbol,
    base,
    quote,
    last: ticker.last ?? null,
    bid: ticker.bid ?? null,
    ask: ticker.ask ?? null,
    high: ticker.high ?? null,
    low: ticker.low ?? null,
    baseVolume: ticker.baseVolume ?? null,
    quoteVolume: ticker.quoteVolume ?? null,
    percentage: ticker.percentage ?? null,
    timestamp: ticker.timestamp ?? null,
    raw: ticker,
  };
}

function toRequiredNumber(value: number | undefined, fieldName: string, exchangeId: SupportedExchangeId, symbol: string) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  throw new Error(`Invalid ${fieldName} value from ${exchangeId} for ${symbol}`);
}

function toOhlcvSnapshot(exchangeId: SupportedExchangeId, symbol: string, timeframe: string, row: OHLCV): ExchangeOhlcvSnapshot {
  return {
    exchangeId,
    symbol,
    timeframe,
    timestamp: toRequiredNumber(row[0], 'timestamp', exchangeId, symbol),
    open: toRequiredNumber(row[1], 'open', exchangeId, symbol),
    high: toRequiredNumber(row[2], 'high', exchangeId, symbol),
    low: toRequiredNumber(row[3], 'low', exchangeId, symbol),
    close: toRequiredNumber(row[4], 'close', exchangeId, symbol),
    volume: row[5] ?? null,
    raw: row,
  };
}

export async function fetchExchangeTicker(exchangeId: SupportedExchangeId, symbol: string) {
  const exchange = createExchange(exchangeId);

  try {
    await exchange.loadMarkets();
    const ticker = await exchange.fetchTicker(symbol);

    return toTickerSnapshot(exchangeId, ticker);
  } finally {
    await exchange.close();
  }
}

export async function fetchExchangeTickers(exchangeId: SupportedExchangeId, symbols?: string[]) {
  const exchange = createExchange(exchangeId);

  try {
    await exchange.loadMarkets();
    const supportedSymbols = getSupportedSymbols(exchange, symbols);

    if (symbols?.length && (!supportedSymbols || supportedSymbols.length === 0)) {
      return [];
    }

    if (exchange.has.fetchTickers) {
      const tickers = await exchange.fetchTickers(supportedSymbols);

      return Object.values(tickers).map((ticker) => toTickerSnapshot(exchangeId, ticker));
    }

    const targetSymbols = supportedSymbols ?? symbols ?? Object.keys(exchange.markets);
    const tickers = await Promise.all(
      targetSymbols.map(async (symbol) => toTickerSnapshot(exchangeId, await exchange.fetchTicker(symbol))),
    );

    return tickers;
  } finally {
    await exchange.close();
  }
}

export async function fetchExchangeOHLCV(
  exchangeId: SupportedExchangeId,
  symbol: string,
  timeframe: string,
  since?: number,
  limit?: number,
) {
  const exchange = createExchange(exchangeId);

  try {
    await exchange.loadMarkets();

    if (!exchange.has.fetchOHLCV) {
      return [];
    }

    const rows = await exchange.fetchOHLCV(symbol, timeframe, since, limit);

    return rows.map((row) => toOhlcvSnapshot(exchangeId, symbol, timeframe, row));
  } finally {
    await exchange.close();
  }
}
