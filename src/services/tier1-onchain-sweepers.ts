import { and, desc, eq, inArray, or } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { onchainDexes, onchainNetworks, onchainPools } from '../db/schema';
import {
  type DefillamaPoolData,
  type DefillamaTokenPrices,
  fetchDefillamaPoolData,
  fetchDefillamaTokenPrices,
} from '../providers/defillama';
import { type SqdEthereumSwapLog, fetchEthereumPoolSwapLogs } from '../providers/sqd';
import { generateDeterministicAddress, normalizeAddress, slugifyOnchainId, toDexName } from '../modules/onchain/helpers';
import { deriveLivePoolTrades } from '../modules/onchain/trades';
import { ingestOnchainTradeReplay, type RawOnchainTradeReplay } from './onchain-trade-ingestion';
import {
  finishProviderAttempt,
  getProviderFaultControl,
  startProviderAttempt,
  type MarketDataRuntimeState,
  type ProviderAttemptOutcome,
} from './market-runtime-state';
import type { MetricsRegistry, ProviderStabilityOutcome } from './metrics';
import { enforceSnapshotRetention } from './snapshot-retention';
import {
  canAttemptProvider,
  classifyProviderFailure,
  createProviderBreakerState,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-breaker';

type SweepTarget = {
  id: string;
};

type SweepFailure = {
  target: string;
  reason: string;
};

type SweepResult = {
  targetsProcessed: number;
  rowsWritten: number;
  rowsPruned?: number;
  partialFailures: SweepFailure[];
};

type DefillamaPoolFetcher = () => Promise<DefillamaPoolData | null>;
type DefillamaTokenPriceFetcher = (coins: string[]) => Promise<DefillamaTokenPrices | null>;
type SqdSwapFetcher = (poolAddress: string) => Promise<SqdEthereumSwapLog[] | null>;

type ProviderStabilityControls = {
  runtimeState?: MarketDataRuntimeState;
  metrics?: Pick<MetricsRegistry,
    | 'recordProviderAttemptStart'
    | 'recordProviderAttemptEnd'
    | 'recordProviderBlockedByBreaker'
    | 'recordProviderPartialFailure'
    | 'recordProviderRecovery'
  >;
};

type DefillamaPoolSweepOptions = ProviderStabilityControls & {
  targets?: SweepTarget[];
  now?: Date;
  fetchPoolData?: DefillamaPoolFetcher;
};

type DefillamaTokenSweepOptions = ProviderStabilityControls & {
  targets?: SweepTarget[];
  now?: Date;
  fetchTokenPrices?: DefillamaTokenPriceFetcher;
};

type SubsquidTradeSweepOptions = {
  targets?: SweepTarget[];
  now?: Date;
  fetchSwaps?: SqdSwapFetcher;
};

const DEFILLAMA_NETWORK_CONFIG = {
  Ethereum: {
    networkId: 'eth',
    name: 'Ethereum',
    chainIdentifier: 1,
    coingeckoAssetPlatformId: 'ethereum',
    nativeCurrencyCoinId: 'ethereum',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/279/small/ethereum.png',
  },
  Arbitrum: {
    networkId: 'arbitrum',
    name: 'Arbitrum',
    chainIdentifier: 42161,
    coingeckoAssetPlatformId: 'arbitrum-one',
    nativeCurrencyCoinId: 'ethereum',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/6450/small/arbitrum.png',
  },
  Base: {
    networkId: 'base',
    name: 'Base',
    chainIdentifier: 8453,
    coingeckoAssetPlatformId: 'base',
    nativeCurrencyCoinId: 'ethereum',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/131/small/base-network.png',
  },
  Polygon: {
    networkId: 'polygon',
    name: 'Polygon',
    chainIdentifier: 137,
    coingeckoAssetPlatformId: 'polygon-pos',
    nativeCurrencyCoinId: 'matic-network',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/385/small/polygon.png',
  },
  BSC: {
    networkId: 'bsc',
    name: 'BNB Smart Chain',
    chainIdentifier: 56,
    coingeckoAssetPlatformId: 'binance-smart-chain',
    nativeCurrencyCoinId: 'binancecoin',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/125/small/bnb-chain.png',
  },
  Solana: {
    networkId: 'solana',
    name: 'Solana',
    chainIdentifier: 101,
    coingeckoAssetPlatformId: 'solana',
    nativeCurrencyCoinId: 'solana',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/4128/small/solana.png',
  },
  Avalanche: {
    networkId: 'avalanche',
    name: 'Avalanche',
    chainIdentifier: 43114,
    coingeckoAssetPlatformId: 'avalanche',
    nativeCurrencyCoinId: 'avalanche-2',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/127/small/avalanche.png',
  },
  Fantom: {
    networkId: 'fantom',
    name: 'Fantom',
    chainIdentifier: 250,
    coingeckoAssetPlatformId: 'fantom',
    nativeCurrencyCoinId: 'fantom',
    imageUrl: 'https://assets.coingecko.com/asset_platforms/images/87/small/fantom.png',
  },
} as const;

const DEFILLAMA_DEX_OVERRIDES: Record<string, { id: string; name: string; url: string; imageUrl: string | null }> = {
  'uniswap-v3': {
    id: 'uniswap_v3',
    name: 'Uniswap V3',
    url: 'https://app.uniswap.org',
    imageUrl: 'https://assets.coingecko.com/markets/images/665/small/uniswap.png',
  },
  curve: {
    id: 'curve',
    name: 'Curve',
    url: 'https://curve.fi',
    imageUrl: 'https://assets.coingecko.com/markets/images/538/small/curve.png',
  },
  raydium: {
    id: 'raydium',
    name: 'Raydium',
    url: 'https://raydium.io',
    imageUrl: 'https://assets.coingecko.com/markets/images/609/small/Raydium.png',
  },
  pancakeswap: {
    id: 'pancakeswap',
    name: 'PancakeSwap',
    url: 'https://pancakeswap.finance',
    imageUrl: null,
  },
  aerodrome: {
    id: 'aerodrome',
    name: 'Aerodrome',
    url: 'https://aerodrome.finance',
    imageUrl: null,
  },
  sushiswap: {
    id: 'sushiswap',
    name: 'Sushi',
    url: 'https://www.sushi.com',
    imageUrl: null,
  },
};

const DEFILLAMA_PROVIDER_ID = 'defillama';
const DEFILLAMA_PROVIDER_FAMILY = 'onchain';

function sanitizeFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

function toProviderAttemptOutcome(error: unknown): ProviderAttemptOutcome {
  if (error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message))) {
    return 'canceled';
  }

  const classified = classifyProviderFailure(error);
  if (classified.kind === 'timeout') {
    return 'timed_out';
  }
  if (classified.kind === 'regional_block' || classified.kind === 'unavailable_market') {
    return 'blocked_unavailable';
  }

  return 'failed';
}

