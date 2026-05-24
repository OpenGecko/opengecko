import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { coins, marketSnapshots, supplyChartPoints } from '../src/db/schema';

type MarketRowNullShapeFixture = {
  mode: string;
  request: string;
  rows: Array<{
    id: string;
    keys: string[];
    nullFields: string[];
    populatedFields: string[];
  }>;
};

type CoinsMarketsBaselineFixture = {
  request: string;
  rowCount: number;
  sha256: string;
};

const EXCLUDED_TIMING_FIELDS = new Set([
  'last_updated',
  'updated_at',
  'timestamp',
  'duration_ms',
  'age_seconds',
]);

function canonicalizeForParityHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForParityHash);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !EXCLUDED_TIMING_FIELDS.has(key))
        .sort()
        .map((key) => [key, canonicalizeForParityHash((value as Record<string, unknown>)[key])]),
    );
  }

  return value;
}

function sha256CanonicalJson(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForParityHash(value)))
    .digest('hex');
}

function readCoinsMarketsBaselineFixture(): CoinsMarketsBaselineFixture {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/coins-markets-baseline.json'),
    'utf8',
  )) as CoinsMarketsBaselineFixture;
}

function readMarketRowNullShapeFixture(mode: string): MarketRowNullShapeFixture {
  return JSON.parse(readFileSync(
    join(process.cwd(), 'tests/fixtures/market-row-validation-overrides', `${mode}.json`),
    'utf8',
  )) as MarketRowNullShapeFixture;
}

function summarizeMarketRowNullShape(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    keys: Object.keys(row),
    nullFields: Object.keys(row).filter((key) => row[key] === null),
    populatedFields: Object.keys(row).filter((key) => row[key] !== null),
  };
}

