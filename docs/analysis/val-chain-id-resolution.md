# Chain-ID Resolution – Testable Behavioral Assertions

---

### VAL-CID-001: CCXT network IDs are normalized to canonical CoinGecko-style platform IDs during chain catalog sync

When `syncChainCatalogFromExchanges` processes exchange networks, each raw CCXT `networkId` must be resolved through `resolveCanonicalPlatformId` so that the resulting `assetPlatforms` row uses the CoinGecko-compatible form (e.g. `ethereum`, `binance-smart-chain`, `solana`) rather than the raw exchange alias (e.g. `eth`, `bsc`, `sol`).

**Pass condition:** After sync with an exchange that reports network IDs `ETH`, `BSC`, `SOL`, the `assetPlatforms` table contains rows with `id` values `ethereum`, `binance-smart-chain`, `solana` respectively — not `eth`, `bsc`, or `sol`.
**Evidence:** Query `assetPlatforms` table for `id IN ('ethereum','binance-smart-chain','solana')` and assert all three exist; query for `id IN ('eth','bsc','sol')` and assert none exist.

---

### VAL-CID-002: Legacy alias platform rows are deleted when canonical ID is inserted

During `syncChainCatalogFromExchanges`, if a legacy-aliased platform row exists in `assetPlatforms` (e.g. `id = 'eth'`) and the canonical resolution produces a different ID (e.g. `ethereum`), the legacy row must be explicitly deleted before the canonical row is upserted.

**Pass condition:** Pre-seed an `assetPlatforms` row with `id = 'bsc'`. After chain catalog sync that discovers Binance Smart Chain (chainId 56), the row `id = 'bsc'` no longer exists and `id = 'binance-smart-chain'` exists with `chain_identifier = 56`.
**Evidence:** `SELECT id FROM asset_platforms WHERE id = 'bsc'` returns zero rows; `SELECT id, chain_identifier FROM asset_platforms WHERE id = 'binance-smart-chain'` returns exactly one row with `chain_identifier = 56`.

---

### VAL-CID-003: Chain identifier takes precedence over alias when resolving canonical platform ID

`resolveCanonicalPlatformId` must check the numeric `chainIdentifier` map before falling back to the string alias map. If a network reports `networkId = 'custom_eth'` but `chainIdentifier = 1`, the resolution must return `ethereum` (from the chain identifier map), not a normalized form of the raw ID.

**Pass condition:** `resolveCanonicalPlatformId('custom_eth', { chainIdentifier: 1 })` returns `'ethereum'`.
**Evidence:** Unit test calling `resolveCanonicalPlatformId` directly with a non-matching string alias but matching numeric chain identifier, asserting the result equals the chain-identifier-mapped value.

---

### VAL-CID-004: Alias resolution covers all documented legacy identifiers

Every entry in the `PLATFORM_ID_BY_ALIAS` map (`eth`, `erc20`, `bsc`, `bnbsmartchain`, `binancesmartchain`, `bep20`, `sol`, `btc`, `trx`, `trc20`) must resolve to the expected canonical platform ID through `resolveCanonicalPlatformId`.

**Pass condition:** For each alias → canonical pair in the map, `resolveCanonicalPlatformId(alias)` returns the expected canonical ID.
**Evidence:** Parametrized unit test iterating all 15 alias entries and asserting exact output.

---

### VAL-CID-005: Platform shortnames are deterministic and match known conventions

`getCanonicalPlatformShortname` must return the well-known shortname for recognized platforms (`ethereum` → `eth`, `binance-smart-chain` → `bsc`, `solana` → `sol`, `bitcoin` → `btc`, `tron` → `trx`). For unknown platforms, it must return a deterministic slug derived from the platform ID, truncated to 12 characters.

**Pass condition:** Known platforms return their assigned shortname. An unknown platform like `avalanche-c-chain` returns a truncated normalized token (e.g. `avalanceccha`). The same input always produces the same output.
**Evidence:** Unit test calling `getCanonicalPlatformShortname` for all known entries plus at least two unknown platform IDs, verifying determinism with repeated calls.

---

### VAL-CID-006: /diagnostics/chain_coverage returns mapped vs unresolved platform counts

`GET /diagnostics/chain_coverage` must return a JSON body with `data.platform_counts.total`, `data.platform_counts.with_chain_identifier`, and `data.platform_counts.without_chain_identifier`, where `total = with_chain_identifier + without_chain_identifier`. The response must also contain `data.contract_mapping.active_coins`, `data.contract_mapping.coins_with_platform_mappings`, and `data.contract_mapping.coins_without_platform_mappings`.

**Pass condition:** Response status is 200. All six numeric fields are present and non-negative integers. `total == with_chain_identifier + without_chain_identifier` and `active_coins == coins_with_platform_mappings + coins_without_platform_mappings`.
**Evidence:** HTTP GET to `/diagnostics/chain_coverage`, parse JSON, assert field presence, types, and arithmetic invariants.

