import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { eq, and } from 'drizzle-orm';
import { marketSnapshots } from '../db/schema';
import { fetchExchangeTickers, type SupportedExchangeId } from '../providers/ccxt';
import { recordQuoteSnapshot, toDailyBucket, toMinuteBucket, upsertCanonicalCandle } from './candle-store';
import { buildLiveSnapshotValue, createMarketQuoteAccumulator, type MarketQuoteAccumulator } from './market-snapshots';

const SUPPORTED_EXCHANGES: SupportedExchangeId[] = ['binance', 'coinbase', 'kraken'];

const COIN_MARKET_CANDIDATES = {
  bitcoin: {
    usd: ['BTC/USD', 'BTC/USDT'],
    eur: ['BTC/EUR'],
  },
  ethereum: {
    usd: ['ETH/USD', 'ETH/USDT'],
    eur: ['ETH/EUR'],
  },
  'usd-coin': {
    usd: ['USDC/USD', 'USDC/USDT'],
    eur: ['USDC/EUR'],
  },
  solana: {
    usd: ['SOL/USD', 'SOL/USDT'],
  },
  ripple: {
    usd: ['XRP/USD', 'XRP/USDT'],
  },
  dogecoin: {
    usd: ['DOGE/USD', 'DOGE/USDT'],
  },
  cardano: {
    usd: ['ADA/USD', 'ADA/USDT'],
  },
  chainlink: {
    usd: ['LINK/USD', 'LINK/USDT'],
  },
} satisfies Record<string, Partial<Record<'usd' | 'eur', string[]>>>;

function buildRequestedSymbolIndex() {
  const symbolEntries: Array<[string, { coinId: string; vsCurrency: string }]> = Object.entries(COIN_MARKET_CANDIDATES).flatMap(([coinId, currencyCandidates]) =>
    Object.entries(currencyCandidates).flatMap(([vsCurrency, symbols]) =>
      symbols.map((symbol) => [symbol, { coinId, vsCurrency }] as [string, { coinId: string; vsCurrency: string }]),
    ),
  );

  return new Map<string, { coinId: string; vsCurrency: string }>(symbolEntries);
}

function isSupportedExchangeId(value: string): value is SupportedExchangeId {
  return SUPPORTED_EXCHANGES.includes(value as SupportedExchangeId);
}

export async function runMarketRefreshOnce(database: AppDatabase, config: Pick<AppConfig, 'ccxtExchanges'>) {
  const exchangeIds = config.ccxtExchanges.filter(isSupportedExchangeId);

  if (exchangeIds.length === 0) {
    return;
  }

  const symbolIndex = buildRequestedSymbolIndex();
  const requestedSymbols = [...symbolIndex.keys()];
  const accumulators = new Map<string, { coinId: string; vsCurrency: string; accumulator: MarketQuoteAccumulator }>();

  for (const exchangeId of exchangeIds) {
    const tickers = await fetchExchangeTickers(exchangeId, requestedSymbols);

    for (const ticker of tickers) {
      const marketTarget = symbolIndex.get(ticker.symbol);

      if (!marketTarget || ticker.last === null) {
        continue;
      }

      recordQuoteSnapshot(database, {
        coinId: marketTarget.coinId,
        vsCurrency: marketTarget.vsCurrency,
        exchangeId,
        symbol: ticker.symbol,
        fetchedAt: new Date(ticker.timestamp ?? Date.now()),
        price: ticker.last,
        quoteVolume: ticker.quoteVolume,
        priceChangePercentage24h: ticker.percentage,
        sourcePayloadJson: JSON.stringify(ticker.raw),
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
}
