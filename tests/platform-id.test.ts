import { describe, expect, it } from 'vitest';

import {
  PLATFORM_ID_BY_ALIAS,
  resolveCanonicalPlatform,
  resolveCanonicalPlatformId,
} from '../src/lib/platform-id';

describe('platform id resolution', () => {
  it('resolves all documented aliases to their canonical ids', () => {
    const expected = new Map<string, string>([
      ['eth', 'ethereum'],
      ['erc20', 'ethereum'],
      ['bsc', 'binance-smart-chain'],
      ['bnbsmartchain', 'binance-smart-chain'],
      ['bep20', 'binance-smart-chain'],
      ['sol', 'solana'],
      ['btc', 'bitcoin'],
      ['trx', 'tron'],
      ['trc20', 'tron'],
      ['polygon', 'polygon-pos'],
      ['matic', 'polygon-pos'],
      ['arbitrum', 'arbitrum-one'],
      ['arb', 'arbitrum-one'],
      ['optimism', 'optimistic-ethereum'],
      ['op', 'optimistic-ethereum'],
      ['base', 'base'],
      ['avax', 'avalanche'],
      ['fantom', 'fantom'],
      ['xdai', 'gnosis'],
      ['celo', 'celo'],
      ['moonbeam', 'moonbeam'],
      ['moonriver', 'moonriver'],
      ['cronos', 'cronos'],
      ['kava', 'kava'],
      ['linea', 'linea'],
      ['scroll', 'scroll'],
      ['zksyncera', 'zksync'],
      ['mantle', 'mantle'],
      ['opbnb', 'opbnb'],
    ]);

    for (const [alias, canonicalId] of expected.entries()) {
      expect(PLATFORM_ID_BY_ALIAS.get(alias)).toBe(canonicalId);
      expect(resolveCanonicalPlatformId(alias)).toBe(canonicalId);
    }
  });

  it('gives chain identifier precedence over the raw alias value', () => {
    expect(resolveCanonicalPlatformId('custom_eth', { chainIdentifier: 1 })).toBe('ethereum');
    expect(resolveCanonicalPlatform('custom_eth', { chainIdentifier: 1 })).toEqual({
      canonicalPlatformId: 'ethereum',
      confidence: 'exact',
    });
  });

  it('classifies alias and chain-id matches as exact', () => {
    expect(resolveCanonicalPlatform('eth')).toEqual({
      canonicalPlatformId: 'ethereum',
      confidence: 'exact',
    });

    expect(resolveCanonicalPlatform('ignored', { networkName: 'BNB Smart Chain', chainIdentifier: 56 })).toEqual({
      canonicalPlatformId: 'binance-smart-chain',
      confidence: 'exact',
    });
  });

  it('classifies normalized network-name alias matches as exact', () => {
    expect(resolveCanonicalPlatform('mystery_network', { networkName: 'Polygon POS' })).toEqual({
      canonicalPlatformId: 'polygon-pos',
      confidence: 'exact',
    });
  });

  it('classifies unknown network-name fallback matches as heuristic', () => {
    expect(resolveCanonicalPlatform('mystery_network', { networkName: 'Polygon Super Chain' })).toEqual({
      canonicalPlatformId: 'polygon-super-chain',
      confidence: 'heuristic',
    });
  });

  it('normalizes known and unknown platforms into deterministic slugs', () => {
    expect(resolveCanonicalPlatform('Polygon_POS')).toEqual({
      canonicalPlatformId: 'polygon-pos',
      confidence: 'exact',
    });
    expect(resolveCanonicalPlatformId('Polygon_POS')).toBe('polygon-pos');
    expect(resolveCanonicalPlatformId('Made Up Chain')).toBe('made-up-chain');
  });

  it('marks empty fallthrough values as unresolved', () => {
    expect(resolveCanonicalPlatform('   ')).toEqual({
      canonicalPlatformId: '',
      confidence: 'unresolved',
    });
  });
});
