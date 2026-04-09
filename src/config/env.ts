import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import {
  DEFAULT_CCXT_EXCHANGES,
  DEFAULT_CURRENCY_REFRESH_INTERVAL_SECONDS,
  DEFAULT_MARKET_FRESHNESS_THRESHOLD_SECONDS,
  DEFAULT_MARKET_REFRESH_INTERVAL_SECONDS,
  DEFAULT_OHLCV_RETENTION_DAYS,
  DEFAULT_OHLCV_TARGET_HISTORY_DAYS,
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
  OHLCV_TARGET_HISTORY_DAYS: z.coerce.number().int().positive().default(DEFAULT_OHLCV_TARGET_HISTORY_DAYS),
  OHLCV_RETENTION_DAYS: z.coerce.number().int().positive().default(DEFAULT_OHLCV_RETENTION_DAYS),
  DEFILLAMA_BASE_URL: z.string().url().default('https://api.llama.fi'),
  DEFILLAMA_YIELDS_BASE_URL: z.string().url().default('https://yields.llama.fi'),
  RESPONSE_COMPRESSION_THRESHOLD_BYTES: z.coerce.number().int().nonnegative().default(1024),
  STARTUP_PREWARM_BUDGET_MS: z.coerce.number().int().nonnegative().default(250),
  DISABLE_REMOTE_CURRENCY_REFRESH: z.boolean().default(false),
  OPEN_GECKO_REBUILD_CANONICAL_DB_ON_START: z.boolean().default(false),
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
  ohlcvTargetHistoryDays: number;
  ohlcvRetentionDays: number;
  defillamaBaseUrl: string;
  defillamaYieldsBaseUrl: string;
  responseCompressionThresholdBytes: number;
  startupPrewarmBudgetMs: number;
  disableRemoteCurrencyRefresh: boolean;
  rebuildCanonicalDbOnStart: boolean;
};

function parseBooleanEnv(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return value;
}

let repoEnvLoaded = false;
let repoEnvLoadedFromCwd: string | null = null;
let lastResolvedConfig: AppConfig | null = null;

function parseDotenv(contents: string) {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separatorIndex = normalized.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = normalized.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

export function loadRepoDotenv(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const normalizedCwd = resolve(cwd);

  if (repoEnvLoaded && repoEnvLoadedFromCwd === normalizedCwd) {
    return false;
  }

  if (env.OPEN_GECKO_DISABLE_REPO_DOTENV === '1') {
    repoEnvLoaded = true;
    repoEnvLoadedFromCwd = normalizedCwd;
    return false;
  }
  const dotenvPath = resolve(normalizedCwd, '.env');

  if (!existsSync(dotenvPath)) {
    repoEnvLoaded = true;
    repoEnvLoadedFromCwd = normalizedCwd;
    return false;
  }

  const parsed = parseDotenv(readFileSync(dotenvPath, 'utf8'));

  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }

  repoEnvLoaded = true;
  repoEnvLoadedFromCwd = normalizedCwd;
  return true;
}

export function resetRepoDotenvLoaderForTests() {
  repoEnvLoaded = false;
  repoEnvLoadedFromCwd = null;
  lastResolvedConfig = null;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  if (rawEnv === process.env) {
    loadRepoDotenv();
  }

  const normalizedEnv = Object.fromEntries(
    Object.entries(rawEnv).map(([key, value]) => [key, parseBooleanEnv(value)]),
  );
  const env = envSchema.parse(normalizedEnv);

  const config = {
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
    ohlcvTargetHistoryDays: env.OHLCV_TARGET_HISTORY_DAYS,
    ohlcvRetentionDays: env.OHLCV_RETENTION_DAYS,
    defillamaBaseUrl: env.DEFILLAMA_BASE_URL,
    defillamaYieldsBaseUrl: env.DEFILLAMA_YIELDS_BASE_URL,
    responseCompressionThresholdBytes: env.RESPONSE_COMPRESSION_THRESHOLD_BYTES,
    startupPrewarmBudgetMs: env.STARTUP_PREWARM_BUDGET_MS,
    disableRemoteCurrencyRefresh: env.DISABLE_REMOTE_CURRENCY_REFRESH,
    rebuildCanonicalDbOnStart: env.OPEN_GECKO_REBUILD_CANONICAL_DB_ON_START,
  };

  lastResolvedConfig = config;
  return config;
}

export function mergeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const config = {
    ...loadConfig(),
    ...overrides,
  };

  lastResolvedConfig = config;

  return config;
}

export function getLastResolvedConfig() {
  return lastResolvedConfig;
}