function toMetricProviderOutcome(outcome: ProviderAttemptOutcome): ProviderStabilityOutcome {
  return outcome;
}

function buildDefillamaFaultError(state: MarketDataRuntimeState | undefined) {
  const faultControl = getProviderFaultControl(state, DEFILLAMA_PROVIDER_ID, DEFILLAMA_PROVIDER_FAMILY);
  if (!faultControl || faultControl.mode === 'off') {
    return null;
  }

  if (faultControl.mode === 'canceled') {
    const error = new Error(faultControl.reason ?? 'DeFiLlama provider request canceled by validator fault control');
    error.name = 'AbortError';
    return error;
  }
  if (faultControl.mode === 'timeout') {
    const error = new Error(faultControl.reason ?? 'DeFiLlama provider request timed out by validator fault control');
    error.name = 'DefillamaProviderTimeoutError';
    return error;
  }
  if (faultControl.mode === 'blocked_unavailable') {
    return new Error(faultControl.reason ?? '403 Forbidden DeFiLlama provider unavailable by validator fault control');
  }

  return new Error(faultControl.reason ?? 'validator controlled DeFiLlama provider failure');
}

async function runDefillamaProviderAttempt<T>(
  options: ProviderStabilityControls & { now: Date },
  operation: () => Promise<T>,
): Promise<{ status: 'success'; value: T } | { status: 'skipped'; result: SweepResult }> {
  if (!options.runtimeState && !options.metrics) {
    return { status: 'success', value: await operation() };
  }

  const nowMs = options.now.getTime();
  const providerBreakers = options.runtimeState
    ? options.runtimeState.providerBreakers ?? (options.runtimeState.providerBreakers = createProviderBreakerState([DEFILLAMA_PROVIDER_ID]))
    : null;

  if (providerBreakers && !canAttemptProvider(providerBreakers, DEFILLAMA_PROVIDER_ID, nowMs)) {
    options.metrics?.recordProviderBlockedByBreaker(DEFILLAMA_PROVIDER_ID);
    options.metrics?.recordProviderAttemptEnd(DEFILLAMA_PROVIDER_ID, DEFILLAMA_PROVIDER_FAMILY, 'breaker_open', 0);
    if (options.runtimeState) {
      finishProviderAttempt(options.runtimeState, DEFILLAMA_PROVIDER_ID, DEFILLAMA_PROVIDER_FAMILY, 'breaker_open', 'provider breaker open', nowMs);
    }
    return {
      status: 'skipped',
      result: {
        targetsProcessed: 0,
        rowsWritten: 0,
        partialFailures: [{ target: DEFILLAMA_PROVIDER_ID, reason: 'provider breaker open' }],
      },
    };
  }

  const providerHadFailure = providerBreakers
    ? (providerBreakers.providers[DEFILLAMA_PROVIDER_ID]?.failureCount ?? 0) > 0
    : false;
  if (options.runtimeState) {
    startProviderAttempt(options.runtimeState, DEFILLAMA_PROVIDER_ID, DEFILLAMA_PROVIDER_FAMILY, nowMs);
  }
  options.metrics?.recordProviderAttemptStart(DEFILLAMA_PROVIDER_ID, DEFILLAMA_PROVIDER_FAMILY);
  const startedAt = nowMs;

  try {
    const faultError = buildDefillamaFaultError(options.runtimeState);
    if (faultError) {
      throw faultError;
    }

    const value = await operation();
    if (providerBreakers) {
      recordProviderSuccess(providerBreakers, DEFILLAMA_PROVIDER_ID, Date.now());
    }
    if (providerHadFailure) {
      options.metrics?.recordProviderRecovery(DEFILLAMA_PROVIDER_ID);
    }
    if (options.runtimeState) {
      finishProviderAttempt(options.runtimeState, DEFILLAMA_PROVIDER_ID, DEFILLAMA_PROVIDER_FAMILY, 'successful', null);
    }
    options.metrics?.recordProviderAttemptEnd(DEFILLAMA_PROVIDER_ID, DEFILLAMA_PROVIDER_FAMILY, 'successful', Date.now() - startedAt);
    return { status: 'success', value };
  } catch (error) {
    const classifiedFailure = classifyProviderFailure(error);
    const outcome = toProviderAttemptOutcome(error);
    if (providerBreakers) {
      recordProviderFailure(
        providerBreakers,
        DEFILLAMA_PROVIDER_ID,
        Date.now(),
        error instanceof Error ? error.message : String(error),
      );
    }
    options.metrics?.recordProviderPartialFailure(DEFILLAMA_PROVIDER_ID);
    if (options.runtimeState) {
      finishProviderAttempt(options.runtimeState, DEFILLAMA_PROVIDER_ID, DEFILLAMA_PROVIDER_FAMILY, outcome, classifiedFailure.reason);
    }
    options.metrics?.recordProviderAttemptEnd(
      DEFILLAMA_PROVIDER_ID,
      DEFILLAMA_PROVIDER_FAMILY,
      toMetricProviderOutcome(outcome),
      Date.now() - startedAt,
    );
    throw new Error(classifiedFailure.reason, { cause: error });
  }
}

