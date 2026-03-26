# Image Hydration

Constraints, source strategy, and mapping rules for coin/token image hydration.

**What belongs here:** approved image sources, identity/mapping rules, confidence gates, and worker guidance for frontend-facing image fields.
**What does NOT belong here:** service commands/ports (use `.factory/services.yaml`) or feature status.

---

- Do not use the CoinGecko API for coin/token image hydration in this mission.
- Current OpenGecko coin rows often have `image_*_url = null` for exchange-discovered assets because catalog sync preserves existing image fields but does not hydrate new ones.
- `trustwallet/assets` is a viable non-CoinGecko source only when OpenGecko can identify an asset with high confidence.
- Treat image hydration as compatibility data, not best-effort guessing. Do not map by symbol/name alone for ambiguous assets.

## Approved strategy for this mission

- Build a broader asset-identity layer first.
- This mission's acceptance bar is **major/frontend-critical assets**, not all long-tail exchange-discovered coins.
- Safe image hydration targets in this mission:
  - curated native assets (for example BTC/ETH/SOL) with explicit mappings
  - assets with trusted `platformsJson` contract mappings that can be normalized confidently
- Ambiguous assets may remain unhydrated for now rather than receiving incorrect images.

## Trust Wallet mapping constraints

- Native chain logos use blockchain-level paths and require a stable mapping from OpenGecko asset/native IDs to Trust Wallet blockchain folders.
- Token logos require `(chain, contractAddress)` identity and chain-specific normalization.
- EVM tokens generally require checksum-normalized addresses.
- Most exchange-discovered assets currently do not carry enough persisted identity metadata for broad safe hydration.

## Worker guidance

- Prefer explicit curated mappings and trusted platform/contract mappings over heuristic inference.
- Preserve existing image values when already present.
- Add characterization for both:
  - representative assets that should hydrate successfully
  - ambiguous or unmapped assets that should remain unchanged/null
- Validate frontend-facing surfaces directly:
  - `/coins/markets`
  - `/coins/:id`
  - relevant frontend contract scripts such as `scripts/modules/mr-market-frontend/mr-market-frontend.sh`
