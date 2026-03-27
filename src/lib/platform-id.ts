const PLATFORM_DEFINITIONS = [
  { id: 'ethereum', chainIdentifiers: [1], aliases: ['eth', 'ethereum', 'erc20'], shortname: 'eth', name: 'Ethereum' },
  { id: 'binance-smart-chain', chainIdentifiers: [56], aliases: ['bsc', 'bnbsmartchain', 'binancesmartchain', 'binance-smart-chain', 'bep20'], shortname: 'bsc', name: 'BNB Smart Chain' },
  { id: 'solana', chainIdentifiers: [101], aliases: ['sol', 'solana'], shortname: 'sol', name: 'Solana' },
  { id: 'bitcoin', chainIdentifiers: [], aliases: ['btc', 'bitcoin'], shortname: 'btc', name: 'Bitcoin' },
  { id: 'tron', chainIdentifiers: [728126428], aliases: ['trx', 'tron', 'trc20'], shortname: 'trx', name: 'Tron' },
  { id: 'polygon-pos', chainIdentifiers: [137], aliases: ['polygon', 'polygonpos', 'matic', 'maticnetwork', 'polygon-pos', 'erc20polygon'], shortname: 'matic', name: 'Polygon POS' },
  { id: 'arbitrum-one', chainIdentifiers: [42161], aliases: ['arbitrum', 'arbitrumone', 'arb', 'arbitrum-one'], shortname: 'arb', name: 'Arbitrum One' },
  { id: 'optimistic-ethereum', chainIdentifiers: [10], aliases: ['optimism', 'optimisticethereum', 'optimistic-ethereum', 'op'], shortname: 'op', name: 'Optimism' },
  { id: 'base', chainIdentifiers: [8453], aliases: ['base'], shortname: 'base', name: 'Base' },
  { id: 'avalanche', chainIdentifiers: [43114], aliases: ['avax', 'avalanchecchain', 'avalanchecchain', 'avalanche', 'cchain'], shortname: 'avax', name: 'Avalanche' },
  { id: 'fantom', chainIdentifiers: [250], aliases: ['fantom', 'ftm'], shortname: 'ftm', name: 'Fantom' },
  { id: 'gnosis', chainIdentifiers: [100], aliases: ['gnosis', 'xdai'], shortname: 'gno', name: 'Gnosis' },
  { id: 'celo', chainIdentifiers: [42220], aliases: ['celo'], shortname: 'celo', name: 'Celo' },
  { id: 'moonbeam', chainIdentifiers: [1284], aliases: ['moonbeam', 'glmr'], shortname: 'glmr', name: 'Moonbeam' },
  { id: 'moonriver', chainIdentifiers: [1285], aliases: ['moonriver', 'movr'], shortname: 'movr', name: 'Moonriver' },
  { id: 'cronos', chainIdentifiers: [25], aliases: ['cronos', 'cro'], shortname: 'cro', name: 'Cronos' },
  { id: 'kava', chainIdentifiers: [2222], aliases: ['kava'], shortname: 'kava', name: 'Kava' },
  { id: 'linea', chainIdentifiers: [59144], aliases: ['linea'], shortname: 'linea', name: 'Linea' },
  { id: 'scroll', chainIdentifiers: [534352], aliases: ['scroll'], shortname: 'scroll', name: 'Scroll' },
  { id: 'zksync', chainIdentifiers: [324], aliases: ['zksync', 'zksyncera', 'zk'], shortname: 'zksync', name: 'zkSync Era' },
  { id: 'mantle', chainIdentifiers: [5000], aliases: ['mantle'], shortname: 'mnt', name: 'Mantle' },
  { id: 'opbnb', chainIdentifiers: [204], aliases: ['opbnb'], shortname: 'opbnb', name: 'opBNB' },
  { id: 'sui', chainIdentifiers: [], aliases: ['sui'], shortname: 'sui', name: 'Sui' },
  { id: 'aptos', chainIdentifiers: [], aliases: ['aptos'], shortname: 'apt', name: 'Aptos' },
  { id: 'near-protocol', chainIdentifiers: [], aliases: ['near', 'nearprotocol', 'near-protocol'], shortname: 'near', name: 'Near Protocol' },
  { id: 'algorand', chainIdentifiers: [], aliases: ['algorand', 'algo'], shortname: 'algo', name: 'Algorand' },
  { id: 'stellar', chainIdentifiers: [], aliases: ['stellar', 'xlm'], shortname: 'xlm', name: 'Stellar' },
  { id: 'cosmos', chainIdentifiers: [], aliases: ['cosmos', 'atom'], shortname: 'atom', name: 'Cosmos' },
  { id: 'osmosis', chainIdentifiers: [], aliases: ['osmosis', 'osmo'], shortname: 'osmo', name: 'Osmosis' },
  { id: 'injective', chainIdentifiers: [], aliases: ['injective', 'inj'], shortname: 'inj', name: 'Injective' },
] as const;

