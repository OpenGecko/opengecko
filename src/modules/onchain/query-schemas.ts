import { z } from 'zod';

export const paginationQuerySchema = z.object({
  page: z.string().optional(),
});

export const poolListQuerySchema = z.object({
  page: z.string().optional(),
  sort: z.enum(['h24_volume_usd_liquidity_desc', 'h24_tx_count_desc', 'reserve_in_usd_desc']).optional(),
});

export const poolDetailQuerySchema = z.object({
  include: z.string().optional(),
  include_volume_breakdown: z.string().optional(),
  include_composition: z.string().optional(),
});

export const poolMultiQuerySchema = z.object({
  include: z.string().optional(),
});

export const discoveryPoolsQuerySchema = z.object({
  page: z.string().optional(),
  include: z.string().optional(),
});

export const trendingPoolsQuerySchema = z.object({
  page: z.string().optional(),
  include: z.string().optional(),
  duration: z.string().optional(),
});

export const searchPoolsQuerySchema = z.object({
  query: z.string().optional(),
  network: z.string().optional(),
  page: z.string().optional(),
});

export const trendingSearchQuerySchema = z.object({
  page: z.string().optional(),
  per_page: z.string().optional(),
  pools: z.string().optional(),
});

export const megafilterQuerySchema = z.object({
  page: z.string().optional(),
  per_page: z.string().optional(),
  include: z.string().optional(),
  networks: z.string().optional(),
  dexes: z.string().optional(),
  min_reserve_in_usd: z.string().optional(),
  max_reserve_in_usd: z.string().optional(),
  min_volume_usd_h24: z.string().optional(),
  max_volume_usd_h24: z.string().optional(),
  min_tx_count_h24: z.string().optional(),
  max_tx_count_h24: z.string().optional(),
  sort: z.string().optional(),
});

export const tokenDetailQuerySchema = z.object({
  include: z.string().optional(),
  include_inactive_source: z.string().optional(),
  include_composition: z.string().optional(),
});

export const tokenMultiQuerySchema = z.object({
  include: z.string().optional(),
});

export const simpleTokenPriceQuerySchema = z.object({
  include_market_cap: z.string().optional(),
  include_24hr_vol: z.string().optional(),
  include_24hr_price_change: z.string().optional(),
  include_total_reserve_in_usd: z.string().optional(),
});

export const poolInfoQuerySchema = z.object({
  include: z.string().optional(),
});

export const recentlyUpdatedTokenInfoQuerySchema = z.object({
  include: z.string().optional(),
  network: z.string().optional(),
  page: z.string().optional(),
});

export const tradesQuerySchema = z.object({
  trade_volume_in_usd_greater_than: z.string().optional(),
  token: z.string().optional(),
  limit: z.string().optional(),
  before_timestamp: z.string().optional(),
});

export const onchainOhlcvQuerySchema = z.object({
  aggregate: z.string().optional(),
  before_timestamp: z.string().optional(),
  limit: z.string().optional(),
  currency: z.string().optional(),
  token: z.string().optional(),
  include_empty_intervals: z.string().optional(),
  include_inactive_source: z.string().optional(),
});

export const topHoldersQuerySchema = z.object({
  holders: z.string().optional(),
  include_pnl_details: z.string().optional(),
  include: z.string().optional(),
});

export const topTradersQuerySchema = z.object({
  traders: z.string().optional(),
  sort: z.string().optional(),
  include_address_label: z.string().optional(),
});

export const holdersChartQuerySchema = z.object({
  days: z.string().optional(),
});

export const onchainCategoriesQuerySchema = z.object({
  page: z.string().optional(),
  sort: z.string().optional(),
});

export const onchainCategoryPoolsQuerySchema = z.object({
  page: z.string().optional(),
  sort: z.string().optional(),
  include: z.string().optional(),
});
