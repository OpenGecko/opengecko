import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins, marketSnapshots } from '../src/db/schema';
import { getSimplePriceAvailabilityFailure, warmSimplePriceCache, type SimplePriceRequestQuery } from '../src/modules/simple';
import type { MarketDataRuntimeState } from '../src/services/market-runtime-state';

const now = new Date('2026-03-28T12:00:00.000Z');

function seedSimpleParityData(database: AppDatabase) {
  const rows = [
    {
      id: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      price: 66_194,
      marketCap: 1_323_878_876_195.027,
      totalVolume: 47_657_767_940.0297,
      priceChangePercentage24h: -3.6821618128964673,
      lastUpdated: new Date('2026-03-28T10:21:22.000Z'),
    },
    {
      id: 'ethereum',
      symbol: 'eth',
      name: 'Ethereum',
      price: 1_987.94,
      marketCap: 239_883_065_644.24435,
      totalVolume: 18_589_171_218.177616,
      priceChangePercentage24h: -3.509680921533086,
      lastUpdated: new Date('2026-03-28T10:21:13.000Z'),
    },
  ];

  for (const row of rows) {
    database.db.insert(coins).values({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      apiSymbol: row.id,
      hashingAlgorithm: null,
      blockTimeInMinutes: null,
      categoriesJson: '[]',
      descriptionJson: '{}',
      linksJson: '{}',
      imageThumbUrl: null,
      imageSmallUrl: null,
      imageLargeUrl: null,
      marketCapRank: null,
      genesisDate: null,
      platformsJson: '{}',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: coins.id,
      set: {
        symbol: row.symbol,
        name: row.name,
        apiSymbol: row.id,
        updatedAt: now,
      },
    }).run();

    database.db.insert(marketSnapshots).values({
      coinId: row.id,
      vsCurrency: 'usd',
      price: row.price,
      marketCap: row.marketCap,
      totalVolume: row.totalVolume,
      marketCapRank: null,
      fullyDilutedValuation: null,
      circulatingSupply: null,
      totalSupply: null,
      maxSupply: null,
      ath: null,
      athChangePercentage: null,
      athDate: null,
      atl: null,
      atlChangePercentage: null,
      atlDate: null,
      priceChange24h: null,
      priceChangePercentage24h: row.priceChangePercentage24h,
      sourceProvidersJson: '["binance"]',
      sourceCount: 1,
      updatedAt: now,
      lastUpdated: row.lastUpdated,
    }).run();
  }
}

function createRuntimeState(overrides: Partial<MarketDataRuntimeState> = {}): MarketDataRuntimeState {
  return {
    initialSyncCompleted: true,
    listenerBindDeferred: false,
    initialSyncCompletedWithoutUsableLiveSnapshots: false,
    allowStaleLiveService: false,
    syncFailureReason: null,
    validationOverride: {
      mode: 'off',
      reason: null,
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    },
    providerFailureCooldownUntil: null,
    forcedProviderFailure: {
      active: false,
      reason: null,
    },
    startupPrewarm: {
      enabled: false,
      budgetMs: 0,
      readyWithinBudget: true,
      firstRequestWarmBenefitsObserved: false,
      firstRequestWarmBenefitPending: false,
      targets: [],
      completedAt: null,
      totalDurationMs: null,
      targetResults: [],
    },
    hotDataRevision: 1,
    listenerBound: false,
    ...overrides,
  };
}

