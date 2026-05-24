import { z } from 'zod';

export const coinIdParamsSchema = z.object({ id: z.string() });

export const coinContractParamsSchema = z.object({
  platform_id: z.string(),
  contract_address: z.string(),
});

export const coinsListQuerySchema = z.object({
  include_platform: z.enum(['true', 'false']).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
});

export const coinMarketsQuerySchema = z.object({
  vs_currency: z.string(),
  ids: z.string().optional(),
  names: z.string().optional(),
  symbols: z.string().optional(),
  category: z.string().optional(),
  order: z.string().optional(),
  per_page: z.string().optional(),
  page: z.string().optional(),
  price_change_percentage: z.string().optional(),
  sparkline: z.enum(['true', 'false']).optional(),
  precision: z.string().optional(),
});

export const coinDetailQuerySchema = z.object({
  localization: z.enum(['true', 'false']).optional(),
  tickers: z.enum(['true', 'false']).optional(),
  market_data: z.enum(['true', 'false']).optional(),
  community_data: z.enum(['true', 'false']).optional(),
  developer_data: z.enum(['true', 'false']).optional(),
  sparkline: z.enum(['true', 'false']).optional(),
  include_categories_details: z.enum(['true', 'false']).optional(),
  dex_pair_format: z.string().optional(),
});

export const coinHistoryQuerySchema = z.object({
  date: z.string(),
  localization: z.enum(['true', 'false']).optional(),
});

export const coinChartQuerySchema = z.object({
  vs_currency: z.string(),
  days: z.string(),
  interval: z.string().optional(),
  precision: z.string().optional(),
});

export const coinChartRangeQuerySchema = z.object({
  vs_currency: z.string(),
  from: z.string(),
  to: z.string(),
  interval: z.string().optional(),
  precision: z.string().optional(),
});

export const supplyChartQuerySchema = z.object({
  days: z.string(),
  interval: z.string().optional(),
});

export const supplyChartRangeQuerySchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const categoriesQuerySchema = z.object({
  order: z.string().optional(),
});

export const coinTickersQuerySchema = z.object({
  exchange_ids: z.string().optional(),
  include_exchange_logo: z.enum(['true', 'false']).optional(),
  depth: z.enum(['true', 'false']).optional(),
  dex_pair_format: z.string().optional(),
  per_page: z.string().optional(),
  page: z.string().optional(),
  order: z.string().optional(),
});

export const topGainersLosersQuerySchema = z.object({
  vs_currency: z.string(),
  duration: z.string().optional(),
  top_coins: z.string().optional(),
  price_change_percentage: z.string().optional(),
});
