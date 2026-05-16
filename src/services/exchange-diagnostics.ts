import type { AppDatabase } from '../db/client';
import { coinTickers, exchangeVolumeSourcePoints, exchanges } from '../db/schema';
import type { MarketDataRuntimeState } from './market-runtime-state';

const SEEDED_EXCHANGE_TIMESTAMP_MS = Date.parse('2026-03-20T00:00:00.000Z');

function latestIso(timestamps: Array<Date | null>) {
  const latest = timestamps.reduce<Date | null>((current, timestamp) => (
    timestamp !== null && (current === null || timestamp.getTime() > current.getTime()) ? timestamp : current
  ), null);

  return latest?.toISOString() ?? null;
}

function classifyExchangeEvidence(input: {
  liveTickerRowCount: number;
  seededTickerRowCount: number;
  liveVolumeRowCount: number;
  replayVolumeRowCount: number;
}) {
  if (input.liveTickerRowCount > 0 && input.liveVolumeRowCount > 0) {
    return 'live_ticker_and_volume';
  }

  if (input.liveTickerRowCount > 0) {
    return 'live_ticker';
  }

  if (input.liveVolumeRowCount > 0) {
    return 'live_volume';
  }

  if (input.replayVolumeRowCount > 0) {
    return 'replay_only';
  }

  if (input.seededTickerRowCount > 0) {
    return 'seeded_ticker_only';
  }

  return 'seeded_registry_only';
}

export function buildExchangeDiagnostics(database: AppDatabase, runtimeState: MarketDataRuntimeState) {
  const exchangeRows = database.db.select().from(exchanges).all();
  const tickerRows = database.db.select().from(coinTickers).all();
  const volumeRows = database.db.select().from(exchangeVolumeSourcePoints).all();
  const exchangeTickerIngestion = runtimeState.exchangeTickerIngestion ?? {
    last_refresh_at: null,
    exchange_results: {},
  };
  const ingestionResults = exchangeTickerIngestion.exchange_results;

  return {
    generated_at: new Date().toISOString(),
    last_ticker_refresh_at: exchangeTickerIngestion.last_refresh_at,
    exchanges: exchangeRows.map((exchange) => {
      const exchangeTickers = tickerRows.filter((row) => row.exchangeId === exchange.id);
      const liveTickerRows = exchangeTickers.filter((row) => row.lastFetchAt instanceof Date && row.lastFetchAt.getTime() !== SEEDED_EXCHANGE_TIMESTAMP_MS);
      const seededTickerRows = exchangeTickers.filter((row) => row.lastFetchAt instanceof Date && row.lastFetchAt.getTime() === SEEDED_EXCHANGE_TIMESTAMP_MS);
      const exchangeVolumes = volumeRows.filter((row) => row.exchangeId === exchange.id);
      const liveVolumeRows = exchangeVolumes.filter((row) => row.sourceKind === 'live');
      const replayVolumeRows = exchangeVolumes.filter((row) => row.sourceKind === 'replay');
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
              failed_reason: ingestion.failed_reason,
            }
          : {
              fetched_ticker_count: 0,
              matched_ticker_count: 0,
              accepted_ticker_rows: 0,
              rejected_ticker_rows: 0,
              rejection_reasons: {},
              failed_reason: null,
            },
      };
    }),
  };
}
