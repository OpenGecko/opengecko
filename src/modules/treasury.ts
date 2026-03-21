import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { chartPoints, coins, marketSnapshots, treasuryEntities, treasuryHoldings, treasuryTransactions, type TreasuryEntityRow, type TreasuryTransactionRow } from '../db/schema';
import { HttpError } from '../http/errors';
import { parseBooleanQuery, parseCsvQuery, parsePositiveInt } from '../http/params';

const entitiesListQuerySchema = z.object({
  entity_type: z.enum(['companies', 'governments']).optional(),
  per_page: z.string().optional(),
  page: z.string().optional(),
});

const treasuryByCoinQuerySchema = z.object({
  per_page: z.string().optional(),
  page: z.string().optional(),
  order: z.string().optional(),
});

const treasuryHoldingChartQuerySchema = z.object({
  days: z.string().optional(),
  include_empty_intervals: z.string().optional(),
});

const treasuryTransactionHistoryQuerySchema = z.object({
  per_page: z.string().optional(),
  page: z.string().optional(),
  order: z.string().optional(),
  coin_ids: z.string().optional(),
});

const VALID_TREASURY_CHART_DAYS = new Set(['7', '14', '30', '90', '180', '365', '730', 'max']);

function mapEntitySegmentToType(entity: 'companies' | 'governments') {
  return entity === 'companies' ? 'company' : 'government';
}

function sortNumber(value: number | null | undefined, fallback: number) {
  return value ?? fallback;
}

function parseTreasuryChartDays(value: string | undefined) {
  const normalizedValue = value ?? '365';

  if (!VALID_TREASURY_CHART_DAYS.has(normalizedValue)) {
    throw new HttpError(400, 'invalid_parameter', `Invalid days value: ${value}`);
  }

  return normalizedValue;
}

function buildEntityListRow(row: TreasuryEntityRow) {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    country: row.country,
    entity_type: row.entityType,
  };
}

function getTreasuryEntityOrThrow(database: AppDatabase, entityId: string) {
  const entity = database.db.select().from(treasuryEntities).where(eq(treasuryEntities.id, entityId)).limit(1).get();

  if (!entity) {
    throw new HttpError(404, 'not_found', `Treasury entity not found: ${entityId}`);
  }

  return entity;
}

function getCoinOrThrow(database: AppDatabase, coinId: string) {
  const coin = database.db.select().from(coins).where(eq(coins.id, coinId)).limit(1).get();

  if (!coin) {
    throw new HttpError(404, 'not_found', `Coin not found: ${coinId}`);
  }

  return coin;
}

