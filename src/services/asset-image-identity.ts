import type { CoinRow } from '../db/schema';

type ImageIdentitySource =
  | 'trustwallet_native'
  | 'trustwallet_token';

export type ResolvedCoinImageSet = {
  thumb: string;
  small: string;
  large: string;
  source: ImageIdentitySource;
};

type NativeAssetMapping = {
  trustWalletAssetId: string;
};

type TrustedPlatformMapping = {
  trustWalletAssetId: string;
  contractAddressPattern: RegExp;
  normalizeContractAddress: (value: string) => string | null;
};

const TRUST_WALLET_ASSETS_BASE_URL = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains';

const CURATED_NATIVE_ASSET_MAPPINGS: Record<string, NativeAssetMapping> = {
  bitcoin: { trustWalletAssetId: 'bitcoin' },
  ethereum: { trustWalletAssetId: 'ethereum' },
  ripple: { trustWalletAssetId: 'xrp' },
  solana: { trustWalletAssetId: 'solana' },
  dogecoin: { trustWalletAssetId: 'dogecoin' },
};

const TRUSTED_PLATFORM_MAPPINGS: Record<string, TrustedPlatformMapping> = {
  ethereum: {
    trustWalletAssetId: 'ethereum',
    contractAddressPattern: /^0x[a-fA-F0-9]{40}$/,
    normalizeContractAddress: (value) => value.toLowerCase(),
  },
};

function buildTrustWalletNativeImageSet(trustWalletAssetId: string): ResolvedCoinImageSet {
  const path = `${TRUST_WALLET_ASSETS_BASE_URL}/${trustWalletAssetId}/info/logo.png`;
  return {
    thumb: path,
    small: path,
    large: path,
    source: 'trustwallet_native',
  };
}

function buildTrustWalletTokenImageSet(platformId: string, contractAddress: string): ResolvedCoinImageSet {
  const normalizedContractAddress = TRUSTED_PLATFORM_MAPPINGS[platformId]!.normalizeContractAddress(contractAddress)!;
  const path = `${TRUST_WALLET_ASSETS_BASE_URL}/${TRUSTED_PLATFORM_MAPPINGS[platformId]!.trustWalletAssetId}/assets/${normalizedContractAddress}/logo.png`;
  return {
    thumb: path,
    small: path,
    large: path,
    source: 'trustwallet_token',
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

  return buildTrustWalletNativeImageSet(mapping.trustWalletAssetId);
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

  return buildTrustWalletTokenImageSet(platformId, normalizedContractAddress);
}

export function resolveCoinImageIdentity(coin: CoinRow): ResolvedCoinImageSet | null {
  if (hasAnyImage(coin)) {
    return null;
  }

  return resolveCuratedNativeAssetImage(coin) ?? resolveTrustedPlatformContractImage(coin);
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
