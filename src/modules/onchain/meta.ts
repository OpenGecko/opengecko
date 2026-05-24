type OnchainResponseSource = 'live' | 'seeded' | 'fixture' | 'replay';

export const ONCHAIN_HTTP_CACHE_POLICY = {
  maxAgeSeconds: 60,
  staleWhileRevalidateSeconds: 60,
};

export const ONCHAIN_LIVE_HTTP_CACHE_POLICY = {
  maxAgeSeconds: 30,
  staleWhileRevalidateSeconds: 30,
};

export const ONCHAIN_FIXTURE_VERSION = 'opengecko-onchain-fixture-v1';

export const latestPoolUpdatedAt = (rows: Array<{ updatedAt: Date }>) =>
  rows.reduce<Date | null>((latest, row) =>
    latest === null || row.updatedAt.getTime() > latest.getTime() ? row.updatedAt : latest, null);

export const buildOnchainFieldProvenance = (source: OnchainResponseSource) => ({
  reserve_usd: {
    source,
    source_mode: source,
    provider: source === 'live' ? 'DeFiLlama' : 'seed onchain catalog',
    unavailable_behavior: 'null_when_unavailable',
    no_silent_zero_fill: true,
  },
  volume_usd: {
    source,
    source_mode: source,
    provider: source === 'live' ? 'DeFiLlama/SQD' : 'seed onchain catalog or replay fixture',
    unavailable_behavior: 'null_when_unavailable_no_silent_zero_fill',
    no_silent_zero_fill: true,
  },
  price_usd: {
    source,
    source_mode: source,
    provider: source === 'live' ? 'DeFiLlama/simple-token-price' : 'seed onchain catalog',
    unavailable_behavior: 'null_when_unavailable',
    no_silent_zero_fill: true,
  },
  trades_ohlcv_analytics: {
    source,
    source_mode: source,
    provider: source === 'live' ? 'SQD/DeFiLlama' : 'replay or fixture fallback',
    unavailable_behavior: 'fixture_or_out_of_scope_marked_in_meta',
    no_silent_zero_fill: true,
  },
});

export const buildOnchainSourceMeta = (options: {
  source: OnchainResponseSource;
  updatedAt?: Date | null;
  latestSourceFetchedAt?: Date | null;
  sourceIdentifiers?: string[];
  fixtureVersion?: string | null;
  reasonCodes?: string[];
  degradedReason?: string | null;
  fallbackReason?: string | null;
  unavailableReason?: string | null;
  fieldProvenance?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}) => ({
  fixture: options.source === 'seeded' || options.source === 'fixture',
  source: options.source,
  source_mode: options.source,
  source_identifiers: options.sourceIdentifiers ?? [
    options.source === 'live'
      ? 'defillama/sqd'
      : options.source === 'replay'
        ? 'opengecko.provider_replay'
        : 'opengecko.seed',
  ],
  updated_at: options.updatedAt?.toISOString() ?? null,
  source_fetched_at: options.latestSourceFetchedAt?.toISOString() ?? null,
  latest_source_fetched_at: options.latestSourceFetchedAt?.toISOString() ?? null,
  fixture_version: options.source === 'fixture' || options.source === 'seeded'
    ? options.fixtureVersion ?? ONCHAIN_FIXTURE_VERSION
    : options.fixtureVersion ?? null,
  reason_codes: options.reasonCodes ?? (options.source === 'live' ? [] : [`${options.source}_source`]),
  degraded_reason: options.degradedReason ?? (options.source === 'live' ? null : `${options.source}_source_not_live_complete`),
  fallback_reason: options.fallbackReason ?? (options.source === 'fixture' || options.source === 'seeded' ? `${options.source}_fallback` : null),
  unavailable_reason: options.unavailableReason ?? null,
  no_silent_zero_fill: {
    numeric_fields: ['reserve_usd', 'volume_usd', 'price_usd'],
    policy: 'null_or_marked_fallback_when_unavailable',
    zero_fill_is_marked: true,
  },
  field_provenance: options.fieldProvenance ?? buildOnchainFieldProvenance(options.source),
  ...options.extra,
});

export const buildOnchainOhlcvFieldProvenance = (
  source: OnchainResponseSource,
  options: { nullVolumeCount?: number; includeEmptyIntervals?: boolean } = {},
) => ({
  ohlcv_list: {
    source,
    source_mode: source,
    provider: source === 'live' ? 'SQD-derived trades' : source === 'replay' ? 'provider replay OHLCV rows' : 'OpenGecko synthetic fixture',
    fields: ['timestamp', 'open', 'high', 'low', 'close', 'volume_usd'],
    no_silent_zero_fill: true,
    null_volume_count: options.nullVolumeCount ?? 0,
    empty_interval_zero_fill_marked: options.includeEmptyIntervals === true,
    unavailable_behavior: 'fixture_or_degraded_reason_codes_in_meta',
  },
});

export const buildOnchainAnalyticsFieldProvenance = (source: OnchainResponseSource, fields: string[]) => ({
  analytics_fields: {
    source,
    source_mode: source,
    provider: source === 'live' ? 'configured onchain analytics provider' : source === 'replay' ? 'provider replay analytics rows' : 'OpenGecko analytics fixture',
    fields,
    no_silent_zero_fill: true,
    unavailable_behavior: 'empty_or_fixture_rows_marked_with_reason_codes',
  },
});

export const latestTradeUpdatedAt = (trades: Array<{ id: string; sourceFetchedAt?: Date | null }>) =>
  trades.reduce<Date | null>((latest, trade) =>
    trade.sourceFetchedAt && (latest === null || trade.sourceFetchedAt.getTime() > latest.getTime())
      ? trade.sourceFetchedAt
      : latest, null);
