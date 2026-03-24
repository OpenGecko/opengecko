import { and, eq, lte, or } from 'drizzle-orm';

import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { coinTickers, exchanges, exchangeVolumePoints, marketSnapshots } from '../db/schema';
import { coins } from '../db/schema';
import type { Logger } from 'pino';
import { fetchExchangeTickers, isValidExchangeId, type ExchangeId } from '../providers/ccxt';
import { syncCoinCatalogFromExchanges } from './coin-catalog-sync';
import { recordQuoteSnapshot, toMinuteBucket, toDailyBucket, upsertCanonicalCandle } from './candle-store';
import { getCurrencyApiSnapshot } from './currency-rates';
import { buildLiveSnapshotValue, createMarketQuoteAccumulator, type MarketQuoteAccumulator } from './market-snapshots';

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
  const databaseCoinsForRefresh = database.db
    .select()
    .from(coins)
    .where(or(eq(coins.status, 'active'), lte(coins.marketCapRank, 100)))
    .all();

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

function buildBidAskSpreadPercentage(bid: number | null, ask: number | null) {
  if (bid === null || ask === null || ask <= 0) {
    return null;
  }

  return ((ask - bid) / ask) * 100;
}

function buildTradeUrl(exchangeId: ExchangeId, base: string, target: string) {
  return `https://www.${exchangeId}.com/trade/${base}-${target}`;
}

function buildTokenInfoUrl(_exchangeId: ExchangeId, _coinId: string) {
  return null;
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

export async function runMarketRefreshOnce(
  database: AppDatabase,
  config: Pick<AppConfig, 'ccxtExchanges'>,
  logger?: Logger,
) {
  const refreshLogger = logger?.child({ operation: 'market_refresh' });
  const startTime = Date.now();
  const exchangeIds = config.ccxtExchanges.filter(isValidExchangeId);

  if (exchangeIds.length === 0) {
    return;
  }

  refreshLogger?.debug({ exchanges: exchangeIds }, 'starting market refresh');

  await syncCoinCatalogFromExchanges(database, exchangeIds, refreshLogger);

  const symbolIndex = buildRequestedSymbolIndex(database);
  const requestedSymbols = [...symbolIndex.keys()];
  const accumulators = new Map<string, { coinId: string; vsCurrency: string; accumulator: MarketQuoteAccumulator }>();
  const pendingCoinTickers: PendingCoinTicker[] = [];
  const exchangeQuoteVolumes = new Map<string, number>(); // normalizedExchangeId -> total quote volume
  const exchangeTrustScoreById = new Map(
    database.db.select().from(exchanges).all().map((row) => [row.id, row.trustScore]),
  );

  for (const exchangeId of exchangeIds) {
    const exchangeLogger = refreshLogger?.child({ exchange: exchangeId });
    const exchangeStart = Date.now();

    let tickers: Awaited<ReturnType<typeof fetchExchangeTickers>> = [];
    try {
      tickers = await fetchExchangeTickers(exchangeId, requestedSymbols);
    } catch (error) {
      const errorInfo = error instanceof Error
        ? { message: error.message, name: error.name }
        : { message: String(error) };
      exchangeLogger?.warn({ ...errorInfo, durationMs: Date.now() - exchangeStart }, 'exchange ticker fetch failed');
      continue;
    }

    let matchedCount = 0;
    for (const ticker of tickers) {
      const marketTarget = symbolIndex.get(ticker.symbol);

      if (!marketTarget || ticker.last === null) {
        continue;
      }

      matchedCount += 1;
      const normalizedExchangeId = exchangeId;
      const fetchedAt = new Date(ticker.timestamp ?? Date.now());

      // Track per-exchange quote volume for volume snapshots
      if (ticker.quoteVolume !== null) {
        exchangeQuoteVolumes.set(
          normalizedExchangeId,
          (exchangeQuoteVolumes.get(normalizedExchangeId) ?? 0) + ticker.quoteVolume,
        );
      }

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

    exchangeLogger?.debug({
      tickerCount: tickers.length,
      matchedCount,
      durationMs: Date.now() - exchangeStart,
    }, 'exchange ticker fetch complete');
  }

  const now = new Date();
  const usdPriceByCoinId = new Map<string, number>();

  // Write exchange volume snapshots
  for (const [normalizedExchangeId, totalQuoteVolume] of exchangeQuoteVolumes) {
    database.db
      .insert(exchangeVolumePoints)
      .values({
        exchangeId: normalizedExchangeId,
        timestamp: now,
        volumeBtc: totalQuoteVolume,
      })
      .onConflictDoNothing()
      .run();

    // Update exchange records with live 24h volume
    database.db
      .update(exchanges)
      .set({
        tradeVolume24hBtc: totalQuoteVolume,
        updatedAt: now,
      })
      .where(eq(exchanges.id, normalizedExchangeId))
      .run();
  }

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
      .select()
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

  const durationMs = Date.now() - startTime;
  refreshLogger?.info({
    snapshotCount: accumulators.size,
    tickerCount: pendingCoinTickers.length,
    exchangeCount: exchangeIds.length,
    durationMs,
  }, 'market refresh complete');
}