function getDexConfig(projectSlug: string) {
  return DEFILLAMA_DEX_OVERRIDES[projectSlug] ?? {
    id: projectSlug,
    name: toDexName(projectSlug),
    url: `https://defillama.com/protocol/${projectSlug}`,
    imageUrl: null,
  };
}

function upsertNetworkAndDex(database: AppDatabase, chainName: string, projectSlug: string, now: Date) {
  const networkConfig = DEFILLAMA_NETWORK_CONFIG[chainName as keyof typeof DEFILLAMA_NETWORK_CONFIG];
  if (!networkConfig) {
    return null;
  }

  const dexConfig = getDexConfig(projectSlug);

  database.db.insert(onchainNetworks).values({
    id: networkConfig.networkId,
    name: networkConfig.name,
    chainIdentifier: networkConfig.chainIdentifier,
    coingeckoAssetPlatformId: networkConfig.coingeckoAssetPlatformId,
    nativeCurrencyCoinId: networkConfig.nativeCurrencyCoinId,
    imageUrl: networkConfig.imageUrl,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: onchainNetworks.id,
    set: {
      name: networkConfig.name,
      chainIdentifier: networkConfig.chainIdentifier,
      coingeckoAssetPlatformId: networkConfig.coingeckoAssetPlatformId,
      nativeCurrencyCoinId: networkConfig.nativeCurrencyCoinId,
      imageUrl: networkConfig.imageUrl,
      updatedAt: now,
    },
  }).run();

  database.db.insert(onchainDexes).values({
    id: dexConfig.id,
    networkId: networkConfig.networkId,
    name: dexConfig.name,
    url: dexConfig.url,
    imageUrl: dexConfig.imageUrl,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [onchainDexes.networkId, onchainDexes.id],
    set: {
      name: dexConfig.name,
      url: dexConfig.url,
      imageUrl: dexConfig.imageUrl,
      updatedAt: now,
    },
  }).run();

  return { networkConfig, dexConfig };
}

