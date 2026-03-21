import { and, eq } from 'drizzle-orm';

import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { coinTickers, exchanges, marketSnapshots } from '../db/schema';
import { coins } from '../db/schema';
import { fetchExchangeTickers, type SupportedExchangeId } from '../providers/ccxt';
import { syncCoinCatalogWithBinance } from './coin-catalog-sync';
import { recordQuoteSnapshot, toDailyBucket, toMinuteBucket, upsertCanonicalCandle } from './candle-store';
import { getCurrencyApiSnapshot } from './currency-rates';
import { buildLiveSnapshotValue, createMarketQuoteAccumulator, type MarketQuoteAccumulator } from './market-snapshots';

const SUPPORTED_EXCHANGES: SupportedExchangeId[] = ['binance', 'coinbase', 'kraken'];

const EXCHANGE_TABLE_IDS = {
  binance: 'binance',
  coinbase: 'coinbase_exchange',
  kraken: 'kraken',
} satisfies Record<SupportedExchangeId, string>;

type SymbolIndexEntry = {
  coinId: string;
  vsCurrency: 'usd' | 'eur';
};

type PendingCoinTicker = {
  coinId: string;
  exchangeId: string;
  base: string;
  target: string;
  marketName: string;
  last: number;
  volume: number | null;
  quoteVolume: number | null;
  bidAskSpreadPercentage: number | null;
  lastTradedAt: Date;
  lastFetchAt: Date;
  trustScore: string | null;
  isAnomaly: boolean;
  isStale: boolean;
  tradeUrl: string | null;
  tokenInfoUrl: string | null;
  coinGeckoUrl: string;
  vsCurrency: 'usd' | 'eur';
};

function buildRequestedSymbolIndex(database: AppDatabase) {
  const symbolEntries: Array<[string, SymbolIndexEntry]> = [];
  const databaseCoinsForRefresh = database.db.select({ id: coins.id, symbol: coins.symbol }).from(coins).all();

  for (const coin of databaseCoinsForRefresh) {
    const symbol = coin.symbol.toUpperCase();

    for (const vsCurrency of ['usd', 'eur'] as const) {
      const quoteCandidates = vsCurrency === 'usd' ? ['USD', 'USDT'] : ['EUR'];

      for (const quote of quoteCandidates) {
        symbolEntries.push([`${symbol}/${quote}`, { coinId: coin.id, vsCurrency }]);
      }
    }
  }

  return new Map<string, SymbolIndexEntry>(symbolEntries);
}

function isSupportedExchangeId(value: string): value is SupportedExchangeId {
  return SUPPORTED_EXCHANGES.includes(value as SupportedExchangeId);
}

function buildBidAskSpreadPercentage(bid: number | null, ask: number | null) {
  if (bid === null || ask === null || ask <= 0) {
    return null;
  }

  return ((ask - bid) / ask) * 100;
}

function buildTradeUrl(exchangeId: SupportedExchangeId, base: string, target: string) {
  switch (exchangeId) {
    case 'binance':
      return `https://www.binance.com/en/trade/${base}_${target}`;
    case 'coinbase':
      return `https://exchange.coinbase.com/trade/${base}-${target}`;
    case 'kraken':
      return `https://pro.kraken.com/app/trade/${base}-${target}`;
  }
}

function buildTokenInfoUrl(exchangeId: SupportedExchangeId, coinId: string) {
  switch (exchangeId) {
    case 'binance':
      return `https://www.binance.com/en/price/${coinId}`;
    case 'coinbase':
      return `https://www.coinbase.com/price/${coinId}`;
    case 'kraken':
      return null;
  }
}