function sortTreasuryRows(
  rows: Array<{
    entityId: string;
    name: string;
    symbol: string | null;
    country: string | null;
    amount: number;
    currentValueUsd: number | null;
    entryValueUsd: number | null;
    reportedAt: Date;
    sourceUrl: string | null;
  }>,
  order: string | undefined,
) {
  const normalizedOrder = (order ?? 'holdings_desc').toLowerCase();
  const sortableRows = [...rows];

  switch (normalizedOrder) {
    case 'holdings_desc':
      return sortableRows.sort((left, right) => right.amount - left.amount);
    case 'holdings_asc':
      return sortableRows.sort((left, right) => left.amount - right.amount);
    case 'value_desc':
      return sortableRows.sort((left, right) => sortNumber(right.currentValueUsd, -1) - sortNumber(left.currentValueUsd, -1));
    case 'value_asc':
      return sortableRows.sort((left, right) => sortNumber(left.currentValueUsd, Number.MAX_SAFE_INTEGER) - sortNumber(right.currentValueUsd, Number.MAX_SAFE_INTEGER));
    case 'name_asc':
      return sortableRows.sort((left, right) => left.name.localeCompare(right.name));
    case 'name_desc':
      return sortableRows.sort((left, right) => right.name.localeCompare(left.name));
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported order value: ${order}`);
  }
}

function sortTreasuryTransactions(rows: TreasuryTransactionRow[], order: string | undefined) {
  const normalizedOrder = (order ?? 'date_desc').toLowerCase();
  const sortableRows = [...rows];

  switch (normalizedOrder) {
    case 'date_desc':
      return sortableRows.sort((left, right) => right.happenedAt.getTime() - left.happenedAt.getTime());
    case 'date_asc':
      return sortableRows.sort((left, right) => left.happenedAt.getTime() - right.happenedAt.getTime());
    case 'holding_net_change_desc':
      return sortableRows.sort((left, right) => right.holdingNetChange - left.holdingNetChange);
    case 'holding_net_change_asc':
      return sortableRows.sort((left, right) => left.holdingNetChange - right.holdingNetChange);
    case 'transaction_value_usd_desc':
      return sortableRows.sort((left, right) => sortNumber(right.transactionValueUsd, -1) - sortNumber(left.transactionValueUsd, -1));
    case 'transaction_value_usd_asc':
      return sortableRows.sort((left, right) => sortNumber(left.transactionValueUsd, Number.MAX_SAFE_INTEGER) - sortNumber(right.transactionValueUsd, Number.MAX_SAFE_INTEGER));
    case 'average_cost_desc':
      return sortableRows.sort((left, right) => sortNumber(right.averageEntryValueUsd, -1) - sortNumber(left.averageEntryValueUsd, -1));
    case 'average_cost_asc':
      return sortableRows.sort((left, right) => sortNumber(left.averageEntryValueUsd, Number.MAX_SAFE_INTEGER) - sortNumber(right.averageEntryValueUsd, Number.MAX_SAFE_INTEGER));
    default:
      throw new HttpError(400, 'invalid_parameter', `Unsupported order value: ${order}`);
  }
}

function findLatestBalanceAtOrBefore(rows: TreasuryTransactionRow[], timestamp: number) {
  let latestRow: TreasuryTransactionRow | undefined;

  for (const row of rows) {
    if (row.happenedAt.getTime() <= timestamp) {
      latestRow = row;
      continue;
    }

    break;
  }

  return latestRow?.holdingBalance;
}

export function registerTreasuryRoutes(app: FastifyInstance, database: AppDatabase) {
  app.get('/entities/list', async (request) => {
    const query = entitiesListQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const rows = database.db.select().from(treasuryEntities).all();
    let filteredRows = rows;

    if (query.entity_type !== undefined) {
      const entityType = mapEntitySegmentToType(query.entity_type);

      filteredRows = rows.filter((row) => row.entityType === entityType);
    }

    const sortedRows = [...filteredRows].sort((left, right) => left.name.localeCompare(right.name));
    const start = (page - 1) * perPage;

    return sortedRows.slice(start, start + perPage).map(buildEntityListRow);
  });

  app.get('/:entity/public_treasury/:coin_id', async (request) => {
    const params = z.object({
      entity: z.enum(['companies', 'governments']),
      coin_id: z.string(),
    }).parse(request.params);
    const query = treasuryByCoinQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const coin = getCoinOrThrow(database, params.coin_id);

    const snapshot = database.db
      .select()
      .from(marketSnapshots)
      .where(and(eq(marketSnapshots.coinId, params.coin_id), eq(marketSnapshots.vsCurrency, 'usd')))
      .limit(1)
      .get();
    const rows = database.db
      .select({
        entity: treasuryEntities,
        holding: treasuryHoldings,
      })
      .from(treasuryHoldings)
      .innerJoin(treasuryEntities, eq(treasuryEntities.id, treasuryHoldings.entityId))
      .where(and(eq(treasuryHoldings.coinId, params.coin_id), eq(treasuryEntities.entityType, mapEntitySegmentToType(params.entity))))
      .all()
      .map((row) => ({
        entityId: row.entity.id,
        name: row.entity.name,
        symbol: row.entity.symbol,
        country: row.entity.country,
        amount: row.holding.amount,
        currentValueUsd: snapshot ? row.holding.amount * snapshot.price : null,
        entryValueUsd: row.holding.entryValueUsd,
        reportedAt: row.holding.reportedAt,
        sourceUrl: row.holding.sourceUrl,
      }));
    const sortedRows = sortTreasuryRows(rows, query.order);
    const start = (page - 1) * perPage;
    const pagedRows = sortedRows.slice(start, start + perPage);
    const totalHoldings = rows.reduce((sum, row) => sum + row.amount, 0);
    const totalValueUsd = rows.reduce((sum, row) => sum + (row.currentValueUsd ?? 0), 0);

    return {
      coin_id: coin.id,
      current_price_usd: snapshot?.price ?? null,
      total_holdings: totalHoldings,
      total_value_usd: totalValueUsd,
      market_cap_percentage: snapshot?.marketCap ? Number(((totalValueUsd / snapshot.marketCap) * 100).toFixed(4)) : null,
      [params.entity]: pagedRows.map((row) => ({
        entity_id: row.entityId,
        name: row.name,
        symbol: row.symbol,
        country: row.country,
        total_holdings: row.amount,
        current_value_usd: row.currentValueUsd,
        entry_value_usd: row.entryValueUsd,
        reported_at: row.reportedAt.toISOString(),
        source_url: row.sourceUrl,
      })),
    };
  });

  app.get('/public_treasury/:entity_id', async (request) => {
    const params = z.object({ entity_id: z.string() }).parse(request.params);
    const entity = getTreasuryEntityOrThrow(database, params.entity_id);

    const holdings = database.db
      .select({
        holding: treasuryHoldings,
        coin: coins,
        snapshot: marketSnapshots,
      })
      .from(treasuryHoldings)
      .innerJoin(coins, eq(coins.id, treasuryHoldings.coinId))
      .leftJoin(
        marketSnapshots,
        and(eq(marketSnapshots.coinId, treasuryHoldings.coinId), eq(marketSnapshots.vsCurrency, 'usd')),
      )
      .where(eq(treasuryHoldings.entityId, params.entity_id))
      .all()
      .map((row) => ({
        coin_id: row.coin.id,
        symbol: row.coin.symbol,
        name: row.coin.name,
        current_price_usd: row.snapshot?.price ?? null,
        amount: row.holding.amount,
        average_entry_value_usd: row.holding.entryValueUsd && row.holding.amount > 0
          ? row.holding.entryValueUsd / row.holding.amount
          : null,
        entry_value_usd: row.holding.entryValueUsd,
        current_value_usd: row.snapshot ? row.holding.amount * row.snapshot.price : null,
        unrealized_pnl_usd: row.snapshot && row.holding.entryValueUsd !== null
          ? row.holding.amount * row.snapshot.price - row.holding.entryValueUsd
          : null,
        reported_at: row.holding.reportedAt.toISOString(),
        source_url: row.holding.sourceUrl,
      }));
    const totalEntryValueUsd = holdings.reduce((sum, holding) => sum + (holding.entry_value_usd ?? 0), 0);
    const totalCurrentValueUsd = holdings.reduce((sum, holding) => sum + (holding.current_value_usd ?? 0), 0);

    return {
      id: entity.id,
      name: entity.name,
      symbol: entity.symbol,
      entity_type: entity.entityType,
      country: entity.country,
      description: entity.description,
      website_url: entity.websiteUrl,
      total_entry_value_usd: totalEntryValueUsd,
      total_current_value_usd: totalCurrentValueUsd,
      total_unrealized_pnl_usd: totalCurrentValueUsd - totalEntryValueUsd,
      holdings,
    };
  });

  app.get('/public_treasury/:entity_id/:coin_id/holding_chart', async (request) => {
    const params = z.object({
      entity_id: z.string(),
      coin_id: z.string(),
    }).parse(request.params);
    const query = treasuryHoldingChartQuerySchema.parse(request.query);
    const days = parseTreasuryChartDays(query.days);
    const includeEmptyIntervals = parseBooleanQuery(query.include_empty_intervals, false);

    getTreasuryEntityOrThrow(database, params.entity_id);
    getCoinOrThrow(database, params.coin_id);

    const rows = database.db
      .select()
      .from(treasuryTransactions)
      .where(and(eq(treasuryTransactions.entityId, params.entity_id), eq(treasuryTransactions.coinId, params.coin_id)))
      .orderBy(asc(treasuryTransactions.happenedAt))
      .all();
    const prices = database.db
      .select()
      .from(chartPoints)
      .where(and(eq(chartPoints.coinId, params.coin_id), eq(chartPoints.vsCurrency, 'usd')))
      .orderBy(asc(chartPoints.timestamp))
      .all();

    if (rows.length === 0 || prices.length === 0) {
      return {
        holdings: [],
        holding_value_in_usd: [],
      };
    }

    const latestTimestamp = prices[prices.length - 1]?.timestamp.getTime() ?? 0;
    const cutoffTimestamp = days === 'max'
      ? Number.MIN_SAFE_INTEGER
      : latestTimestamp - (Number(days) - 1) * 24 * 60 * 60 * 1000;
    const filteredPrices = prices.filter((row) => row.timestamp.getTime() >= cutoffTimestamp);
    const chartRows = includeEmptyIntervals
      ? filteredPrices
          .map((row) => {
            const holdingBalance = findLatestBalanceAtOrBefore(rows, row.timestamp.getTime());

            if (holdingBalance === undefined) {
              return null;
            }

            return {
              timestamp: row.timestamp.getTime(),
              holdingBalance,
              holdingValueUsd: holdingBalance * row.price,
            };
          })
          .filter((row): row is { timestamp: number; holdingBalance: number; holdingValueUsd: number } => row !== null)
      : rows
          .filter((row) => row.happenedAt.getTime() >= cutoffTimestamp)
          .map((row) => {
            const priceRow = filteredPrices.find((price) => price.timestamp.getTime() === row.happenedAt.getTime());

            if (!priceRow) {
              return null;
            }

            return {
              timestamp: row.happenedAt.getTime(),
              holdingBalance: row.holdingBalance,
              holdingValueUsd: row.holdingBalance * priceRow.price,
            };
          })
          .filter((row): row is { timestamp: number; holdingBalance: number; holdingValueUsd: number } => row !== null);

    return {
      holdings: chartRows.map((row) => [row.timestamp, row.holdingBalance]),
      holding_value_in_usd: chartRows.map((row) => [row.timestamp, row.holdingValueUsd]),
    };
  });

  app.get('/public_treasury/:entity_id/transaction_history', async (request) => {
    const params = z.object({ entity_id: z.string() }).parse(request.params);
    const query = treasuryTransactionHistoryQuerySchema.parse(request.query);
    const page = parsePositiveInt(query.page, 1);
    const perPage = Math.min(parsePositiveInt(query.per_page, 100), 250);
    const coinIds = parseCsvQuery(query.coin_ids);

    getTreasuryEntityOrThrow(database, params.entity_id);

    const rows = database.db
      .select()
      .from(treasuryTransactions)
      .where(eq(treasuryTransactions.entityId, params.entity_id))
      .all();
    const filteredRows = coinIds.length === 0
      ? rows
      : rows.filter((row) => coinIds.includes(row.coinId));
    const sortedRows = sortTreasuryTransactions(filteredRows, query.order);
    const start = (page - 1) * perPage;

    return {
      transactions: sortedRows.slice(start, start + perPage).map((row) => ({
        date: row.happenedAt.getTime(),
        source_url: row.sourceUrl,
        coin_id: row.coinId,
        type: row.type,
        holding_net_change: row.holdingNetChange,
        transaction_value_usd: row.transactionValueUsd,
        holding_balance: row.holdingBalance,
        average_entry_value_usd: row.averageEntryValueUsd,
      })),
    };
  });
}
