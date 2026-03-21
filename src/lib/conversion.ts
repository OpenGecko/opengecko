import type { AppDatabase } from '../db/client';
import { HttpError } from '../http/errors';
import { getMarketRows } from '../modules/catalog';
import { getUsableSnapshot } from '../modules/market-freshness';

export const SUPPORTED_VS_CURRENCIES = ['usd', 'eur', 'btc', 'eth'] as const;

const FALLBACK_USD_CONVERSION_RATES = {
  usd: 1,
  eur: 0.92,
  btc: 1 / 85_000,
  eth: 1 / 2_000,
} as const satisfies Record<(typeof SUPPORTED_VS_CURRENCIES)[number], number>;

type SupportedVsCurrency = (typeof SUPPORTED_VS_CURRENCIES)[number];

function getCoinSnapshot(
  database: AppDatabase,
  coinId: string,
  vsCurrency: SupportedVsCurrency,
  marketFreshnessThresholdSeconds: number,
) {
  return getUsableSnapshot(
    getMarketRows(database, vsCurrency, { ids: [coinId], status: 'all' })[0]?.snapshot ?? null,
    marketFreshnessThresholdSeconds,
  );
}

export function getConversionRates(database: AppDatabase, marketFreshnessThresholdSeconds: number) {
  const bitcoinUsdSnapshot = getCoinSnapshot(database, 'bitcoin', 'usd', marketFreshnessThresholdSeconds);
  const bitcoinEurSnapshot = getCoinSnapshot(database, 'bitcoin', 'eur', marketFreshnessThresholdSeconds);
  const ethereumUsdSnapshot = getCoinSnapshot(database, 'ethereum', 'usd', marketFreshnessThresholdSeconds);
  const ethereumEurSnapshot = getCoinSnapshot(database, 'ethereum', 'eur', marketFreshnessThresholdSeconds);
  const usdCoinUsdSnapshot = getCoinSnapshot(database, 'usd-coin', 'usd', marketFreshnessThresholdSeconds);
  const usdCoinEurSnapshot = getCoinSnapshot(database, 'usd-coin', 'eur', marketFreshnessThresholdSeconds);
  const eurCrossRates = [
    bitcoinUsdSnapshot && bitcoinEurSnapshot && bitcoinUsdSnapshot.price > 0
      ? bitcoinEurSnapshot.price / bitcoinUsdSnapshot.price
      : null,
    ethereumUsdSnapshot && ethereumEurSnapshot && ethereumUsdSnapshot.price > 0
      ? ethereumEurSnapshot.price / ethereumUsdSnapshot.price
      : null,
    usdCoinUsdSnapshot && usdCoinEurSnapshot && usdCoinUsdSnapshot.price > 0
      ? usdCoinEurSnapshot.price / usdCoinUsdSnapshot.price
      : null,
  ].filter((rate): rate is number => typeof rate === 'number' && Number.isFinite(rate) && rate > 0);

  return {
    usd: 1,
    eur: eurCrossRates.length === 0
      ? FALLBACK_USD_CONVERSION_RATES.eur
      : eurCrossRates.reduce((sum, value) => sum + value, 0) / eurCrossRates.length,
    btc: bitcoinUsdSnapshot && bitcoinUsdSnapshot.price > 0
      ? 1 / bitcoinUsdSnapshot.price
      : FALLBACK_USD_CONVERSION_RATES.btc,
    eth: ethereumUsdSnapshot && ethereumUsdSnapshot.price > 0
      ? 1 / ethereumUsdSnapshot.price
      : FALLBACK_USD_CONVERSION_RATES.eth,
  } satisfies Record<SupportedVsCurrency, number>;
}

export function getConversionRate(
  database: AppDatabase,
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
) {
  const normalized = vsCurrency.toLowerCase();
  const rates = getConversionRates(database, marketFreshnessThresholdSeconds);

  if (normalized in rates) {
    return rates[normalized as keyof typeof rates];
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported vs_currency: ${vsCurrency}`);
}

export function buildExchangeRatesPayload(database: AppDatabase, marketFreshnessThresholdSeconds: number) {
  const conversionRates = getConversionRates(database, marketFreshnessThresholdSeconds);
  const bitcoinValueUsd = 1 / conversionRates.btc;

  return {
    rates: {
      btc: {
        name: 'Bitcoin',
        unit: 'BTC',
        value: 1,
        type: 'crypto',
      },
      eth: {
        name: 'Ether',
        unit: 'ETH',
        value: bitcoinValueUsd * conversionRates.eth,
        type: 'crypto',
      },
      usd: {
        name: 'US Dollar',
        unit: '$',
        value: bitcoinValueUsd,
        type: 'fiat',
      },
      eur: {
        name: 'Euro',
        unit: '€',
        value: bitcoinValueUsd * conversionRates.eur,
        type: 'fiat',
      },
    },
  };
}