const PLATFORM_ID_BY_CHAIN_IDENTIFIER = new Map<number, string>(
  PLATFORM_DEFINITIONS.flatMap((definition) => definition.chainIdentifiers.map((chainIdentifier) => [chainIdentifier, definition.id] as const)),
);

export const PLATFORM_ID_BY_ALIAS = new Map<string, string>(
  PLATFORM_DEFINITIONS.flatMap((definition) => definition.aliases.map((alias) => [normalizePlatformToken(alias), definition.id] as const)),
);

const PLATFORM_SHORTNAME_BY_ID: Record<string, string> = Object.fromEntries(
  PLATFORM_DEFINITIONS.map((definition) => [definition.id, definition.shortname]),
);

const PLATFORM_NAME_BY_ID: Record<string, string> = Object.fromEntries(
  PLATFORM_DEFINITIONS.map((definition) => [definition.id, definition.name]),
);

function normalizePlatformToken(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function normalizePlatformId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleizePlatformId(platformId: string) {
  return platformId
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

export type PlatformResolutionConfidence = 'exact' | 'heuristic' | 'unresolved';

export function resolveCanonicalPlatformId(
  platformId: string,
  options?: {
    networkName?: string;
    chainIdentifier?: number | null;
  },
) {
  return resolveCanonicalPlatform(platformId, options).canonicalPlatformId;
}

export function resolveCanonicalPlatform(
  platformId: string,
  options?: {
    networkName?: string;
    chainIdentifier?: number | null;
  },
): { canonicalPlatformId: string; confidence: PlatformResolutionConfidence } {
  if (typeof options?.chainIdentifier === 'number') {
    const chainMatch = PLATFORM_ID_BY_CHAIN_IDENTIFIER.get(options.chainIdentifier);
    if (chainMatch) {
      return { canonicalPlatformId: chainMatch, confidence: 'exact' };
    }
  }

  const directMatch = PLATFORM_ID_BY_ALIAS.get(normalizePlatformToken(platformId));
  if (directMatch) {
    return { canonicalPlatformId: directMatch, confidence: 'exact' };
  }

  if (options?.networkName) {
    const nameMatch = PLATFORM_ID_BY_ALIAS.get(normalizePlatformToken(options.networkName));
    if (nameMatch) {
      return { canonicalPlatformId: nameMatch, confidence: 'exact' };
    }

    const normalizedNetworkName = normalizePlatformId(options.networkName);
    if (normalizedNetworkName.length > 0) {
      return { canonicalPlatformId: normalizedNetworkName, confidence: 'heuristic' };
    }
  }

  const normalizedPlatformId = normalizePlatformId(platformId);
  return {
    canonicalPlatformId: normalizedPlatformId,
    confidence: normalizedPlatformId.length > 0 ? 'heuristic' : 'unresolved',
  };
}

export function getCanonicalPlatformShortname(platformId: string) {
  return PLATFORM_SHORTNAME_BY_ID[platformId] ?? (normalizePlatformToken(platformId).slice(0, 12) || 'chain');
}

export function getCanonicalPlatformName(platformId: string, fallbackName?: string) {
  return PLATFORM_NAME_BY_ID[platformId] ?? (fallbackName?.trim() || titleizePlatformId(platformId));
}

export function getPlatformLookupIds(platformId: string) {
  const canonicalPlatformId = resolveCanonicalPlatformId(platformId);

  return [...new Set([
    normalizePlatformId(platformId),
    canonicalPlatformId,
    getCanonicalPlatformShortname(canonicalPlatformId),
  ])].filter((value) => value.length > 0);
}
