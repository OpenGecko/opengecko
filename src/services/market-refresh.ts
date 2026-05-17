import { and, eq, lte, or } from 'drizzle-orm';
import BigNumber from 'bignumber.js';

import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { coinTickers, exchanges, exchangeVolumePoints, marketSnapshots } from '../db/schema';
import { coins } from '../db/schema';
import type { Logger } from 'pino';
import { fetchExchangeTickers, isValidExchangeId, type ExchangeId, type ExchangeTickerSnapshot } from '../providers/ccxt';
import { syncCoinCatalogFromExchanges } from './coin-catalog-sync';
import { recordQuoteSnapshot, toMinuteBucket, toDailyBucket, upsertCanonicalCandle, enforceQuoteSnapshotRetention } from './candle-store';
import { getCurrencyApiSnapshot } from './currency-rates';
import {
  buildLiveSnapshotValue,
  buildMarketQuoteAccumulator,
  type MarketQuoteSample,
} from './market-snapshots';
import {
  buildAcceptedIngestionPlan,
  normalizeMarketTickerCandidate,
  type NormalizedMarketTickerCandidate,
} from './market-ingestion-acceptance-plan';
import { clearProviderFailureCooldown, recordProviderFailureCooldown, type MarketDataRuntimeState } from './market-runtime-state';
import type { MetricsRegistry } from './metrics';
import {
  canAttemptProvider,
  createProviderBreakerState,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-breaker';
import { runBudgetedProviderFanout } from './provider-readiness-coordinator';

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
  marketSample: MarketQuoteSample;
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

type PendingQuoteSnapshot = {
  marketSample: MarketQuoteSample;
  coinId: string;
  vsCurrency: 'usd' | 'eur';
  exchangeId: string;
  symbol: string;
  fetchedAt: Date;
  price: number;
  quoteVolume: number | null;
  priceChangePercentage24h: number | null;
  sourcePayloadJson: string;
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
  pendingQuoteSnapshots: PendingQuoteSnapshot[];
  pendingCoinTickers: PendingCoinTicker[];
};

type ExchangeTickerRefreshDiagnostic = NonNullable<MarketDataRuntimeState['exchangeTickerIngestion']>['exchange_results'][string];

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

  const budgetMs = progress?.startupTickerFetchBudgetMs;

  const buildBudgetError = (exchangeId: string) => {
    const error = new Error(`${exchangeId} startup ticker fetch budget exceeded after ${budgetMs}ms`);
    error.name = 'ExchangeTickerStartupBudgetExceededError';
    return error;
  };

  return await runBudgetedProviderFanout({
    items: exchangeIds,
    concurrency,
    budgetMs,
    run: (exchangeId) => withExchangeFetchTimeout(exchangeId, fetchExchangeTickers(exchangeId, requestedSymbols)),
    buildBudgetError,
    reportBudgetFailure: true,
    onStart: (exchangeId) => {
      progress?.onExchangeFetchStart?.(exchangeId);
    },
    onComplete: (exchangeId, _index, durationMs) => {
      progress?.onExchangeFetchComplete?.(exchangeId, durationMs);
    },
    onFailure: (exchangeId, _index, error, durationMs) => {
      progress?.onExchangeFetchFailed?.(exchangeId, error.message, durationMs);
    },
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

function resolveCanonicalExchangeId(exchangeId: ExchangeId, knownExchangeIds: Set<string>) {
  const canonicalExchangeIds: Record<string, string> = {
    bybit: 'bybit_spot',
    coinbase: 'gdax',
    okx: 'okex',
  };

  const canonicalExchangeId = canonicalExchangeIds[exchangeId];

  return canonicalExchangeId && !knownExchangeIds.has(exchangeId) && knownExchangeIds.has(canonicalExchangeId)
    ? canonicalExchangeId
    : exchangeId;
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
    pendingQuoteSnapshots: [],
    pendingCoinTickers: [],
  };
}

function createExchangeTickerRefreshDiagnostic(): ExchangeTickerRefreshDiagnostic {
  return {
    fetched_ticker_count: 0,
    matched_ticker_count: 0,
    accepted_ticker_rows: 0,
    rejected_ticker_rows: 0,
    rejection_reasons: {},
    failed_reason: null,
  };
}

function incrementTickerRejection(
  diagnostic: ExchangeTickerRefreshDiagnostic | undefined,
  reason: string,
) {
  if (!diagnostic) {
    return;
  }

  diagnostic.rejected_ticker_rows += 1;
  diagnostic.rejection_reasons[reason] = (diagnostic.rejection_reasons[reason] ?? 0) + 1;
}

function recordAccumulatorSample(
  marketSamples: RefreshTickerProcessingState['marketSamples'],
  marketTarget: SymbolIndexEntry,
  exchangeId: ExchangeId,
  ticker: ExchangeTickerSnapshot,
  normalizedTicker: Extract<NormalizedMarketTickerCandidate, { accepted: true }>,
) {
  const marketSampleKey = `${marketTarget.coinId}:${marketTarget.vsCurrency}`;
  const entry = marketSamples.get(marketSampleKey) ?? {
    coinId: marketTarget.coinId,
    vsCurrency: marketTarget.vsCurrency,
    samples: [],
  };

  const sample = {
    price: ticker.last!,
    quoteVolume: normalizedTicker.quoteVolume,
    changePercentage24h: normalizedTicker.percentage,
    timestamp: normalizedTicker.timestamp,
    provider: exchangeId,
  };
  entry.samples.push(sample);
  marketSamples.set(marketSampleKey, entry);

  return sample;
}

function recordMatchedTicker(
  exchangeTrustScoreById: Map<string, number | null>,
  knownExchangeIds: Set<string>,
  processingState: RefreshTickerProcessingState,
  exchangeId: ExchangeId,
  marketTarget: SymbolIndexEntry,
  ticker: ExchangeTickerSnapshot,
  normalizedTicker: Extract<NormalizedMarketTickerCandidate, { accepted: true }>,
) {
  const normalizedExchangeId = resolveCanonicalExchangeId(exchangeId, knownExchangeIds);
  const fetchedAt = new Date(normalizedTicker.timestamp);
  const marketSample = recordAccumulatorSample(processingState.marketSamples, marketTarget, exchangeId, ticker, normalizedTicker);

  processingState.pendingQuoteSnapshots.push({
    marketSample,
    coinId: marketTarget.coinId,
    vsCurrency: marketTarget.vsCurrency,
    exchangeId,
    symbol: ticker.symbol,
    fetchedAt,
    price: ticker.last!,
    quoteVolume: normalizedTicker.quoteVolume,
    priceChangePercentage24h: normalizedTicker.percentage,
    sourcePayloadJson: JSON.stringify(ticker.raw),
  });

  processingState.pendingCoinTickers.push({
    marketSample,
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

function persistAcceptedQuoteSnapshots(
  database: AppDatabase,
  pendingQuoteSnapshots: PendingQuoteSnapshot[],
) {
  for (const pendingSnapshot of pendingQuoteSnapshots) {
    recordQuoteSnapshot(database, {
      coinId: pendingSnapshot.coinId,
      vsCurrency: pendingSnapshot.vsCurrency,
      exchangeId: pendingSnapshot.exchangeId,
      symbol: pendingSnapshot.symbol,
      fetchedAt: pendingSnapshot.fetchedAt,
      price: pendingSnapshot.price,
      quoteVolume: pendingSnapshot.quoteVolume,
      priceChangePercentage24h: pendingSnapshot.priceChangePercentage24h,
      sourcePayloadJson: pendingSnapshot.sourcePayloadJson,
    });
  }
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
  const exchangeTickerDiagnostics = new Map<ExchangeId, ExchangeTickerRefreshDiagnostic>();
  for (const exchangeId of attemptedExchangeIds) {
    exchangeTickerDiagnostics.set(exchangeId, createExchangeTickerRefreshDiagnostic());
  }
  const exchangeTrustScoreById = new Map(
    database.db.select().from(exchanges).all().map((row) => [row.id, row.trustScore]),
  );
  const knownExchangeIds = new Set(exchangeTrustScoreById.keys());

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
    const tickerDiagnostic = exchangeTickerDiagnostics.get(exchangeId);
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
      if (tickerDiagnostic) {
        tickerDiagnostic.failed_reason = errorInfo.message;
      }
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
    if (tickerDiagnostic) {
      tickerDiagnostic.fetched_ticker_count = tickers.length;
    }

    for (const ticker of tickers) {
      const request = tickerDiscoveryRequests.get(ticker.symbol);
      const marketTarget = request?.marketTarget;
      const normalizedTicker = normalizeMarketTickerCandidate(ticker);

      if (!marketTarget) {
        incrementTickerRejection(tickerDiagnostic, 'unsupported_or_unmapped_symbol');
        continue;
      }

      if (!normalizedTicker.accepted) {
        incrementTickerRejection(tickerDiagnostic, normalizedTicker.reason);
        continue;
      }

      matchedCount += 1;
      if (tickerDiagnostic) {
        tickerDiagnostic.matched_ticker_count += 1;
      }
      recordMatchedTicker(exchangeTrustScoreById, knownExchangeIds, processingState, exchangeId, marketTarget, ticker, normalizedTicker);

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
        exchangeTrustScoreById,
        knownExchangeIds,
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
  const acceptedIngestionPlan = buildAcceptedIngestionPlan({
    marketSamples: processingState.marketSamples,
    pendingQuoteSnapshots: processingState.pendingQuoteSnapshots,
    pendingCoinTickers: processingState.pendingCoinTickers,
  });
  persistAcceptedQuoteSnapshots(database, acceptedIngestionPlan.acceptedQuoteSnapshots);
  updateExchangeVolumes(database, acceptedIngestionPlan.exchangeQuoteVolumes, now);
  const writeSnapshotsPhase = createLongPhaseReporter(progress);
  writeSnapshotsPhase.start(`Still working: writing ${acceptedIngestionPlan.acceptedMarketSamples.size.toLocaleString()} market snapshots`);
  const usdPriceByCoinId = writeMarketSnapshots(database, acceptedIngestionPlan.acceptedMarketSamples, now);
  const conversionContext = buildConversionContext(database, usdPriceByCoinId);
  const knownExchangeIdsForDiagnostics = new Set(
    database.db.select().from(exchanges).all().map((row) => row.id),
  );
  for (const pendingTicker of processingState.pendingCoinTickers) {
    const diagnostic = exchangeTickerDiagnostics.get(pendingTicker.exchangeId);
    if (!diagnostic) {
      continue;
    }

    if (!knownExchangeIdsForDiagnostics.has(pendingTicker.exchangeId)) {
      incrementTickerRejection(diagnostic, 'unknown_exchange_identity');
      continue;
    }

    if (!acceptedIngestionPlan.acceptedSamples.has(pendingTicker.marketSample)) {
      incrementTickerRejection(diagnostic, 'consensus_rejected');
      continue;
    }

    diagnostic.accepted_ticker_rows += 1;
  }
  writeSnapshotsPhase.update(`Still working: updating ${processingState.pendingCoinTickers.length.toLocaleString()} coin tickers and exchange volumes`);
  upsertPendingCoinTickers(database, acceptedIngestionPlan.acceptedCoinTickers, conversionContext);
  writeSnapshotsPhase.stop();
  enforceQuoteSnapshotRetention(database);
  if (runtimeState) {
    runtimeState.exchangeTickerIngestion = {
      last_refresh_at: now.toISOString(),
      exchange_results: Object.fromEntries(exchangeTickerDiagnostics),
    };
  }

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
