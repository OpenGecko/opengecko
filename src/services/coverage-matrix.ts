import type { AppDatabase } from '../db/client';
import {
  coinTickers,
  coins,
  derivativeTickers,
  exchangeVolumePoints,
  exchanges,
  marketSnapshots,
  ohlcvCandles,
  onchainPoolOhlcv,
  onchainPools,
  onchainTokenHolderCounts,
  onchainTokenHolders,
  onchainTokenTraders,
  treasuryHoldings,
  treasurySourceDocuments,
} from '../db/schema';
import { getEndpointFreshnessBudget } from './freshness-budgets';

export type DataOwnershipClass = 'live' | 'hybrid' | 'seeded' | 'synthetic' | 'fixture' | 'unavailable';

export type CoverageFreshnessState = 'fresh' | 'degraded' | 'stale' | 'unbudgeted' | 'unknown';

type CoverageMatrixEntryConfig = {
  family: string;
  representativeRoutes: string[];
  ownershipClass: DataOwnershipClass;
  providers: string[];
  lastSuccessfulRefreshAt: Date | null;
  evidence: string[];
  notes: string;
};

function latestDate<T>(rows: T[], selector: (row: T) => Date | null | undefined) {
  return rows.reduce<Date | null>((latest, row) => {
    const value = selector(row);
    if (!value) {
      return latest;
    }

    return latest === null || value.getTime() > latest.getTime() ? value : latest;
  }, null);
}

function ageSeconds(now: Date, timestamp: Date | null) {
  if (!timestamp) {
    return null;
  }

  return Math.max(Math.floor((now.getTime() - timestamp.getTime()) / 1_000), 0);
}

function classifyFreshness(
  currentAgeSeconds: number | null,
  targetFreshnessSeconds: number | null,
  degradedAfterSeconds: number | null,
): CoverageFreshnessState {
  if (targetFreshnessSeconds === null || degradedAfterSeconds === null) {
    return 'unbudgeted';
  }

  if (currentAgeSeconds === null) {
    return 'unknown';
  }

  if (currentAgeSeconds <= targetFreshnessSeconds) {
    return 'fresh';
  }

  if (currentAgeSeconds <= degradedAfterSeconds) {
    return 'degraded';
  }

  return 'stale';
}

function buildEntry(config: CoverageMatrixEntryConfig, now: Date) {
  const budget = getEndpointFreshnessBudget(config.family);
  const currentAgeSeconds = ageSeconds(now, config.lastSuccessfulRefreshAt);
  const targetFreshnessSeconds = budget?.target_freshness_seconds ?? null;
  const degradedAfterSeconds = budget?.degraded_after_seconds ?? null;

  return {
    family: config.family,
    representative_routes: [...config.representativeRoutes],
    ownership_class: config.ownershipClass,
    providers: [...config.providers],
    last_successful_refresh_at: config.lastSuccessfulRefreshAt?.toISOString() ?? null,
    freshness: {
      target_freshness_seconds: targetFreshnessSeconds,
      degraded_after_seconds: degradedAfterSeconds,
      current_age_seconds: currentAgeSeconds,
      state: classifyFreshness(currentAgeSeconds, targetFreshnessSeconds, degradedAfterSeconds),
    },
    evidence: {
      tests: [...config.evidence],
      notes: config.notes,
    },
  };
}

