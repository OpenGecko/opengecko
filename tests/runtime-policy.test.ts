import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/env';
import {
  DEFAULT_CCXT_EXCHANGES,
  DEFAULT_MARKET_FRESHNESS_THRESHOLD_SECONDS,
  DEFAULT_MARKET_REFRESH_INTERVAL_SECONDS,
  DEFAULT_SEARCH_REBUILD_INTERVAL_SECONDS,
  STALE_DATA_POLICY,
} from '../src/config/runtime-policy';

describe('runtime policy defaults', () => {
  it('loads the default exchange set and polling cadence', () => {
    const config = loadConfig({});

    expect(config.ccxtExchanges).toEqual([...DEFAULT_CCXT_EXCHANGES]);
    expect(config.marketFreshnessThresholdSeconds).toBe(DEFAULT_MARKET_FRESHNESS_THRESHOLD_SECONDS);
    expect(config.providerFanoutConcurrency).toBe(2);
    expect(config.marketRefreshIntervalSeconds).toBe(DEFAULT_MARKET_REFRESH_INTERVAL_SECONDS);
    expect(config.searchRebuildIntervalSeconds).toBe(DEFAULT_SEARCH_REBUILD_INTERVAL_SECONDS);
    expect(config.httpLogStyle).toBe('emoji_compact_p');
  });

  it('keeps the stale-data policy explicit in code', () => {
    expect(STALE_DATA_POLICY).toEqual({
      seededSnapshotsRemainUsable: true,
      omitStaleLiveSnapshotsFromSimpleResponses: true,
      omitStaleLiveSnapshotsFromGlobalAggregates: true,
      nullOutStaleLiveMarketFieldsInDetailResponses: true,
    });
  });
});
