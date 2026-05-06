import { randomUUID } from 'node:crypto';

import { desc, sql } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import {
  chartResponseSourceCounters,
  chartResponseSourceEvents,
  type ChartResponseSourceCounterRow,
} from '../db/schema';

export type ChartResponseRoute =
  | 'market_chart_days'
  | 'market_chart_range'
  | 'ohlc_days'
  | 'ohlc_range';

export type ChartResponseSource =
  | 'source_backed'
  | 'canonical'
  | 'provider_filled'
  | 'empty';

export type ChartResponseSourceCounts = Record<ChartResponseRoute, Record<ChartResponseSource, number>>;
export type ChartResponseRecentEventSource = Extract<ChartResponseSource, 'provider_filled' | 'empty'>;

export type ChartResponseSourceEventInput = {
  coinId: string;
  vsCurrency: string;
  interval?: string | null;
  request:
    | { kind: 'days'; days: string }
    | { kind: 'range'; from: number; to: number };
};

export type ChartResponseSourceRecentEvent = {
  route: ChartResponseRoute;
  source: ChartResponseRecentEventSource;
  coin_id: string;
  vs_currency: string;
  interval: string | null;
  request: {
    kind: 'days' | 'range';
    days: string | null;
    from: string | null;
    to: string | null;
  };
  observed_at: string;
};

const ROUTES: ChartResponseRoute[] = ['market_chart_days', 'market_chart_range', 'ohlc_days', 'ohlc_range'];
const SOURCES: ChartResponseSource[] = ['source_backed', 'canonical', 'provider_filled', 'empty'];
const RECENT_EVENT_LIMIT = 50;

function emptyCounts(): ChartResponseSourceCounts {
  return Object.fromEntries(ROUTES.map((route) => [
    route,
    Object.fromEntries(SOURCES.map((source) => [source, 0])),
  ])) as ChartResponseSourceCounts;
}

export type ChartResponseSourceDiagnostics = {
  record: (route: ChartResponseRoute, source: ChartResponseSource, event?: ChartResponseSourceEventInput) => void;
  snapshot: () => ChartResponseSourceCounts;
  recentEvents: () => ChartResponseSourceRecentEvent[];
};

function readPersistedCounts(database: AppDatabase): ChartResponseSourceCounts {
  const rows = database.db.select().from(chartResponseSourceCounters).all();
  const counts = emptyCounts();

  for (const row of rows) {
    const typedRow = row as ChartResponseSourceCounterRow;
    counts[typedRow.route][typedRow.source] = typedRow.count;
  }

  return counts;
}

function persistCount(database: AppDatabase, route: ChartResponseRoute, source: ChartResponseSource, now: Date) {
  database.db
    .insert(chartResponseSourceCounters)
    .values({
      route,
      source,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [chartResponseSourceCounters.route, chartResponseSourceCounters.source],
      set: {
        count: sql`${chartResponseSourceCounters.count} + 1`,
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .run();
}

function isRecentEventSource(source: ChartResponseSource): source is ChartResponseRecentEventSource {
  return source === 'provider_filled' || source === 'empty';
}

function persistRecentEvent(
  database: AppDatabase,
  route: ChartResponseRoute,
  source: ChartResponseRecentEventSource,
  event: ChartResponseSourceEventInput,
  now: Date,
) {
  database.db
    .insert(chartResponseSourceEvents)
    .values({
      id: randomUUID(),
      route,
      source,
      coinId: event.coinId,
      vsCurrency: event.vsCurrency,
      interval: event.interval ?? null,
      requestKind: event.request.kind,
      days: event.request.kind === 'days' ? event.request.days : null,
      fromAt: event.request.kind === 'range' ? new Date(event.request.from) : null,
      toAt: event.request.kind === 'range' ? new Date(event.request.to) : null,
      observedAt: now,
    })
    .run();

  database.client.prepare(
    `DELETE FROM chart_response_source_events
     WHERE id NOT IN (
       SELECT id
       FROM chart_response_source_events
       ORDER BY observed_at DESC, id DESC
       LIMIT ?
     )`,
  ).run(RECENT_EVENT_LIMIT);
}

function readRecentEvents(database: AppDatabase): ChartResponseSourceRecentEvent[] {
  return database.db
    .select()
    .from(chartResponseSourceEvents)
    .orderBy(desc(chartResponseSourceEvents.observedAt), desc(chartResponseSourceEvents.id))
    .limit(RECENT_EVENT_LIMIT)
    .all()
    .map((row) => ({
      route: row.route,
      source: row.source,
      coin_id: row.coinId,
      vs_currency: row.vsCurrency,
      interval: row.interval,
      request: {
        kind: row.requestKind,
        days: row.days,
        from: row.fromAt?.toISOString() ?? null,
        to: row.toAt?.toISOString() ?? null,
      },
      observed_at: row.observedAt.toISOString(),
    }));
}

export function createChartResponseSourceDiagnostics(database?: AppDatabase): ChartResponseSourceDiagnostics {
  const counts = emptyCounts();
  const events: ChartResponseSourceRecentEvent[] = [];
  let lastObservedAt = 0;

  function nextObservedAt() {
    const observedAt = Math.max(Date.now(), lastObservedAt + 1);
    lastObservedAt = observedAt;

    return new Date(observedAt);
  }

  return {
    record(route, source, event) {
      counts[route][source] += 1;
      const shouldRecordEvent = event !== undefined && isRecentEventSource(source);
      const observedAt = nextObservedAt();

      if (database) {
        try {
          persistCount(database, route, source, observedAt);
          if (shouldRecordEvent) {
            persistRecentEvent(database, route, source, event, observedAt);
          }
        } catch {
          // Diagnostics must not break public chart/OHLC responses.
        }
      }

      if (shouldRecordEvent) {
        events.unshift({
          route,
          source,
          coin_id: event.coinId,
          vs_currency: event.vsCurrency,
          interval: event.interval ?? null,
          request: {
            kind: event.request.kind,
            days: event.request.kind === 'days' ? event.request.days : null,
            from: event.request.kind === 'range' ? new Date(event.request.from).toISOString() : null,
            to: event.request.kind === 'range' ? new Date(event.request.to).toISOString() : null,
          },
          observed_at: observedAt.toISOString(),
        });
        events.splice(RECENT_EVENT_LIMIT);
      }
    },
    snapshot() {
      if (database) {
        try {
          return readPersistedCounts(database);
        } catch {
          // Fall through to in-process counters if durable diagnostics are unavailable.
        }
      }

      return structuredClone(counts);
    },
    recentEvents() {
      if (database) {
        try {
          return readRecentEvents(database);
        } catch {
          // Fall through to in-process events if durable diagnostics are unavailable.
        }
      }

      return structuredClone(events);
    },
  };
}
