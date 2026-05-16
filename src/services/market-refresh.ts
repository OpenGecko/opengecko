import { and, eq, lte, or } from 'drizzle-orm';
import BigNumber from 'bignumber.js';

import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { coinTickers, exchanges, exchangeVolumePoints, marketSnapshots } from '../db/schema';
import { coins } from '../db/schema';
import type { Logger } from 'pino';
import { fetchExchangeTickers, isValidExchangeId, type ExchangeId, type ExchangeTickerSnapshot } from '../providers/ccxt';
import { syncCoinCatalogFromExchanges } from './coin-catalog-sync';
import { mapWithConcurrency } from '../lib/async';
import { recordQuoteSnapshot, toMinuteBucket, toDailyBucket, upsertCanonicalCandle, enforceQuoteSnapshotRetention } from './candle-store';
import { getCurrencyApiSnapshot } from './currency-rates';
import { buildLiveSnapshotValue, buildMarketQuoteAccumulator, normalizeMarketTimestamp, type MarketQuoteSample } from './market-snapshots';
import { clearProviderFailureCooldown, recordProviderFailureCooldown, type MarketDataRuntimeState } from './market-runtime-state';
import type { MetricsRegistry } from './metrics';
import {
  canAttemptProvider,
  createProviderBreakerState,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-breaker';

const PROVIDER_FAILURE_COOLDOWN_MS = 60_000;
const EXCHANGE_TICKER_FETCH_TIMEOUT_MS = 60_000;
export const STARTUP_TICKER_FETCH_BUDGET_MS = 3_000;

type SymbolIndexEntry = {
  coinId: string;
  vsCurrency: 'usd' | 'eur';
};

type TickerDiscoveryRequest = {
  symbol: string;
  marketTarget: SymbolIndexEntry;
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

type QuoteCandidate = {
  symbol: string;
  vsCurrency: 'usd' | 'eur';
};

type ConversionContext = {
  eurPerUsd: number;
  usdPriceByCoinId: Map<string, number>;
  btcUsdPrice: number | null;
};

type RefreshTickerProcessingState = {
  marketSamples: Map<string, { coinId: string; vsCurrency: string; samples: MarketQuoteSample[] }>;
  pendingCoinTickers: PendingCoinTicker[];
  exchangeQuoteVolumes: Map<string, number>;
};

type MarketRefreshProgressHandlers = {
  onLongPhaseStatus?: (message: string) => void;
  onExchangeFetchStart?: (exchangeId: string) => void;
  onExchangeFetchComplete?: (exchangeId: string, durationMs: number) => void;
  onExchangeFetchFailed?: (exchangeId: string, message: string, durationMs: number) => void;
  onWaitingExchangeStatus?: (exchangeIds: string[]) => void;
  startupTickerFetchBudgetMs?: number;
  suppressSummaryLogs?: boolean;
};

function createLongPhaseReporter(progress?: MarketRefreshProgressHandlers) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let reported = false;

  return {
    start(message: string) {
      reported = false;
      if (!progress?.onLongPhaseStatus) {
        return;
      }

      timeout = setTimeout(() => {
        reported = true;
        progress.onLongPhaseStatus?.(message);
      }, 10_000);
    },
    update(message: string) {
      if (reported) {
        progress?.onLongPhaseStatus?.(message);
      }
    },
    stop() {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      reported = false;
    },
  };
}

export async function withExchangeFetchTimeout<T>(exchangeId: string, operation: Promise<T>, timeoutMs = EXCHANGE_TICKER_FETCH_TIMEOUT_MS) {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new Error(`${exchangeId} ticker fetch timed out after ${timeoutMs}ms`);
          error.name = 'ExchangeTickerTimeoutError';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function fetchExchangeTickerResults(
  exchangeIds: ExchangeId[],
  requestedSymbols: string[],
  concurrency: number,
  progress?: MarketRefreshProgressHandlers,
): Promise<PromiseSettledResult<ExchangeTickerSnapshot[]>[]> {
  if (exchangeIds.length === 0) {
    return [];
  }

  const normalizedConcurrency = Math.max(1, Math.floor(concurrency));
  const results = new Array<PromiseSettledResult<ExchangeTickerSnapshot[]> | undefined>(exchangeIds.length);
  const budgetMs = progress?.startupTickerFetchBudgetMs;

  if (!budgetMs || budgetMs <= 0) {
    return await mapWithConcurrency(exchangeIds, normalizedConcurrency, async (exchangeId) => {
      const exchangeFetchStart = Date.now();
      progress?.onExchangeFetchStart?.(exchangeId);
      const result = await Promise.allSettled([
        withExchangeFetchTimeout(exchangeId, fetchExchangeTickers(exchangeId, requestedSymbols)),
      ]).then(([settled]) => settled);
      const durationMs = Date.now() - exchangeFetchStart;

      if (result.status === 'fulfilled') {
        progress?.onExchangeFetchComplete?.(exchangeId, durationMs);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        progress?.onExchangeFetchFailed?.(exchangeId, message, durationMs);
      }

      return result;
    });
  }

  let nextIndex = 0;
  let activeWorkers = 0;
  let settledWorkers = 0;
  let resolved = false;
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;

  const buildBudgetError = (exchangeId: string) => {
    const error = new Error(`${exchangeId} startup ticker fetch budget exceeded after ${budgetMs}ms`);
    error.name = 'ExchangeTickerStartupBudgetExceededError';
    return error;
  };

  return await new Promise<PromiseSettledResult<ExchangeTickerSnapshot[]>[]>((resolve) => {
    const resolveOnce = () => {
      if (resolved) {
        return;
      }

      resolved = true;
      if (budgetTimer) {
        clearTimeout(budgetTimer);
        budgetTimer = null;
      }
      resolve(Array.from({ length: exchangeIds.length }, (_, index) => results[index] ?? {
        status: 'rejected',
        reason: buildBudgetError(exchangeIds[index]),
      }));
    };

    const startNext = () => {
      if (resolved) {
        return;
      }

      while (activeWorkers < Math.min(normalizedConcurrency, exchangeIds.length) && nextIndex < exchangeIds.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        activeWorkers += 1;
        const exchangeId = exchangeIds[currentIndex];
        const exchangeFetchStart = Date.now();
        progress?.onExchangeFetchStart?.(exchangeId);

        Promise.allSettled([
          withExchangeFetchTimeout(exchangeId, fetchExchangeTickers(exchangeId, requestedSymbols)),
        ])
          .then(([settled]) => {
            if (resolved) {
              return;
            }

            const durationMs = Date.now() - exchangeFetchStart;
            results[currentIndex] = settled;

            if (settled.status === 'fulfilled') {
              progress?.onExchangeFetchComplete?.(exchangeId, durationMs);
            } else {
              const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
              progress?.onExchangeFetchFailed?.(exchangeId, message, durationMs);
            }
          })
          .catch((reason) => {
            if (resolved) {
              return;
            }

            const durationMs = Date.now() - exchangeFetchStart;
            const error = reason instanceof Error ? reason : new Error(String(reason));
            results[currentIndex] = { status: 'rejected', reason: error };
            progress?.onExchangeFetchFailed?.(exchangeId, error.message, durationMs);
          })
          .finally(() => {
            activeWorkers -= 1;
            settledWorkers += 1;

            if (settledWorkers === exchangeIds.length) {
              resolveOnce();
              return;
            }

            startNext();
          });
      }
    };

    budgetTimer = setTimeout(() => {
      for (let index = 0; index < exchangeIds.length; index++) {
        if (results[index]) {
          continue;
        }

        const exchangeId = exchangeIds[index];
        const error = buildBudgetError(exchangeId);
        results[index] = { status: 'rejected', reason: error };
        progress?.onExchangeFetchFailed?.(exchangeId, error.message, budgetMs);
      }

      resolveOnce();
    }, budgetMs);

    startNext();
  });
}

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

function buildTickerDiscoveryRequests(
  symbolIndex: Map<string, SymbolIndexEntry>,
  quoteCandidatesByCoinId: Map<string, QuoteCandidate[]>,
) {
  const requests = new Map<string, TickerDiscoveryRequest>();

  for (const [symbol, marketTarget] of symbolIndex) {
    requests.set(symbol, { symbol, marketTarget });
  }

  for (const [coinId, candidates] of quoteCandidatesByCoinId) {
    for (const candidate of candidates) {
      if (!requests.has(candidate.symbol)) {
        requests.set(candidate.symbol, {
          symbol: candidate.symbol,
          marketTarget: {
            coinId,
            vsCurrency: candidate.vsCurrency,
          },
        });
      }
    }
  }

  return requests;
}

function buildQuoteCandidates(database: AppDatabase) {
  const quoteCandidatesByCoinId = new Map<string, QuoteCandidate[]>();
  const databaseCoinsForRefresh = database.db
    .select()
    .from(coins)
    .where(or(eq(coins.status, 'active'), lte(coins.marketCapRank, 100)))
    .all();

  for (const coin of databaseCoinsForRefresh) {
    const symbol = coin.symbol.toUpperCase();

    quoteCandidatesByCoinId.set(coin.id, [
      { symbol: `${symbol}/USD`, vsCurrency: 'usd' },
      { symbol: `${symbol}/USDT`, vsCurrency: 'usd' },
      { symbol: `${symbol}/EUR`, vsCurrency: 'eur' },
    ]);
  }

  return quoteCandidatesByCoinId;
}

function buildBidAskSpreadPercentage(bid: number | null, ask: number | null) {
  if (bid === null || ask === null || ask <= 0) {
    return null;
  }

  return new BigNumber(ask).minus(bid).dividedBy(ask).multipliedBy(100).toNumber();
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
  conversionContext: ConversionContext,
) {
  const convertedLastUsd = conversionContext.usdPriceByCoinId.get(pendingTicker.coinId)
    ?? (pendingTicker.vsCurrency === 'eur'
      ? new BigNumber(pendingTicker.last).dividedBy(conversionContext.eurPerUsd).toNumber()
      : pendingTicker.last);
  const convertedVolumeUsd = pendingTicker.quoteVolume === null
    ? (pendingTicker.volume === null ? null : new BigNumber(pendingTicker.volume).multipliedBy(convertedLastUsd).toNumber())
    : (pendingTicker.vsCurrency === 'eur'
      ? new BigNumber(pendingTicker.quoteVolume).dividedBy(conversionContext.eurPerUsd).toNumber()
      : pendingTicker.quoteVolume);
  const convertedLastBtc = conversionContext.btcUsdPrice === null
    ? null
    : new BigNumber(convertedLastUsd).dividedBy(conversionContext.btcUsdPrice).toNumber();

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

function createRefreshTickerProcessingState(): RefreshTickerProcessingState {
  return {
    marketSamples: new Map(),
    pendingCoinTickers: [],
    exchangeQuoteVolumes: new Map(),
  };
}

function recordExchangeQuoteVolume(exchangeQuoteVolumes: Map<string, number>, exchangeId: string, quoteVolume: number | null) {
  if (quoteVolume === null) {
    return;
  }

  exchangeQuoteVolumes.set(
    exchangeId,
    new BigNumber(exchangeQuoteVolumes.get(exchangeId) ?? 0).plus(quoteVolume).toNumber(),
  );
}

function toFiniteNullableNonNegative(value: number | null) {
  if (value === null) {
    return null;
  }

  return Number.isFinite(value) && value >= 0 ? value : null;
}

function toFiniteNullablePercentage(value: number | null) {
  if (value === null) {
    return null;
  }

  return Number.isFinite(value) ? value : null;
}

function hasTruthyQualityFlag(ticker: ExchangeTickerSnapshot, flagNames: string[]) {
  const tickerRecord = ticker as unknown as Record<string, unknown>;
  const rawRecord = ticker.raw && typeof ticker.raw === 'object'
    ? ticker.raw as unknown as Record<string, unknown>
    : {};

  return flagNames.some((flagName) =>
    tickerRecord[flagName] === true
    || rawRecord[flagName] === true
    || rawRecord[flagName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] === true,
  );
}

function normalizeTickerForMarketSnapshot(ticker: ExchangeTickerSnapshot, nowMs = Date.now()) {
  const timestamp = normalizeMarketTimestamp(ticker.timestamp, nowMs);

  if (
    timestamp === null
    || typeof ticker.symbol !== 'string'
    || ticker.symbol.length === 0
    || typeof ticker.base !== 'string'
    || ticker.base.length === 0
    || typeof ticker.quote !== 'string'
    || ticker.quote.length === 0
    || ticker.last === null
    || !Number.isFinite(ticker.last)
    || ticker.last <= 0
    || hasTruthyQualityFlag(ticker, ['isAnomaly', 'isStale'])
  ) {
    return null;
  }

  const baseVolume = toFiniteNullableNonNegative(ticker.baseVolume);
  const quoteVolume = toFiniteNullableNonNegative(ticker.quoteVolume);
  const percentage = toFiniteNullablePercentage(ticker.percentage);

  return {
    timestamp,
    baseVolume,
    quoteVolume,
    percentage,
  };
}

function recordAccumulatorSample(
  marketSamples: RefreshTickerProcessingState['marketSamples'],
  marketTarget: SymbolIndexEntry,
  exchangeId: ExchangeId,
  ticker: ExchangeTickerSnapshot,
  normalizedTicker: NonNullable<ReturnType<typeof normalizeTickerForMarketSnapshot>>,
) {
  const marketSampleKey = `${marketTarget.coinId}:${marketTarget.vsCurrency}`;
  const entry = marketSamples.get(marketSampleKey) ?? {
    coinId: marketTarget.coinId,
    vsCurrency: marketTarget.vsCurrency,
    samples: [],
  };

  entry.samples.push({
    price: ticker.last!,
    quoteVolume: normalizedTicker.quoteVolume,
    changePercentage24h: normalizedTicker.percentage,
    timestamp: normalizedTicker.timestamp,
    provider: exchangeId,
  });
  marketSamples.set(marketSampleKey, entry);
}

function recordMatchedTicker(
  database: AppDatabase,
  exchangeTrustScoreById: Map<string, number | null>,
  processingState: RefreshTickerProcessingState,
  exchangeId: ExchangeId,
  marketTarget: SymbolIndexEntry,
  ticker: ExchangeTickerSnapshot,
  normalizedTicker: NonNullable<ReturnType<typeof normalizeTickerForMarketSnapshot>>,
) {
  const normalizedExchangeId = exchangeId;
  const fetchedAt = new Date(normalizedTicker.timestamp);

  recordExchangeQuoteVolume(processingState.exchangeQuoteVolumes, normalizedExchangeId, normalizedTicker.quoteVolume);

  recordQuoteSnapshot(database, {
    coinId: marketTarget.coinId,
    vsCurrency: marketTarget.vsCurrency,
    exchangeId: normalizedExchangeId,
    symbol: ticker.symbol,
    fetchedAt,
    price: ticker.last!,
    quoteVolume: normalizedTicker.quoteVolume,
    priceChangePercentage24h: normalizedTicker.percentage,
    sourcePayloadJson: JSON.stringify(ticker.raw),
  });

  processingState.pendingCoinTickers.push({
    coinId: marketTarget.coinId,
    exchangeId: normalizedExchangeId,
    base: ticker.base,
    target: ticker.quote,
    marketName: ticker.symbol,
    last: ticker.last!,
    volume: normalizedTicker.baseVolume,
    quoteVolume: normalizedTicker.quoteVolume,
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

  recordAccumulatorSample(processingState.marketSamples, marketTarget, exchangeId, ticker, normalizedTicker);
}

function determineTickerVsCurrency(
  quoteCandidatesByCoinId: Map<string, QuoteCandidate[]>,
  coinId: string,
  symbol: string,
  quote: string,
) {
  const normalizedQuote = quote.toUpperCase();

  if (normalizedQuote === 'EUR') {
    return 'eur' as const;
  }

  if (normalizedQuote === 'USD' || normalizedQuote === 'USDT') {
    return 'usd' as const;
  }

  const candidates = quoteCandidatesByCoinId.get(coinId) ?? [];
  const matchedCandidate = candidates.find((candidate) => candidate.symbol === symbol);

  return matchedCandidate?.vsCurrency ?? null;
}

function updateExchangeVolumes(database: AppDatabase, exchangeQuoteVolumes: Map<string, number>, now: Date) {
  const knownExchangeIds = new Set(
    database.db.select().from(exchanges).all().map((row) => row.id),
  );

  for (const [normalizedExchangeId, totalQuoteVolume] of exchangeQuoteVolumes) {
    if (!knownExchangeIds.has(normalizedExchangeId)) {
      continue;
    }

    database.db
      .insert(exchangeVolumePoints)
      .values({
        exchangeId: normalizedExchangeId,
        timestamp: now,
        volumeBtc: totalQuoteVolume,
      })
      .onConflictDoNothing()
      .run();

    database.db
      .update(exchanges)
      .set({
        tradeVolume24hBtc: totalQuoteVolume,
        updatedAt: now,
      })
      .where(eq(exchanges.id, normalizedExchangeId))
      .run();
  }
}

function buildConversionContext(database: AppDatabase, usdPriceByCoinId: Map<string, number>): ConversionContext {
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

  return {
    eurPerUsd,
    usdPriceByCoinId,
    btcUsdPrice,
  };
}

function writeMarketSnapshots(
  database: AppDatabase,
  marketSamples: RefreshTickerProcessingState['marketSamples'],
  now: Date,
) {
  const usdPriceByCoinId = new Map<string, number>();

  for (const { coinId, vsCurrency, samples } of marketSamples.values()) {
    const accumulator = buildMarketQuoteAccumulator(samples);

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

  return usdPriceByCoinId;
}

function upsertPendingCoinTickers(
  database: AppDatabase,
  pendingCoinTickers: PendingCoinTicker[],
  conversionContext: ConversionContext,
) {
  const knownExchangeIds = new Set(
    database.db.select().from(exchanges).all().map((row) => row.id),
  );

  for (const pendingTicker of pendingCoinTickers) {
    if (!knownExchangeIds.has(pendingTicker.exchangeId)) {
      continue;
    }

    upsertLiveCoinTicker(database, pendingTicker, conversionContext);
  }
}

export async function runMarketRefreshOnce(
  database: AppDatabase,
  config: Pick<AppConfig, 'ccxtExchanges' | 'providerFanoutConcurrency'>,
  logger?: Logger,
  runtimeState?: MarketDataRuntimeState,
  metrics?: Pick<MetricsRegistry, 'recordProviderRefresh' | 'recordProviderForcedFailure' | 'recordProviderBlockedByBreaker' | 'recordProviderPartialFailure' | 'recordProviderRecovery'>,
  progress?: MarketRefreshProgressHandlers,
) {
  const refreshLogger = logger?.child({ operation: 'market_refresh' });
  const startTime = Date.now();
  const exchangeIds = config.ccxtExchanges.filter(isValidExchangeId);
  const cooldownUntil = runtimeState?.providerFailureCooldownUntil ?? null;

  if (exchangeIds.length === 0) {
    return;
  }

  if (runtimeState?.forcedProviderFailure.active) {
    metrics?.recordProviderRefresh('forced_failure', exchangeIds.length, exchangeIds.length);
    for (const exchangeId of exchangeIds) {
      metrics?.recordProviderForcedFailure(exchangeId);
    }
    throw new Error(runtimeState.forcedProviderFailure.reason ?? 'forced provider failure active');
  }

  if (cooldownUntil !== null && cooldownUntil > startTime) {
    metrics?.recordProviderRefresh('cooldown_skip', exchangeIds.length, 0);
    refreshLogger?.warn({
      cooldownUntil: new Date(cooldownUntil).toISOString(),
      remainingCooldownMs: cooldownUntil - startTime,
      exchangeCount: exchangeIds.length,
    }, 'market refresh skipped because provider failure cooldown is active');
    return;
  }

  const providerBreakers = runtimeState
    ? runtimeState.providerBreakers ?? (runtimeState.providerBreakers = createProviderBreakerState(exchangeIds))
    : null;
  const attemptedExchangeIds = providerBreakers
    ? exchangeIds.filter((exchangeId) => canAttemptProvider(providerBreakers, exchangeId, startTime))
    : exchangeIds;
  const blockedExchangeCount = exchangeIds.length - attemptedExchangeIds.length;
  for (const exchangeId of exchangeIds) {
    if (!attemptedExchangeIds.includes(exchangeId)) {
      metrics?.recordProviderBlockedByBreaker(exchangeId);
    }
  }

  if (attemptedExchangeIds.length === 0) {
    metrics?.recordProviderRefresh('breaker_skip', exchangeIds.length, 0);
    refreshLogger?.warn({
      exchangeCount: exchangeIds.length,
      blockedExchangeCount,
    }, 'market refresh skipped because all provider breakers are open');
    return;
  }

  refreshLogger?.debug({
    exchanges: attemptedExchangeIds,
    blockedExchangeCount,
  }, 'starting market refresh');

  await syncCoinCatalogFromExchanges(
    database,
    attemptedExchangeIds,
    refreshLogger,
    config.providerFanoutConcurrency,
    { suppressSummaryLog: Boolean(progress?.suppressSummaryLogs) },
  );

  const symbolIndexPhase = createLongPhaseReporter(progress);
  symbolIndexPhase.start('Still working: building symbol index for market snapshot refresh');
  const symbolIndex = buildRequestedSymbolIndex(database);
  const quoteCandidatesByCoinId = buildQuoteCandidates(database);
  const tickerDiscoveryRequests = buildTickerDiscoveryRequests(symbolIndex, quoteCandidatesByCoinId);
  symbolIndexPhase.stop();
  const requestedSymbols = [...tickerDiscoveryRequests.keys()];
  const processingState = createRefreshTickerProcessingState();
  const exchangeTrustScoreById = new Map(
    database.db.select().from(exchanges).all().map((row) => [row.id, row.trustScore]),
  );

  // Fetch all exchange tickers in parallel
  const pendingExchangeIds = new Set(attemptedExchangeIds);
  let waitingStatusTimer: ReturnType<typeof setInterval> | null = null;
  const stopWaitingStatus = () => {
    if (waitingStatusTimer) {
      clearInterval(waitingStatusTimer);
      waitingStatusTimer = null;
    }
  };

  if (progress?.onWaitingExchangeStatus) {
    waitingStatusTimer = setInterval(() => {
      if (pendingExchangeIds.size > 0) {
        progress.onWaitingExchangeStatus?.([...pendingExchangeIds]);
      }
    }, 10_000);
  }

  const fetchTickersPhase = createLongPhaseReporter(progress);
  fetchTickersPhase.start(`Still working: fetching tickers from ${attemptedExchangeIds.length} exchanges`);
  const tickerResults = await fetchExchangeTickerResults(
    attemptedExchangeIds,
    requestedSymbols,
    config.providerFanoutConcurrency,
    progress
      ? {
          ...progress,
          onExchangeFetchComplete: (exchangeId, durationMs) => {
            pendingExchangeIds.delete(exchangeId);
            progress.onExchangeFetchComplete?.(exchangeId, durationMs);
          },
          onExchangeFetchFailed: (exchangeId, message, durationMs) => {
            pendingExchangeIds.delete(exchangeId);
            progress.onExchangeFetchFailed?.(exchangeId, message, durationMs);
          },
        }
      : undefined,
  );
  stopWaitingStatus();
  fetchTickersPhase.stop();
  let failedExchanges = 0;
  const failedExchangeIds: string[] = [];

  for (let i = 0; i < attemptedExchangeIds.length; i++) {
    const exchangeId = attemptedExchangeIds[i];
    const result = tickerResults[i];
    const exchangeLogger = refreshLogger?.child({ exchange: exchangeId });
    const exchangeStart = Date.now();
    const processingPhase = createLongPhaseReporter(progress);
    processingPhase.start(`Still working: processing ${exchangeId} ticker results`);

    if (result.status === 'rejected') {
      processingPhase.stop();
      failedExchanges += 1;
      failedExchangeIds.push(exchangeId);
      const errorInfo = result.reason instanceof Error
        ? { message: result.reason.message, name: result.reason.name }
        : { message: String(result.reason) };
      if (providerBreakers) {
        recordProviderFailure(providerBreakers, exchangeId, Date.now(), errorInfo.message);
      }
      exchangeLogger?.warn({ ...errorInfo, durationMs: Date.now() - exchangeStart }, 'exchange ticker fetch failed');
      continue;
    }

    const providerHadFailure = providerBreakers
      ? (providerBreakers.providers[exchangeId]?.failureCount ?? 0) > 0
      : false;
    if (providerBreakers) {
      recordProviderSuccess(providerBreakers, exchangeId, Date.now());
    }
    if (providerHadFailure) {
      metrics?.recordProviderRecovery(exchangeId);
    }

    const tickers = Array.isArray(result.value) ? result.value : [];
    let matchedCount = 0;

    for (const ticker of tickers) {
      const request = tickerDiscoveryRequests.get(ticker.symbol);
      const marketTarget = request?.marketTarget;
      const normalizedTicker = normalizeTickerForMarketSnapshot(ticker);

      if (!marketTarget || normalizedTicker === null) {
        continue;
      }

      matchedCount += 1;
      recordMatchedTicker(database, exchangeTrustScoreById, processingState, exchangeId, marketTarget, ticker, normalizedTicker);

      const tickerVsCurrency = determineTickerVsCurrency(
        quoteCandidatesByCoinId,
        marketTarget.coinId,
        ticker.symbol,
        ticker.quote,
      );

      if (tickerVsCurrency === null || tickerVsCurrency === marketTarget.vsCurrency) {
        continue;
      }

      recordMatchedTicker(
        database,
        exchangeTrustScoreById,
        processingState,
        exchangeId,
        {
          coinId: marketTarget.coinId,
          vsCurrency: tickerVsCurrency,
        },
        ticker,
        normalizedTicker,
      );
    }
    processingPhase.stop();

    exchangeLogger?.debug({
      tickerCount: tickers.length,
      matchedCount,
      durationMs: Date.now() - exchangeStart,
    }, 'exchange ticker fetch complete');
  }

  const unavailableExchangeCount = failedExchanges + blockedExchangeCount;

  if (failedExchanges === attemptedExchangeIds.length) {
    if (runtimeState) {
      recordProviderFailureCooldown(runtimeState, startTime + PROVIDER_FAILURE_COOLDOWN_MS);
    }

    metrics?.recordProviderRefresh('failure', exchangeIds.length, unavailableExchangeCount);
    refreshLogger?.warn({
      failedExchangeCount: failedExchanges,
      blockedExchangeCount,
      exchangeCount: exchangeIds.length,
      cooldownMs: PROVIDER_FAILURE_COOLDOWN_MS,
    }, 'all exchange ticker fetches failed; activating provider failure cooldown');
    throw new Error('provider failure cooldown active after exchange refresh failure');
  }

  if (runtimeState) {
    clearProviderFailureCooldown(runtimeState);
  }

  if (failedExchangeIds.length > 0) {
    for (const exchangeId of failedExchangeIds) {
      metrics?.recordProviderPartialFailure(exchangeId);
    }
  }

  metrics?.recordProviderRefresh(
    unavailableExchangeCount > 0 ? 'partial_failure' : 'success',
    exchangeIds.length,
    unavailableExchangeCount,
  );

  const now = new Date();
  updateExchangeVolumes(database, processingState.exchangeQuoteVolumes, now);
  const writeSnapshotsPhase = createLongPhaseReporter(progress);
  writeSnapshotsPhase.start(`Still working: writing ${processingState.marketSamples.size.toLocaleString()} market snapshots`);
  const usdPriceByCoinId = writeMarketSnapshots(database, processingState.marketSamples, now);
  const conversionContext = buildConversionContext(database, usdPriceByCoinId);
  writeSnapshotsPhase.update(`Still working: updating ${processingState.pendingCoinTickers.length.toLocaleString()} coin tickers and exchange volumes`);
  upsertPendingCoinTickers(database, processingState.pendingCoinTickers, conversionContext);
  writeSnapshotsPhase.stop();
  enforceQuoteSnapshotRetention(database);

  const durationMs = Date.now() - startTime;
  if (!progress) {
    refreshLogger?.info({
      snapshotCount: processingState.marketSamples.size,
      tickerCount: processingState.pendingCoinTickers.length,
      exchangeCount: exchangeIds.length,
      failedExchangeCount: failedExchanges,
      blockedExchangeCount,
      durationMs,
    }, 'market refresh complete');
  }
}
