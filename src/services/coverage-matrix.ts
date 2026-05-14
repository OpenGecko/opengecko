import type { AppDatabase } from '../db/client';
import {
  coinTickers,
  coinHistorySnapshots,
  coins,
  derivativeTickers,
  exchangeVolumePoints,
  exchangeVolumeSourcePoints,
  exchanges,
  marketChartSourcePoints,
  marketSnapshots,
  ohlcvCandles,
  onchainPoolOhlcv,
  onchainPoolTrades,
  onchainPools,
  onchainTokenHolderCounts,
  onchainTokenHolders,
  onchainTokenTraders,
  supplyChartPoints,
  treasuryHoldings,
  treasurySourceDocuments,
} from '../db/schema';
import { getEndpointFreshnessBudget } from './freshness-budgets';
import { loadDefaultCoverageTargets } from './coverage-targets';

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

function hasSourceBackedMarketSnapshot(row: { sourceCount: number; sourceProvidersJson: string }) {
  if (row.sourceCount <= 0) {
    return false;
  }

  try {
    const providers = JSON.parse(row.sourceProvidersJson) as unknown;

    return Array.isArray(providers) && providers.some((provider) => (
      typeof provider === 'string'
      && provider.trim().length > 0
      && provider !== 'canonical-validation-snapshot'
    ));
  } catch {
    return false;
  }
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
  const marketSnapshotRows = database.db.select().from(marketSnapshots).all();
  const sourceBackedMarketSnapshotRows = marketSnapshotRows.filter(hasSourceBackedMarketSnapshot);
  const enabledDefaultCoverageTargets = loadDefaultCoverageTargets().filter((target) => target.enabled);
  const enabledHistoricalCoverageTargets = enabledDefaultCoverageTargets.filter(
    (target) => target.family === 'market_charts' || target.family === 'ohlcv',
  );
  const enabledHistoricalCoverageKeyCount = new Set(
    enabledHistoricalCoverageTargets.map((target) => [target.family, target.provider, target.entityId, target.interval, target.vsCurrency].join(':')),
  ).size;
  const latestMarketSnapshotAt = latestDate(
    sourceBackedMarketSnapshotRows,
    (row) => row.lastUpdated,
  );
  const latestExchangeTickerAt = latestDate(
    database.db.select().from(coinTickers).all(),
    (row) => row.lastFetchAt,
  );
  const latestCoinHistorySnapshotAt = latestDate(
    database.db.select().from(coinHistorySnapshots).all(),
    (row) => row.sourceFetchedAt,
  );
  const latestCoinDetailDataAt = latestDate(
    [
      { timestamp: latestMarketSnapshotAt },
      { timestamp: latestExchangeTickerAt },
      { timestamp: latestCoinHistorySnapshotAt },
    ],
    (row) => row.timestamp,
  );
  const latestExchangeVolumeAt = latestDate(
    database.db.select().from(exchangeVolumePoints).all(),
    (row) => row.timestamp,
  );
  const latestExchangeVolumeSourceAt = latestDate(
    database.db.select().from(exchangeVolumeSourcePoints).all(),
    (row) => row.sourceFetchedAt,
  );
  const latestExchangeDataAt = latestDate(
    [
      { timestamp: latestExchangeTickerAt },
      { timestamp: latestExchangeVolumeSourceAt },
      { timestamp: latestExchangeVolumeAt },
    ],
    (row) => row.timestamp,
  );
  const latestHistoricalCandleAt = latestDate(
    database.db.select().from(ohlcvCandles).all(),
    (row) => row.timestamp,
  );
  const latestMarketChartSourceAt = latestDate(
    database.db.select().from(marketChartSourcePoints).all(),
    (row) => row.sourceFetchedAt,
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
  const latestOnchainTradeAt = latestDate(
    database.db.select().from(onchainPoolTrades).all(),
    (row) => row.sourceFetchedAt,
  );
  const latestSupplyChartAt = latestDate(
    database.db.select().from(supplyChartPoints).all(),
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
      notes: latestMarketSnapshotAt
        ? 'Hot price routes are promoted only from source-attributed market snapshots; seeded snapshots remain fallback data.'
        : 'Hot price routes are seeded until source-attributed market snapshots with providers are written.',
    }, observedAt),
    buildEntry({
      family: 'coins_markets',
      representativeRoutes: ['/coins/markets'],
      ownershipClass: latestMarketSnapshotAt ? 'live' : 'seeded',
      providers: ['CCXT', 'DeFiLlama'],
      lastSuccessfulRefreshAt: latestMarketSnapshotAt,
      evidence: ['tests/coins-markets-parity.test.ts', 'tests/http-cache.test.ts'],
      notes: latestMarketSnapshotAt
        ? 'Market lists use source-attributed snapshot freshness with route-local response caching.'
        : 'Market lists remain seeded until source-attributed market snapshots with providers are written.',
    }, observedAt),
    buildEntry({
      family: 'coin_detail',
      representativeRoutes: ['/coins/:id', '/coins/:id/history', '/coins/:id/tickers'],
      ownershipClass: latestMarketSnapshotAt || latestExchangeTickerAt || latestCoinHistorySnapshotAt ? 'hybrid' : 'seeded',
      providers: ['CCXT', 'seed catalog', 'coin history replay'],
      lastSuccessfulRefreshAt: latestCoinDetailDataAt,
      evidence: ['tests/coin-detail-parity.test.ts', 'tests/app.test.ts', 'tests/provider-replay-coin-history.test.ts'],
      notes: latestCoinHistorySnapshotAt
        ? 'Metadata is seeded/catalog-backed while market fields, tickers, and dated history snapshots can read source-attributed replay/live rows; replay history must not be advertised as live.'
        : 'Metadata is seeded/catalog-backed while market fields and tickers can be live-backed; dated history still falls back to seeded chart/current snapshot blending until source-attributed history rows are ingested.',
    }, observedAt),
    buildEntry({
      family: 'exchanges',
      representativeRoutes: ['/exchanges', '/exchanges/:id', '/exchanges/:id/tickers', '/exchanges/:id/volume_chart'],
      ownershipClass: latestExchangeTickerAt || latestExchangeVolumeSourceAt || latestExchangeVolumeAt ? 'hybrid' : 'seeded',
      providers: ['CCXT', 'seed exchange catalog', 'exchange volume replay'],
      lastSuccessfulRefreshAt: latestExchangeDataAt,
      evidence: ['tests/exchange-fidelity.test.ts', 'tests/provider-replay-exchange-volumes.test.ts', 'tests/http-cache.test.ts'],
      notes: latestExchangeVolumeSourceAt
        ? 'Exchange metadata is seeded/catalog-backed; ticker routes are live-capable and volume charts can read source-attributed exchange volume replay/live rows before canonical fallback.'
        : 'Exchange metadata is seeded/catalog-backed; ticker and volume surfaces are live-capable when provider rows exist.',
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
      lastSuccessfulRefreshAt: latestOnchainTradeAt ?? latestOnchainAnalyticsAt ?? latestOnchainPoolOhlcvAt ?? latestOnchainPoolAt,
      evidence: ['tests/modules/onchain.test.ts', 'tests/http-cache.test.ts', 'tests/provider-replay-defillama.test.ts', 'tests/provider-replay-onchain-analytics.test.ts', 'tests/provider-replay-onchain-trades.test.ts'],
      notes: latestOnchainTradeAt
        ? 'Pool discovery/detail routes are hybrid; trade, OHLCV, and token analytics routes can read source-attributed replay/live rows before fixture or synthetic fallbacks.'
        : latestOnchainAnalyticsAt
          ? 'Pool discovery/detail routes are hybrid; pool OHLCV and token analytics can read source-attributed replay/live rows before fixture fallbacks, but analytics replay must not be advertised as live.'
          : latestOnchainPoolOhlcvAt
            ? 'Pool discovery/detail routes are hybrid; pool OHLCV can read source-attributed replay/live rows before synthetic fallback; holders, traders, and trades still use fixture fallbacks.'
            : 'Pool discovery/detail routes are hybrid; holders, traders, trades, and some OHLCV analytics still use fixture or synthetic fallbacks.',
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
      ownershipClass: latestHistoricalCandleAt || latestMarketChartSourceAt ? 'hybrid' : 'seeded',
      providers: ['CCXT OHLCV', 'market chart replay', 'seed chart corpus'],
      lastSuccessfulRefreshAt: latestMarketChartSourceAt ?? latestHistoricalCandleAt,
      evidence: ['tests/ohlcv-sync.test.ts', 'tests/provider-replay-market-charts.test.ts', 'tests/http-cache.test.ts'],
      notes: latestMarketChartSourceAt || latestHistoricalCandleAt
        ? `Historical chart and OHLC routes can read source-attributed replay/live rows before seeded chart or canonical candle fallback; ${enabledHistoricalCoverageKeyCount} enabled coverage targets define breadth/depth expectations. Future live classification requires documented breadth/depth thresholds.`
        : `Historical quality is judged by continuity and retention, not latest tick age; ${enabledHistoricalCoverageKeyCount} enabled coverage targets are configured but not yet source-backed.` ,
    }, observedAt),
    buildEntry({
      family: 'supply_charts',
      representativeRoutes: ['/coins/:id/circulating_supply_chart', '/coins/:id/total_supply_chart'],
      ownershipClass: latestSupplyChartAt ? 'hybrid' : 'fixture',
      providers: ['supply replay fixtures'],
      lastSuccessfulRefreshAt: latestSupplyChartAt,
      evidence: ['tests/provider-replay-supply-charts.test.ts', 'tests/http-cache.test.ts'],
      notes: latestSupplyChartAt
        ? 'Circulating and total supply chart routes can read source-attributed replay/live supply rows before fixture fallback; replay rows must not be advertised as live.'
        : 'Circulating and total supply chart routes remain fixture fallbacks until source-attributed replay/live supply rows are ingested.',
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