function upsertLiveCoinTicker(
  database: AppDatabase,
  pendingTicker: PendingCoinTicker,
  conversionContext: {
    eurPerUsd: number;
    usdPriceByCoinId: Map<string, number>;
    btcUsdPrice: number | null;
  },
) {
  const convertedLastUsd = conversionContext.usdPriceByCoinId.get(pendingTicker.coinId)
    ?? (pendingTicker.vsCurrency === 'eur' ? pendingTicker.last / conversionContext.eurPerUsd : pendingTicker.last);
  const convertedVolumeUsd = pendingTicker.quoteVolume === null
    ? (pendingTicker.volume === null ? null : pendingTicker.volume * convertedLastUsd)
    : (pendingTicker.vsCurrency === 'eur' ? pendingTicker.quoteVolume / conversionContext.eurPerUsd : pendingTicker.quoteVolume);
  const convertedLastBtc = conversionContext.btcUsdPrice === null ? null : convertedLastUsd / conversionContext.btcUsdPrice;

  database.db
    .insert(coinTickers)
    .values({
      coinId: pendingTicker.coinId,
      exchangeId: pendingTicker.exchangeId,
      base: pendingTicker.base,
      target: pendingTicker.target,
      marketName: pendingTicker.marketName,
      last: pendingTicker.last,
      volume: pendingTicker.volume,
      convertedLastUsd,
      convertedLastBtc,
      convertedVolumeUsd,
      bidAskSpreadPercentage: pendingTicker.bidAskSpreadPercentage,
      trustScore: pendingTicker.trustScore,
      lastTradedAt: pendingTicker.lastTradedAt,
      lastFetchAt: pendingTicker.lastFetchAt,
      isAnomaly: pendingTicker.isAnomaly,
      isStale: pendingTicker.isStale,
      tradeUrl: pendingTicker.tradeUrl,
      tokenInfoUrl: pendingTicker.tokenInfoUrl,
      coinGeckoUrl: pendingTicker.coinGeckoUrl,
    })
    .onConflictDoUpdate({
      target: [coinTickers.coinId, coinTickers.exchangeId, coinTickers.base, coinTickers.target],
      set: {
        marketName: pendingTicker.marketName,
        last: pendingTicker.last,
        volume: pendingTicker.volume,
        convertedLastUsd,
        convertedLastBtc,
        convertedVolumeUsd,
        bidAskSpreadPercentage: pendingTicker.bidAskSpreadPercentage,
        trustScore: pendingTicker.trustScore,
        lastTradedAt: pendingTicker.lastTradedAt,
        lastFetchAt: pendingTicker.lastFetchAt,
        isAnomaly: pendingTicker.isAnomaly,
        isStale: pendingTicker.isStale,
        tradeUrl: pendingTicker.tradeUrl,
        tokenInfoUrl: pendingTicker.tokenInfoUrl,
        coinGeckoUrl: pendingTicker.coinGeckoUrl,
      },
    })
    .run();
}

