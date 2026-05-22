import type { AppDatabase } from '../db/client';
import {
  coinTickers,
  coinHistorySnapshots,
  coins,
  derivativeTickers,
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
import {
  ageSeconds,
  classifyCoverageFreshness,
  hasSourceBackedProviders,
  isCanonicalValidationSnapshotProvider,
  isLiveSourceKind,
  isReplaySourceKind,
} from './diagnostics-policy';
import {
  COVERAGE_FRESHNESS_STATE_VALUES,
  COVERAGE_OWNERSHIP_CLASS_VALUES,
  DATA_SOURCE_STATE_VALUES,
  NON_LIVE_DATA_SOURCE_STATES,
} from './data-quality-contract';
import { getEndpointFreshnessBudget } from './freshness-budgets';
import { loadDefaultCoverageTargets } from './coverage-targets';

export type DataOwnershipClass = typeof COVERAGE_OWNERSHIP_CLASS_VALUES[number];

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

type HistoricalChartSourceCoverage = {
  ownershipClass: Extract<DataOwnershipClass, 'live' | 'hybrid' | 'seeded'>;
  latestSourceFetchedAt: Date | null;
  liveTargetKeyCount: number;
  replayTargetKeyCount: number;
  enabledTargetKeyCount: number;
  minPointsPerEnabledTarget: number;
};

const HISTORICAL_CHART_LIVE_MIN_TARGET_COVERAGE_RATIO = 0.25;
const HISTORICAL_CHART_LIVE_MIN_POINTS_PER_TARGET = 30;

function classifyHistoricalChartSourceCoverage(database: AppDatabase): HistoricalChartSourceCoverage {
  const enabledTargets = loadDefaultCoverageTargets().filter(
    (target) => target.enabled && target.family === 'market_charts',
  );
  const enabledTargetKeys = new Set(
    enabledTargets.map((target) => [target.provider, target.entityId, target.vsCurrency, target.interval].join(':')),
  );
  const rows = database.db.select().from(marketChartSourcePoints).all();
  const targetRows = new Map<string, typeof rows>();
  let latestReplaySourceFetchedAt: Date | null = null;
  let latestLiveSourceFetchedAt: Date | null = null;

  for (const row of rows) {
    if (row.sourceProvider === 'seed' || isCanonicalValidationSnapshotProvider(row.sourceProvider)) {
      continue;
    }

    const key = [row.sourceProvider, row.coinId, row.vsCurrency, row.interval].join(':');
    if (!enabledTargetKeys.has(key)) {
      continue;
    }

    targetRows.set(key, [...(targetRows.get(key) ?? []), row]);

    if (isLiveSourceKind(row.sourceKind)) {
      latestLiveSourceFetchedAt = latestDate([{ timestamp: latestLiveSourceFetchedAt }, { timestamp: row.sourceFetchedAt }], (item) => item.timestamp);
    } else if (isReplaySourceKind(row.sourceKind)) {
      latestReplaySourceFetchedAt = latestDate([{ timestamp: latestReplaySourceFetchedAt }, { timestamp: row.sourceFetchedAt }], (item) => item.timestamp);
    }
  }

  let liveTargetKeyCount = 0;
  let replayTargetKeyCount = 0;
  let minPointsPerEnabledTarget = Number.POSITIVE_INFINITY;

  for (const key of Array.from(enabledTargetKeys)) {
    const rowsForTarget = targetRows.get(key) ?? [];
    const liveRowsForTarget = rowsForTarget.filter((row) => isLiveSourceKind(row.sourceKind));
    const replayRowsForTarget = rowsForTarget.filter((row) => isReplaySourceKind(row.sourceKind));
    if (liveRowsForTarget.length > 0) {
      liveTargetKeyCount += 1;
      minPointsPerEnabledTarget = Math.min(minPointsPerEnabledTarget, liveRowsForTarget.length);
    }
    if (replayRowsForTarget.length > 0) {
      replayTargetKeyCount += 1;
    }
  }

  const requiredLiveTargetKeyCount = Math.max(
    1,
    Math.ceil(enabledTargetKeys.size * HISTORICAL_CHART_LIVE_MIN_TARGET_COVERAGE_RATIO),
  );
  const hasLiveBreadthAndDepth = liveTargetKeyCount >= requiredLiveTargetKeyCount
    && minPointsPerEnabledTarget >= HISTORICAL_CHART_LIVE_MIN_POINTS_PER_TARGET;

  return {
    ownershipClass: hasLiveBreadthAndDepth ? 'live' : liveTargetKeyCount > 0 ? 'hybrid' : 'seeded',
    latestSourceFetchedAt: latestLiveSourceFetchedAt ?? (liveTargetKeyCount > 0 ? latestReplaySourceFetchedAt : null),
    liveTargetKeyCount,
    replayTargetKeyCount,
    enabledTargetKeyCount: enabledTargetKeys.size,
    minPointsPerEnabledTarget: Number.isFinite(minPointsPerEnabledTarget) ? minPointsPerEnabledTarget : 0,
  };
}

function buildEntry(config: CoverageMatrixEntryConfig, now: Date) {
  const budget = getEndpointFreshnessBudget(config.family);
  const currentAgeSeconds = ageSeconds(now, config.lastSuccessfulRefreshAt);
  const targetFreshnessSeconds = budget?.target_freshness_seconds ?? null;
  const degradedAfterSeconds = budget?.degraded_after_seconds ?? null;
  const freshnessState = classifyCoverageFreshness({ currentAgeSeconds, targetFreshnessSeconds, degradedAfterSeconds });
  const reasonCodes = config.ownershipClass === 'live'
    ? []
    : [config.ownershipClass === 'unavailable' ? 'source_unavailable' : `${config.ownershipClass}_only`];

  return {
    family: config.family,
    representative_routes: [...config.representativeRoutes],
    ownership_class: config.ownershipClass,
    contract_support: {
      status: 'supported',
      supported: true,
      representative_route_count: config.representativeRoutes.length,
      representative_routes: [...config.representativeRoutes],
      evidence_tests: [...config.evidence],
    },
    data_fidelity: {
      classification: config.ownershipClass,
      source_state: config.ownershipClass,
      counts_as_live: config.ownershipClass === 'live',
      non_live: config.ownershipClass !== 'live',
      reason_codes: reasonCodes,
      latest_source_at: config.lastSuccessfulRefreshAt?.toISOString() ?? null,
      freshness_state: freshnessState,
      freshness_budget: {
        target_freshness_seconds: targetFreshnessSeconds,
        degraded_after_seconds: degradedAfterSeconds,
        current_age_seconds: currentAgeSeconds,
      },
    },
    providers: [...config.providers],
    last_successful_refresh_at: config.lastSuccessfulRefreshAt?.toISOString() ?? null,
    freshness: {
      target_freshness_seconds: targetFreshnessSeconds,
      degraded_after_seconds: degradedAfterSeconds,
      current_age_seconds: currentAgeSeconds,
      state: freshnessState,
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
  const sourceBackedMarketSnapshotRows = marketSnapshotRows.filter((row) => (
    hasSourceBackedProviders(row.sourceCount, row.sourceProvidersJson)
  ));
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
  const exchangeVolumeSourceRows = database.db.select().from(exchangeVolumeSourcePoints).all();
  const liveExchangeVolumeSourceRows = exchangeVolumeSourceRows.filter((row) => isLiveSourceKind(row.sourceKind));
  const replayExchangeVolumeSourceRows = exchangeVolumeSourceRows.filter((row) => isReplaySourceKind(row.sourceKind));
  const latestExchangeVolumeLiveSourceAt = latestDate(
    liveExchangeVolumeSourceRows,
    (row) => row.sourceFetchedAt,
  );
  const latestExchangeDataAt = latestDate(
    [
      { timestamp: latestExchangeTickerAt },
      { timestamp: latestExchangeVolumeLiveSourceAt },
    ],
    (row) => row.timestamp,
  );
  const latestHistoricalCandleAt = latestDate(
    database.db.select().from(ohlcvCandles).all(),
    (row) => row.timestamp,
  );
  const historicalChartSourceCoverage = classifyHistoricalChartSourceCoverage(database);
  const latestMarketChartSourceAt = historicalChartSourceCoverage.latestSourceFetchedAt;
  const latestHistoricalSourceAt = latestMarketChartSourceAt ?? (historicalChartSourceCoverage.liveTargetKeyCount > 0 ? latestHistoricalCandleAt : null);
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
  const onchainTradeRows = database.db.select().from(onchainPoolTrades).all();
  const liveOnchainTradeRows = onchainTradeRows.filter((row) => isLiveSourceKind(row.sourceKind));
  const replayOnchainTradeRows = onchainTradeRows.filter((row) => isReplaySourceKind(row.sourceKind));
  const latestOnchainTradeAt = latestDate(
    liveOnchainTradeRows,
    (row) => row.sourceFetchedAt,
  );
  const latestSupplyChartAt = latestDate(
    database.db.select().from(supplyChartPoints).all().filter((row) => row.sourceProvider !== 'canonical-validation-snapshot'),
    (row) => row.sourceFetchedAt,
  );
  const derivativeRows = database.db.select().from(derivativeTickers).all();
  const liveDerivativeRows = derivativeRows.filter((row) => isLiveSourceKind(row.sourceKind));
  const replayDerivativeRows = derivativeRows.filter((row) => isReplaySourceKind(row.sourceKind));
  const latestDerivativeAt = latestDate(
    liveDerivativeRows,
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
      ownershipClass: latestExchangeTickerAt || latestExchangeVolumeLiveSourceAt ? 'hybrid' : 'seeded',
      providers: ['CCXT', 'seed exchange catalog', 'exchange volume live/replay'],
      lastSuccessfulRefreshAt: latestExchangeDataAt,
      evidence: ['tests/exchange-fidelity.test.ts', 'tests/provider-replay-exchange-volumes.test.ts', 'tests/http-cache.test.ts'],
      notes: latestExchangeVolumeLiveSourceAt
        ? 'Exchange metadata is seeded/catalog-backed; ticker routes are live-capable and volume charts can read live source-attributed exchange volume rows before canonical fallback.'
        : replayExchangeVolumeSourceRows.length > 0
          ? 'Exchange metadata is seeded/catalog-backed; exchange volume replay rows prove adapter shape but do not promote production coverage.'
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
        ? 'Pool discovery/detail routes are hybrid; trade rows include live source-backed freshness evidence while OHLCV and token analytics may still use fixture or replay fallbacks.'
        : replayOnchainTradeRows.length > 0
          ? 'Pool discovery/detail routes are hybrid; onchain trade replay rows prove Subsquid normalization but do not promote production trade freshness.'
          : latestOnchainAnalyticsAt
            ? 'Pool discovery/detail routes are hybrid; pool OHLCV and token analytics can read source-attributed replay/live rows before fixture fallbacks, but analytics replay must not be advertised as live.'
            : latestOnchainPoolOhlcvAt
              ? 'Pool discovery/detail routes are hybrid; pool OHLCV can read source-attributed replay/live rows before synthetic fallback; holders, traders, and trades still use fixture fallbacks.'
              : 'Pool discovery/detail routes are hybrid; holders, traders, trades, and some OHLCV analytics still use fixture or synthetic fallbacks.',
    }, observedAt),
    buildEntry({
      family: 'derivatives',
      representativeRoutes: ['/derivatives', '/derivatives/exchanges', '/derivatives/exchanges/:id'],
      ownershipClass: liveDerivativeRows.length > 0 ? 'hybrid' : 'fixture',
      providers: ['seed derivatives fixtures', 'CCXT derivatives live/replay'],
      lastSuccessfulRefreshAt: latestDerivativeAt ?? latestFixtureDerivativeAt,
      evidence: ['tests/compare-coingecko.test.ts', 'tests/provider-replay-derivatives.test.ts'],
      notes: liveDerivativeRows.length > 0
        ? 'Derivative rows include live source-attributed futures/swap rows; seeded fixture rows may still be present until full live ingestion breadth lands.'
        : replayDerivativeRows.length > 0
          ? 'Derivative rows include replay rows that prove CCXT raw ticker normalization and idempotent writes, but replay rows do not promote production coverage.'
          : 'Derivative rows are seeded fixtures until live futures/swap ingestion lands; CCXT-style replay proves raw ticker normalization without promoting live coverage.',
    }, observedAt),
    buildEntry({
      family: 'historical_charts',
      representativeRoutes: ['/coins/:id/market_chart', '/coins/:id/ohlc', '/exchanges/:id/volume_chart'],
      ownershipClass: historicalChartSourceCoverage.ownershipClass === 'live'
        ? 'live'
        : historicalChartSourceCoverage.liveTargetKeyCount > 0
          ? 'hybrid'
          : 'seeded',
      providers: ['CCXT OHLCV', 'market chart replay', 'seed chart corpus'],
      lastSuccessfulRefreshAt: latestHistoricalSourceAt,
      evidence: ['tests/ohlcv-sync.test.ts', 'tests/provider-replay-market-charts.test.ts', 'tests/http-cache.test.ts'],
      notes: historicalChartSourceCoverage.ownershipClass === 'live'
        ? `Historical chart rows satisfy source-backed live breadth/depth gates across ${historicalChartSourceCoverage.liveTargetKeyCount}/${historicalChartSourceCoverage.enabledTargetKeyCount} enabled market chart targets with at least ${historicalChartSourceCoverage.minPointsPerEnabledTarget} live points per covered target.`
        : latestMarketChartSourceAt || latestHistoricalCandleAt
          ? `Historical chart and OHLC routes can read source-attributed rows before seeded chart or canonical candle fallback, but live classification requires at least ${HISTORICAL_CHART_LIVE_MIN_POINTS_PER_TARGET} live points on ${Math.ceil(historicalChartSourceCoverage.enabledTargetKeyCount * HISTORICAL_CHART_LIVE_MIN_TARGET_COVERAGE_RATIO)} enabled market chart targets; current live/replay target coverage is ${historicalChartSourceCoverage.liveTargetKeyCount}/${historicalChartSourceCoverage.replayTargetKeyCount}.`
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
    schema_version: 1,
    generated_at: observedAt.toISOString(),
    classification_contract: {
      contract_support_statuses: ['supported'],
      data_fidelity_classifications: [...COVERAGE_OWNERSHIP_CLASS_VALUES],
      source_states: [...DATA_SOURCE_STATE_VALUES],
      non_live_source_states: [...NON_LIVE_DATA_SOURCE_STATES],
      freshness_states: [...COVERAGE_FRESHNESS_STATE_VALUES],
      live_data_rules: {
        contract_support_does_not_imply_live_data: true,
        only_data_fidelity_classification_live_counts_as_live: true,
        seeded_fixture_replay_synthetic_fallback_degraded_stale_unavailable_out_of_scope_are_non_live: true,
      },
    },
    entries,
  };
}
