import type { AppDatabase } from '../db/client';
import { coins } from '../db/schema';
import { fetchExchangeMarkets, type ExchangeId } from '../providers/ccxt';

const USD_QUOTE_PRIORITY = ['USDT', 'USD'] as const;

export type OhlcvPriorityTier = 'top100' | 'requested' | 'long_tail';

export type OhlcvSyncTargetSeed = {
  coinId: string;
  exchangeId: ExchangeId;
  symbol: string;
  priorityTier: OhlcvPriorityTier;
  targetHistoryDays: number;
};

export async function buildOhlcvSyncTargets(
  database: AppDatabase,
  enabledExchanges: ExchangeId[],
  topCoinIds: Set<string> = new Set(),
): Promise<OhlcvSyncTargetSeed[]> {
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
        return [{
          coinId: row.id,
          exchangeId,
          symbol: `${base}/${matchedQuote}`,
          priorityTier: topCoinIds.has(row.id) ? 'top100' : 'long_tail',
          targetHistoryDays: 365,
        } satisfies OhlcvSyncTargetSeed];
      }
    }

    return [];
  });
}
