import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app';
import { createResponseCache } from '../services/response-cache';

type RouteBenchmarkTarget = {
  name: string;
  url: string;
};

type RouteBenchmarkResult = {
  name: string;
  url: string;
  status_code: number;
  cold_ms: number;
  warm_ms: number;
  payload_bytes: number;
  gzip_bytes: number | null;
  brotli_bytes: number | null;
  gzip_ratio: number | null;
  brotli_ratio: number | null;
  cache_control: string | null;
  etag_present: boolean;
};

type CacheEventCounts = Record<string, Record<'hit' | 'miss', number>>;

export type HotRouteBenchmarkReport = {
  generated_at: string;
  routes: RouteBenchmarkResult[];
  cache_events: CacheEventCounts;
  cache_probe: {
    coalesced_request_count: number;
    producer_call_count: number;
    eviction_count: number;
    final_size: number;
  };
};

const BENCHMARK_TARGETS: RouteBenchmarkTarget[] = [
  {
    name: 'simple_price_representative',
    url: '/simple/price?ids=bitcoin,ethereum,solana,usd-coin&vs_currencies=usd,btc&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true',
  },
  {
    name: 'coins_markets_page_1',
    url: '/coins/markets?vs_currency=usd&order=market_cap_desc&page=1&per_page=100&price_change_percentage=24h,7d&sparkline=false',
  },
  {
    name: 'exchange_tickers_binance',
    url: '/exchanges/binance/tickers?include_exchange_logo=true&depth=true',
  },
];

function roundMs(value: number) {
  return Number(value.toFixed(3));
}

function ratio(compressedBytes: number | null, payloadBytes: number) {
  if (compressedBytes === null || payloadBytes === 0) {
    return null;
  }

  return Number((compressedBytes / payloadBytes).toFixed(4));
}

async function timedInject(app: FastifyInstance, url: string, headers?: Record<string, string>) {
  const startedAt = performance.now();
  const response = await app.inject({
    method: 'GET',
    url,
    headers,
  });
  const durationMs = performance.now() - startedAt;

  return {
    response,
    durationMs,
  };
}

async function measureCompressedBytes(app: FastifyInstance, url: string, encoding: 'gzip' | 'br') {
  const response = await app.inject({
    method: 'GET',
    url,
    headers: {
      'accept-encoding': encoding,
    },
  });

  if (response.statusCode !== 200 || response.headers['content-encoding'] !== encoding) {
    return null;
  }

  const decoded = encoding === 'gzip'
    ? gunzipSync(response.rawPayload).toString('utf8')
    : brotliDecompressSync(response.rawPayload).toString('utf8');

  JSON.parse(decoded);

  return response.rawPayload.length;
}

async function benchmarkRoute(app: FastifyInstance, target: RouteBenchmarkTarget): Promise<RouteBenchmarkResult> {
  const cold = await timedInject(app, target.url);
  const warm = await timedInject(app, target.url);
  const payloadBytes = Buffer.byteLength(warm.response.body);
  const gzipBytes = await measureCompressedBytes(app, target.url, 'gzip');
  const brotliBytes = await measureCompressedBytes(app, target.url, 'br');

  return {
    name: target.name,
    url: target.url,
    status_code: warm.response.statusCode,
    cold_ms: roundMs(cold.durationMs),
    warm_ms: roundMs(warm.durationMs),
    payload_bytes: payloadBytes,
    gzip_bytes: gzipBytes,
    brotli_bytes: brotliBytes,
    gzip_ratio: ratio(gzipBytes, payloadBytes),
    brotli_ratio: ratio(brotliBytes, payloadBytes),
    cache_control: typeof warm.response.headers['cache-control'] === 'string' ? warm.response.headers['cache-control'] : null,
    etag_present: typeof warm.response.headers.etag === 'string',
  };
}

function parseCacheEvents(metrics: string): CacheEventCounts {
  const events: CacheEventCounts = {};
  const metricPattern = /^opengecko_cache_events_total\{outcome="(?<outcome>hit|miss)",surface="(?<surface>[^"]+)"\} (?<value>\d+)$/gm;

  for (const match of metrics.matchAll(metricPattern)) {
    const groups = match.groups;

    if (!groups) {
      continue;
    }

    const surface = groups.surface;
    const outcome = groups.outcome as 'hit' | 'miss';
    const value = Number(groups.value);
    events[surface] ??= { hit: 0, miss: 0 };
    events[surface][outcome] = value;
  }

  return events;
}

async function runCacheProbe() {
  const cache = createResponseCache<{ value: number }>({
    ttlMs: 60_000,
    maxEntries: 2,
    clone: (value) => ({ ...value }),
  });
  let producerCallCount = 0;
  const coalescedRequestCount = 5;

  await Promise.all(Array.from({ length: coalescedRequestCount }, () => cache.getOrSet('coalesced', 1, async () => {
    producerCallCount += 1;
    await Promise.resolve();
    return { value: producerCallCount };
  })));

  cache.set('first', { value: 1 }, 1);
  cache.set('second', { value: 2 }, 1);
  cache.set('third', { value: 3 }, 1);

  const evictionCount = cache.getStale('first', 1) === null ? 1 : 0;

  return {
    coalesced_request_count: coalescedRequestCount,
    producer_call_count: producerCallCount,
    eviction_count: evictionCount,
    final_size: cache.size(),
  };
}

export async function runHotRouteBenchmark(app: FastifyInstance): Promise<HotRouteBenchmarkReport> {
  await app.ready();

  const routes: RouteBenchmarkResult[] = [];

  for (const target of BENCHMARK_TARGETS) {
    routes.push(await benchmarkRoute(app, target));
  }

  const metricsResponse = await app.inject({
    method: 'GET',
    url: '/metrics',
  });

  return {
    generated_at: new Date().toISOString(),
    routes,
    cache_events: parseCacheEvents(metricsResponse.body),
    cache_probe: await runCacheProbe(),
  };
}

export async function runIsolatedHotRouteBenchmark() {
  const app = buildApp({
    config: {
      databaseUrl: ':memory:',
      ccxtExchanges: ['binance', 'coinbase', 'kraken', 'okx'],
      host: '127.0.0.1',
      port: 3102,
      logLevel: 'silent',
      responseCompressionThresholdBytes: 64,
    },
    startBackgroundJobs: false,
  });

  try {
    return await runHotRouteBenchmark(app);
  } finally {
    await app.close();
  }
}

async function main() {
  const report = await runIsolatedHotRouteBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
