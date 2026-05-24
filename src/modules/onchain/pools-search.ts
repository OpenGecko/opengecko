import type { AppDatabase } from '../../db/client';
import { onchainDexes, onchainNetworks, onchainPools } from '../../db/schema';
import { HttpError } from '../../http/errors';
import { parseCsvQuery } from '../../http/params';
import { type MegafilterSort } from './helpers';

export function scorePoolSearchMatch(row: typeof onchainPools.$inferSelect, rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return 0;
  }

  const normalizedQuery = query.replace(/\s+/g, ' ').trim();
  const name = row.name.toLowerCase();
  const normalizedName = name.replace(/\s+/g, ' ').trim();
  const address = row.address.toLowerCase();
  const symbolHaystacks = [row.baseTokenSymbol, row.quoteTokenSymbol].map((value) => value.toLowerCase());

  if (address === query) {
    return 10_000;
  }

  if (normalizedName === normalizedQuery) {
    return 9_000;
  }

  if (symbolHaystacks.some((symbol) => symbol === query)) {
    return 8_000;
  }

  const queryTokens = normalizedQuery
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const nameTokens = normalizedName
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (queryTokens.length > 0 && queryTokens.every((token) => nameTokens.includes(token) || symbolHaystacks.includes(token))) {
    return 7_000;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 5_000;
  }

  if (symbolHaystacks.some((symbol) => symbol.startsWith(query))) {
    return 4_500;
  }

  if (address.includes(query)) {
    return 4_000;
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 3_500;
  }

  if (symbolHaystacks.some((symbol) => symbol.includes(query))) {
    return 3_000;
  }

  return 0;
}

export function searchPoolRows(
  rows: typeof onchainPools.$inferSelect[],
  rawQuery: string,
) {
  return rows
    .map((row) => ({ row, score: scorePoolSearchMatch(row, rawQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || (right.row.volume24hUsd ?? 0) - (left.row.volume24hUsd ?? 0)
      || (right.row.reserveUsd ?? 0) - (left.row.reserveUsd ?? 0)
      || left.row.address.localeCompare(right.row.address))
    .map(({ row }) => row);
}

export function buildMegafilterRow(row: typeof onchainPools.$inferSelect) {
  const txCount = row.transactions24hBuys + row.transactions24hSells;

  return {
    id: row.address,
    type: 'pool',
    attributes: {
      name: row.name,
      address: row.address,
      reserve_in_usd: row.reserveUsd ?? 0,
      volume_usd_h24: row.volume24hUsd ?? 0,
      tx_count_h24: txCount,
      price_usd: row.priceUsd,
      pool_created_at: row.createdAtTimestamp ? Math.floor(row.createdAtTimestamp.getTime() / 1000) : null,
      base_token_address: row.baseTokenAddress,
      base_token_symbol: row.baseTokenSymbol,
      quote_token_address: row.quoteTokenAddress,
      quote_token_symbol: row.quoteTokenSymbol,
    },
    relationships: {
      network: {
        data: {
          type: 'network',
          id: row.networkId,
        },
      },
      dex: {
        data: {
          type: 'dex',
          id: row.dexId,
        },
      },
    },
  };
}

export function sortMegafilterRows(rows: typeof onchainPools.$inferSelect[], sort: MegafilterSort) {
  const descending = sort.endsWith('_desc');

  const metric = (row: typeof onchainPools.$inferSelect) => {
    switch (sort) {
      case 'reserve_in_usd_desc':
      case 'reserve_in_usd_asc':
        return row.reserveUsd ?? 0;
      case 'volume_usd_h24_desc':
      case 'volume_usd_h24_asc':
        return row.volume24hUsd ?? 0;
      case 'tx_count_h24_desc':
      case 'tx_count_h24_asc':
        return row.transactions24hBuys + row.transactions24hSells;
    }
  };

  return [...rows].sort((left, right) => {
    const primary = descending ? metric(right) - metric(left) : metric(left) - metric(right);
    if (primary !== 0) {
      return primary;
    }

    const reserveTie = (right.reserveUsd ?? 0) - (left.reserveUsd ?? 0);
    if (reserveTie !== 0) {
      return reserveTie;
    }

    return left.address.localeCompare(right.address);
  });
}

export function parseMegafilterNetworks(value: string | undefined, database: AppDatabase) {
  const networks = parseCsvQuery(value);
  if (networks.length === 0) {
    return [];
  }

  const knownNetworks = new Set(database.db.select().from(onchainNetworks).all().map((row) => row.id));
  for (const network of networks) {
    if (!knownNetworks.has(network)) {
      throw new HttpError(400, 'invalid_parameter', `Unknown onchain network: ${network}`);
    }
  }

  return networks;
}

export function parseMegafilterDexes(value: string | undefined, database: AppDatabase) {
  const dexes = parseCsvQuery(value);
  if (dexes.length === 0) {
    return [];
  }

  const knownDexes = new Set(database.db.select().from(onchainDexes).all().map((row) => row.id));
  for (const dex of dexes) {
    if (!knownDexes.has(dex)) {
      throw new HttpError(400, 'invalid_parameter', `Unknown onchain dex: ${dex}`);
    }
  }

  return dexes;
}

export function parseTrendingSearchCandidates(
  pools: string | undefined,
  rows: typeof onchainPools.$inferSelect[],
) {
  if (pools === undefined) {
    return {
      rows,
      candidateCount: rows.length,
      ignoredCandidates: [] as string[],
    };
  }

  const availableByAddress = new Map(rows.map((row) => [row.address.toLowerCase(), row]));
  const seen = new Set<string>();
  const resolved: typeof rows = [];
  const ignoredCandidates: string[] = [];

  for (const rawCandidate of pools.split(',').map((value) => value.trim()).filter((value) => value.length > 0)) {
    const normalizedCandidate = rawCandidate.toLowerCase();
    const candidate = availableByAddress.get(normalizedCandidate);

    if (!candidate || seen.has(normalizedCandidate)) {
      ignoredCandidates.push(rawCandidate);
      continue;
    }

    seen.add(normalizedCandidate);
    resolved.push(candidate);
  }

  return {
    rows: resolved,
    candidateCount: resolved.length,
    ignoredCandidates,
  };
}
