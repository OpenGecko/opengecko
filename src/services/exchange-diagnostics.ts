import type { AppDatabase } from '../db/client';
import { coinTickers, exchangeVolumeSourcePoints, exchanges } from '../db/schema';
import {
  classifyExchangeEvidence,
  isLiveSourceKind,
  isReplaySourceKind,
  isSeededExchangeTimestamp,
} from './diagnostics-policy';
import { summarizeProviderBreakerState } from './provider-breaker';
import type { MarketDataRuntimeState } from './market-runtime-state';

function latestIso(timestamps: Array<Date | null>) {
  const latest = timestamps.reduce<Date | null>((current, timestamp) => (
    timestamp !== null && (current === null || timestamp.getTime() > current.getTime()) ? timestamp : current
  ), null);

  return latest?.toISOString() ?? null;
}

export function buildExchangeDiagnostics(database: AppDatabase, runtimeState: MarketDataRuntimeState) {
  const exchangeRows = database.db.select().from(exchanges).all();
  const tickerRows = database.db.select().from(coinTickers).all();
  const volumeRows = database.db.select().from(exchangeVolumeSourcePoints).all();
  const exchangeTickerIngestion = runtimeState.exchangeTickerIngestion ?? {
    last_refresh_at: null,
    configured_exchange_ids: [],
    attempted_exchange_ids: [],
    promotion_attempted_exchange_ids: [],
    successful_exchange_ids: [],
    live_backed_exchange_ids: [],
    failed_exchange_ids: [],
    blocked_exchange_ids: [],
    unavailable_exchange_ids: [],
    exchange_results: {},
  };
  const ingestionResults = exchangeTickerIngestion.exchange_results;
  const providerBreakerSummaries = new Map(
    runtimeState.providerBreakers
      ? summarizeProviderBreakerState(runtimeState.providerBreakers).map((provider) => [provider.id, provider])
      : [],
  );
  const liveBackedExchangeIds = exchangeTickerIngestion.live_backed_exchange_ids.length > 0
    ? exchangeTickerIngestion.live_backed_exchange_ids
    : exchangeRows
      .filter((exchange) => tickerRows.some((row) => row.exchangeId === exchange.id && row.lastFetchAt instanceof Date && !isSeededExchangeTimestamp(row.lastFetchAt)))
      .map((exchange) => exchange.id);
  const configuredExchangeIds = exchangeTickerIngestion.configured_exchange_ids;
  const attemptedExchangeIds = exchangeTickerIngestion.attempted_exchange_ids;
  const observedProviderAttemptIds = configuredExchangeIds.filter((exchangeId) => {
    const providerBreaker = providerBreakerSummaries.get(exchangeId) ?? null;
    return attemptedExchangeIds.includes(exchangeId)
      || liveBackedExchangeIds.includes(exchangeId)
      || providerBreaker?.last_failure_at !== null
      || providerBreaker?.last_success_at !== null;
  });
  const promotionAttemptedExchangeIds = [...new Set([
    ...exchangeTickerIngestion.promotion_attempted_exchange_ids,
    ...observedProviderAttemptIds,
  ])];
  const successfulExchangeIds = exchangeTickerIngestion.successful_exchange_ids;
  const failedExchangeIds = exchangeTickerIngestion.failed_exchange_ids;
  const blockedExchangeIds = exchangeTickerIngestion.blocked_exchange_ids;
  const unavailableExchangeIds = exchangeTickerIngestion.unavailable_exchange_ids.length > 0
    ? exchangeTickerIngestion.unavailable_exchange_ids
    : [...new Set([...failedExchangeIds, ...blockedExchangeIds])];
  const minimumPromotionAttemptCount = 12;

  return {
    generated_at: new Date().toISOString(),
    last_ticker_refresh_at: exchangeTickerIngestion.last_refresh_at,
    provider_coverage: {
      configured_exchange_ids: configuredExchangeIds,
      configured_exchange_count: configuredExchangeIds.length,
      attempted_exchange_ids: attemptedExchangeIds,
      attempted_exchange_count: attemptedExchangeIds.length,
      promotion_attempted_exchange_ids: promotionAttemptedExchangeIds,
      promotion_attempted_exchange_count: promotionAttemptedExchangeIds.length,
      successful_exchange_ids: successfulExchangeIds,
      successful_exchange_count: successfulExchangeIds.length,
      live_backed_exchange_ids: liveBackedExchangeIds,
      live_backed_exchange_count: liveBackedExchangeIds.length,
      failed_exchange_ids: failedExchangeIds,
      failed_exchange_count: failedExchangeIds.length,
      blocked_exchange_ids: blockedExchangeIds,
      blocked_exchange_count: blockedExchangeIds.length,
      unavailable_exchange_ids: unavailableExchangeIds,
      unavailable_exchange_count: unavailableExchangeIds.length,
      minimum_promotion_attempt_count: minimumPromotionAttemptCount,
      attempted_minimum_met: configuredExchangeIds.length >= minimumPromotionAttemptCount
        ? promotionAttemptedExchangeIds.length >= minimumPromotionAttemptCount
        : promotionAttemptedExchangeIds.length === configuredExchangeIds.length,
      notes: 'Live promotion counts only source-backed live ticker rows; failed, blocked, fixture, seeded, and catalog-only exchanges remain separate.',
    },
    providers: configuredExchangeIds.map((exchangeId) => {
      const ingestion = ingestionResults[exchangeId] ?? null;
      const providerBreaker = providerBreakerSummaries.get(exchangeId) ?? null;
      const attempted = attemptedExchangeIds.includes(exchangeId);
      const failed = failedExchangeIds.includes(exchangeId);
      const blocked = blockedExchangeIds.includes(exchangeId);
      const liveBacked = liveBackedExchangeIds.includes(exchangeId);
      const successful = successfulExchangeIds.includes(exchangeId);

      return {
        id: exchangeId,
        attempt_status: liveBacked
          ? 'live_backed'
          : failed
            ? 'failed'
            : blocked
              ? 'blocked_by_breaker'
              : successful
                ? 'successful_no_live_rows'
                : attempted
                  ? 'attempted'
                  : 'configured_not_attempted',
        attempted,
        successful,
        live_backed: liveBacked,
        failed,
        blocked,
        failure_kind: ingestion?.failed_kind ?? providerBreaker?.failure_kind ?? null,
        failure_reason: ingestion?.failed_reason ?? providerBreaker?.last_failure_reason ?? null,
        last_success_at: providerBreaker?.last_success_at ? new Date(providerBreaker.last_success_at).toISOString() : null,
        last_failure_at: providerBreaker?.last_failure_at ? new Date(providerBreaker.last_failure_at).toISOString() : null,
      };
    }),
    exchanges: exchangeRows.map((exchange) => {
      const exchangeTickers = tickerRows.filter((row) => row.exchangeId === exchange.id);
      const liveTickerRows = exchangeTickers.filter((row) => row.lastFetchAt instanceof Date && !isSeededExchangeTimestamp(row.lastFetchAt));
      const seededTickerRows = exchangeTickers.filter((row) => isSeededExchangeTimestamp(row.lastFetchAt));
      const exchangeVolumes = volumeRows.filter((row) => row.exchangeId === exchange.id);
      const liveVolumeRows = exchangeVolumes.filter((row) => isLiveSourceKind(row.sourceKind));
      const replayVolumeRows = exchangeVolumes.filter((row) => isReplaySourceKind(row.sourceKind));
      const ingestion = ingestionResults[exchange.id] ?? null;

      return {
        id: exchange.id,
        name: exchange.name,
        evidence_class: classifyExchangeEvidence({
          liveTickerRowCount: liveTickerRows.length,
          seededTickerRowCount: seededTickerRows.length,
          liveVolumeRowCount: liveVolumeRows.length,
          replayVolumeRowCount: replayVolumeRows.length,
        }),
        ticker_evidence: {
          live_row_count: liveTickerRows.length,
          seeded_row_count: seededTickerRows.length,
          last_live_ticker_at: latestIso(liveTickerRows.map((row) => row.lastFetchAt)),
        },
        volume_evidence: {
          live_row_count: liveVolumeRows.length,
          replay_row_count: replayVolumeRows.length,
          last_live_volume_at: latestIso(liveVolumeRows.map((row) => row.sourceFetchedAt)),
          last_replay_volume_at: latestIso(replayVolumeRows.map((row) => row.sourceFetchedAt)),
        },
        ingestion: ingestion
          ? {
              fetched_ticker_count: ingestion.fetched_ticker_count,
              matched_ticker_count: ingestion.matched_ticker_count,
              accepted_ticker_rows: ingestion.accepted_ticker_rows,
              rejected_ticker_rows: ingestion.rejected_ticker_rows,
              rejection_reasons: { ...ingestion.rejection_reasons },
              failed_kind: ingestion.failed_kind,
              failed_reason: ingestion.failed_reason,
            }
          : {
              fetched_ticker_count: 0,
              matched_ticker_count: 0,
              accepted_ticker_rows: 0,
              rejected_ticker_rows: 0,
              rejection_reasons: {},
              failed_kind: null,
              failed_reason: null,
            },
      };
    }),
  };
}
