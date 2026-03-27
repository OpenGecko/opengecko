const PLATFORM_ID_BY_CHAIN_IDENTIFIER = new Map<number, string>([
  [1, 'ethereum'],
  [56, 'binance-smart-chain'],
  [101, 'solana'],
]);

const PLATFORM_ID_BY_ALIAS = new Map<string, string>([
  ['eth', 'ethereum'],
  ['ethereum', 'ethereum'],
  ['erc20', 'ethereum'],
  ['sol', 'solana'],
  ['solana', 'solana'],
  ['bsc', 'binance-smart-chain'],
  ['bnbsmartchain', 'binance-smart-chain'],
  ['binancesmartchain', 'binance-smart-chain'],
  ['binance-smart-chain', 'binance-smart-chain'],
  ['bep20', 'binance-smart-chain'],
  ['btc', 'bitcoin'],
  ['bitcoin', 'bitcoin'],
  ['trx', 'tron'],
  ['tron', 'tron'],
  ['trc20', 'tron'],
]);

const PLATFORM_SHORTNAME_BY_ID: Record<string, string> = {
  ethereum: 'eth',
  'binance-smart-chain': 'bsc',
  solana: 'sol',
  bitcoin: 'btc',
  tron: 'trx',
};

const PLATFORM_NAME_BY_ID: Record<string, string> = {
  ethereum: 'Ethereum',
  'binance-smart-chain': 'BNB Smart Chain',
  solana: 'Solana',
  bitcoin: 'Bitcoin',
  tron: 'Tron',
};

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

export function resolveCanonicalPlatformId(
  platformId: string,
  options?: {
    networkName?: string;
    chainIdentifier?: number | null;
  },
) {
  if (typeof options?.chainIdentifier === 'number') {
    const chainMatch = PLATFORM_ID_BY_CHAIN_IDENTIFIER.get(options.chainIdentifier);
    if (chainMatch) {
      return chainMatch;
    }
  }

  const directMatch = PLATFORM_ID_BY_ALIAS.get(normalizePlatformToken(platformId));
  if (directMatch) {
    return directMatch;
  }

  if (options?.networkName) {
    const nameMatch = PLATFORM_ID_BY_ALIAS.get(normalizePlatformToken(options.networkName));
    if (nameMatch) {
      return nameMatch;
    }
  }

  return normalizePlatformId(platformId);
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