export async function runMarketRefreshOnce(database: AppDatabase, config: Pick<AppConfig, 'ccxtExchanges'>) {
  const exchangeIds = config.ccxtExchanges.filter(isSupportedExchangeId);

  if (exchangeIds.length === 0) {
    return;
  }

  await syncCoinCatalogWithBinance(database);

  const symbolIndex = buildRequestedSymbolIndex(database);
  const requestedSymbols = [...symbolIndex.keys()];
  const accumulators = new Map<string, { coinId: string; vsCurrency: string; accumulator: MarketQuoteAccumulator }>();
  const pendingCoinTickers: PendingCoinTicker[] = [];
  const exchangeTrustScoreById = new Map(
    database.db.select({ id: exchanges.id, trustScore: exchanges.trustScore }).from(exchanges).all().map((row) => [row.id, row.trustScore]),
  );

  for (const exchangeId of exchangeIds) {
    const tickers = await fetchExchangeTickers(exchangeId, requestedSymbols);

    for (const ticker of tickers) {
      const marketTarget = symbolIndex.get(ticker.symbol);

      if (!marketTarget || ticker.last === null) {
        continue;
      }

      const normalizedExchangeId = EXCHANGE_TABLE_IDS[exchangeId];
      const fetchedAt = new Date(ticker.timestamp ?? Date.now());

      recordQuoteSnapshot(database, {
        coinId: marketTarget.coinId,
        vsCurrency: marketTarget.vsCurrency,
        exchangeId: normalizedExchangeId,
        symbol: ticker.symbol,
        fetchedAt,
        price: ticker.last,
        quoteVolume: ticker.quoteVolume,
        priceChangePercentage24h: ticker.percentage,
        sourcePayloadJson: JSON.stringify(ticker.raw),
      });

      pendingCoinTickers.push({
        coinId: marketTarget.coinId,
        exchangeId: normalizedExchangeId,
        base: ticker.base,
        target: ticker.quote,
        marketName: ticker.symbol,
        last: ticker.last,
        volume: ticker.baseVolume,
        quoteVolume: ticker.quoteVolume,
        bidAskSpreadPercentage: buildBidAskSpreadPercentage(ticker.bid, ticker.ask),
        lastTradedAt: fetchedAt,
        lastFetchAt: fetchedAt,
        trustScore: (exchangeTrustScoreById.get(normalizedExchangeId) ?? 0) >= 7 ? 'green' : null,
        isAnomaly: false,
        isStale: false,
        tradeUrl: buildTradeUrl(exchangeId, ticker.base, ticker.quote),
        tokenInfoUrl: buildTokenInfoUrl(exchangeId, marketTarget.coinId),
        coinGeckoUrl: `https://www.coingecko.com/en/coins/${marketTarget.coinId}`,
        vsCurrency: marketTarget.vsCurrency,
      });

      const accumulatorKey = `${marketTarget.coinId}:${marketTarget.vsCurrency}`;
      const accumulator = accumulators.get(accumulatorKey)?.accumulator ?? createMarketQuoteAccumulator();
      accumulator.priceTotal += ticker.last;
      accumulator.priceCount += 1;

      if (ticker.quoteVolume !== null) {
        accumulator.volumeTotal += ticker.quoteVolume;
        accumulator.volumeCount += 1;
      }

      if (ticker.percentage !== null) {
        accumulator.changeTotal += ticker.percentage;
        accumulator.changeCount += 1;
      }

      if (ticker.timestamp !== null) {
        accumulator.latestTimestamp = Math.max(accumulator.latestTimestamp, ticker.timestamp);
      }

      accumulator.providers.add(exchangeId);
      accumulators.set(accumulatorKey, {
        coinId: marketTarget.coinId,
        vsCurrency: marketTarget.vsCurrency,
        accumulator,
      });
    }
  }

  const now = new Date();
  const usdPriceByCoinId = new Map<string, number>();

  for (const { coinId, vsCurrency, accumulator } of accumulators.values()) {
    if (accumulator.priceCount === 0) {
      continue;
    }

    const previousSnapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(and(eq(marketSnapshots.coinId, coinId), eq(marketSnapshots.vsCurrency, vsCurrency)))
      .limit(1)
      .get() ?? null;
    const nextSnapshot = buildLiveSnapshotValue(coinId, accumulator, previousSnapshot, vsCurrency, now);
    const candleTimestampMs = accumulator.latestTimestamp || now.getTime();

    if (vsCurrency === 'usd') {
      usdPriceByCoinId.set(coinId, nextSnapshot.price);
    }

    database.db
      .insert(marketSnapshots)
      .values(nextSnapshot)
      .onConflictDoUpdate({
        target: [marketSnapshots.coinId, marketSnapshots.vsCurrency],
        set: {
          price: nextSnapshot.price,
          marketCap: nextSnapshot.marketCap,
          totalVolume: nextSnapshot.totalVolume,
          marketCapRank: nextSnapshot.marketCapRank,
          fullyDilutedValuation: nextSnapshot.fullyDilutedValuation,
          circulatingSupply: nextSnapshot.circulatingSupply,
          totalSupply: nextSnapshot.totalSupply,
          maxSupply: nextSnapshot.maxSupply,
          ath: nextSnapshot.ath,
          athChangePercentage: nextSnapshot.athChangePercentage,
          athDate: nextSnapshot.athDate,
          atl: nextSnapshot.atl,
          atlChangePercentage: nextSnapshot.atlChangePercentage,
          atlDate: nextSnapshot.atlDate,
          priceChange24h: nextSnapshot.priceChange24h,
          priceChangePercentage24h: nextSnapshot.priceChangePercentage24h,
          sourceProvidersJson: nextSnapshot.sourceProvidersJson,
          sourceCount: nextSnapshot.sourceCount,
          updatedAt: nextSnapshot.updatedAt,
          lastUpdated: nextSnapshot.lastUpdated,
        },
      })
      .run();

    if (vsCurrency === 'usd') {
      upsertCanonicalCandle(database, {
        coinId,
        vsCurrency: 'usd',
        interval: '1m',
        timestamp: toMinuteBucket(candleTimestampMs),
        price: nextSnapshot.price,
        volume: nextSnapshot.totalVolume,
        totalVolume: nextSnapshot.totalVolume,
      });
      upsertCanonicalCandle(database, {
        coinId,
        vsCurrency: 'usd',
        interval: '1d',
        timestamp: toDailyBucket(candleTimestampMs),
        price: nextSnapshot.price,
        volume: nextSnapshot.totalVolume,
        totalVolume: nextSnapshot.totalVolume,
      });
    }
  }

  const currencySnapshot = getCurrencyApiSnapshot();
  const eurPerUsd = currencySnapshot.usdt.eur / currencySnapshot.usdt.usd;
  const btcUsdPrice = usdPriceByCoinId.get('bitcoin')
    ?? database.db
      .select({ price: marketSnapshots.price })
      .from(marketSnapshots)
      .where(and(eq(marketSnapshots.coinId, 'bitcoin'), eq(marketSnapshots.vsCurrency, 'usd')))
      .limit(1)
      .get()
      ?.price
    ?? null;

  for (const pendingTicker of pendingCoinTickers) {
    upsertLiveCoinTicker(database, pendingTicker, {
      eurPerUsd,
      usdPriceByCoinId,
      btcUsdPrice,
    });
  }
}