---

### VAL-CID-007: Contract-address lookup for an unknown platform returns 404 with explicit error

When `GET /coins/:platform_id/contract/:contract_address` is called with a `platform_id` that has no matching asset platform and no coin has a matching contract on that platform, the endpoint must return HTTP 404 with `{ error: 'not_found', message: 'Contract not found: <address>' }`.

**Pass condition:** `GET /coins/nonexistent-chain/contract/0x0000000000000000000000000000000000000000` returns status 404 with body containing `error: 'not_found'`.
**Evidence:** HTTP GET with fabricated platform and contract address, assert status code and error payload structure.

---

### VAL-CID-008: Contract resolution resolves across alias variants of the same platform

`getCoinByContract` must find a coin regardless of whether the caller uses a legacy alias (`eth`), canonical ID (`ethereum`), or shortname (`erc20`) for the platform, as long as the coin's `platformsJson` contains the contract under any of the resolved candidate IDs.

**Pass condition:** A coin with `platformsJson = '{"ethereum":"0xabc..."}'` is found via `getCoinByContract(db, 'eth', '0xabc...')`, `getCoinByContract(db, 'ethereum', '0xabc...')`, and `getCoinByContract(db, 'erc20', '0xabc...')`.
**Evidence:** Seed a coin with an Ethereum contract. Call `getCoinByContract` with three different alias forms. All three return the same coin.

---

### VAL-CID-009: /asset_platforms returns all CCXT-discovered platforms with chain identifiers

`GET /asset_platforms` must return an array where each element has the fields `id`, `chain_identifier`, `name`, `shortname`, `native_coin_id`, and `image`. Platforms discovered from CCXT that have a known chain ID must include a non-null `chain_identifier`.

**Pass condition:** After chain catalog sync, `GET /asset_platforms` response is an array. Each element has all six expected keys. At least one element has a non-null `chain_identifier`. No element has `id` matching a known legacy alias (`eth`, `bsc`, `sol`).
**Evidence:** HTTP GET, parse JSON array, validate field schema on every element, check for absence of legacy aliases.

---

### VAL-CID-010: Multi-exchange network discovery merges chain identifiers

When two exchanges report the same network (e.g. both report a network that resolves to `ethereum`) but only the second provides a `chainIdentifier`, the merged result must retain the non-null `chainIdentifier`.

**Pass condition:** Simulate two exchange network results — exchange A reports `ethereum` with `chainIdentifier: null`, exchange B reports `eth` with `chainIdentifier: 1`. After `syncChainCatalogFromExchanges`, the `assetPlatforms` row for `ethereum` has `chain_identifier = 1`.
**Evidence:** Seed two mock exchange network responses, run sync, query `assetPlatforms` for `ethereum`, assert `chain_identifier = 1`.

---

### VAL-CID-011: resolveRequestedPlatformIds exhaustively gathers all lookup candidates

`resolveRequestedPlatformIds` must return an array containing: the normalized input, the canonical platform ID from alias resolution, the shortname, and any matching `onchainNetworks.coingeckoAssetPlatformId`. This ensures contract lookups succeed regardless of which form the platform was stored under.

**Pass condition:** Given an `assetPlatforms` row `{ id: 'ethereum', shortname: 'eth', chain_identifier: 1 }` and an `onchainNetworks` row `{ id: 'eth', coingecko_asset_platform_id: 'ethereum' }`, calling `resolveRequestedPlatformIds(db, 'eth')` returns an array containing at least `['eth', 'ethereum']`.
**Evidence:** Seed both tables, call function, assert returned array is a superset of `['eth', 'ethereum']`.

---

### VAL-CID-012: Coins discovered from multiple exchanges share a single canonical platform entry

When exchange A and exchange B both report a network that resolves to the same canonical platform ID (e.g. both have currencies on `ethereum`), the chain catalog sync must produce exactly one `assetPlatforms` row for `ethereum`, not two.

**Pass condition:** Run `syncChainCatalogFromExchanges` with two exchanges that both expose Ethereum-compatible networks (one as `ETH`, another as `ERC20`). Assert `SELECT COUNT(*) FROM asset_platforms WHERE id = 'ethereum'` equals 1.
**Evidence:** Mock two exchanges, run sync, count rows for the canonical ID.

---

### VAL-CID-013: Unknown/unmapped networks fall through to normalized slug form

When a CCXT network ID cannot be matched to any alias or chain identifier, `resolveCanonicalPlatformId` must return a deterministic normalized slug (lowercase, hyphens for separators, no leading/trailing hyphens).

**Pass condition:** `resolveCanonicalPlatformId('Polygon_POS')` returns `'polygon-pos'`. `resolveCanonicalPlatformId('  ARBITRUM--ONE  ')` returns `'arbitrum-one'`.
**Evidence:** Unit test with novel network IDs that do not appear in alias or chain-identifier maps, asserting normalized output format.
