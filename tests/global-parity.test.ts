import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase, rebuildSearchIndex, seedStaticReferenceData, type AppDatabase } from '../src/db/client';
import { coins, exchanges, marketSnapshots } from '../src/db/schema';
import { getMarketRows } from '../src/modules/catalog';
import { getSnapshotAccessPolicy, getUsableSnapshot } from '../src/modules/market-freshness';
import type { MarketDataRuntimeState } from '../src/services/market-runtime-state';
import { getSnapshotOwnership } from '../src/services/market-snapshots';

const now = new Date('2026-03-28T12:00:00.000Z');

function seedGlobalParityData(database: AppDatabase) {
  const coinRows = [
    {
      id: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      marketCapRank: 1,
      price: 66_330.91666666667,
      marketCap: 1_316_552_505_800,
      totalVolume: 2_000_000_000,
      priceChangePercentage24h: -2.9,
      lastUpdated: new Date('2026-03-28T10:13:06.000Z'),
    },
    {
      id: 'ethereum',
      symbol: 'eth',
      name: 'Ethereum',
      marketCapRank: 2,
      price: 1_995,
      marketCap: 239_391_279_172.5142,
      totalVolume: 400_000_000,
      priceChangePercentage24h: -3.4,
      lastUpdated: new Date('2026-03-28T10:13:04.000Z'),
    },
    {
      id: 'usd-coin',
      symbol: 'usdc',
      name: 'USD Coin',
      marketCapRank: 3,
      price: 1,
      marketCap: 59_999_374_619.253395,
      totalVolume: 150_000_000,
      priceChangePercentage24h: 0.01,
      lastUpdated: new Date('2026-03-28T10:13:02.000Z'),
    },
    {
      id: 'tether',
      symbol: 'usdt',
      name: 'Tether',
      marketCapRank: 4,
      price: 1.0000354100000002,
      marketCap: 126_680_645_668.43121,
      totalVolume: 100_000_000,
      priceChangePercentage24h: 0.02,
      lastUpdated: new Date('2026-03-28T10:13:00.000Z'),
    },
    {
      id: 'binancecoin',
      symbol: 'bnb',
      name: 'BNB',
      marketCapRank: 5,
      price: 611.5847414776975,
      marketCap: 80_225_541_159.42001,
      totalVolume: 120_000_000,
      priceChangePercentage24h: -1.3,
      lastUpdated: new Date('2026-03-28T10:12:58.000Z'),
    },
    {
      id: 'ripple',
      symbol: 'xrp',
      name: 'XRP',
      marketCapRank: 6,
      price: 1.331157816474203,
      marketCap: 78_535_407_666.24858,
      totalVolume: 110_000_000,
      priceChangePercentage24h: -1.9,
      lastUpdated: new Date('2026-03-28T10:12:56.000Z'),
    },
    {
      id: 'solana',
      symbol: 'sol',
      name: 'Solana',
      marketCapRank: 7,
      price: 82.58380622740492,
      marketCap: 45_450_881_744.67436,
      totalVolume: 90_000_000,
      priceChangePercentage24h: -4.2,
      lastUpdated: new Date('2026-03-28T10:12:54.000Z'),
    },
  ];

  for (const row of coinRows) {
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
      marketCapRank: row.marketCapRank,
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
        marketCapRank: row.marketCapRank,
        updatedAt: now,
      },
    }).run();

    database.db.insert(marketSnapshots).values({
      coinId: row.id,
      vsCurrency: 'usd',
      price: row.price,
      marketCap: row.marketCap,
      totalVolume: row.totalVolume,
      marketCapRank: row.marketCapRank,
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
      sourceProvidersJson: '["seed"]',
      sourceCount: 1,
      updatedAt: now,
      lastUpdated: row.lastUpdated,
    }).run();
  }

  for (const exchangeId of ['binance', 'coinbase', 'kraken', 'okx']) {
    database.db.insert(exchanges).values({
      id: exchangeId,
      name: exchangeId,
      yearEstablished: null,
      country: null,
      description: '',
      url: `https://${exchangeId}.example.com`,
      imageUrl: null,
      hasTradingIncentive: false,
      trustScore: null,
      trustScoreRank: null,
      tradeVolume24hBtc: null,
      tradeVolume24hBtcNormalized: null,
      facebookUrl: null,
      redditUrl: null,
      telegramUrl: null,
      slackUrl: null,
      otherUrlJson: '[]',
      twitterHandle: null,
      centralised: true,
      publicNotice: null,
      alertNotice: null,
      updatedAt: now,
    }).run();
  }
}