export function buildCoverageMatrix(database: AppDatabase, now = new Date()) {
  const observedAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const latestMarketSnapshotAt = latestDate(
    database.db.select().from(marketSnapshots).all(),
    (row) => row.lastUpdated,
  );
  const latestExchangeTickerAt = latestDate(
    database.db.select().from(coinTickers).all(),
    (row) => row.lastFetchAt,
  );
  const latestExchangeVolumeAt = latestDate(
    database.db.select().from(exchangeVolumePoints).all(),
    (row) => row.timestamp,
  );
  const latestHistoricalCandleAt = latestDate(
    database.db.select().from(ohlcvCandles).all(),
    (row) => row.timestamp,
  );
  const latestCatalogAt = latestDate(
    [
      ...database.db.select().from(coins).all(),
      ...database.db.select().from(exchanges).all(),
    ],
    (row) => row.updatedAt,
  );
  const latestOnchainPoolAt = latestDate(
    database.db.select().from(onchainPools).all(),
    (row) => row.updatedAt,
  );
  const latestOnchainPoolOhlcvAt = latestDate(
    database.db.select().from(onchainPoolOhlcv).all(),
    (row) => row.sourceFetchedAt,
  );
  const latestOnchainAnalyticsAt = latestDate(
    [
      ...database.db.select().from(onchainTokenHolders).all(),
      ...database.db.select().from(onchainTokenTraders).all(),
      ...database.db.select().from(onchainTokenHolderCounts).all(),
    ],
    (row) => row.sourceFetchedAt,
  );
  const derivativeRows = database.db.select().from(derivativeTickers).all();
  const sourceBackedDerivativeRows = derivativeRows.filter((row) => row.sourceKind !== 'seed');
  const latestDerivativeAt = latestDate(
    sourceBackedDerivativeRows,
    (row) => row.sourceFetchedAt ?? row.lastTradedAt,
  );
  const latestFixtureDerivativeAt = latestDate(
    derivativeRows,
    (row) => row.lastTradedAt,
  );
  const latestTreasuryAt = latestDate(
    database.db.select().from(treasuryHoldings).all(),
    (row) => row.reportedAt,
  );
  const latestTreasurySourceDocumentAt = latestDate(
    database.db.select().from(treasurySourceDocuments).all(),
    (row) => row.acceptedAt,
  );

  const entries = [
    buildEntry({
      family: 'simple',
      representativeRoutes: ['/simple/price', '/simple/token_price/:id'],
      ownershipClass: latestMarketSnapshotAt ? 'live' : 'seeded',
      providers: ['CCXT', 'DeFiLlama', 'currency-api'],
      lastSuccessfulRefreshAt: latestMarketSnapshotAt,
      evidence: ['tests/simple-price-parity.test.ts', 'tests/http-cache.test.ts'],
      notes: 'Hot price routes are owned by the market snapshot runtime and quote conversion layer.',
    }, observedAt),
    buildEntry({
      family: 'coins_markets',
      representativeRoutes: ['/coins/markets'],
      ownershipClass: latestMarketSnapshotAt ? 'live' : 'seeded',
      providers: ['CCXT', 'DeFiLlama'],
      lastSuccessfulRefreshAt: latestMarketSnapshotAt,
      evidence: ['tests/coins-markets-parity.test.ts', 'tests/http-cache.test.ts'],
      notes: 'Market lists use the same snapshot freshness as hot price routes with route-local response caching.',
    }, observedAt),
    buildEntry({
      family: 'coin_detail',
      representativeRoutes: ['/coins/:id', '/coins/:id/tickers'],
      ownershipClass: latestMarketSnapshotAt || latestExchangeTickerAt ? 'hybrid' : 'seeded',
      providers: ['CCXT', 'seed catalog'],
      lastSuccessfulRefreshAt: latestMarketSnapshotAt ?? latestExchangeTickerAt,
      evidence: ['tests/coin-detail-parity.test.ts', 'tests/app.test.ts'],
      notes: 'Metadata is seeded/catalog-backed while market fields and tickers can be live-backed.',
    }, observedAt),
    buildEntry({
      family: 'exchanges',
      representativeRoutes: ['/exchanges', '/exchanges/:id', '/exchanges/:id/tickers', '/exchanges/:id/volume_chart'],
      ownershipClass: latestExchangeTickerAt || latestExchangeVolumeAt ? 'hybrid' : 'seeded',
      providers: ['CCXT', 'seed exchange catalog'],
      lastSuccessfulRefreshAt: latestExchangeTickerAt ?? latestExchangeVolumeAt,
      evidence: ['tests/exchange-fidelity.test.ts', 'tests/http-cache.test.ts'],
      notes: 'Exchange metadata is seeded/catalog-backed; ticker and volume surfaces are live-capable when provider rows exist.',
    }, observedAt),
    buildEntry({
      family: 'onchain',
      representativeRoutes: [
        '/onchain/networks/:network/pools',
        '/onchain/networks/:network/pools/:address',
        '/onchain/networks/:network/pools/:address/ohlcv/:timeframe',
        '/onchain/networks/:network/tokens/:address/ohlcv/:timeframe',
      ],
      ownershipClass: latestOnchainPoolAt ? 'hybrid' : 'fixture',
      providers: ['DeFiLlama', 'Subsquid', 'seed onchain catalog'],
      lastSuccessfulRefreshAt: latestOnchainAnalyticsAt ?? latestOnchainPoolOhlcvAt ?? latestOnchainPoolAt,
      evidence: ['tests/modules/onchain.test.ts', 'tests/http-cache.test.ts', 'tests/provider-replay-defillama.test.ts', 'tests/provider-replay-onchain-analytics.test.ts'],
      notes: latestOnchainAnalyticsAt
        ? 'Pool discovery/detail routes are hybrid; pool OHLCV and token analytics can read source-attributed replay/live rows before fixture fallbacks, but analytics replay must not be advertised as live.'
        : latestOnchainPoolOhlcvAt
          ? 'Pool discovery/detail routes are hybrid; pool OHLCV can read source-attributed replay/live rows before synthetic fallback; holders and traders still use fixture fallbacks.'
        : 'Pool discovery/detail routes are hybrid; holders, traders, and some OHLCV analytics still use fixture or synthetic fallbacks.',
    }, observedAt),
    buildEntry({
      family: 'derivatives',
      representativeRoutes: ['/derivatives', '/derivatives/exchanges', '/derivatives/exchanges/:id'],
      ownershipClass: sourceBackedDerivativeRows.length > 0 ? 'hybrid' : 'fixture',
      providers: ['seed derivatives fixtures', 'CCXT derivatives replay'],
      lastSuccessfulRefreshAt: latestDerivativeAt ?? latestFixtureDerivativeAt,
      evidence: ['tests/compare-coingecko.test.ts', 'tests/provider-replay-derivatives.test.ts'],
      notes: sourceBackedDerivativeRows.length > 0
        ? 'Derivative rows include source-attributed replay/live-ingested rows; seeded fixture rows may still be present until full live futures/swap ingestion lands.'
        : 'Derivative rows are seeded fixtures until live futures/swap ingestion lands; CCXT-style replay now proves raw ticker normalization and idempotent writes into public response shape.',
    }, observedAt),
    buildEntry({
      family: 'historical_charts',
      representativeRoutes: ['/coins/:id/market_chart', '/coins/:id/ohlc', '/exchanges/:id/volume_chart'],
      ownershipClass: latestHistoricalCandleAt ? 'hybrid' : 'seeded',
      providers: ['CCXT OHLCV', 'seed chart corpus'],
      lastSuccessfulRefreshAt: latestHistoricalCandleAt,
      evidence: ['tests/ohlcv-sync.test.ts', 'tests/http-cache.test.ts'],
      notes: 'Historical quality is judged by continuity and retention, not latest tick age.',
    }, observedAt),
    buildEntry({
      family: 'treasury',
      representativeRoutes: ['/companies/public_treasury/:coin_id', '/public_treasury/:entity_id', '/public_treasury/:entity_id/transaction_history'],
      ownershipClass: 'fixture',
      providers: ['seed treasury fixtures', 'SEC disclosure replay'],
      lastSuccessfulRefreshAt: latestTreasurySourceDocumentAt ?? latestTreasuryAt,
      evidence: ['tests/modules/treasury-ext-contract.test.ts', 'tests/provider-replay-treasury.test.ts'],
      notes: latestTreasurySourceDocumentAt
        ? 'Treasury rows remain seeded by default; disclosure replay stores source documents separately and proves idempotent correction traces into holdings, transactions, and public response shape.'
        : 'Treasury rows remain seeded by default; disclosure replay proves idempotent source document ingestion into holdings, transactions, and public response shape.',
    }, observedAt),
    buildEntry({
      family: 'stable_catalog',
      representativeRoutes: ['/coins/list', '/asset_platforms', '/exchanges/list'],
      ownershipClass: 'seeded',
      providers: ['seed catalog'],
      lastSuccessfulRefreshAt: latestCatalogAt,
      evidence: ['tests/docs-drift.test.ts', 'tests/http-cache.test.ts'],
      notes: 'Stable catalog routes are seeded and cacheable; docs must not imply live catalog parity.',
    }, observedAt),
  ];

  return {
    generated_at: observedAt.toISOString(),
    entries,
  };
}
