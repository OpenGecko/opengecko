import type { AppDatabase } from '../db/client';
import { HttpError } from '../http/errors';
import { getMarketRows } from '../modules/catalog';
import { getUsableSnapshot, type SnapshotAccessPolicy } from '../modules/market-freshness';
import { getCurrencyApiSnapshot } from '../services/currency-rates';

export const SUPPORTED_VS_CURRENCIES = ['usd', 'eur', 'btc', 'eth'] as const;

function getCoinSnapshot(
  database: AppDatabase,
  coinId: string,
  vsCurrency: 'usd' | 'eur' | 'btc' | 'eth',
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
  const rates = Object.fromEntries(
    Object.entries(currencyApiSnapshot.usdt)
      .filter(([, value]) => Number.isFinite(value) && value > 0)
      .map(([currencyCode, value]) => [currencyCode.toLowerCase(), value / usdPerUsdt]),
  ) as Record<string, number>;

  rates.usd = 1;
  rates.btc = bitcoinUsdSnapshot && bitcoinUsdSnapshot.price > 0
    ? 1 / bitcoinUsdSnapshot.price
    : currencyApiSnapshot.usdt.btc / usdPerUsdt;
  rates.eth = ethereumUsdSnapshot && ethereumUsdSnapshot.price > 0
    ? 1 / ethereumUsdSnapshot.price
    : currencyApiSnapshot.usdt.eth / usdPerUsdt;

  return rates;
}

export function getConversionRate(
  database: AppDatabase,
  vsCurrency: string,
  marketFreshnessThresholdSeconds: number,
  snapshotAccessPolicy: SnapshotAccessPolicy,
) {
  const normalized = vsCurrency.toLowerCase();
  const rates = getConversionRates(database, marketFreshnessThresholdSeconds, snapshotAccessPolicy);

  if (normalized in rates && Number.isFinite(rates[normalized]) && rates[normalized] > 0) {
    return rates[normalized];
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
