import type { AppConfig } from '../config/env';
import type { AppDatabase } from '../db/client';
import { fetchExchangeOHLCV, isSupportedExchangeId, type SupportedExchangeId } from '../providers/ccxt';
import { upsertCanonicalOhlcvCandle } from './candle-store';

const CANONICAL_DAILY_BACKFILL_SOURCES = [
  { coinId: 'bitcoin', symbol: 'BTC/USD', exchangeId: 'coinbase' },
  { coinId: 'ethereum', symbol: 'ETH/USD', exchangeId: 'coinbase' },
  { coinId: 'usd-coin', symbol: 'USDC/USD', exchangeId: 'coinbase' },
] satisfies Array<{ coinId: string; symbol: string; exchangeId: SupportedExchangeId }>;

export async function runOhlcvBackfillOnce(
  database: AppDatabase,
  config: Pick<AppConfig, 'ccxtExchanges'>,
  options: { lookbackDays?: number } = {},
) {
  const enabledExchanges = new Set(config.ccxtExchanges.filter(isSupportedExchangeId));
  const lookbackDays = options.lookbackDays ?? 365;
  const since = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  for (const target of CANONICAL_DAILY_BACKFILL_SOURCES) {
    if (!enabledExchanges.has(target.exchangeId)) {
      continue;
    }

    const candles = await fetchExchangeOHLCV(target.exchangeId, target.symbol, '1d', since);

    for (const candle of candles) {
      upsertCanonicalOhlcvCandle(database, {
        coinId: target.coinId,
        vsCurrency: 'usd',
        interval: '1d',
        timestamp: new Date(candle.timestamp),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        totalVolume: candle.volume,
        replaceExisting: true,
      });
    }
  }
}
