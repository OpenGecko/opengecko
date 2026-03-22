import type { AppDatabase } from '../db/client';
import { HttpError } from '../http/errors';
import { getMarketRows } from '../modules/catalog';
import { getUsableSnapshot, type SnapshotAccessPolicy } from '../modules/market-freshness';
import { getCurrencyApiSnapshot } from '../services/currency-rates';

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
  snapshotAccessPolicy: SnapshotAccessPolicy,
) {
  return getUsableSnapshot(
    getMarketRows(database, vsCurrency, { ids: [coinId], status: 'all' })[0]?.snapshot ?? null,
    marketFreshnessThresholdSeconds,
    snapshotAccessPolicy,
  );
}

export function getConversionRates(
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
) {
  const currencyApiSnapshot = getCurrencyApiSnapshot();
  const usdPerUsdt = currencyApiSnapshot.usdt.usd;
  const bitcoinUsdSnapshot = getCoinSnapshot(database, 'bitcoin', 'usd', marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const ethereumUsdSnapshot = getCoinSnapshot(database, 'ethereum', 'usd', marketFreshnessThresholdSeconds, snapshotAccessPolicy);

  return {
    usd: 1,
    eur: currencyApiSnapshot.usdt.eur / usdPerUsdt,
    btc: bitcoinUsdSnapshot && bitcoinUsdSnapshot.price > 0
      ? 1 / bitcoinUsdSnapshot.price
      : currencyApiSnapshot.usdt.btc / usdPerUsdt,
    eth: ethereumUsdSnapshot && ethereumUsdSnapshot.price > 0
      ? 1 / ethereumUsdSnapshot.price
      : currencyApiSnapshot.usdt.eth / usdPerUsdt,
  } satisfies Record<SupportedVsCurrency, number>;
}

export function getConversionRate(
  database: AppDatabase,
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
) {
  const normalized = vsCurrency.toLowerCase();
  const rates = getConversionRates(database, marketFreshnessThresholdSeconds, snapshotAccessPolicy);

  if (normalized in rates) {
    return rates[normalized as keyof typeof rates];
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported vs_currency: ${vsCurrency}`);
}

export function buildExchangeRatesPayload(
  database: AppDatabase,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
) {
  const conversionRates = getConversionRates(database, marketFreshnessThresholdSeconds, snapshotAccessPolicy);
  const bitcoinValueUsd = 1 / conversionRates.btc;

  return {
    data: {
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