function tokenSymbolFromPoolSymbol(symbol: string | undefined, index: number, tokenAddress: string) {
  const parts = symbol?.split(/[-/]/).map((part) => part.trim()).filter((part) => part.length > 0) ?? [];
  return parts[index] ?? tokenAddress.slice(0, 8);
}

export async function runDefillamaPoolSweep(
  database: AppDatabase,
  options: DefillamaPoolSweepOptions = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const fetcher = options.fetchPoolData ?? fetchDefillamaPoolData;
  const providerAttempt = await runDefillamaProviderAttempt(
    { runtimeState: options.runtimeState, metrics: options.metrics, now },
    async () => {
      const poolData = await fetcher();
      if (!poolData) {
        throw new Error('DeFiLlama pool sweep failed: provider returned no pool data');
      }
      return poolData;
    },
  );
  if (providerAttempt.status === 'skipped') {
    return providerAttempt.result;
  }
  const poolData = providerAttempt.value;

  const maxTargets = Math.max(1, options.targets?.length ?? 225);
  const candidates = poolData.pools
    .filter((pool) =>
      typeof pool.tvlUsd === 'number'
      && pool.tvlUsd > 100_000
      && pool.chain
      && pool.project
      && Array.isArray(pool.underlyingTokens)
      && pool.underlyingTokens.length >= 2)
    .sort((left, right) => (right.tvlUsd ?? 0) - (left.tvlUsd ?? 0))
    .slice(0, maxTargets);
  const partialFailures: SweepFailure[] = [];
  let rowsWritten = 0;

  for (const pool of candidates) {
    const target = pool.pool ?? `${pool.chain}:${pool.project}:${pool.symbol ?? 'unknown'}`;
    try {
      const projectSlug = slugifyOnchainId(pool.project ?? '');
      if (!pool.chain || !projectSlug || !pool.underlyingTokens || pool.underlyingTokens.length < 2) {
        throw new Error('pool is missing chain, project, or token identifiers');
      }

      const configs = upsertNetworkAndDex(database, pool.chain, projectSlug, now);
      if (!configs) {
        throw new Error(`unsupported DeFiLlama chain: ${pool.chain}`);
      }

      const [baseToken, quoteToken] = pool.underlyingTokens;
      if (!baseToken || !quoteToken) {
        throw new Error('pool is missing token identifiers');
      }

      const poolIdentifier = pool.pool ?? `${pool.chain}-${pool.project}-${pool.symbol ?? ''}-${pool.underlyingTokens.join(',')}`;
      const poolAddress = normalizeAddress(generateDeterministicAddress(poolIdentifier));

      database.db.insert(onchainPools).values({
        networkId: configs.networkConfig.networkId,
        address: poolAddress,
        dexId: configs.dexConfig.id,
        name: pool.symbol ?? `${poolAddress.slice(0, 8)}...`,
        baseTokenAddress: normalizeAddress(baseToken),
        baseTokenSymbol: tokenSymbolFromPoolSymbol(pool.symbol, 0, baseToken),
        quoteTokenAddress: normalizeAddress(quoteToken),
        quoteTokenSymbol: tokenSymbolFromPoolSymbol(pool.symbol, 1, quoteToken),
        priceUsd: null,
        reserveUsd: pool.tvlUsd ?? null,
        volume24hUsd: pool.volumeUsd1d ?? null,
        transactions24hBuys: 0,
        transactions24hSells: 0,
        createdAtTimestamp: null,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [onchainPools.networkId, onchainPools.address],
        set: {
          dexId: configs.dexConfig.id,
          name: pool.symbol ?? `${poolAddress.slice(0, 8)}...`,
          baseTokenAddress: normalizeAddress(baseToken),
          baseTokenSymbol: tokenSymbolFromPoolSymbol(pool.symbol, 0, baseToken),
          quoteTokenAddress: normalizeAddress(quoteToken),
          quoteTokenSymbol: tokenSymbolFromPoolSymbol(pool.symbol, 1, quoteToken),
          reserveUsd: pool.tvlUsd ?? null,
          volume24hUsd: pool.volumeUsd1d ?? null,
          updatedAt: now,
        },
      }).run();
      rowsWritten += 1;
    } catch (error) {
      partialFailures.push({ target, reason: sanitizeFailureReason(error) });
    }
  }

  if (rowsWritten === 0 && partialFailures.length > 0) {
    throw new Error(`DeFiLlama pool sweep failed for all targets: ${partialFailures[0]!.reason}`);
  }

  return {
    targetsProcessed: candidates.length,
    rowsWritten,
    partialFailures,
  };
}

