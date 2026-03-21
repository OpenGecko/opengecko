import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { coins, marketSnapshots, treasuryEntities, treasuryHoldings, type TreasuryEntityRow } from '../db/schema';
import { HttpError } from '../http/errors';
import { parsePositiveInt } from '../http/params';

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

function mapEntitySegmentToType(entity: 'companies' | 'governments') {
  return entity === 'companies' ? 'company' : 'government';
}

function sortNumber(value: number | null | undefined, fallback: number) {
  return value ?? fallback;
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
    const coin = database.db.select().from(coins).where(eq(coins.id, params.coin_id)).limit(1).get();

    if (!coin) {
      throw new HttpError(404, 'not_found', `Coin not found: ${params.coin_id}`);
    }

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
    const entity = database.db.select().from(treasuryEntities).where(eq(treasuryEntities.id, params.entity_id)).limit(1).get();

    if (!entity) {
      throw new HttpError(404, 'not_found', `Treasury entity not found: ${params.entity_id}`);
    }

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
        amount: row.holding.amount,
        entry_value_usd: row.holding.entryValueUsd,
        current_value_usd: row.snapshot ? row.holding.amount * row.snapshot.price : null,
        reported_at: row.holding.reportedAt.toISOString(),
        source_url: row.holding.sourceUrl,
      }));

    return {
      id: entity.id,
      name: entity.name,
      symbol: entity.symbol,
      entity_type: entity.entityType,
      country: entity.country,
      description: entity.description,
      website_url: entity.websiteUrl,
      holdings,
    };
  });
}
