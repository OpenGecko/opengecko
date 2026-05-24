
import type { AppDatabase } from '../../db/client';
import {
  assetPlatforms,
  coins,
  onchainNetworks,
  onchainPoolOhlcv,
  onchainPools,
  onchainPoolTrades,
  onchainTokenHolderCounts,
  onchainTokenHolders,
  onchainTokenTraders,
  supplyChartPoints,
  treasuryHoldings,
  treasurySourceDocuments,
  treasuryTransactions,
} from '../../db/schema';
import { isLiveSourceKind, isReplaySourceKind } from '../diagnostics-policy';
import { roundScore } from './scoring';
import { isFiniteNonNegative, latestIsoFromDates } from './utils';

function countPopulatedImageUrls(rows: Array<{ imageThumbUrl?: string | null; imageSmallUrl?: string | null; imageLargeUrl?: string | null }>) {
  return rows.filter((row) => row.imageSmallUrl || row.imageThumbUrl || row.imageLargeUrl).length;
}

function parsePlatformsJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}

export function buildCatalogHybridQualityEvidence(database: AppDatabase | undefined) {
  if (!database) {
    return {
      search_quality: { assertions: ['VAL-CATALOG-001', 'VAL-CATALOG-002', 'VAL-CATALOG-003', 'VAL-CATALOG-004', 'VAL-CATALOG-005', 'VAL-CATALOG-006', 'VAL-CATALOG-025'], representative_queries: [], canonical_rank_targets: [], status: 'missing_database' },
      asset_image_quality: { assertions: ['VAL-CATALOG-007', 'VAL-CATALOG-008', 'VAL-CATALOG-009', 'VAL-CATALOG-010', 'VAL-CATALOG-011', 'VAL-CATALOG-012', 'VAL-CATALOG-026', 'VAL-CATALOG-030'], platform_count: 0, mapped_token_count: 0, token_list_logo_count: 0, status: 'missing_database' },
      treasury_reconciliation: { assertions: ['VAL-CATALOG-013', 'VAL-CATALOG-014', 'VAL-CATALOG-015', 'VAL-CATALOG-027'], holding_row_count: 0, source_document_count: 0, fixture_fallback_holding_count: 0, status: 'missing_database' },
      onchain_provenance: { assertions: ['VAL-CATALOG-016', 'VAL-CATALOG-017', 'VAL-CATALOG-018', 'VAL-CATALOG-019', 'VAL-CATALOG-020', 'VAL-CATALOG-028'], network_count: 0, pool_count: 0, trade_count: 0, ohlcv_point_count: 0, status: 'missing_database' },
      supply_variant_quality: { assertions: ['VAL-CATALOG-021', 'VAL-CATALOG-022', 'VAL-CATALOG-029'], variant_count: 0, point_count: 0, status: 'missing_database' },
      hybrid_provenance: { assertions: ['VAL-CATALOG-023', 'VAL-CATALOG-024'], status: 'missing_database' },
    };
  }

  const coinRows = database.db.select().from(coins).all();
  const activeCoinRows = coinRows.filter((row) => row.status === 'active');
  const platformRows = database.db.select().from(assetPlatforms).all();
  const treasuryHoldingRows = database.db.select().from(treasuryHoldings).all();
  const treasurySourceRows = database.db.select().from(treasurySourceDocuments).all();
  const treasuryTransactionRows = database.db.select().from(treasuryTransactions).all();
  const onchainNetworkRows = database.db.select().from(onchainNetworks).all();
  const onchainPoolRows = database.db.select().from(onchainPools).all();
  const onchainTradeRows = database.db.select().from(onchainPoolTrades).all();
  const onchainOhlcvRows = database.db.select().from(onchainPoolOhlcv).all();
  const onchainHolderRows = database.db.select().from(onchainTokenHolders).all();
  const onchainTraderRows = database.db.select().from(onchainTokenTraders).all();
  const onchainHolderCountRows = database.db.select().from(onchainTokenHolderCounts).all();
  const supplyRows = database.db.select().from(supplyChartPoints).all();

  const platformMappedCoins = activeCoinRows
    .map((coin) => ({ coin, platforms: parsePlatformsJson(coin.platformsJson) }))
    .filter((entry) => Object.values(entry.platforms).some((address) => typeof address === 'string' && address.length > 0));
  const mappedTokenCount = platformMappedCoins.reduce((count, entry) =>
    count + Object.values(entry.platforms).filter((address) => typeof address === 'string' && address.length > 0).length, 0);
  const tokenListLogoCount = platformMappedCoins.filter((entry) =>
    entry.coin.imageSmallUrl || entry.coin.imageThumbUrl || entry.coin.imageLargeUrl).length;
  const tokenListLogoCoverageRatio = mappedTokenCount === 0 ? 0 : tokenListLogoCount / mappedTokenCount;
  const coinImageCoverageRatio = activeCoinRows.length === 0 ? 0 : countPopulatedImageUrls(activeCoinRows) / activeCoinRows.length;
  const latestCatalogAt = latestIsoFromDates([
    ...coinRows.map((row) => row.updatedAt),
    ...platformRows.map((row) => row.updatedAt),
  ]);

  const treasurySourceUrls = new Set(treasurySourceRows.map((row) => row.sourceUrl));
  const sourceBackedTreasuryHoldingRows = treasuryHoldingRows.filter((row) => row.sourceUrl && treasurySourceUrls.has(row.sourceUrl));
  const treasuryTotalsByCoin = [...new Set(treasuryHoldingRows.map((row) => row.coinId))].map((coinId) => {
    const rows = treasuryHoldingRows.filter((row) => row.coinId === coinId);
    const totalHoldings = rows.reduce((sum, row) => sum + row.amount, 0);
    const latestTransactionsByEntity = [...new Set(treasuryTransactionRows.filter((row) => row.coinId === coinId).map((row) => row.entityId))]
      .map((entityId) => treasuryTransactionRows
        .filter((row) => row.coinId === coinId && row.entityId === entityId)
        .sort((left, right) => right.happenedAt.getTime() - left.happenedAt.getTime())[0])
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    const latestTransactionHoldings = latestTransactionsByEntity.reduce((sum, row) => sum + row.holdingBalance, 0);
    const holdingTransactionDelta = Math.abs(totalHoldings - latestTransactionHoldings);
    return {
      coin_id: coinId,
      holding_row_count: rows.length,
      total_holdings: totalHoldings,
      latest_transaction_holdings: latestTransactionHoldings,
      holding_transaction_delta: holdingTransactionDelta,
      reconciled: latestTransactionsByEntity.length === 0 || holdingTransactionDelta <= 0.000001,
    };
  });

  const onchainFieldProvenance = {
    reserve_usd: {
      source_fields: ['onchain_pools.reserve_usd', 'DeFiLlama pool tvlUsd when live patch exists'],
      populated_count: onchainPoolRows.filter((row) => isFiniteNonNegative(row.reserveUsd)).length,
      zero_fill_count: onchainPoolRows.filter((row) => row.reserveUsd === 0).length,
    },
    volume_usd_h24: {
      source_fields: ['onchain_pools.volume_24h_usd', 'DeFiLlama volumeUsd1d/dex total24h when live patch exists'],
      populated_count: onchainPoolRows.filter((row) => isFiniteNonNegative(row.volume24hUsd)).length,
      zero_fill_count: onchainPoolRows.filter((row) => row.volume24hUsd === 0).length,
    },
    pool_price_usd: {
      source_fields: ['onchain_pools.price_usd', 'simple token price path when live token price exists'],
      populated_count: onchainPoolRows.filter((row) => isFiniteNonNegative(row.priceUsd)).length,
      zero_fill_count: onchainPoolRows.filter((row) => row.priceUsd === 0).length,
    },
    trades: {
      source_fields: ['onchain_pool_trades.source_kind', 'onchain_pool_trades.source_provider', 'onchain_pool_trades.source_fetched_at'],
      replay_count: onchainTradeRows.filter((row) => isReplaySourceKind(row.sourceKind)).length,
      live_count: onchainTradeRows.filter((row) => isLiveSourceKind(row.sourceKind)).length,
    },
    ohlcv: {
      source_fields: ['onchain_pool_ohlcv.source_kind', 'onchain_pool_ohlcv.source_provider', 'onchain_pool_ohlcv.source_fetched_at'],
      replay_count: onchainOhlcvRows.filter((row) => isReplaySourceKind(row.sourceKind)).length,
      live_count: onchainOhlcvRows.filter((row) => isLiveSourceKind(row.sourceKind)).length,
    },
    analytics: {
      source_fields: [
        'onchain_token_holders.source_kind/source_provider/source_fetched_at',
        'onchain_token_traders.source_kind/source_provider/source_fetched_at',
        'onchain_token_holder_counts.source_kind/source_provider/source_fetched_at',
      ],
      holder_rows: onchainHolderRows.length,
      trader_rows: onchainTraderRows.length,
      holder_count_rows: onchainHolderCountRows.length,
    },
  };

  const supplyVariants = [
    { id: 'circulating_days', route: '/coins/:id/circulating_supply_chart', supply_type: 'circulating', range_variant: false },
    { id: 'circulating_range', route: '/coins/:id/circulating_supply_chart/range', supply_type: 'circulating', range_variant: true },
    { id: 'total_days', route: '/coins/:id/total_supply_chart', supply_type: 'total', range_variant: false },
    { id: 'total_range', route: '/coins/:id/total_supply_chart/range', supply_type: 'total', range_variant: true },
  ].map((variant) => {
    const rows = supplyRows.filter((row) => row.supplyType === variant.supply_type);
    const sourceKinds = [...new Set(rows.map((row) => row.sourceKind))].sort();
    const sourceMode = rows.some((row) => isLiveSourceKind(row.sourceKind))
      ? 'live'
      : rows.some((row) => isReplaySourceKind(row.sourceKind))
        ? 'replay'
        : 'empty';
    return {
      ...variant,
      point_count: rows.length,
      source_mode: sourceMode,
      source_kinds: sourceKinds,
      latest_source_fetched_at: latestIsoFromDates(rows.map((row) => row.sourceFetchedAt)),
    };
  });

  return {
    search_quality: {
      assertions: ['VAL-CATALOG-001', 'VAL-CATALOG-002', 'VAL-CATALOG-003', 'VAL-CATALOG-004', 'VAL-CATALOG-005', 'VAL-CATALOG-006', 'VAL-CATALOG-025'],
      representative_queries: ['bitcoin', 'BTC', 'eth', 'usdc', 'binance', 'nft'],
      canonical_rank_targets: [
        { query: 'bitcoin', expected_coin_id: 'bitcoin', max_rank: 1 },
        { query: 'BTC', expected_coin_id: 'bitcoin', max_rank: 3 },
        { query: 'eth', expected_coin_id: 'ethereum', max_rank: 3 },
        { query: 'usdc', expected_coin_id: 'usd-coin', max_rank: 3 },
      ],
      bucket_count_expectations: ['coins', 'exchanges', 'icos', 'categories', 'nfts'],
      source_mode: 'stable_catalog',
      latest_catalog_at: latestCatalogAt,
    },
    asset_image_quality: {
      assertions: ['VAL-CATALOG-007', 'VAL-CATALOG-008', 'VAL-CATALOG-009', 'VAL-CATALOG-010', 'VAL-CATALOG-011', 'VAL-CATALOG-012', 'VAL-CATALOG-026', 'VAL-CATALOG-030'],
      platform_count: platformRows.length,
      mapped_token_count: mappedTokenCount,
      token_list_logo_count: tokenListLogoCount,
      token_list_logo_coverage_ratio: roundScore(tokenListLogoCoverageRatio * 10),
      active_coin_image_coverage_ratio: roundScore(coinImageCoverageRatio * 10),
      deterministic_url_checks: {
        accepted_prefixes: ['https://', 'ipfs://', '/'],
        placeholder_domains_rejected: ['example.invalid', 'placeholder.invalid'],
        sampled_head_checks: 'bounded_optional_network_check',
      },
      canonical_identity_checks: {
        platform: 'ethereum',
        contracts: platformMappedCoins.slice(0, 10).map((entry) => ({
          coin_id: entry.coin.id,
          symbol: entry.coin.symbol,
          address: entry.platforms.ethereum ?? null,
        })),
      },
      latest_catalog_at: latestCatalogAt,
    },
    treasury_reconciliation: {
      assertions: ['VAL-CATALOG-013', 'VAL-CATALOG-014', 'VAL-CATALOG-015', 'VAL-CATALOG-027'],
      holding_row_count: treasuryHoldingRows.length,
      source_document_count: treasurySourceRows.length,
      source_backed_holding_count: sourceBackedTreasuryHoldingRows.length,
      fixture_fallback_holding_count: treasuryHoldingRows.length - sourceBackedTreasuryHoldingRows.length,
      transaction_count: treasuryTransactionRows.length,
      totals_by_coin: treasuryTotalsByCoin,
      latest_source_at: latestIsoFromDates([
        ...treasuryHoldingRows.map((row) => row.reportedAt),
        ...treasurySourceRows.map((row) => row.acceptedAt),
      ]),
      source_mode: sourceBackedTreasuryHoldingRows.length === treasuryHoldingRows.length && treasuryHoldingRows.length > 0
        ? 'disclosure_replay'
        : sourceBackedTreasuryHoldingRows.length > 0
          ? 'hybrid'
          : 'fixture',
    },
    onchain_provenance: {
      assertions: ['VAL-CATALOG-016', 'VAL-CATALOG-017', 'VAL-CATALOG-018', 'VAL-CATALOG-019', 'VAL-CATALOG-020', 'VAL-CATALOG-028'],
      network_count: onchainNetworkRows.length,
      pool_count: onchainPoolRows.length,
      trade_count: onchainTradeRows.length,
      ohlcv_point_count: onchainOhlcvRows.length,
      analytics_row_count: onchainHolderRows.length + onchainTraderRows.length + onchainHolderCountRows.length,
      field_provenance: onchainFieldProvenance,
      diagnostics_equivalence: {
        alias_path: '/diagnostics/onchain',
        specialized_paths: ['/diagnostics/onchain_analytics', '/diagnostics/onchain_trades'],
      },
      latest_source_at: latestIsoFromDates([
        ...onchainPoolRows.map((row) => row.updatedAt),
        ...onchainTradeRows.map((row) => row.sourceFetchedAt),
        ...onchainOhlcvRows.map((row) => row.sourceFetchedAt),
        ...onchainHolderRows.map((row) => row.sourceFetchedAt),
        ...onchainTraderRows.map((row) => row.sourceFetchedAt),
        ...onchainHolderCountRows.map((row) => row.sourceFetchedAt),
      ]),
    },
    supply_variant_quality: {
      assertions: ['VAL-CATALOG-021', 'VAL-CATALOG-022', 'VAL-CATALOG-029'],
      variants: supplyVariants,
      variant_count: supplyVariants.length,
      point_count: supplyRows.length,
      source_modes: [...new Set(supplyVariants.map((variant) => variant.source_mode))].sort(),
      latest_source_at: latestIsoFromDates(supplyRows.map((row) => row.sourceFetchedAt)),
      diagnostics_path: '/diagnostics/supply_charts',
    },
    hybrid_provenance: {
      assertions: ['VAL-CATALOG-023', 'VAL-CATALOG-024'],
      families: ['search', 'assets', 'treasury', 'onchain', 'supply'],
      required_metadata_fields: ['family', 'source_mode', 'source_identifier', 'timestamp_or_version', 'degraded_reason'],
      source_modes: {
        search: 'stable_catalog',
        assets: 'stable_catalog',
        treasury: sourceBackedTreasuryHoldingRows.length > 0 ? 'hybrid' : 'fixture',
        onchain: onchainPoolRows.length > 0 ? 'hybrid' : 'fixture',
        supply: supplyRows.length > 0 ? 'replay' : 'empty',
      },
    },
  };
}
