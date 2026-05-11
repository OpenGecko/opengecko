import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/env';
import {
  DEFAULT_CCXT_EXCHANGES,
  DEFAULT_CATEGORY_AGGREGATOR_INTERVAL_SECONDS,
  DEFAULT_COIN_CATALOG_RESCAN_INTERVAL_SECONDS,
  DEFAULT_DEFILLAMA_POOL_SWEEP_INTERVAL_SECONDS,
  DEFAULT_DEFILLAMA_TOKEN_SWEEP_INTERVAL_SECONDS,
  DEFAULT_EXCHANGE_METADATA_RESCAN_INTERVAL_SECONDS,
  DEFAULT_GLOBAL_AGGREGATOR_INTERVAL_SECONDS,
  DEFAULT_MARKET_FRESHNESS_THRESHOLD_SECONDS,
  DEFAULT_MARKET_REFRESH_INTERVAL_SECONDS,
  DEFAULT_SEARCH_REBUILD_INTERVAL_SECONDS,
  DEFAULT_SUBSQUID_TRADE_SWEEP_INTERVAL_SECONDS,
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

  it('loads Tier 1 scheduler cadences and disable flags from documented environment names', () => {
    const config = loadConfig({
      DEFILLAMA_POOL_SWEEP_INTERVAL_SECONDS: '11',
      DEFILLAMA_TOKEN_SWEEP_INTERVAL_SECONDS: '12',
      SUBSQUID_TRADE_SWEEP_INTERVAL_SECONDS: '13',
      COIN_CATALOG_RESCAN_INTERVAL_SECONDS: '14',
      EXCHANGE_METADATA_RESCAN_INTERVAL_SECONDS: '15',
      GLOBAL_AGGREGATOR_INTERVAL_SECONDS: '16',
      CATEGORY_AGGREGATOR_INTERVAL_SECONDS: '17',
      DEFILLAMA_POOL_SWEEP_DISABLED: 'true',
      DEFILLAMA_TOKEN_SWEEP_DISABLED: 'true',
      SUBSQUID_TRADE_SWEEP_DISABLED: 'true',
      COIN_CATALOG_RESCAN_DISABLED: 'true',
      EXCHANGE_METADATA_RESCAN_DISABLED: 'true',
      GLOBAL_AGGREGATOR_DISABLED: 'true',
      CATEGORY_AGGREGATOR_DISABLED: 'true',
    });

    expect(config.defillamaPoolSweepIntervalSeconds).toBe(11);
    expect(config.defillamaTokenSweepIntervalSeconds).toBe(12);
    expect(config.subsquidTradeSweepIntervalSeconds).toBe(13);
    expect(config.coinCatalogRescanIntervalSeconds).toBe(14);
    expect(config.exchangeMetadataRescanIntervalSeconds).toBe(15);
    expect(config.globalAggregatorIntervalSeconds).toBe(16);
    expect(config.categoryAggregatorIntervalSeconds).toBe(17);
    expect(config.defillamaPoolSweepDisabled).toBe(true);
    expect(config.defillamaTokenSweepDisabled).toBe(true);
    expect(config.subsquidTradeSweepDisabled).toBe(true);
    expect(config.coinCatalogRescanDisabled).toBe(true);
    expect(config.exchangeMetadataRescanDisabled).toBe(true);
    expect(config.globalAggregatorDisabled).toBe(true);
    expect(config.categoryAggregatorDisabled).toBe(true);
  });

  it('keeps Tier 1 default cadences aligned with the mission contract', () => {
    const config = loadConfig({});

    expect(config.defillamaPoolSweepIntervalSeconds).toBe(DEFAULT_DEFILLAMA_POOL_SWEEP_INTERVAL_SECONDS);
    expect(config.defillamaTokenSweepIntervalSeconds).toBe(DEFAULT_DEFILLAMA_TOKEN_SWEEP_INTERVAL_SECONDS);
    expect(config.subsquidTradeSweepIntervalSeconds).toBe(DEFAULT_SUBSQUID_TRADE_SWEEP_INTERVAL_SECONDS);
    expect(config.coinCatalogRescanIntervalSeconds).toBe(DEFAULT_COIN_CATALOG_RESCAN_INTERVAL_SECONDS);
    expect(config.exchangeMetadataRescanIntervalSeconds).toBe(DEFAULT_EXCHANGE_METADATA_RESCAN_INTERVAL_SECONDS);
    expect(config.globalAggregatorIntervalSeconds).toBe(DEFAULT_GLOBAL_AGGREGATOR_INTERVAL_SECONDS);
    expect(config.categoryAggregatorIntervalSeconds).toBe(DEFAULT_CATEGORY_AGGREGATOR_INTERVAL_SECONDS);
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