function readTokenSweepTargets(database: AppDatabase, limit: number) {
  const rows = database.db
    .select()
    .from(onchainPools)
    .where(eq(onchainPools.networkId, 'eth'))
    .orderBy(desc(onchainPools.reserveUsd), desc(onchainPools.volume24hUsd))
    .limit(Math.max(1, limit))
    .all();
  const tokens = new Map<string, { address: string; symbol: string }>();

  for (const row of rows) {
    for (const token of [
      { address: row.baseTokenAddress, symbol: row.baseTokenSymbol },
      { address: row.quoteTokenAddress, symbol: row.quoteTokenSymbol },
    ]) {
      const address = normalizeAddress(token.address);
      if (!tokens.has(address)) {
        tokens.set(address, {
          address,
          symbol: token.symbol,
        });
      }
    }
  }

  return [...tokens.values()];
}

export async function runDefillamaTokenSweep(
  database: AppDatabase,
  options: DefillamaTokenSweepOptions = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const fetcher = options.fetchTokenPrices ?? fetchDefillamaTokenPrices;
  const targets = readTokenSweepTargets(database, options.targets?.length ?? 225);
  const coinIds = targets.map((target) => `ethereum:${target.address}`);
  const providerAttempt = await runDefillamaProviderAttempt(
    { runtimeState: options.runtimeState, metrics: options.metrics, now },
    async () => {
      const prices = await fetcher(coinIds);
      if (!prices) {
        throw new Error('DeFiLlama token sweep failed: provider returned no token prices');
      }
      return prices;
    },
  );
  if (providerAttempt.status === 'skipped') {
    return providerAttempt.result;
  }
  const prices = providerAttempt.value;

  const partialFailures: SweepFailure[] = [];
  let rowsWritten = 0;

  for (const target of targets) {
    const key = `ethereum:${target.address}`;
    try {
      const price = prices[key]?.price;
      if (typeof price !== 'number' || !Number.isFinite(price)) {
        throw new Error('token price missing from provider response');
      }

      database.db.update(onchainPools)
        .set({
          priceUsd: Number(price.toFixed(6)),
          updatedAt: now,
        })
        .where(and(
          eq(onchainPools.networkId, 'eth'),
          eq(onchainPools.baseTokenAddress, target.address),
        ))
        .run();
      database.db.update(onchainPools)
        .set({
          updatedAt: now,
        })
        .where(and(
          eq(onchainPools.networkId, 'eth'),
          eq(onchainPools.quoteTokenAddress, target.address),
        ))
        .run();
      rowsWritten += 1;
    } catch (error) {
      partialFailures.push({ target: key, reason: sanitizeFailureReason(error) });
    }
  }

  if (rowsWritten === 0 && partialFailures.length > 0) {
    throw new Error(`DeFiLlama token sweep failed for all targets: ${partialFailures[0]!.reason}`);
  }

  return {
    targetsProcessed: targets.length,
    rowsWritten,
    partialFailures,
  };
}

