import type { AppDatabase } from '../db/client';
import { DEFAULT_OHLCV_TARGET_HISTORY_DAYS } from '../config/runtime-policy';
import { coins } from '../db/schema';
import { fetchExchangeMarkets, type ExchangeId } from '../providers/ccxt';
import type { CoverageTarget } from './coverage-targets';

const USD_QUOTE_PRIORITY = ['USDT', 'USD'] as const;
const SUPPORTED_OHLCV_INTERVALS = ['1d', '1m'] as const;

export type OhlcvPriorityTier = 'top100' | 'requested' | 'long_tail';
export type OhlcvTargetInterval = typeof SUPPORTED_OHLCV_INTERVALS[number];

export type OhlcvSyncTargetSeed = {
  coinId: string;
  exchangeId: ExchangeId;
  symbol: string;
  interval: OhlcvTargetInterval;
  priorityTier: OhlcvPriorityTier;
  targetHistoryDays: number;
};

function isSupportedOhlcvInterval(value: string): value is OhlcvTargetInterval {
  return (SUPPORTED_OHLCV_INTERVALS as readonly string[]).includes(value);
}

export async function buildOhlcvSyncTargets(
  database: AppDatabase,
  enabledExchanges: ExchangeId[],
  topCoinIds: Set<string> = new Set(),
  options: { targetHistoryDays?: number; coverageTargets?: CoverageTarget[] } = {},
): Promise<OhlcvSyncTargetSeed[]> {
  const targetHistoryDays = options.targetHistoryDays ?? DEFAULT_OHLCV_TARGET_HISTORY_DAYS;
  const enabledCoverageTargets = (options.coverageTargets ?? [])
    .filter((target) => target.enabled)
    .filter((target) => target.entityType === 'coin')
    .filter((target) => target.vsCurrency === 'usd')
    .filter((target) => isSupportedOhlcvInterval(target.interval));
  const requestedCoverageTargets = new Map(enabledCoverageTargets
    .filter((target) => target.family === 'ohlcv')
    .filter((target) => isSupportedOhlcvInterval(target.interval))
    .map((target) => [`${target.provider}:${target.entityId}:${target.vsCurrency}:${target.interval}`, target]));
  const bridgedMarketChartTargets = new Map(enabledCoverageTargets
    .filter((target) => target.family === 'market_charts')
    .filter((target) => target.provider === 'custom')
    .filter((target) => target.interval === '1m')
    .map((target) => [`${target.entityId}:${target.vsCurrency}:${target.interval}`, target]));
  const marketIndex = new Map<ExchangeId, Set<string>>();

  for (const exchangeId of enabledExchanges) {
    try {
      const markets = await fetchExchangeMarkets(exchangeId);
      const supportedSymbols = new Set(
        markets
          .filter((market) => market.active && market.spot)
          .map((market) => market.symbol),
      );

      marketIndex.set(exchangeId, supportedSymbols);
    } catch {
      continue;
    }
  }

  const rows = database.db.select().from(coins).all();

  return rows.flatMap((row): OhlcvSyncTargetSeed[] => {
    const base = row.symbol.toUpperCase();

    for (const exchangeId of enabledExchanges) {
      const supportedSymbols = marketIndex.get(exchangeId);

      if (!supportedSymbols) {
        continue;
      }

      const matchedQuote = USD_QUOTE_PRIORITY.find((quote) => supportedSymbols.has(`${base}/${quote}`));

      if (matchedQuote) {
        const requestedIntervals = [...requestedCoverageTargets.values()]
          .filter((target) =>
            target.provider === exchangeId
            && target.entityId === row.id
            && target.vsCurrency === 'usd')
          .map((target) => target.interval)
          .filter(isSupportedOhlcvInterval);
        const bridgedIntervals = [...bridgedMarketChartTargets.values()]
          .filter((target) => target.entityId === row.id && target.vsCurrency === 'usd')
          .map((target) => target.interval)
          .filter(isSupportedOhlcvInterval);
        const intervals = [...new Set<OhlcvTargetInterval>(['1d', ...requestedIntervals, ...bridgedIntervals])];

        return intervals.map((interval) => {
          const coverageTarget = requestedCoverageTargets.get(`${exchangeId}:${row.id}:usd:${interval}`)
            ?? bridgedMarketChartTargets.get(`${row.id}:usd:${interval}`);

          return {
            coinId: row.id,
            exchangeId,
            symbol: `${base}/${matchedQuote}`,
            interval,
            priorityTier: topCoinIds.has(row.id) ? 'top100' : coverageTarget ? 'requested' : 'long_tail',
            targetHistoryDays: coverageTarget?.targetHistoryDays ?? targetHistoryDays,
          } satisfies OhlcvSyncTargetSeed;
        });
      }
    }

    return [];
  });
}