describe('simple price parity helpers', () => {
  let database: AppDatabase;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-simple-price-parity-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    seedSimpleParityData(database);
    rebuildSearchIndex(database);
  });

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('populates requested canonical simple-price quote fields from usable live snapshots', () => {
    const cache = new Map();
    const runtimeState = createRuntimeState({
      validationOverride: {
        mode: 'stale_allowed',
        reason: 'seeded default/local runtime exposes persisted snapshots',
        snapshotTimestampOverride: null,
        snapshotSourceCountOverride: null,
      },
    });
    const query: SimplePriceRequestQuery = {
      ids: 'bitcoin,ethereum',
      vs_currencies: 'usd',
      include_market_cap: 'true',
      include_24hr_vol: 'true',
      include_24hr_change: 'true',
      include_last_updated_at: 'true',
    };

    const payload = warmSimplePriceCache(
      cache,
      query,
      database,
      300,
      runtimeState,
    );

    expect(payload).toEqual({
      bitcoin: {
        usd: 66_194,
        usd_market_cap: 1_323_878_876_195.027,
        usd_24h_vol: 47_657_767_940.0297,
        usd_24h_change: -3.6821618128964673,
        last_updated_at: 1_774_693_282,
      },
      ethereum: {
        usd: 1_987.94,
        usd_market_cap: 239_883_065_644.24435,
        usd_24h_vol: 18_589_171_218.177616,
        usd_24h_change: -3.509680921533086,
        last_updated_at: 1_774_693_273,
      },
    });

    expect(getSimplePriceAvailabilityFailure(database, runtimeState, Object.keys(payload).length, 'simple/price')).toBeNull();
  });

  it('only returns degraded no-live-snapshots failures when the runtime explicitly reports zero usable live data', () => {
    database.db.update(marketSnapshots).set({
      sourceCount: 0,
      sourceProvidersJson: '[]',
    }).run();

    const runtimeState = createRuntimeState({
      initialSyncCompletedWithoutUsableLiveSnapshots: true,
    });

    const noPayloadFailure = getSimplePriceAvailabilityFailure(database, runtimeState, 0, 'simple/price');
    expect(noPayloadFailure).toEqual({
      statusCode: 503,
      error: 'service_unavailable',
      message: 'No usable live market snapshots are available for simple/price.',
    });

    const livePayloadFailure = getSimplePriceAvailabilityFailure(database, runtimeState, 2, 'simple/price');
    expect(livePayloadFailure).toBeNull();
  });

  it('resolves ids, names, and symbols to the same canonical coin ids while dropping unknown selector misses', () => {
    const runtimeState = createRuntimeState({
      validationOverride: {
        mode: 'stale_allowed',
        reason: 'seeded default/local runtime exposes persisted snapshots',
        snapshotTimestampOverride: null,
        snapshotSourceCountOverride: null,
      },
    });

    const idsPayload = warmSimplePriceCache(
      new Map(),
      {
        ids: 'bitcoin,unknown-coin',
        vs_currencies: 'usd',
      },
      database,
      300,
      runtimeState,
    );
    const namesPayload = warmSimplePriceCache(
      new Map(),
      {
        names: 'ethereum,unknown-name',
        vs_currencies: 'usd',
      },
      database,
      300,
      runtimeState,
    );
    const symbolsPayload = warmSimplePriceCache(
      new Map(),
      {
        symbols: 'btc,missing-symbol',
        vs_currencies: 'usd',
      },
      database,
      300,
      runtimeState,
    );

    expect(idsPayload).toEqual({
      bitcoin: {
        usd: 66_194,
      },
    });
    expect(namesPayload).toEqual({
      ethereum: {
        usd: 1_987.94,
      },
    });
    expect(symbolsPayload).toEqual({
      bitcoin: {
        usd: 66_194,
      },
    });
    expect(Object.keys(idsPayload)).toEqual(['bitcoin']);
    expect(Object.keys(namesPayload)).toEqual(['ethereum']);
    expect(Object.keys(symbolsPayload)).toEqual(['bitcoin']);
  });

  it('omits optional fields unless explicitly requested and keeps equivalent selector queries stable', () => {
    const runtimeState = createRuntimeState({
      validationOverride: {
        mode: 'stale_allowed',
        reason: 'seeded default/local runtime exposes persisted snapshots',
        snapshotTimestampOverride: null,
        snapshotSourceCountOverride: null,
      },
    });

    const baselinePayload = warmSimplePriceCache(
      new Map(),
      {
        ids: 'ethereum,bitcoin',
        vs_currencies: 'usd',
      },
      database,
      300,
      runtimeState,
    );
    const reorderedPayload = warmSimplePriceCache(
      new Map(),
      {
        ids: 'bitcoin,ethereum',
        vs_currencies: 'usd',
      },
      database,
      300,
      runtimeState,
    );
    const optionalPayload = warmSimplePriceCache(
      new Map(),
      {
        ids: 'bitcoin,ethereum',
        vs_currencies: 'usd',
        include_market_cap: 'true',
        include_24hr_vol: 'true',
        include_24hr_change: 'true',
        include_last_updated_at: 'true',
      },
      database,
      300,
      runtimeState,
    );

    expect(baselinePayload).toEqual(reorderedPayload);
    expect(baselinePayload.bitcoin).toEqual({ usd: 66_194 });
    expect(baselinePayload.ethereum).toEqual({ usd: 1_987.94 });
    expect('usd_market_cap' in baselinePayload.bitcoin).toBe(false);
    expect('usd_24h_vol' in baselinePayload.bitcoin).toBe(false);
    expect('usd_24h_change' in baselinePayload.bitcoin).toBe(false);
    expect('last_updated_at' in baselinePayload.bitcoin).toBe(false);
    expect(optionalPayload.bitcoin).toMatchObject({
      usd: 66_194,
      usd_market_cap: 1_323_878_876_195.027,
      usd_24h_vol: 47_657_767_940.0297,
      usd_24h_change: -3.6821618128964673,
      last_updated_at: 1_774_693_282,
    });
    expect(optionalPayload.ethereum).toMatchObject({
      usd: 1_987.94,
      usd_market_cap: 239_883_065_644.24435,
      usd_24h_vol: 18_589_171_218.177616,
      usd_24h_change: -3.509680921533086,
      last_updated_at: 1_774_693_273,
    });
  });
});