describe('coins markets parity', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({
      config: {
        databaseUrl: ':memory:',
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('matches the final canonical /coins/markets parity hash', { timeout: 30000 }, async () => {
    const baseline = readCoinsMarketsBaselineFixture();
    const response = await app.inject({
      method: 'GET',
      url: baseline.request,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(baseline.rowCount);
    expect(sha256CanonicalJson(body)).toBe(baseline.sha256);
  });

  it('preserves canonical membership, ordering, and core market fields for the sampled assets', { timeout: 30000 }, async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'ethereum', 'solana']);

    expect(body[0]).toMatchObject({
      id: 'bitcoin',
      name: 'Bitcoin',
      image: expect.stringContaining('bitcoin'),
      market_cap_rank: 1,
    });
    expect(body[0].current_price).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[0].market_cap).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[0].total_volume).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[0].last_updated).toSatisfy((value: string | null) => value === null || typeof value === 'string');
    expect(body[0].price_change_percentage_24h_in_currency).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[0].price_change_percentage_7d_in_currency).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    if (body[0].current_price !== null && body[0].high_24h !== null && body[0].low_24h !== null) {
      expect(body[0].high_24h).toBeGreaterThanOrEqual(body[0].current_price);
      expect(body[0].low_24h).toBeLessThanOrEqual(body[0].current_price);
    }

    expect(body[1]).toMatchObject({
      id: 'ethereum',
      name: 'Ethereum',
      image: expect.stringContaining('ethereum'),
      market_cap_rank: 2,
    });
    expect(body[1].current_price).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[1].market_cap).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[1].total_volume).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[1].last_updated).toSatisfy((value: string | null) => value === null || typeof value === 'string');
    expect(body[1].price_change_percentage_24h_in_currency).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[1].price_change_percentage_7d_in_currency).toSatisfy((value: number | null) => value === null || typeof value === 'number');

    expect(body[2]).toMatchObject({
      id: 'solana',
      name: 'Solana',
      image: expect.stringContaining('solana'),
    });
    expect(body[2].market_cap_rank).toSatisfy((value: number | null) => typeof value === 'number' && value > 0);
    expect(body[2].current_price).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[2].market_cap).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[2].total_volume).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[2].last_updated).toSatisfy((value: string | null) => value === null || typeof value === 'string');
    expect(body[2].price_change_percentage_24h_in_currency).toSatisfy((value: number | null) => value === null || typeof value === 'number');
    expect(body[2].price_change_percentage_7d_in_currency).toSatisfy((value: number | null) => value === null || typeof value === 'number');
  });

  it('canonicalizes persisted uppercase symbol names before serializing coins markets rows', { timeout: 30000 }, async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&sparkline=false',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.map((row: { name: string }) => row.name)).toEqual(['Bitcoin', 'Ethereum', 'Solana']);
  });

  it('orders fresh source-backed market rows ahead of source-less rows when stale live data is disallowed', async () => {
    await app.ready();
    app.marketDataRuntimeState.initialSyncCompleted = true;
    app.marketDataRuntimeState.allowStaleLiveService = false;
    app.marketDataRuntimeState.validationOverride = {
      mode: 'stale_disallowed',
      reason: 'market quality scrutiny regression',
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    };
    app.marketDataRuntimeState.hotDataRevision += 1;

    const freshTimestamp = new Date();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 2_000,
        marketCap: 240_000_000_000,
        totalVolume: 10_000_000_000,
        marketCapRank: 2,
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();
    app.db.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify([]),
        sourceCount: 0,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&page=1&per_page=5&sparkline=false',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({
      id: 'ethereum',
      current_price: 2_000,
    });
  });

  it('does not rank fresh null-quality market placeholders above priced market rows', async () => {
    await app.ready();
    app.marketDataRuntimeState.initialSyncCompleted = true;
    app.marketDataRuntimeState.allowStaleLiveService = true;
    app.marketDataRuntimeState.validationOverride = {
      mode: 'stale_allowed',
      reason: 'market quality all-null placeholder regression',
      snapshotTimestampOverride: null,
      snapshotSourceCountOverride: null,
    };
    app.marketDataRuntimeState.hotDataRevision += 1;

    const freshTimestamp = new Date();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 0,
        marketCap: null,
        totalVolume: null,
        marketCapRank: 1,
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 2_000,
        marketCap: 240_000_000_000,
        totalVolume: 10_000_000_000,
        marketCapRank: 2,
        sourceProvidersJson: JSON.stringify(['coinbase']),
        sourceCount: 1,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&page=1&per_page=5&sparkline=false',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body[0]).toMatchObject({
      id: 'ethereum',
      current_price: 2_000,
      market_cap: 240_000_000_000,
      total_volume: 10_000_000_000,
    });
    expect(body[0].id).not.toBe('bitcoin');
    const bitcoinIndex = body.findIndex((row: { id: string }) => row.id === 'bitcoin');
    const ethereumIndex = body.findIndex((row: { id: string }) => row.id === 'ethereum');
    expect(bitcoinIndex === -1 || bitcoinIndex > ethereumIndex).toBe(true);
  });

  it('keeps source-evidenced canonical majors on the first market-cap page while serving residual stale fallback', async () => {
    await app.ready();
    app.marketDataRuntimeState.initialSyncCompleted = true;
    app.marketDataRuntimeState.allowStaleLiveService = true;
    app.marketDataRuntimeState.syncFailureReason = 'startup providers timed out; residual snapshots retained';
    app.marketDataRuntimeState.hotDataRevision += 1;

    const staleTimestamp = new Date('2026-03-19T00:00:00.000Z');
    app.db.db
      .update(coins)
      .set({ marketCapRank: null })
      .where(eq(coins.id, 'tether'))
      .run();
    app.db.db
      .update(coins)
      .set({ marketCapRank: null })
      .where(eq(coins.id, 'binancecoin'))
      .run();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 1,
        marketCap: 110_000_000_000,
        totalVolume: 25_000_000_000,
        marketCapRank: null,
        sourceProvidersJson: JSON.stringify(['canonical-validation-snapshot']),
        sourceCount: 1,
        updatedAt: staleTimestamp,
        lastUpdated: staleTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'tether'))
      .run();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 612,
        marketCap: null,
        totalVolume: 1_500_000_000,
        marketCapRank: null,
        sourceProvidersJson: JSON.stringify(['canonical-validation-snapshot']),
        sourceCount: 1,
        updatedAt: staleTimestamp,
        lastUpdated: staleTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'binancecoin'))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=market_cap_desc&page=1&per_page=25&sparkline=true&price_change_percentage=1h,24h,7d',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ids = body.map((row: { id: string }) => row.id);

    expect(ids).toEqual(expect.arrayContaining(['bitcoin', 'ethereum', 'tether', 'binancecoin', 'usd-coin']));
    expect(ids.indexOf('bitcoin')).toBeLessThan(ids.indexOf('ethereum'));
    expect(ids.indexOf('ethereum')).toBeLessThan(ids.indexOf('tether'));
    expect(ids.indexOf('tether')).toBeLessThan(ids.indexOf('usd-coin'));

    const tether = body.find((row: { id: string }) => row.id === 'tether');
    const binancecoin = body.find((row: { id: string }) => row.id === 'binancecoin');

    expect(tether).toMatchObject({
      market_cap_rank: 3,
      market_cap: 110_000_000_000,
      total_volume: 25_000_000_000,
      price_change_percentage_1h_in_currency: expect.any(Number),
      price_change_percentage_24h_in_currency: 0,
      price_change_percentage_7d_in_currency: expect.any(Number),
    });
    expect(tether.sparkline_in_7d.price.length).toBeGreaterThan(1);
    expect(binancecoin).toMatchObject({
      market_cap_rank: 4,
      current_price: 612,
      market_cap: null,
      total_volume: 1_500_000_000,
      price_change_percentage_1h_in_currency: null,
    });
    expect(binancecoin.sparkline_in_7d.price).toEqual([]);
  });

  it('publishes stable top-N market quality denominators and replayable evidence in diagnostics', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(response.statusCode).toBe(200);

    const coinsFamily = (response.json().data.families as Array<{
      family: string;
      counts: Record<string, number>;
      evidence: {
        market_quality?: {
          assertions: string[];
          request_path: string;
          top_n: {
            configured_denominator: number;
            measured_denominator: number;
            returned_rows: number;
            price_complete_count: number;
            market_cap_complete_count: number;
            volume_complete_count: number;
            circulating_supply_evidence_count: number;
            total_supply_evidence_count: number;
            persisted_market_cap_evidence_count: number;
            source_backed_market_cap_derivation_count: number;
            price_completeness_ratio: number;
            market_cap_completeness_ratio: number;
            volume_completeness_ratio: number;
            null_quality_row_count: number;
            null_quality_first_page_ids: string[];
            missing_market_cap_ids: string[];
          };
          exceptions?: Array<{
            field: string;
            reason_code: string;
            configured_denominator?: number;
            measured_denominator?: number;
            complete_count?: number;
            unavailable_count?: number;
            affected_ids?: string[];
          }>;
        };
        replayable_evidence?: {
          base_url_env: string;
          request_paths: string[];
          diagnostics_paths: string[];
          generated_at: string;
        };
      };
    }>).find((family) => family.family === 'coins');

    expect(coinsFamily).toBeDefined();
    expect(coinsFamily?.counts.market_top_n_configured_denominator).toBe(100);
    expect(coinsFamily?.evidence.market_quality).toMatchObject({
      assertions: expect.arrayContaining([
        'VAL-MARKET-007',
        'VAL-MARKET-008',
        'VAL-MARKET-009',
        'VAL-MARKET-021',
        'VAL-MARKET-022',
      ]),
      request_path: '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1',
      top_n: {
        configured_denominator: 100,
        measured_denominator: expect.any(Number),
        returned_rows: expect.any(Number),
        price_complete_count: expect.any(Number),
        market_cap_complete_count: expect.any(Number),
        volume_complete_count: expect.any(Number),
        circulating_supply_evidence_count: expect.any(Number),
        total_supply_evidence_count: expect.any(Number),
        persisted_market_cap_evidence_count: expect.any(Number),
        source_backed_market_cap_derivation_count: expect.any(Number),
        price_completeness_ratio: expect.any(Number),
        market_cap_completeness_ratio: expect.any(Number),
        volume_completeness_ratio: expect.any(Number),
        null_quality_row_count: expect.any(Number),
        null_quality_first_page_ids: expect.any(Array),
        missing_market_cap_ids: expect.any(Array),
      },
    });
    const topN = coinsFamily?.evidence.market_quality?.top_n;
    expect(topN).toBeDefined();
    expect(topN?.measured_denominator).toBeLessThanOrEqual(topN?.configured_denominator ?? 0);
    expect(topN?.price_completeness_ratio).toBe((topN?.price_complete_count ?? 0) / 100);
    expect(topN?.market_cap_completeness_ratio).toBe((topN?.market_cap_complete_count ?? 0) / 100);
    expect(topN?.volume_completeness_ratio).toBe((topN?.volume_complete_count ?? 0) / 100);
    expect(topN?.price_completeness_ratio).toBeLessThanOrEqual((topN?.price_complete_count ?? 0) / Math.max(topN?.measured_denominator ?? 1, 1));

    const marketCapException = coinsFamily?.evidence.market_quality?.exceptions?.find(
      (exception) => exception.field === 'market_cap' && exception.reason_code === 'source_unavailable',
    );
    if ((topN?.market_cap_complete_count ?? 0) < 80) {
      expect(marketCapException).toMatchObject({
        configured_denominator: 100,
        measured_denominator: topN?.measured_denominator,
        complete_count: topN?.market_cap_complete_count,
        unavailable_count: 100 - (topN?.market_cap_complete_count ?? 0),
        affected_ids: topN?.missing_market_cap_ids,
      });
    }
    expect(coinsFamily?.evidence.replayable_evidence).toMatchObject({
      base_url_env: 'BASE_URL',
      request_paths: expect.arrayContaining([
        '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1',
      ]),
      diagnostics_paths: expect.arrayContaining(['/diagnostics/data_quality', '/diagnostics/runtime']),
      generated_at: expect.any(String),
    });
  });

  it('counts source-backed market-cap derivations only when backed by field-level supply evidence', async () => {
    await app.ready();

    const freshTimestamp = new Date();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 100,
        marketCap: 1_800_000_000,
        circulatingSupply: 18_000_000,
        totalVolume: 100_000_000,
        marketCapRank: 1,
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    app.db.db
      .update(marketSnapshots)
      .set({
        price: 2_000,
        marketCap: 240_000_000_000,
        circulatingSupply: 120_000_000,
        totalVolume: 10_000_000_000,
        marketCapRank: 2,
        sourceProvidersJson: JSON.stringify(['coinbase']),
        sourceCount: 1,
        updatedAt: freshTimestamp,
        lastUpdated: freshTimestamp,
      })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();
    app.db.db.insert(supplyChartPoints).values({
      coinId: 'ethereum',
      supplyType: 'circulating',
      timestamp: freshTimestamp,
      value: 120_000_000,
      sourceKind: 'live',
      sourceProvider: 'public-supply-provider',
      sourceFetchedAt: freshTimestamp,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/diagnostics/data_quality',
    });

    expect(response.statusCode).toBe(200);

    const coinsFamily = (response.json().data.families as Array<{
      family: string;
      evidence: {
        market_quality?: {
          top_n: {
            persisted_market_cap_evidence_count: number;
            source_backed_market_cap_derivation_count: number;
          };
          field_provenance?: {
            source_backed_market_cap_derivation_ids: string[];
          };
        };
      };
    }>).find((family) => family.family === 'coins');

    expect(coinsFamily?.evidence.market_quality?.field_provenance?.source_backed_market_cap_derivation_ids).toContain('ethereum');
    expect(coinsFamily?.evidence.market_quality?.field_provenance?.source_backed_market_cap_derivation_ids).not.toContain('bitcoin');
    expect(coinsFamily?.evidence.market_quality?.top_n.source_backed_market_cap_derivation_count).toBeLessThan(
      coinsFamily?.evidence.market_quality?.top_n.persisted_market_cap_evidence_count ?? 0,
    );
  });


  it('null-shapes bootstrap-only market completeness fields for seeded bootstrap rows', async () => {
    const validationApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        host: '127.0.0.1',
        port: 3102,
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const response = await validationApp.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h&sparkline=false',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      for (const row of body) {
        expect(row.market_cap_rank).toBeNull();
        expect(row.total_volume).toBeNull();
        expect(row.high_24h).toBeNull();
        expect(row.low_24h).toBeNull();
        expect(row.ath).toBeNull();
        expect(row.atl).toBeNull();
        expect(row.last_updated).toBeNull();
        expect(row.price_change_24h).toBeNull();
        expect(row.price_change_percentage_24h).toBeNull();
        expect(row.price_change_percentage_24h_in_currency).toBeNull();
      }
    } finally {
      await validationApp.close();
    }
  });
  it('keeps seeded bootstrap market rows limited to bootstrap-safe identity and price fields', async () => {
    const validationApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        host: '127.0.0.1',
        port: 3102,
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    const response = await validationApp.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
    });

    try {
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body[0]).toMatchObject({
        id: 'bitcoin',
        name: 'Bitcoin',
        image: expect.stringContaining('bitcoin'),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        high_24h: null,
        low_24h: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[0].price_change_percentage_24h_in_currency).toBeNull();
      expect(body[0].price_change_percentage_7d_in_currency).toBeNull();
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        name: 'Ethereum',
        image: expect.stringContaining('ethereum'),
        roi: expect.objectContaining({
          currency: 'btc',
        }),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        high_24h: null,
        low_24h: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[1].price_change_percentage_24h_in_currency).toBeNull();
      expect(body[1].price_change_percentage_7d_in_currency).toBeNull();
      expect(body[2]).toMatchObject({
        id: 'solana',
        name: 'Solana',
        image: expect.stringContaining('solana'),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        high_24h: null,
        low_24h: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[2].price_change_percentage_24h_in_currency).toBeNull();
      expect(body[2].price_change_percentage_7d_in_currency).toBeNull();
    } finally {
      await validationApp.close();
    }
  });

  it('preserves imported live snapshot ownership while null-shaping seeded bootstrap completeness fields', async () => {
    const validationApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        host: '127.0.0.1',
        port: 3102,
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const [marketsResponse, diagnosticsResponse] = await Promise.all([
        validationApp.inject({
          method: 'GET',
          url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
        }),
        validationApp.inject({
          method: 'GET',
          url: '/diagnostics/runtime',
        }),
      ]);

      expect(marketsResponse.statusCode).toBe(200);
      const body = marketsResponse.json();

      expect(body[0]).toMatchObject({
        id: 'bitcoin',
        name: 'Bitcoin',
        image: expect.stringContaining('bitcoin'),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        name: 'Ethereum',
        image: expect.stringContaining('ethereum'),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        price_change_24h: null,
        price_change_percentage_24h: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });
      expect(body[2]).toMatchObject({
        id: 'solana',
        name: 'Solana',
        image: expect.stringContaining('solana'),
        current_price: expect.any(Number),
        market_cap: null,
        market_cap_rank: null,
        total_volume: null,
        market_cap_change_24h: null,
        market_cap_change_percentage_24h: null,
        ath: null,
        atl: null,
        last_updated: null,
      });

      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json().data).toMatchObject({
        readiness: {
          state: 'starting',
          initial_sync_completed: false,
        },
        degraded: {
          active: false,
          validation_override: {
            active: true,
            mode: 'seeded_bootstrap',
            reason: 'validation runtime seeded from persistent live snapshots',
          },
        },
        hot_paths: {
          shared_market_snapshot: {
            source_class: 'seeded_bootstrap',
            provider_count: expect.any(Number),
          },
        },
      });
      expect(diagnosticsResponse.json().data.hot_paths.shared_market_snapshot.provider_count).toBeGreaterThan(0);
    } finally {
      await validationApp.close();
    }
  });

  it('exposes canonical market rows from the default/local seeded bootstrap runtime', async () => {
    const localApp = buildApp({
      config: {
        databaseUrl: ':memory:',
        host: '0.0.0.0',
        port: 3000,
        ccxtExchanges: [],
        logLevel: 'silent',
      },
      startBackgroundJobs: false,
    });

    try {
      const response = await localApp.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&page=1&per_page=3&price_change_percentage=24h,7d&sparkline=false',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.map((row: { id: string }) => row.id)).toEqual(['bitcoin', 'ethereum', 'solana']);
      expect(body[0]).toMatchObject({
        id: 'bitcoin',
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[1]).toMatchObject({
        id: 'ethereum',
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        last_updated: expect.any(String),
      });
      expect(body[2]).toMatchObject({
        id: 'solana',
        current_price: expect.any(Number),
        market_cap: expect.any(Number),
        total_volume: expect.any(Number),
        last_updated: expect.any(String),
      });
    } finally {
      await localApp.close();
    }
  });

  it('preserves explicit ids ordering, drops unknown ids, bypasses page slicing, and gates optional market fields', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=solana,unknown-coin,bitcoin&order=id_desc&page=9&per_page=1&price_change_percentage=24h,7d&sparkline=true&precision=2',
    });

    expect(response.statusCode).toBe(200);

    expect(response.json()).toEqual([
      expect.objectContaining({
        id: 'solana',
        sparkline_in_7d: {
          price: expect.any(Array),
        },
        price_change_percentage_24h_in_currency: expect.any(Number),
        price_change_percentage_7d_in_currency: expect.any(Number),
      }),
      expect.objectContaining({
        id: 'bitcoin',
        sparkline_in_7d: {
          price: expect.any(Array),
        },
        price_change_percentage_24h_in_currency: expect.any(Number),
        price_change_percentage_7d_in_currency: expect.any(Number),
      }),
    ]);

    expect(response.json()).toHaveLength(2);
    expect(response.json().every((row: { sparkline_in_7d: { price: number[] } }) =>
      row.sparkline_in_7d.price.length > 0
      && row.sparkline_in_7d.price.every((value) => Number.isFinite(value)),
    )).toBe(true);
    expect(response.json().map((row: { id: string }) => row.id)).toEqual(['solana', 'bitcoin']);
    expect(response.json()[0].current_price).toBeTypeOf('number');
  });

  it('treats explicit names and symbols selectors like explicit ids for ordering, unknown omission, and page-slice bypass', async () => {
    const [namesResponse, symbolsResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&names=solana,unknown-coin,bitcoin&page=9&per_page=1',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&symbols=sol,unknown-symbol,btc&page=7&per_page=1',
      }),
    ]);

    expect(namesResponse.statusCode).toBe(200);
    expect(symbolsResponse.statusCode).toBe(200);

    const namesBody = namesResponse.json();
    const symbolsBody = symbolsResponse.json();

    expect(namesBody).toHaveLength(2);
    expect(namesBody.map((row: { id: string }) => row.id)).toEqual(['solana', 'bitcoin']);

    expect(symbolsBody).toHaveLength(2);
    expect(symbolsBody.map((row: { id: string }) => row.id)).toEqual(['solana', 'bitcoin']);
  });

  it('rejects unsupported order values and invalid precision values with the standard invalid-parameter envelope', async () => {
    const [invalidOrderResponse, invalidPrecisionResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&order=unsupported',
      }),
      app.inject({
        method: 'GET',
        url: '/coins/markets?vs_currency=usd&precision=not-a-number',
      }),
    ]);

    expect(invalidOrderResponse.statusCode).toBe(400);
    expect(invalidOrderResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'Unsupported order value: unsupported',
    });

    expect(invalidPrecisionResponse.statusCode).toBe(400);
    expect(invalidPrecisionResponse.json()).toEqual({
      error: 'invalid_parameter',
      message: 'Invalid precision value: not-a-number',
    });
  });

  it('pins market row null shape for every validation override mode', async () => {
    await app.ready();

    const modes = [
      'undefined',
      'off',
      'stale_disallowed',
      'degraded_seeded_bootstrap',
      'seeded_bootstrap',
    ];

    for (const mode of modes) {
      const fixture = readMarketRowNullShapeFixture(mode);

      if (mode === 'undefined') {
        delete (app.marketDataRuntimeState as Partial<typeof app.marketDataRuntimeState>).validationOverride;
      } else {
        app.marketDataRuntimeState.validationOverride = {
          mode: mode as typeof app.marketDataRuntimeState.validationOverride.mode,
          reason: `${mode} fixture`,
          snapshotTimestampOverride: null,
          snapshotSourceCountOverride: null,
        };
      }

      app.marketDataRuntimeState.hotDataRevision += 1;

      const response = await app.inject({
        method: 'GET',
        url: fixture.request,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().map((row: Record<string, unknown>) => summarizeMarketRowNullShape(row))).toEqual(fixture.rows);
    }
  });

  it('keeps fresh live rows ahead of stale disallowed rows for market metric sorting', async () => {
    await app.ready();
    app.marketDataRuntimeState.initialSyncCompleted = true;
    app.marketDataRuntimeState.allowStaleLiveService = false;
    app.marketDataRuntimeState.hotDataRevision += 1;

    app.db.db
      .update(marketSnapshots)
      .set({
        totalVolume: 999_000_000_000,
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    app.db.db
      .update(marketSnapshots)
      .set({
        totalVolume: 1_000,
        sourceProvidersJson: JSON.stringify(['coinbase']),
        sourceCount: 1,
        lastUpdated: new Date(),
      })
      .where(eq(marketSnapshots.coinId, 'ethereum'))
      .run();

    const response = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&order=volume_desc&per_page=20&page=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({
      id: 'ethereum',
      total_volume: 1000,
    });
    expect(response.json().some((row: { id: string; total_volume: number | null }) =>
      row.id === 'bitcoin' && row.total_volume === null,
    )).toBe(true);
  });

  it('invalidates the coins markets cache when stale-live access policy flips without a revision bump', async () => {
    await app.ready();
    app.db.db
      .update(marketSnapshots)
      .set({
        sourceProvidersJson: JSON.stringify(['binance']),
        sourceCount: 1,
        lastUpdated: new Date('2026-03-19T00:00:00.000Z'),
      })
      .where(eq(marketSnapshots.coinId, 'bitcoin'))
      .run();
    app.marketDataRuntimeState.initialSyncCompleted = true;
    app.marketDataRuntimeState.allowStaleLiveService = true;
    app.marketDataRuntimeState.hotDataRevision += 1;

    const staleAllowed = await app.inject({
      method: 'GET',
      url: '/coins/markets?vs_currency=usd&ids=bitcoin',
    });
    const revisionAfterWarm = app.marketDataRuntimeState.hotDataRevision;

    app.marketDataRuntimeState.allowStaleLiveService = false;

    const staleDisallowed = await app.inject({
      method: 'GET',
      url: '/coins/markets?ids=bitcoin&vs_currency=usd',
    });

    expect(app.marketDataRuntimeState.hotDataRevision).toBe(revisionAfterWarm);
    expect(staleAllowed.statusCode).toBe(200);
    expect(staleAllowed.json()[0]).toMatchObject({
      id: 'bitcoin',
      current_price: expect.any(Number),
      last_updated: expect.any(String),
    });
    expect(staleDisallowed.statusCode).toBe(200);
    expect(staleDisallowed.json()).toEqual([
      expect.objectContaining({
        id: 'bitcoin',
        current_price: null,
        market_cap: null,
        total_volume: null,
        last_updated: null,
      }),
    ]);
  });
});
