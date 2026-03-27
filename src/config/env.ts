import { z } from 'zod';

import {
  DEFAULT_CCXT_EXCHANGES,
  DEFAULT_CURRENCY_REFRESH_INTERVAL_SECONDS,
  DEFAULT_MARKET_FRESHNESS_THRESHOLD_SECONDS,
  DEFAULT_MARKET_REFRESH_INTERVAL_SECONDS,
  DEFAULT_PROVIDER_FANOUT_CONCURRENCY,
  DEFAULT_SEARCH_REBUILD_INTERVAL_SECONDS,
} from './runtime-policy';
import { HTTP_LOG_STYLES } from '../http/http-log-style';

const envSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.boolean().default(true),
  LOG_HTTP_STYLE: z.enum(HTTP_LOG_STYLES).default('emoji_compact_p'),
  DATABASE_URL: z.string().default('./data/opengecko.db'),
  CCXT_EXCHANGES: z.string().default(DEFAULT_CCXT_EXCHANGES.join(',')),
  MARKET_FRESHNESS_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(DEFAULT_MARKET_FRESHNESS_THRESHOLD_SECONDS),
  MARKET_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_MARKET_REFRESH_INTERVAL_SECONDS),
  CURRENCY_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_CURRENCY_REFRESH_INTERVAL_SECONDS),
  SEARCH_REBUILD_INTERVAL_SECONDS: z.coerce.number().int().positive().default(DEFAULT_SEARCH_REBUILD_INTERVAL_SECONDS),
  PROVIDER_FANOUT_CONCURRENCY: z.coerce.number().int().positive().default(DEFAULT_PROVIDER_FANOUT_CONCURRENCY),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  RESPONSE_COMPRESSION_THRESHOLD_BYTES: z.coerce.number().int().nonnegative().default(1024),
  STARTUP_PREWARM_BUDGET_MS: z.coerce.number().int().nonnegative().default(250),
});

export type AppConfig = {
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  logPretty: boolean;
  httpLogStyle: z.infer<typeof envSchema>['LOG_HTTP_STYLE'];
  databaseUrl: string;
  ccxtExchanges: string[];
  marketFreshnessThresholdSeconds: number;
  marketRefreshIntervalSeconds: number;
  currencyRefreshIntervalSeconds: number;
  searchRebuildIntervalSeconds: number;
  providerFanoutConcurrency: number;
  requestTimeoutMs: number;
  responseCompressionThresholdBytes: number;
  startupPrewarmBudgetMs: number;
};

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(rawEnv);

  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    httpLogStyle: env.LOG_HTTP_STYLE,
    databaseUrl: env.DATABASE_URL,
    ccxtExchanges: env.CCXT_EXCHANGES.split(',').map((value) => value.trim()).filter(Boolean),
    marketFreshnessThresholdSeconds: env.MARKET_FRESHNESS_THRESHOLD_SECONDS,
    marketRefreshIntervalSeconds: env.MARKET_REFRESH_INTERVAL_SECONDS,
    currencyRefreshIntervalSeconds: env.CURRENCY_REFRESH_INTERVAL_SECONDS,
    searchRebuildIntervalSeconds: env.SEARCH_REBUILD_INTERVAL_SECONDS,
    providerFanoutConcurrency: env.PROVIDER_FANOUT_CONCURRENCY,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    responseCompressionThresholdBytes: env.RESPONSE_COMPRESSION_THRESHOLD_BYTES,
    startupPrewarmBudgetMs: env.STARTUP_PREWARM_BUDGET_MS,
  };
}

export function mergeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(),
    ...overrides,
  };
}
