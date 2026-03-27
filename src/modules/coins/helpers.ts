import type { AppDatabase } from '../../db/client';
import type { CoinRow, MarketSnapshotRow } from '../../db/schema';
import { HttpError } from '../../http/errors';
import { parseJsonObject } from '../catalog';
import { getChartGranularityMs } from '../chart-semantics';
import { getSnapshotOwnership } from '../../services/market-snapshots';

export function toNumberOrNull(value: number | null | undefined, precision: number | 'full') {
  if (value === null || value === undefined) {
    return null;
  }

  if (precision === 'full') {
    return value;
  }

  return Number(value.toFixed(precision));
}

export function parsePlatforms(platformsJson: string) {
  return parseJsonObject<Record<string, string>>(platformsJson);
}

export function buildDetailPlatforms(platformsJson: string) {
  return Object.fromEntries(
    Object.entries(parsePlatforms(platformsJson)).map(([platformId, contractAddress]) => [
      platformId,
      {
        decimal_place: null,
        contract_address: contractAddress,
      },
    ]),
  );
}

export function buildLocalizationPayload(coin: CoinRow, includeLocalization: boolean) {
  if (!includeLocalization) {
    return {};
  }

  return {
    en: coin.name,
  };
}

export function buildCommunityData(includeCommunityData: boolean) {
  if (!includeCommunityData) {
    return null;
  }

  return {
    facebook_likes: null,
    twitter_followers: null,
    reddit_average_posts_48h: null,
    reddit_average_comments_48h: null,
    reddit_subscribers: null,
    reddit_accounts_active_48h: null,
    telegram_channel_user_count: null,
  };
}

export function buildDeveloperData(includeDeveloperData: boolean) {
  if (!includeDeveloperData) {
    return null;
  }

  return {
    forks: null,
    stars: null,
    subscribers: null,
    total_issues: null,
    closed_issues: null,
    pull_requests_merged: null,
    pull_request_contributors: null,
    code_additions_deletions_4_weeks: {
      additions: null,
      deletions: null,
    },
    commit_count_4_weeks: null,
    last_4_weeks_commit_activity_series: [],
  };
}

export function normalizeCategoryId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sortNumber(value: number | null | undefined, fallback: number) {
  return value ?? fallback;
}

export function parseDexPairFormat(value: string | undefined) {
  if (!value) {
    return 'symbol';
  }

  const normalized = value.toLowerCase();

  if (normalized === 'symbol' || normalized === 'contract_address') {
    return normalized;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported dex_pair_format value: ${value}`);
}

export function parseChartInterval(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();

  if (normalized === 'hourly' || normalized === 'daily' || normalized === 'weekly') {
    return normalized;
  }

  throw new HttpError(400, 'invalid_parameter', `Unsupported interval value: ${value}`);
}

export function getGranularityMs(durationMs: number, interval?: string) {
  const parsedInterval = parseChartInterval(interval);

  if (!parsedInterval) {
    return getChartGranularityMs(durationMs);
  }

  switch (parsedInterval) {
    case 'hourly':
      return 60 * 60 * 1000;
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'weekly':
      return 7 * 24 * 60 * 60 * 1000;
  }
}

export function normalizeSelector(values: string[]) {
  return [...new Set(values)].sort();
}

export function parseMoverDuration(value: string | undefined) {
  if (!value) {
    return { days: 1, field: 'price_change_percentage_24h' as const };
  }

  const normalized = value.toLowerCase();

  switch (normalized) {
    case '24h':
      return { days: 1, field: 'price_change_percentage_24h' as const };
    case '7d':
      return { days: 7, field: 'price_change_percentage_7d_in_currency' as const };
    case '14d':
      return { days: 14, field: 'price_change_percentage_14d_in_currency' as const };
    case '30d':
      return { days: 30, field: 'price_change_percentage_30d_in_currency' as const };
    case '60d':
      return { days: 60, field: 'price_change_percentage_60d_in_currency' as const };
    case '1y':
      return { days: 365, field: 'price_change_percentage_1y_in_currency' as const };
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported duration value: ${value}`);
  }
}

export function parseTopCoinsLimit(value: string | undefined) {
  if (!value) {
    return 30;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || ![300, 500, 1000].includes(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Unsupported top_coins value: ${value}`);
  }

  return parsed;
}

export function parseMoverPriceChangePercentage(value: string | undefined) {
  if (!value) {
    return ['24h'];
  }

  const rawEntries = value.split(',').map((entry) => entry.trim());
  let trailingEmptyEntryCount = 0;
  for (let index = rawEntries.length - 1; index >= 0 && rawEntries[index]?.length === 0; index -= 1) {
    trailingEmptyEntryCount += 1;
  }
  const entries = rawEntries.filter(Boolean).map((entry) => entry.toLowerCase());
  const supported = new Set(['24h', '7d', '14d', '30d', '200d', '1y']);

  if (
    rawEntries.slice(0, rawEntries.length - trailingEmptyEntryCount).some((entry) => entry.length === 0)
    || entries.length === 0
    || entries.some((entry) => !supported.has(entry))
  ) {
    throw new HttpError(400, 'invalid_parameter', `Unsupported price_change_percentage value: ${value}`);
  }

  return entries;
}

export function buildNewListingRow(coin: CoinRow) {
  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    activated_at: Math.floor(coin.createdAt.getTime() / 1000),
  };
}

export function parseHistoryDate(date: string) {
  const [day, month, year] = date.split('-').map(Number);

  if (![day, month, year].every(Number.isInteger)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid history date: ${date}`);
  }

  return Date.UTC(year, month - 1, day);
}

export function parseUnixTimestampSeconds(value: string, fieldName: string) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid ${fieldName} value: ${value}`);
  }

  return parsed * 1000;
}

export function buildSupplyPayload(
  rows: ReadonlyArray<readonly [number, number]>,
  seriesKey: 'circulating_supply' | 'total_supply',
) {
  return {
    [seriesKey]: rows.map((row) => [row[0], row[1]]),
  };
}

export function isSeededBootstrapSnapshot(snapshot: MarketSnapshotRow | null) {
  return snapshot !== null && getSnapshotOwnership(snapshot) === 'seeded';
}

export function buildCategoriesDetails(
  database: AppDatabase,
  categoriesList: string[],
  getCategories: (database: AppDatabase) => Array<{
    id: string;
    name: string;
    marketCap: number | null;
    marketCapChange24h: number | null;
    volume24h: number | null;
  }>,
) {
  const categoriesById = new Map(getCategories(database).map((category) => [category.id, category]));

  return categoriesList.map((entry) => {
    const categoryId = normalizeCategoryId(entry);
    const category = categoriesById.get(categoryId);

    return {
      id: categoryId,
      name: category?.name ?? entry,
      market_cap: category?.marketCap ?? null,
      market_cap_change_24h: category?.marketCapChange24h ?? null,
      volume_24h: category?.volume24h ?? null,
    };
  });
}
