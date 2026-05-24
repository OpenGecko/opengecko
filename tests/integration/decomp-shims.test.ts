import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFastifyApp } from '../../src/app/fastify';
import { mergeConfig } from '../../src/config/env';
import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData } from '../../src/db/client';
import { registerErrorHandler } from '../../src/http/errors';
import { registerTransportControls } from '../../src/http/transport';
import type { registerCoinRoutes as registerCoinRoutesType } from '../../src/modules/coins/routes';
import { createChartResponseSourceDiagnostics } from '../../src/services/chart-response-source-diagnostics';
import { createMarketDataRuntimeState } from '../../src/services/market-runtime-state';
import { createMetricsRegistry } from '../../src/services/metrics';
import * as candleStore from '../../src/services/candle-store';

vi.mock('../../src/providers/ccxt', () => ({
  fetchExchangeOHLCV: vi.fn().mockResolvedValue([]),
  fetchExchangeMarkets: vi.fn().mockResolvedValue([]),
  fetchExchangeNetworks: vi.fn().mockResolvedValue([]),
  closeExchangePool: vi.fn().mockResolvedValue(undefined),
  isValidExchangeId: (value: string): value is string =>
    ['binance', 'coinbase', 'kraken', 'bybit', 'okx'].includes(value),
}));

import { fetchExchangeOHLCV } from '../../src/providers/ccxt';

const mockedFetchExchangeOHLCV = fetchExchangeOHLCV as ReturnType<typeof vi.fn>;

type CoinRouteRegistrar = typeof registerCoinRoutesType;

function decodePayload(payload: Buffer, encoding: unknown) {
  if (encoding === 'br') {
    return brotliDecompressSync(payload).toString('utf8');
  }

  if (encoding === 'gzip') {
    return gunzipSync(payload).toString('utf8');
  }

  return payload.toString('utf8');
}

function normalizeJsonBodyForComparison(body: string) {
  const timingFields = new Set(['last_updated', 'updated_at', 'timestamp', 'duration_ms', 'age_seconds']);
  const parsed = JSON.parse(body) as unknown;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }

    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .filter((key) => !timingFields.has(key))
          .sort()
          .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
      );
    }

    return value;
  };

  return normalize(parsed);
}

function buildCoinOnlyApp(registerCoinRoutes: CoinRouteRegistrar): FastifyInstance {
  const config = mergeConfig({
    databaseUrl: ':memory:',
    ccxtExchanges: [],
    logLevel: 'silent',
    responseCompressionThresholdBytes: 1,
  });
  const app = createFastifyApp(config, {});
  const database = createDatabase(':memory:');
  const runtimeState = createMarketDataRuntimeState([]);
  const metrics = createMetricsRegistry();
  const chartResponseSources = createChartResponseSourceDiagnostics(database);

  migrateDatabase(database);
  seedStaticReferenceData(database, {
    includeSeededExchanges: true,
    includeValidationMarketCorpus: true,
  });
  rebuildSearchIndex(database);

  app.decorate('metrics', metrics);
  registerErrorHandler(app);
  registerTransportControls(app, {
    responseCompressionThresholdBytes: config.responseCompressionThresholdBytes,
  });
  registerCoinRoutes(
    app,
    database,
    config.marketFreshnessThresholdSeconds,
    runtimeState,
    chartResponseSources,
  );
  app.addHook('onClose', async () => {
    database.client.close();
  });

  return app;
}

async function injectWithCounts(app: FastifyInstance, url: string, acceptEncoding?: string) {
  mockedFetchExchangeOHLCV.mockClear();
  const upsertSpy = vi.spyOn(candleStore, 'upsertCanonicalOhlcvCandle');
  upsertSpy.mockClear();

  const response = await app.inject({
    method: 'GET',
    url,
    headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : undefined,
  });
  const providerFetchCalls = mockedFetchExchangeOHLCV.mock.calls.length;
  const candleWriteCalls = upsertSpy.mock.calls.length;
  upsertSpy.mockRestore();

  return {
    statusCode: response.statusCode,
    encoding: response.headers['content-encoding'],
    body: normalizeJsonBodyForComparison(decodePayload(response.rawPayload, response.headers['content-encoding'])),
    providerFetchCalls,
    candleWriteCalls,
  };
}

describe('decomposition re-export shims', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('keeps pre-milestone import paths resolving to their direct route modules', async () => {
    const coinsShim = await import('../../src/modules/coins');
    const coinsDirect = await import('../../src/modules/coins/routes');
    const onchainShim = await import('../../src/modules/onchain');
    const onchainDirect = await import('../../src/modules/onchain/routes');
    const dataQualityShim = await import('../../src/services/data-quality-diagnostics');
    const dataQualityDirect = await import('../../src/services/data-quality-diagnostics/index');

    expect(coinsShim.registerCoinRoutes).toBe(coinsDirect.registerCoinRoutes);
    expect(onchainShim.registerOnchainRoutes).toBe(onchainDirect.registerOnchainRoutes);
    expect(onchainShim.ONCHAIN_FIXTURE_VERSION).toBe(onchainDirect.ONCHAIN_FIXTURE_VERSION);
    expect(dataQualityShim.buildDataQualityDiagnostics).toBe(dataQualityDirect.buildDataQualityDiagnostics);
    expect(dataQualityShim.TARGET_THRESHOLD).toBe(dataQualityDirect.TARGET_THRESHOLD);
  });

  it('produces identical shim-vs-direct responses, compression headers, and read-path spy counts', async () => {
    const { registerCoinRoutes: shimRegisterCoinRoutes } = await import('../../src/modules/coins');
    const { registerCoinRoutes: directRegisterCoinRoutes } = await import('../../src/modules/coins/routes');
    const shimApp = buildCoinOnlyApp(shimRegisterCoinRoutes);
    const directApp = buildCoinOnlyApp(directRegisterCoinRoutes);
    apps.push(shimApp, directApp);

    await Promise.all(apps.map((app) => app.ready()));

    const cases = [
      {
        url: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=5&page=1&sparkline=true&price_change_percentage=24h,7d',
        acceptEncoding: 'br;q=1, gzip;q=0.5',
      },
      {
        url: '/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily',
        acceptEncoding: 'identity, *;q=0',
      },
      {
        url: '/coins/bitcoin/ohlc?vs_currency=usd&days=14&interval=daily',
        acceptEncoding: 'br;q=0, gzip;q=1',
      },
    ];

    for (const requestCase of cases) {
      const shimResult = await injectWithCounts(shimApp, requestCase.url, requestCase.acceptEncoding);
      const directResult = await injectWithCounts(directApp, requestCase.url, requestCase.acceptEncoding);

      expect(shimResult).toEqual(directResult);
      expect(shimResult.providerFetchCalls).toBe(0);
      expect(shimResult.candleWriteCalls).toBe(0);
    }
  });
});
