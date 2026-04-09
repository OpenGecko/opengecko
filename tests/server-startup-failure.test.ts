import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApp = {
  log: {
    error: vi.fn(),
  },
  close: vi.fn().mockResolvedValue(undefined),
};

const tracker = {
  start: vi.fn(),
  complete: vi.fn(),
  begin: vi.fn(),
  fail: vi.fn(),
  failCurrent: vi.fn(),
  reportExchangeResult: vi.fn(),
  reportCatalogResult: vi.fn(),
  reportWarning: vi.fn(),
  reportStatus: vi.fn(),
  finish: vi.fn(),
  updateOhlcvProgress: vi.fn(),
};

const buildApp = vi.fn(() => mockApp);
const loadConfig = vi.fn();
const getLastResolvedConfig = vi.fn();
const detectSqliteRuntime = vi.fn(() => 'node');
const createStartupProgressTracker = vi.fn(() => tracker);

vi.mock('../src/app', () => ({
  buildApp,
}));

vi.mock('../src/config/env', () => ({
  loadConfig,
  getLastResolvedConfig,
}));

vi.mock('../src/db/client', () => ({
  detectSqliteRuntime,
}));

vi.mock('../src/services/startup-progress', () => ({
  createStartupProgressTracker,
}));

describe('server startup failure logging', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockApp.close.mockResolvedValue(undefined);
  });

  it('uses the last resolved config for deterministic failure logging without reloading config', async () => {
    const startupError = new Error('invalid port');
    const resolvedConfig = {
      host: '127.0.0.1',
      port: 3103,
      logLevel: 'error',
      logPretty: false,
      httpLogStyle: 'emoji_compact_p',
      databaseUrl: ':memory:',
      ccxtExchanges: ['coinbase'],
      marketFreshnessThresholdSeconds: 300,
      marketRefreshIntervalSeconds: 60,
      currencyRefreshIntervalSeconds: 300,
      searchRebuildIntervalSeconds: 900,
      providerFanoutConcurrency: 4,
      requestTimeoutMs: 15000,
      ohlcvTargetHistoryDays: 365,
      ohlcvRetentionDays: 365,
      defillamaBaseUrl: 'https://api.llama.fi',
      defillamaYieldsBaseUrl: 'https://yields.llama.fi',
      responseCompressionThresholdBytes: 1024,
      startupPrewarmBudgetMs: 250,
      disableRemoteCurrencyRefresh: false,
    };

    loadConfig.mockImplementation(() => {
      throw startupError;
    });
    getLastResolvedConfig.mockReturnValue(resolvedConfig);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('../src/server');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(getLastResolvedConfig).toHaveBeenCalledTimes(1);
    expect(buildApp).toHaveBeenCalledWith({
      config: resolvedConfig,
      startBackgroundJobs: false,
      pluginTimeout: 0,
    });
    expect(tracker.failCurrent).toHaveBeenCalledWith('invalid port');
    expect(mockApp.log.error).toHaveBeenCalledWith(
      {
        error: expect.objectContaining({
          name: 'Error',
          message: 'invalid port',
        }),
      },
      'server startup failed',
    );
    expect(mockApp.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it('falls back to a deterministic structured stderr log when no config was resolved', async () => {
    const startupError = new Error('invalid port');

    loadConfig.mockImplementation(() => {
      throw startupError;
    });
    getLastResolvedConfig.mockReturnValue(null);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('../src/server');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(buildApp).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0]?.[0]).toEqual(JSON.stringify({
      level: 'error',
      message: 'server startup failed',
      error: {
        name: 'Error',
        message: 'invalid port',
        stack: startupError.stack,
      },
    }));
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