describe('global parity', () => {
  let tempDir: string;
  let database: AppDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opengecko-global-parity-'));
    database = createDatabase(join(tempDir, 'test.db'));
    migrateDatabase(database);
    seedStaticReferenceData(database);
    seedGlobalParityData(database);
    rebuildSearchIndex(database);
  });

  function createRuntimeState(): MarketDataRuntimeState {
    return {
      initialSyncCompleted: false,
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
      hotDataRevision: 0,
      listenerBound: false,
    };
  }

  afterEach(() => {
    database.client.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns positive, internally coherent canonical /global aggregates and market-cap percentages', async () => {
    const runtimeState = createRuntimeState();
    const accessPolicy = getSnapshotAccessPolicy(runtimeState);
    const usableRows = getMarketRows(database, 'usd', { status: 'active' })
      .map((row) => ({
        coin: row.coin,
        snapshot: getUsableSnapshot(row.snapshot, 300, accessPolicy, row.snapshot ? row.snapshot.lastUpdated.getTime() : undefined),
        ownership: row.snapshot ? getSnapshotOwnership(row.snapshot) : null,
      }))
      .filter((row): row is typeof row & { snapshot: NonNullable<typeof row.snapshot> } => row.snapshot !== null);
    const totalMarketCapUsd = usableRows.reduce((sum, row) => sum + (row.snapshot.marketCap ?? 0), 0);
    const totalVolumeUsd = usableRows.reduce((sum, row) => sum + (row.snapshot.totalVolume ?? 0), 0);
    const updatedAt = usableRows.reduce((maxTimestamp, row) => Math.max(maxTimestamp, row.snapshot.lastUpdated.getTime()), 0);
    const marketCapPercentage = Object.fromEntries(
      usableRows
        .filter((row) => ['bitcoin', 'ethereum', 'tether', 'binancecoin', 'ripple', 'usd-coin', 'solana'].includes(row.coin.id))
        .map((row) => [row.coin.symbol.toLowerCase(), ((row.snapshot.marketCap ?? 0) / totalMarketCapUsd) * 100]),
    );

    expect(usableRows).toHaveLength(7);
    expect(totalMarketCapUsd).toBeGreaterThan(0);
    expect(totalVolumeUsd).toBeGreaterThan(0);
    expect(totalMarketCapUsd).toBeCloseTo(1_946_835_635_830.5417, 3);
    expect(totalVolumeUsd).toBeCloseTo(2_970_000_000, 3);
    expect(totalMarketCapUsd * 0.8627000182076447).toBeCloseTo(1_679_535_138_478.2998, 1);
    expect(totalMarketCapUsd / 66_330.91666666667).toBeCloseTo(29_350_350.238848522, 3);
    expect(totalMarketCapUsd / 1_995).toBeCloseTo(975_857_461.5691938, 3);
    expect(totalVolumeUsd / 66_330.91666666667).toBeCloseTo(44_775.50061497215, 3);
    expect(updatedAt).toBe(1_774_692_786_000);
    expect(Object.keys(marketCapPercentage).sort()).toEqual(['bnb', 'btc', 'eth', 'sol', 'usdc', 'usdt', 'xrp']);
    expect(marketCapPercentage['btc']).toBeCloseTo(67.6252520536149, 2);
    expect(marketCapPercentage['eth']).toBeCloseTo(12.29642989714369, 2);
    expect(marketCapPercentage['usdc']).toBeCloseTo(3.0818921492392444, 2);
    expect(marketCapPercentage['usdt']).toBeCloseTo(6.507002611670802, 2);
    expect(marketCapPercentage['bnb']).toBeCloseTo(4.1208173757922255, 2);
    expect(marketCapPercentage['xrp']).toBeCloseTo(4.0340029851952295, 2);
    expect(marketCapPercentage['sol']).toBeCloseTo(2.3346029273439157, 2);
  });
});
