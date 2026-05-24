
import type { AppDatabase } from '../../db/client';
import { coinTickers, exchangeVolumeSourcePoints, exchanges } from '../../db/schema';
import { isLiveSourceKind, isReplaySourceKind, isSeededExchangeTimestamp } from '../diagnostics-policy';
import { MAJOR_EXCHANGE_TARGETS } from './constants';
import { isFiniteNonNegative, isFinitePositive, latestIsoFromDates } from './utils';

export function buildExchangeQualityEvidence(database: AppDatabase | undefined) {
  if (!database) {
    return {
      assertions: ['VAL-EXGLOBAL-026', 'VAL-EXGLOBAL-027', 'VAL-EXGLOBAL-028'],
      major_targets: MAJOR_EXCHANGE_TARGETS.map((target) => ({
        ...target,
        status: 'unknown_no_database',
        matched_exchange_id: null,
        ticker_numeric_quality: null,
        volume_chart_evidence: null,
      })),
      ticker_numeric_quality: {
        total_rows: 0,
        valid_last_count: 0,
        valid_converted_volume_count: 0,
        parseable_timestamp_count: 0,
        invalid_row_count: 0,
      },
      volume_chart_evidence: {
        source_backed_exchange_count: 0,
        live_point_count: 0,
        replay_point_count: 0,
        latest_source_fetched_at: null,
        dimension_status: 'degraded',
        reason_codes: ['missing_database'],
      },
    };
  }

  const exchangeRows = database.db.select().from(exchanges).all();
  const tickerRows = database.db.select().from(coinTickers).all();
  const volumeRows = database.db.select().from(exchangeVolumeSourcePoints).all();
  const liveOrReplayVolumeRows = volumeRows.filter((row) => isLiveSourceKind(row.sourceKind) || isReplaySourceKind(row.sourceKind));
  const invalidTickerRows = tickerRows.filter((row) => (
    !isFinitePositive(row.last)
    || !isFiniteNonNegative(row.convertedVolumeUsd)
    || !(row.lastFetchAt instanceof Date)
  ));

  const majorTargets = MAJOR_EXCHANGE_TARGETS.map((target) => {
    const exchange = exchangeRows.find((row) => target.aliases.includes(row.id)) ?? null;
    const targetTickerRows = exchange
      ? tickerRows.filter((row) => row.exchangeId === exchange.id)
      : [];
    const liveTickerRows = targetTickerRows.filter((row) => row.lastFetchAt instanceof Date && !isSeededExchangeTimestamp(row.lastFetchAt));
    const validTickerRows = targetTickerRows.filter((row) => (
      isFinitePositive(row.last)
      && isFiniteNonNegative(row.convertedVolumeUsd)
      && row.lastFetchAt instanceof Date
    ));
    const targetVolumeRows = exchange
      ? volumeRows.filter((row) => row.exchangeId === exchange.id)
      : [];
    const sourceBackedVolumeRows = targetVolumeRows.filter((row) => isLiveSourceKind(row.sourceKind) || isReplaySourceKind(row.sourceKind));

    return {
      target_id: target.target_id,
      aliases: target.aliases,
      matched_exchange_id: exchange?.id ?? null,
      status: exchange
        ? liveTickerRows.length > 0
          ? 'live_ticker_backed'
          : targetTickerRows.length > 0
            ? 'fixture_or_seeded_tickers'
            : 'catalog_only'
        : 'missing_catalog',
      ticker_numeric_quality: {
        total_rows: targetTickerRows.length,
        live_row_count: liveTickerRows.length,
        valid_numeric_rows: validTickerRows.length,
        valid_ratio: targetTickerRows.length > 0 ? validTickerRows.length / targetTickerRows.length : 0,
        invalid_or_missing_rows: Math.max(targetTickerRows.length - validTickerRows.length, 0),
        latest_ticker_at: latestIsoFromDates(targetTickerRows.map((row) => row.lastFetchAt)),
      },
      volume_chart_evidence: {
        total_point_count: targetVolumeRows.length,
        source_backed_point_count: sourceBackedVolumeRows.length,
        live_point_count: targetVolumeRows.filter((row) => isLiveSourceKind(row.sourceKind)).length,
        replay_point_count: targetVolumeRows.filter((row) => isReplaySourceKind(row.sourceKind)).length,
        latest_source_fetched_at: latestIsoFromDates(sourceBackedVolumeRows.map((row) => row.sourceFetchedAt)),
      },
      degradation_reason: exchange
        ? targetTickerRows.length > 0 || sourceBackedVolumeRows.length > 0
          ? null
          : 'no_live_ticker_or_volume_rows'
        : 'exchange_catalog_missing',
    };
  });

  return {
    assertions: ['VAL-EXGLOBAL-026', 'VAL-EXGLOBAL-027', 'VAL-EXGLOBAL-028'],
    major_targets: majorTargets,
    ticker_numeric_quality: {
      total_rows: tickerRows.length,
      valid_last_count: tickerRows.filter((row) => isFinitePositive(row.last)).length,
      valid_converted_volume_count: tickerRows.filter((row) => isFiniteNonNegative(row.convertedVolumeUsd)).length,
      parseable_timestamp_count: tickerRows.filter((row) => row.lastFetchAt instanceof Date).length,
      invalid_row_count: invalidTickerRows.length,
      invalid_row_samples: invalidTickerRows.slice(0, 10).map((row) => ({
        exchange_id: row.exchangeId,
        pair: `${row.base}/${row.target}`,
        last: row.last,
        converted_volume_usd: row.convertedVolumeUsd,
        last_fetch_at: row.lastFetchAt?.toISOString() ?? null,
      })),
    },
    volume_chart_evidence: {
      source_backed_exchange_count: new Set(liveOrReplayVolumeRows.map((row) => row.exchangeId)).size,
      live_point_count: volumeRows.filter((row) => isLiveSourceKind(row.sourceKind)).length,
      replay_point_count: volumeRows.filter((row) => isReplaySourceKind(row.sourceKind)).length,
      latest_source_fetched_at: latestIsoFromDates(liveOrReplayVolumeRows.map((row) => row.sourceFetchedAt)),
      dimension_status: liveOrReplayVolumeRows.length > 0 ? 'source_backed' : 'degraded',
      reason_codes: liveOrReplayVolumeRows.length > 0 ? [] : ['missing_exchange_volume_chart_source'],
    },
    note: 'Major exchange targets are matched through CoinGecko-compatible exchange IDs and common CCXT aliases; missing venues are explicit per target instead of blocking the whole family.',
  };
}
