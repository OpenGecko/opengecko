import type { CoinRow } from '../db/schema';

type ImageIdentitySource =
  | 'opengecko_assets_native'
  | 'opengecko_assets_token'
  | 'trustwallet_native'
  | 'trustwallet_token';

export type ResolvedCoinImageSet = {
  thumb: string;
  small: string;
  large: string;
  source: ImageIdentitySource;
};

type NativeAssetMapping = {
  openGeckoAssetsPlatformId: string;
};

type TrustedPlatformMapping = {
  openGeckoAssetsPlatformId: string;
  trustWalletAssetId: string;
  contractAddressPattern: RegExp;
  normalizeContractAddress: (value: string) => string | null;
};

const OPENGECKO_ASSETS_BASE_URL = process.env.ASSET_IMAGE_BASE_URL ?? 'http://localhost:3001/assets';

const CURATED_NATIVE_ASSET_MAPPINGS: Record<string, NativeAssetMapping> = {
  bitcoin: { openGeckoAssetsPlatformId: 'bitcoin' },
  ethereum: { openGeckoAssetsPlatformId: 'ethereum' },
  ripple: { openGeckoAssetsPlatformId: 'xrp' },
  solana: { openGeckoAssetsPlatformId: 'solana' },
  dogecoin: { openGeckoAssetsPlatformId: 'dogecoin' },
  cardano: { openGeckoAssetsPlatformId: 'cardano' },
};

const TRUSTED_PLATFORM_MAPPINGS: Record<string, TrustedPlatformMapping> = {
  ethereum: {
    openGeckoAssetsPlatformId: 'ethereum',
    trustWalletAssetId: 'ethereum',
    contractAddressPattern: /^0x[a-fA-F0-9]{40}$/,
    normalizeContractAddress: (value) => value.toLowerCase(),
  },
  tron: {
    openGeckoAssetsPlatformId: 'tron',
    trustWalletAssetId: 'tron',
    contractAddressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    normalizeContractAddress: (value) => value.trim(),
  },
  cosmos: {
    openGeckoAssetsPlatformId: 'cosmos',
    trustWalletAssetId: 'cosmos',
    contractAddressPattern: /^[a-z0-9][a-z0-9-]{1,127}$/,
    normalizeContractAddress: (value) => value.toLowerCase(),
  },
};

function buildOpenGeckoAssetsNativeImageSet(platformId: string): ResolvedCoinImageSet {
  const path = `${OPENGECKO_ASSETS_BASE_URL}/chains/${platformId}/logo.png`;
  return {
    thumb: path,
    small: path,
    large: path,
    source: 'opengecko_assets_native',
  };
}

function buildOpenGeckoAssetsTokenImageSet(platformId: string, contractAddress: string): ResolvedCoinImageSet {
  const normalizedContractAddress = TRUSTED_PLATFORM_MAPPINGS[platformId]!.normalizeContractAddress(contractAddress)!;
  const canonicalPlatformId = TRUSTED_PLATFORM_MAPPINGS[platformId]!.openGeckoAssetsPlatformId;
  const path = `${OPENGECKO_ASSETS_BASE_URL}/chains/${canonicalPlatformId}/assets/${normalizedContractAddress}/logo.png`;
  return {
    thumb: path,
    small: path,
    large: path,
    source: 'opengecko_assets_token',
  };
}

function parsePlatforms(platformsJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(platformsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function hasAnyImage(coin: Pick<CoinRow, 'imageThumbUrl' | 'imageSmallUrl' | 'imageLargeUrl'>) {
  return Boolean(coin.imageThumbUrl || coin.imageSmallUrl || coin.imageLargeUrl);
}

function resolveCuratedNativeAssetImage(coin: CoinRow): ResolvedCoinImageSet | null {
  const mapping = CURATED_NATIVE_ASSET_MAPPINGS[coin.id];

  if (!mapping) {
    return null;
  }

  return buildOpenGeckoAssetsNativeImageSet(mapping.openGeckoAssetsPlatformId);
}

function resolveAssetPlatformNativeImage(coin: CoinRow): ResolvedCoinImageSet | null {
  const knownNativePlatformByCoinId: Record<string, string> = {
    bitcoin: 'bitcoin',
    ethereum: 'ethereum',
    solana: 'solana',
  };

  const platformId = knownNativePlatformByCoinId[coin.id];
  if (!platformId) {
    return null;
  }

  return buildOpenGeckoAssetsNativeImageSet(platformId);
}

function resolveKnownNativeCoinImage(coin: CoinRow): ResolvedCoinImageSet | null {
  return resolveCuratedNativeAssetImage(coin) ?? resolveAssetPlatformNativeImage(coin);
}

function resolveTrustedPlatformContractImage(coin: CoinRow): ResolvedCoinImageSet | null {
  const platforms = parsePlatforms(coin.platformsJson);
  const entries = Object.entries(platforms)
    .map(([platformId, contractAddress]) => [platformId.toLowerCase(), contractAddress.trim()] as const)
    .filter(([, contractAddress]) => contractAddress.length > 0);

  if (entries.length !== 1) {
    return null;
  }

  const [platformId, contractAddress] = entries[0]!;
  const platformMapping = TRUSTED_PLATFORM_MAPPINGS[platformId];

  if (!platformMapping) {
    return null;
  }

  if (!platformMapping.contractAddressPattern.test(contractAddress)) {
    return null;
  }

  const normalizedContractAddress = platformMapping.normalizeContractAddress(contractAddress);

  if (!normalizedContractAddress) {
    return null;
  }

  return buildOpenGeckoAssetsTokenImageSet(platformId, normalizedContractAddress);
}

export function resolveCoinImageIdentity(coin: CoinRow): ResolvedCoinImageSet | null {
  if (hasAnyImage(coin)) {
    return null;
  }

  return resolveKnownNativeCoinImage(coin) ?? resolveTrustedPlatformContractImage(coin);
}

export function withResolvedCoinImages<T extends CoinRow>(coin: T): T {
  const resolved = resolveCoinImageIdentity(coin);

  if (!resolved) {
    return coin;
  }

  return {
    ...coin,
    imageThumbUrl: coin.imageThumbUrl ?? resolved.thumb,
    imageSmallUrl: coin.imageSmallUrl ?? resolved.small,
    imageLargeUrl: coin.imageLargeUrl ?? resolved.large,
  };
}