function readTradeSweepTargets(database: AppDatabase, limit: number) {
  return database.db
    .select()
    .from(onchainPools)
    .where(and(
      eq(onchainPools.networkId, 'eth'),
      or(
        eq(onchainPools.dexId, 'uniswap_v3'),
        inArray(onchainPools.dexId, ['uniswap-v3', 'uniswap_v3']),
      ),
    ))
    .orderBy(desc(onchainPools.volume24hUsd), desc(onchainPools.reserveUsd))
    .limit(Math.max(1, limit))
    .all();
}

function toTradeReplay(
  pool: typeof onchainPools.$inferSelect,
  swaps: SqdEthereumSwapLog[],
  capturedAt: Date,
): RawOnchainTradeReplay | null {
  const liveTrades = deriveLivePoolTrades(pool, swaps.map((swap) => ({
    id: `${swap.txHash}:${swap.blockNumber}`,
    amount0: swap.amount0,
    amount1: swap.amount1,
    amountUSD: null,
    timestamp: swap.blockTimestamp,
    transaction: {
      id: swap.txHash,
      blockNumber: String(swap.blockNumber),
    },
  })));

  if (!liveTrades || liveTrades.length === 0) {
    return null;
  }

  return {
    provider: 'subsquid',
    captured_at: capturedAt.toISOString(),
    network_id: pool.networkId,
    pool_address: pool.address,
    trades: liveTrades.map((trade) => ({
      id: trade.id,
      token_address: trade.tokenAddress,
      side: trade.side,
      volume_usd: trade.volumeUsd,
      price_usd: trade.priceUsd,
      tx_hash: trade.txHash,
      block_timestamp: trade.blockTimestamp,
    })),
  };
}

export async function runSubsquidTradeSweep(
  database: AppDatabase,
  options: SubsquidTradeSweepOptions = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const fetcher = options.fetchSwaps ?? ((poolAddress: string) => fetchEthereumPoolSwapLogs(poolAddress, {
    toBlock: undefined,
    maxResults: 128,
  }));
  const targets = readTradeSweepTargets(database, Math.min(options.targets?.length ?? 25, 25));
  const partialFailures: SweepFailure[] = [];
  let rowsWritten = 0;

  for (const pool of targets) {
    try {
      const swaps = await fetcher(pool.address);
      if (!swaps || swaps.length === 0) {
        throw new Error('no Subsquid swaps returned for pool');
      }

      const replay = toTradeReplay(pool, swaps, now);
      if (!replay) {
        throw new Error('Subsquid swaps could not be normalized into endpoint trades');
      }

      const result = ingestOnchainTradeReplay(database, replay, {
        sourceKind: 'live',
        sourceProvider: 'subsquid',
        sourceFetchedAt: now,
      });
      rowsWritten += result.trades_written;
    } catch (error) {
      partialFailures.push({ target: `${pool.networkId}:${pool.address}`, reason: sanitizeFailureReason(error) });
    }
  }

  if (rowsWritten === 0 && partialFailures.length > 0) {
    throw new Error(`Subsquid trade sweep failed for all targets: ${partialFailures[0]!.reason}`);
  }

  const retention = rowsWritten > 0
    ? enforceSnapshotRetention(database, { now })
    : null;

  return {
    targetsProcessed: targets.length,
    rowsWritten,
    rowsPruned: retention?.totalRowsPruned ?? 0,
    partialFailures,
  };
}
