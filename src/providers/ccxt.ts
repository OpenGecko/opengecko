import ccxt, { type Exchange, type OHLCV, type Ticker } from 'ccxt';

export type ExchangeId = string;

export type ExchangeTickerSnapshot = {
  exchangeId: ExchangeId;
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
  exchangeId: ExchangeId;
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

export type ExchangeMarketSnapshot = {
  exchangeId: ExchangeId;
  symbol: string;
  base: string;
  quote: string;
  active: boolean;
  spot: boolean;
  baseName: string | null;
  baseNetworks?: string[];
  raw: unknown;
};

export type ExchangeNetworkSnapshot = {
  exchangeId: ExchangeId;
  networkId: string;
  networkName: string;
  chainIdentifier: number | null;
};

const VALID_EXCHANGE_IDS = new Set(ccxt.exchanges);
const exchangePool = new Map<ExchangeId, Exchange>();

export function isValidExchangeId(value: string): value is ExchangeId {
  return VALID_EXCHANGE_IDS.has(value);
}

export function getValidExchangeIds(): string[] {
  return [...ccxt.exchanges];
}

function createExchange(exchangeId: ExchangeId): Exchange {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExchangeClass = (ccxt as Record<string, any>)[exchangeId];

  if (!ExchangeClass) {
    throw new Error(`Unknown exchange: ${exchangeId}`);
  }

  return new ExchangeClass({
    enableRateLimit: true,
    timeout: 10_000,
  });
}

function getOrCreateExchange(exchangeId: ExchangeId) {
  const existing = exchangePool.get(exchangeId);

  if (existing) {
    return existing;
  }

  const exchange = createExchange(exchangeId);
  exchangePool.set(exchangeId, exchange);

  return exchange;
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

function getTickerChunkSize(exchangeId: ExchangeId) {
  if (exchangeId === 'bigone') {
    return 50;
  }

  return undefined;
}

function chunkSymbols(symbols: string[], size: number) {
  const chunks: string[][] = [];

  for (let index = 0; index < symbols.length; index += size) {
    chunks.push(symbols.slice(index, index + size));
  }

  return chunks;
}

function toTickerSnapshot(exchangeId: ExchangeId, ticker: Ticker): ExchangeTickerSnapshot {
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

function toMarketSnapshot(
  exchangeId: ExchangeId,
  market: Exchange['markets'][string],
  currencyName: string | null,
  baseNetworks: string[],
): ExchangeMarketSnapshot {
  return {
    exchangeId,
    symbol: market.symbol,
    base: market.base,
    quote: market.quote,
    active: market.active ?? true,
    spot: market.spot ?? false,
    baseName: currencyName,
    baseNetworks,
    raw: market,
  };
}

function normalizeNetworkAlias(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  if (normalized === 'erc20' || normalized === 'ethereum') {
    return 'eth';
  }

  if (normalized === 'bep20' || normalized === 'binance_smart_chain') {
    return 'bsc';
  }

  if (normalized === 'trc20' || normalized === 'trx') {
    return 'tron';
  }

  return normalized;
}

function collectCurrencyNetworkIds(exchange: Exchange, code: string) {
  const currency = exchange.currencies?.[code];

  if (!currency) {
    return [];
  }

  const networkIds = new Set<string>();

  const directNetworkValue = (currency as { network?: unknown }).network;
  const directNetwork = typeof directNetworkValue === 'string' ? normalizeNetworkAlias(directNetworkValue) : '';
  if (directNetwork) {
    networkIds.add(directNetwork);
  }

  const networkEntries = currency.networks ? Object.values(currency.networks) : [];

  for (const networkEntry of networkEntries) {
    if (!networkEntry) {
      continue;
    }

    const aliasCandidates = [
      typeof networkEntry.id === 'string' ? networkEntry.id : '',
      typeof networkEntry.network === 'string' ? networkEntry.network : '',
      typeof networkEntry.name === 'string' ? networkEntry.name : '',
    ];

    for (const candidate of aliasCandidates) {
      const normalized = normalizeNetworkAlias(candidate);
      if (normalized) {
        networkIds.add(normalized);
      }
    }
  }

  return [...networkIds].sort();
}

function toNetworkSnapshot(
  exchangeId: ExchangeId,
  networkId: string,
  networkName: string,
  chainIdentifier: number | null,
): ExchangeNetworkSnapshot {
  return {
    exchangeId,
    networkId,
    networkName,
    chainIdentifier,
  };
}

function toRequiredNumber(value: number | undefined, fieldName: string, exchangeId: ExchangeId, symbol: string) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  throw new Error(`Invalid ${fieldName} value from ${exchangeId} for ${symbol}`);
}

function toOhlcvSnapshot(exchangeId: ExchangeId, symbol: string, timeframe: string, row: OHLCV): ExchangeOhlcvSnapshot {
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

export async function fetchExchangeTicker(exchangeId: ExchangeId, symbol: string) {
  const exchange = getOrCreateExchange(exchangeId);

  await exchange.loadMarkets();
  const ticker = await exchange.fetchTicker(symbol);

  return toTickerSnapshot(exchangeId, ticker);
}

export async function fetchExchangeTickers(exchangeId: ExchangeId, symbols?: string[]) {
  const exchange = getOrCreateExchange(exchangeId);

  await exchange.loadMarkets();
  const supportedSymbols = getSupportedSymbols(exchange, symbols);

  if (symbols?.length && (!supportedSymbols || supportedSymbols.length === 0)) {
    return [];
  }

  if (exchange.has.fetchTickers) {
    const targetSymbols = supportedSymbols ?? symbols;
    const chunkSize = targetSymbols ? getTickerChunkSize(exchangeId) : undefined;

    try {
      if (chunkSize && targetSymbols && targetSymbols.length > chunkSize) {
        const tickers = await Promise.all(chunkSymbols(targetSymbols, chunkSize).map((chunk) => exchange.fetchTickers(chunk)));

        return tickers.flatMap((tickerChunk) => Object.values(tickerChunk).map((ticker) => toTickerSnapshot(exchangeId, ticker)));
      }

      const tickers = await exchange.fetchTickers(supportedSymbols);

      return Object.values(tickers).map((ticker) => toTickerSnapshot(exchangeId, ticker));
    } catch (error) {
      if (!targetSymbols?.length) {
        throw error;
      }

      const tickers = await Promise.all(
        targetSymbols.map(async (symbol) => toTickerSnapshot(exchangeId, await exchange.fetchTicker(symbol))),
      );

      return tickers;
    }
  }

  const targetSymbols = supportedSymbols ?? symbols ?? Object.keys(exchange.markets);
  const tickers = await Promise.all(
    targetSymbols.map(async (symbol) => toTickerSnapshot(exchangeId, await exchange.fetchTicker(symbol))),
  );

  return tickers;
}

export async function fetchExchangeMarkets(exchangeId: ExchangeId) {
  const exchange = getOrCreateExchange(exchangeId);

  await exchange.loadMarkets();

  return Object.values(exchange.markets).map((market) =>
    toMarketSnapshot(
      exchangeId,
      market,
      exchange.currencies?.[market.base]?.name ?? null,
      collectCurrencyNetworkIds(exchange, market.base),
    ),
  );
}

export async function fetchExchangeNetworks(exchangeId: ExchangeId) {
  const exchange = getOrCreateExchange(exchangeId);

  await exchange.loadMarkets();

  const byNetworkId = new Map<string, ExchangeNetworkSnapshot>();
  const currencies = Object.values(exchange.currencies ?? {});

  for (const currency of currencies) {
    const networkEntries = currency.networks ? Object.values(currency.networks) : [];

    for (const networkEntry of networkEntries) {
      if (!networkEntry) {
        continue;
      }

      const normalizedId = normalizeNetworkAlias(
        (typeof networkEntry.id === 'string' && networkEntry.id) ||
          (typeof networkEntry.network === 'string' && networkEntry.network) ||
          (typeof networkEntry.name === 'string' && networkEntry.name) ||
          '',
      );

      if (!normalizedId) {
        continue;
      }

      const rawChainId = networkEntry.info?.chainId;
      const numericChainId =
        typeof rawChainId === 'number'
          ? rawChainId
          : typeof rawChainId === 'string' && rawChainId.trim().length > 0
            ? Number(rawChainId)
            : Number.NaN;

      const chainIdentifier = Number.isFinite(numericChainId) ? numericChainId : null;
      const networkName =
        (typeof networkEntry.name === 'string' && networkEntry.name) ||
        (typeof networkEntry.network === 'string' && networkEntry.network) ||
        normalizedId;

      if (!byNetworkId.has(normalizedId)) {
        byNetworkId.set(normalizedId, toNetworkSnapshot(exchangeId, normalizedId, networkName, chainIdentifier));
        continue;
      }

      const existing = byNetworkId.get(normalizedId);
      if (existing && existing.chainIdentifier === null && chainIdentifier !== null) {
        byNetworkId.set(normalizedId, toNetworkSnapshot(exchangeId, normalizedId, networkName, chainIdentifier));
      }
    }
  }

  return [...byNetworkId.values()].sort((a, b) => a.networkId.localeCompare(b.networkId));
}

export async function fetchExchangeOHLCV(
  exchangeId: ExchangeId,
  symbol: string,
  timeframe: string,
  since?: number,
  limit?: number,
) {
  const exchange = getOrCreateExchange(exchangeId);

  await exchange.loadMarkets();

  if (!exchange.has.fetchOHLCV) {
    return [];
  }

  const rows = await exchange.fetchOHLCV(symbol, timeframe, since, limit);

  return rows.map((row) => toOhlcvSnapshot(exchangeId, symbol, timeframe, row));
}

export async function closeExchangePool() {
  const exchanges = [...exchangePool.values()];
  exchangePool.clear();

  await Promise.all(exchanges.map((exchange) => exchange.close()));
}
