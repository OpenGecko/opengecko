# OpenGecko Assets PRD: Self-Maintained Crypto Asset Image Repository

## 1. Document Purpose

This document is the canonical product requirements document for **OpenGecko Assets**, a standalone open-source repository that provides crypto asset images (token logos, chain icons, exchange logos) for the OpenGecko API platform and any other project that needs them.

It defines:

- what OpenGecko Assets is and why it exists
- what image assets it covers
- how images are sourced, validated, and distributed
- how the repository is structured
- how the build and release pipeline works
- how the community contributes
- how OpenGecko API integrates with this repository
- how success will be measured

This is a separate project from the OpenGecko API server. It has its own repository, its own CI/CD, and its own release cycle. The OpenGecko API consumes it as an upstream dependency.

## 2. Executive Summary

OpenGecko Assets is an open-source, community-maintained, automatically-curated repository of crypto asset images. It serves as the canonical image source for the OpenGecko API platform.

The core problem is simple: token metadata images are off-chain data that must be stored somewhere accessible. CoinGecko hosts its own CDN (`coin-images.coingecko.com`). For an open-source, self-hostable alternative, there must be a public, free, reliable image source that anyone can use without vendor lock-in.

The core product promise:

- **comprehensive coverage**: aim to cover 25,000+ tokens across 50+ chains at launch, growing continuously
- **zero-config for deployers**: OpenGecko API instances get working image URLs out of the box via public CDN
- **automated pipeline**: images are aggregated from multiple upstream sources automatically, not manually curated one-by-one
- **community-extensible**: anyone can submit missing logos via pull request
- **self-hostable**: deployers can fork the repo and point to their own CDN if desired

The key insight is that building a useful image repository is not about manually collecting logos. It is about building an **automated aggregation pipeline** that pulls from existing public sources, validates and normalizes images, deduplicates across sources, and produces a clean, versioned, CDN-ready output.

## 3. Background and Opportunity

### 3.1 The image problem in crypto APIs

Every crypto API needs to return image URLs for tokens, chains, and exchanges. These images are off-chain metadata — they do not live on any blockchain. They must be hosted somewhere.

Current approaches and their limitations:

| Approach | Limitation |
| --- | --- |
| CoinGecko CDN | Proprietary, TOS-restricted, not for third-party use |
| TrustWallet Assets repo | Community-maintained but coverage gaps (~8k tokens), strict listing requirements, slow PR review |
| Token-list logoURIs | Scattered across dozens of lists, inconsistent formats, many broken links |
| On-chain metadata (Metaplex, etc.) | Only covers some chains, URIs often point to IPFS with unreliable gateways |
| No images | Poor user experience, unprofessional API output |

### 3.2 Why a dedicated repository

A dedicated OpenGecko Assets repository solves the problem by:

1. **Aggregating** images from all available public sources into one canonical location
2. **Normalizing** them to a consistent format and size
3. **Distributing** them via free, production-grade CDN (jsDelivr)
4. **Versioning** releases so API consumers can pin to stable snapshots
5. **Automating** the pipeline so coverage grows without manual effort

### 3.3 Existing sources available for aggregation

| Source | Type | Estimated coverage | License |
| --- | --- | --- | --- |
| TrustWallet Assets | GitHub repo | ~8,000 tokens, ~60 chains | MIT |
| Uniswap Token List | JSON token-list | ~1,000 ETH/Polygon/Arb/OP tokens | GPL-3.0 |
| Jupiter Verified Token List | JSON token-list | ~1,000 Solana tokens | ISC |
| 1inch Token List | JSON token-list | ~2,000 multi-chain tokens | MIT |
| PancakeSwap Token List | JSON token-list | ~500 BSC tokens | GPL-3.0 |
| SushiSwap Token List | JSON token-list | ~1,500 multi-chain tokens | MIT |
| CoinGecko Token Lists | JSON token-list | ~10,000 multi-chain tokens | MIT |
| ErikThiart/cryptocurrency-icons | GitHub repo | ~15,000 icons (by symbol) | CC0 |
| cryptocurrency-icons (npm) | npm package | ~400 major tokens (SVG/PNG) | CC0 |
| On-chain metadata (Metaplex, etc.) | On-chain | Solana tokens with metadata | N/A |

Combined, these sources can provide initial coverage of **25,000+ unique tokens** after deduplication.

## 4. Product Goals

### 4.1 Primary goals

- Provide a single canonical source of crypto asset images for the OpenGecko ecosystem.
- Cover at least 25,000 tokens across 50+ chains at initial release.
- Deliver images via free CDN with zero configuration required by API deployers.
- Automate image aggregation from upstream sources so coverage grows without manual curation.
- Maintain a consistent image specification (format, size, quality) across all assets.
- Support community contributions for tokens not covered by automated sources.
- Version releases so API consumers can pin to stable, immutable image sets.

### 4.2 Secondary goals

- Provide a machine-readable manifest for efficient existence checks.
- Support exchange and chain logos in addition to token logos.
- Enable self-hosting deployers to fork and use their own CDN.
- Track coverage metrics and identify gaps by chain.

## 5. Non-Goals

- **Real-time updates**: this is a batch-processed repository, not a live service. Weekly releases are sufficient.
- **Image generation**: we do not generate placeholder or fallback images. If an image is missing, it is missing.
- **Image transformation**: we do not serve multiple sizes or formats dynamically. One canonical size is stored.
- **Token metadata beyond images**: this repository stores images only. Name, symbol, decimals, and other metadata belong in the OpenGecko API database.
- **NFT artwork**: this is for fungible token logos, chain icons, and exchange logos. NFT collection images are out of scope.
- **Copyright-problematic sources**: we do not scrape or redistribute images from sources with restrictive terms (e.g., directly downloading from CoinGecko's CDN).

## 6. Repository Structure

### 6.1 Directory layout

```
opengecko-assets/
├── chains/                              ← Chain/platform assets
│   ├── ethereum/
│   │   ├── logo.png                     ← Native coin logo (ETH)
│   │   └── assets/
│   │       ├── 0xdac17f958d2ee523a2206206994597c13d831ec7/
│   │       │   └── logo.png             ← ERC-20 token logo (USDT)
│   │       └── 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/
│   │           └── logo.png             ← ERC-20 token logo (USDC)
│   ├── solana/
│   │   ├── logo.png
│   │   └── assets/
│   │       └── EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/
│   │           └── logo.png
│   ├── bitcoin/
│   │   └── logo.png
│   ├── binance-smart-chain/
│   ├── polygon-pos/
│   ├── avalanche/
│   ├── arbitrum-one/
│   ├── optimistic-ethereum/
│   ├── base/
│   ├── tron/
│   ├── fantom/
│   └── ...
├── exchanges/                           ← Exchange logos
│   ├── binance/
│   │   └── logo.png
│   ├── coinbase-exchange/
│   │   └── logo.png
│   ├── okx/
│   │   └── logo.png
│   └── ...
├── scripts/                             ← Automation tooling
│   ├── sources/                         ← Source-specific importers
│   │   ├── trustwallet.ts               ← TrustWallet Assets importer
│   │   ├── tokenlists.ts                ← Token-list aggregator
│   │   ├── cryptocurrency-icons.ts      ← cryptocurrency-icons importer
│   │   └── onchain-metadata.ts          ← On-chain metadata resolver
│   ├── validate.ts                      ← Image validation (format, size, dimensions)
│   ├── generate-manifest.ts             ← Manifest generator
│   ├── deduplicate.ts                   ← Cross-source deduplication
│   ├── report.ts                        ← Coverage reporting
│   └── lib/
│       ├── image-utils.ts               ← Image processing helpers
│       ├── chain-mappings.ts            ← Source chain ID → CoinGecko platform ID mapping
│       └── download.ts                  ← Robust HTTP download with retry
├── manifest.json                        ← Auto-generated asset index
├── coverage-report.json                 ← Auto-generated coverage stats
├── chain-mappings.json                  ← Canonical chain ID mapping table
├── .github/
│   └── workflows/
│       ├── validate-pr.yml              ← PR validation CI
│       ├── scheduled-sync.yml           ← Weekly automated sync from upstream sources
│       └── release.yml                  ← Version tagging and release
├── CONTRIBUTING.md
├── LICENSE                              ← MIT
├── README.md
└── package.json
```

### 6.2 Naming conventions

| Entity | Directory naming | Rule |
| --- | --- | --- |
| Chain/Platform | `chains/{platform_id}/` | Use CoinGecko `asset_platforms` ID as the canonical slug (e.g., `ethereum`, `polygon-pos`, `binance-smart-chain`) |
| Native coin | `chains/{platform_id}/logo.png` | One logo per chain |
| Token | `chains/{platform_id}/assets/{contract_address}/logo.png` | Contract address in chain-native format |
| Exchange | `exchanges/{exchange_id}/logo.png` | Use CoinGecko exchange ID as the canonical slug |

### 6.3 Contract address normalization

| Chain family | Normalization rule | Example |
| --- | --- | --- |
| EVM chains (Ethereum, BSC, Polygon, etc.) | Lowercase, checksum not required | `0xdac17f958d2ee523a2206206994597c13d831ec7` |
| Solana | Case-sensitive, as-is | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Tron | Base58, as-is | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |
| Cosmos-based | Lowercase | `ibc/27394fb092d2eccd56123c74f36e4c1f926001ceada9ca97ea622b25f41e5eb2` |
| Other | Chain-native format, documented per chain | — |

## 7. Image Specification

### 7.1 Requirements for all images

| Property | Requirement |
| --- | --- |
| Format | PNG |
| Dimensions | 256 × 256 px (square, exact) |
| Background | Transparent preferred; solid color acceptable if part of official branding |
| File size | ≤ 100 KB |
| Color space | sRGB |
| File name | `logo.png` (always) |
| Content | Must be the official or widely-recognized logo for the asset |

### 7.2 Validation rules (enforced by CI)

1. File must be valid PNG
2. Dimensions must be exactly 256 × 256
3. File size must be ≤ 100 KB
4. File must be named `logo.png`
5. Parent directory must follow naming conventions (valid chain slug + valid contract address format)
6. No duplicate: same chain + contract address must not already exist

### 7.3 Image processing pipeline

When importing from upstream sources, images are automatically processed:

1. Download original image
2. Validate it is a valid image file (PNG, JPG, SVG, or WebP accepted as input)
3. Convert to PNG if not already
4. Resize to 256 × 256 (preserve aspect ratio, pad with transparency if needed)
5. Optimize file size (pngquant or similar)
6. Reject if result exceeds 100 KB after optimization
7. Write to canonical path

## 8. Automated Aggregation Pipeline

The pipeline is the core product. It replaces manual curation with automated sourcing.

### 8.1 Source priority and conflict resolution

When multiple sources provide an image for the same token, the highest-priority source wins:

| Priority | Source | Rationale |
| --- | :--- | --- |
| 1 (highest) | Manual override (committed directly) | Human-verified, intentional |
| 2 | TrustWallet Assets | Industry standard, community-vetted |
| 3 | Official token-lists (Uniswap, Jupiter, etc.) | Project-maintained, chain-specific |
| 4 | CoinGecko token-lists | Broad coverage |
| 5 | ErikThiart/cryptocurrency-icons | Largest symbol-based collection |
| 6 | On-chain metadata | Unvetted, fallback only |

A higher-priority source always replaces a lower-priority one. An existing image is never overwritten by a lower-priority source.

### 8.2 Source importers

Each source has a dedicated importer script under `scripts/sources/`.

#### 8.2.1 TrustWallet importer (`trustwallet.ts`)

- Clones or fetches `trustwallet/assets` repository
- Walks `blockchains/*/info/logo.png` for native chain logos
- Walks `blockchains/*/assets/*/logo.png` for token logos
- Maps TrustWallet chain names to CoinGecko platform IDs using `chain-mappings.json`
- Processes and copies images to canonical paths

Chain mapping table (subset):

| TrustWallet chain | CoinGecko platform ID |
| --- | --- |
| `ethereum` | `ethereum` |
| `smartchain` | `binance-smart-chain` |
| `polygon` | `polygon-pos` |
| `avalanchec` | `avalanche` |
| `arbitrum` | `arbitrum-one` |
| `optimism` | `optimistic-ethereum` |
| `base` | `base` |
| `solana` | `solana` |
| `tron` | `tron` |
| `fantom` | `fantom` |
| `cosmos` | `cosmos` |
| `near` | `near-protocol` |
| `sui` | `sui` |
| `aptos` | `aptos` |
| `ton` | `the-open-network` |

Full mapping maintained in `chain-mappings.json`.

#### 8.2.2 Token-list aggregator (`tokenlists.ts`)

- Fetches JSON token-lists from configured URLs
- For each token entry with a `logoURI`:
  - Resolves the chain using `chainId` → CoinGecko platform ID mapping
  - Downloads the image from `logoURI`
  - Processes and stores it
- Handles common `logoURI` patterns:
  - HTTPS URLs (direct download)
  - IPFS URIs (`ipfs://...` → public gateway resolution)
  - Data URIs (`data:image/...` → decode and process)

Configured token-list sources:

```json
[
  { "name": "Uniswap Default", "url": "https://tokens.uniswap.org", "priority": 3 },
  { "name": "Jupiter Verified", "url": "https://token.jup.ag/strict", "priority": 3 },
  { "name": "1inch", "url": "https://tokens.1inch.io/v1.2/1/tokens.json", "priority": 3 },
  { "name": "PancakeSwap", "url": "https://tokens.pancakeswap.finance/pancakeswap-extended.json", "priority": 3 },
  { "name": "SushiSwap", "url": "https://token-list.sushi.com", "priority": 3 },
  { "name": "CoinGecko Ethereum", "url": "https://tokens.coingecko.com/ethereum/all.json", "priority": 4 },
  { "name": "CoinGecko BSC", "url": "https://tokens.coingecko.com/binance-smart-chain/all.json", "priority": 4 },
  { "name": "CoinGecko Polygon", "url": "https://tokens.coingecko.com/polygon-pos/all.json", "priority": 4 },
  { "name": "CoinGecko Solana", "url": "https://tokens.coingecko.com/solana/all.json", "priority": 4 },
  { "name": "CoinGecko Avalanche", "url": "https://tokens.coingecko.com/avalanche/all.json", "priority": 4 },
  { "name": "CoinGecko Arbitrum", "url": "https://tokens.coingecko.com/arbitrum-one/all.json", "priority": 4 },
  { "name": "CoinGecko Base", "url": "https://tokens.coingecko.com/base/all.json", "priority": 4 }
]
```

#### 8.2.3 cryptocurrency-icons importer (`cryptocurrency-icons.ts`)

- Fetches the `ErikThiart/cryptocurrency-icons` repository
- These are indexed by symbol, not contract address
- Matching strategy:
  - Cross-reference symbol against OpenGecko's coin catalog to resolve chain + contract
  - Only import when there is an unambiguous 1:1 symbol → token match
  - Skip ambiguous symbols (e.g., multiple tokens with symbol "USDT" on different chains can be resolved because USDT has the same logo everywhere; but "SAFE" on different chains may be different projects)
- Lower priority — only fills gaps not covered by sources 1-4

#### 8.2.4 On-chain metadata resolver (`onchain-metadata.ts`)

- For Solana: reads Metaplex token metadata, resolves `uri` field, downloads image
- For EVM: reads ERC-20 metadata if available (rare for logos)
- Lowest priority, used only as final fallback
- Must validate that resolved images are actually logos (not NFT art, not broken IPFS links)

### 8.3 Deduplication logic (`deduplicate.ts`)

When processing multiple sources:

1. Build an in-memory index of `{chain}/{contract}` → `{source, priority, hash}`
2. For each candidate image, check if target path already exists
3. If exists: compare source priority. Only overwrite if new source has strictly higher priority.
4. If new: process and write
5. Log all decisions for auditability

### 8.4 Scheduled sync pipeline

A GitHub Actions workflow runs weekly (and can be triggered manually):

```
Trigger (weekly cron or manual dispatch)
  │
  ├── 1. Clone/fetch upstream sources
  ├── 2. Run importers in priority order (TW → token-lists → crypto-icons → on-chain)
  ├── 3. Process images (convert, resize, optimize)
  ├── 4. Deduplicate (priority-based conflict resolution)
  ├── 5. Validate all images (CI checks)
  ├── 6. Generate manifest.json
  ├── 7. Generate coverage-report.json
  ├── 8. Commit changes to main branch
  └── 9. Create versioned release tag if changes exist
```

## 9. Manifest and Coverage Reporting

### 9.1 manifest.json

Auto-generated on every sync and release. Provides a machine-readable index of all available assets.

```json
{
  "version": "1.2.0",
  "generated_at": "2026-03-31T00:00:00Z",
  "base_url": "https://cdn.jsdelivr.net/gh/opengecko/assets@v1.2.0",
  "stats": {
    "total_tokens": 28432,
    "total_chains": 52,
    "total_exchanges": 487,
    "total_native_coins": 52
  },
  "chains": {
    "ethereum": {
      "has_native_logo": true,
      "token_count": 8921,
      "tokens": [
        "0x0000000000085d4780b73119b644ae5ecd22b376",
        "0x0001a500a6b18995b03f44bb040a5ffc28e45cb0"
      ]
    },
    "solana": {
      "has_native_logo": true,
      "token_count": 3204,
      "tokens": [
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
      ]
    }
  },
  "exchanges": [
    "binance",
    "coinbase-exchange",
    "okx"
  ]
}
```

### 9.2 coverage-report.json

Tracks coverage gaps and source attribution:

```json
{
  "generated_at": "2026-03-31T00:00:00Z",
  "by_chain": {
    "ethereum": {
      "known_tokens_in_opengecko_db": 12500,
      "tokens_with_images": 8921,
      "coverage_pct": 71.4,
      "sources": {
        "trustwallet": 4200,
        "tokenlists": 3100,
        "cryptocurrency-icons": 1200,
        "manual": 321,
        "onchain-metadata": 100
      }
    }
  },
  "overall": {
    "known_tokens": 45000,
    "tokens_with_images": 28432,
    "coverage_pct": 63.2
  }
}
```

## 10. CDN Distribution

### 10.1 Primary distribution: jsDelivr

jsDelivr provides free, production-grade CDN for GitHub repositories with:

- Global multi-CDN (Cloudflare + Fastly), 540+ PoP nodes
- Permanent S3 storage — files remain available even if deleted from GitHub
- No rate limits, no bandwidth caps for open-source projects
- HTTP/2, Brotli compression, optimized caching
- China-optimized edge locations

URL pattern:

```
# Versioned (recommended for production — permanently cached)
https://cdn.jsdelivr.net/gh/opengecko/assets@v1.2.0/chains/ethereum/logo.png
https://cdn.jsdelivr.net/gh/opengecko/assets@v1.2.0/chains/ethereum/assets/0xdac17f.../logo.png
https://cdn.jsdelivr.net/gh/opengecko/assets@v1.2.0/exchanges/binance/logo.png

# Latest (follows main branch — 12h cache)
https://cdn.jsdelivr.net/gh/opengecko/assets@main/chains/ethereum/logo.png
```

### 10.2 Version pinning strategy

- Each weekly release creates a new semver tag: `v1.0.0`, `v1.1.0`, `v1.2.0`, ...
- **Patch** bump: image quality fixes, broken image replacements, no new tokens
- **Minor** bump: new tokens added, new chains, new exchanges (normal weekly sync)
- **Major** bump: directory structure changes, breaking manifest schema changes
- OpenGecko API pins to a specific version via config. Updated periodically.

### 10.3 Alternative distribution for self-hosters

| Deployment mode | Configuration |
| --- | --- |
| Default (zero-config) | jsDelivr CDN, pinned to latest release |
| Fork | Fork the repo, jsDelivr serves from the fork's URL |
| Self-hosted CDN | Fork the repo, deploy to own S3/CloudFront/Nginx, set `ASSET_IMAGE_BASE_URL` |
| Bundled | Clone repo contents into a static-file directory served by the API process |

## 11. OpenGecko API Integration

### 11.1 Configuration

```bash
# Default — uses OpenGecko's public asset repo via jsDelivr
# No configuration needed

# Custom asset source
ASSET_IMAGE_BASE_URL=https://cdn.jsdelivr.net/gh/opengecko/assets@v1.2.0

# Self-hosted
ASSET_IMAGE_BASE_URL=https://assets.my-domain.com
```

### 11.2 Image resolution fallback chain

The OpenGecko API's `asset-image-identity` service resolves images in this order:

```
1. Database override (image_thumb_url / image_small_url / image_large_url in coins table)
   ↓ if empty
2. OpenGecko Assets repo (via ASSET_IMAGE_BASE_URL + manifest existence check)
   ↓ if not in manifest
3. TrustWallet Assets (legacy fallback, kept for coverage during ramp-up)
   ↓ if not resolvable
4. Empty string (no image available)
```

### 11.3 Manifest-based existence check

The API server can optionally fetch and cache `manifest.json` at startup to know which tokens have images available. This avoids returning URLs that would 404:

- Fetch manifest on startup (or periodically)
- Before constructing an OpenGecko Assets URL, check if the chain + contract exists in the manifest
- If yes: return the CDN URL
- If no: fall through to next fallback

This is an optimization, not a requirement. Without the manifest, the API can still return CDN URLs speculatively — jsDelivr will return a 404 for missing images, which clients should handle gracefully.

### 11.4 Response format

The API continues to return CoinGecko-compatible image fields. The only change is the URL domain:

```json
{
  "image": {
    "thumb": "https://cdn.jsdelivr.net/gh/opengecko/assets@v1.2.0/chains/ethereum/assets/0xdac17f.../logo.png",
    "small": "https://cdn.jsdelivr.net/gh/opengecko/assets@v1.2.0/chains/ethereum/assets/0xdac17f.../logo.png",
    "large": "https://cdn.jsdelivr.net/gh/opengecko/assets@v1.2.0/chains/ethereum/assets/0xdac17f.../logo.png"
  }
}
```

Since we store only one 256×256 image, `thumb`, `small`, and `large` all point to the same URL. This is acceptable because:

- CoinGecko's own thumb/small/large are often the same image at different sizes
- 256×256 is small enough for "large" use and quality enough for "thumb" use
- Clients that need a specific size can resize client-side

## 12. Community Contribution

### 12.1 Contribution workflow

```
Contributor                              CI                         Maintainer
    │                                    │                              │
    ├── Fork repo                        │                              │
    ├── Add logo.png to correct path     │                              │
    ├── Open PR                          │                              │
    │                                    ├── Validate image spec        │
    │                                    ├── Validate directory naming  │
    │                                    ├── Check for duplicates       │
    │                                    ├── Report result ✓/✗          │
    │                                    │                              │
    │                                    │                              ├── Verify logo authenticity
    │                                    │                              ├── Merge or request changes
    │                                    │                              │
    └────────────────────────────────────────────────────── Done ───────┘
```

### 12.2 PR requirements

Every community PR must include:

1. Image file at the correct path (`chains/{platform_id}/assets/{contract_address}/logo.png`)
2. PR description with:
   - Token name and symbol
   - Chain and contract address
   - Official project website or link for verification
3. CI validation must pass (format, size, dimensions, naming)

### 12.3 Anti-abuse measures

- CI rejects images that are not valid PNGs or don't meet spec
- CI rejects paths with invalid chain slugs or malformed contract addresses
- Maintainers verify that submitted logos match the actual project (prevent phishing logos)
- Bulk submissions (>50 images) require maintainer pre-approval
- Rate limit: maximum 20 open PRs per contributor

## 13. CI/CD Pipeline

### 13.1 PR validation (`validate-pr.yml`)

Triggered on every pull request. Checks only changed/added files.

Steps:

1. Identify changed image files
2. For each image:
   - Validate PNG format
   - Validate 256×256 dimensions
   - Validate ≤ 100 KB file size
   - Validate directory path (chain slug exists in `chain-mappings.json`, contract address format is valid for that chain)
   - Check for duplicate (same chain + contract must not already exist unless this is a replacement)
3. Report results as PR comment

### 13.2 Scheduled sync (`scheduled-sync.yml`)

Triggered weekly (Sunday 00:00 UTC) and on manual dispatch.

Steps:

1. Checkout repository
2. Install dependencies
3. Run TrustWallet importer
4. Run token-list aggregator
5. Run cryptocurrency-icons importer
6. Run on-chain metadata resolver (optional, gated by flag)
7. Run deduplication pass
8. Run full validation
9. Generate `manifest.json`
10. Generate `coverage-report.json`
11. If changes exist:
    - Commit to main
    - Trigger release workflow

### 13.3 Release (`release.yml`)

Triggered after scheduled sync completes with changes, or manually.

Steps:

1. Calculate version bump (minor for new images, patch for fixes)
2. Update version in `package.json` and `manifest.json`
3. Create git tag
4. Create GitHub release with changelog summary (new tokens count, new chains, coverage delta)
5. jsDelivr automatically picks up the new tag

## 14. Technical Stack

| Component | Technology | Rationale |
| --- | --- | --- |
| Runtime | Bun | Consistent with OpenGecko API |
| Language | TypeScript | Consistent with OpenGecko API |
| Image processing | sharp (npm) | Fast, production-grade PNG/JPEG/WebP processing |
| Image optimization | pngquant (via sharp or CLI) | Lossless/near-lossless PNG compression |
| CI | GitHub Actions | Free for public repos, native GitHub integration |
| CDN | jsDelivr (via GitHub) | Free, multi-CDN, permanent storage, global |
| Package management | Bun | Consistent with OpenGecko API |

## 15. Success Metrics

### 15.1 Coverage metrics

| Metric | Target (launch) | Target (3 months) | Target (6 months) |
| --- | --- | --- | --- |
| Total tokens with images | 25,000 | 35,000 | 50,000 |
| Chains covered | 50 | 60 | 80 |
| Exchanges covered | 400 | 500 | 600 |
| Coverage of OpenGecko top-100 coins | 100% | 100% | 100% |
| Coverage of OpenGecko top-1000 coins | 95% | 98% | 99% |
| Overall coverage (vs OpenGecko coin DB) | 60% | 70% | 80% |

### 15.2 Operational metrics

| Metric | Target |
| --- | --- |
| Weekly sync success rate | > 99% |
| CDN availability (jsDelivr) | > 99.9% |
| Image validation pass rate (automated imports) | > 95% |
| Community PR response time | < 72 hours |
| Release cadence | Weekly |

### 15.3 Quality metrics

| Metric | Target |
| --- | --- |
| Images meeting spec (format, size, dimensions) | 100% |
| Broken/corrupted images | 0% |
| Incorrect logos (wrong project) | < 0.1% |

## 16. Risks and Mitigations

### Risk 1: Upstream source disappears or changes structure

**Impact**: automated sync breaks, coverage gaps.
**Mitigation**: each source importer is isolated. One failing source does not block others. Existing images are never deleted by automated sync — only new images are added. Monitor sync jobs for failures.

### Risk 2: Upstream source contains malicious or phishing logos

**Impact**: users see fake logos, potential fraud enablement.
**Mitigation**: higher-priority sources (TrustWallet, official token-lists) have their own vetting processes. Lower-priority sources go through deduplication, so they rarely introduce images for well-known tokens. Community PRs require maintainer review.

### Risk 3: Repository grows too large for GitHub / jsDelivr

**Impact**: clone times increase, jsDelivr may impose limits. At 256×256 PNG ≤ 100 KB per image, 50,000 images ≈ 5 GB maximum. GitHub supports repos up to 5-10 GB. jsDelivr supports repos up to 150 MB per request but serves individual files fine.
**Mitigation**: use shallow clones in CI. If repo exceeds GitHub comfort zone, split into per-chain sub-repos or switch to release-artifact-based distribution.

### Risk 4: License conflicts with upstream sources

**Impact**: legal risk.
**Mitigation**: only use sources with permissive licenses (MIT, CC0, Apache, GPL for token-lists which list logos by URL). Token logos themselves are generally trademarked by their projects — we redistribute them the same way TrustWallet does, as a community resource. Document all source licenses in README.

### Risk 5: jsDelivr service disruption

**Impact**: all image URLs break.
**Mitigation**: jsDelivr has multi-CDN redundancy (Cloudflare + Fastly) and 99.999% historical uptime. For additional safety, deployers can fork to their own CDN. The `ASSET_IMAGE_BASE_URL` env var makes switching trivial.

## 17. Implementation Roadmap

### Phase 1: Repository foundation (Week 1)

- Create repository with directory structure
- Implement image validation script (`validate.ts`)
- Implement chain-mappings configuration (`chain-mappings.json`)
- Set up PR validation CI workflow
- Write README and CONTRIBUTING.md
- Set up package.json with Bun + sharp dependencies

**Exit criteria**: empty repo accepts and validates community PRs correctly.

### Phase 2: TrustWallet import (Week 1-2)

- Implement TrustWallet importer (`trustwallet.ts`)
- Build image processing pipeline (convert, resize, optimize)
- Run initial import
- Generate first manifest.json

**Exit criteria**: ~8,000 tokens imported, manifest generated, validation passes.

### Phase 3: Token-list aggregation (Week 2)

- Implement token-list aggregator (`tokenlists.ts`)
- Handle chainId → platform ID mapping
- Handle logoURI download (HTTPS, IPFS, data URI)
- Implement deduplication logic
- Run aggregation pass

**Exit criteria**: ~13,000 total tokens (TW + token-lists), deduplication working.

### Phase 4: Broad coverage expansion (Week 3)

- Implement cryptocurrency-icons importer
- Implement on-chain metadata resolver (Solana Metaplex)
- Run full pipeline
- Generate coverage report
- Create first versioned release (v1.0.0)

**Exit criteria**: 25,000+ tokens, coverage report generated, v1.0.0 tag on jsDelivr.

### Phase 5: API integration (Week 3-4)

- Modify OpenGecko API `asset-image-identity.ts` to use OpenGecko Assets as primary source
- Add `ASSET_IMAGE_BASE_URL` configuration
- Implement optional manifest-based existence check
- Update fallback chain: DB → OpenGecko Assets → TrustWallet → empty

**Exit criteria**: OpenGecko API serves images from own asset repo, fallback chain works.

### Phase 6: Automation and community (Week 4)

- Set up scheduled sync workflow (weekly)
- Set up release workflow (auto-tagging)
- Open repository for community contributions
- Publish first coverage report
- Write announcement / documentation

**Exit criteria**: fully automated weekly sync, community PR flow tested, public.

## 18. Future Considerations

Items explicitly deferred but worth tracking:

- **SVG support**: storing logos as SVG in addition to PNG for vector-quality scaling. Adds complexity to validation.
- **Multiple sizes**: generating thumb (64×64), small (128×128), large (256×256) from a single source. Adds storage but improves client experience.
- **Dynamic image proxy**: an optional API endpoint that resizes/converts on the fly with caching. Higher operational complexity.
- **Exchange logo automation**: automated import of exchange logos from CCXT or other sources.
- **Category and chain-type icons**: icons for DeFi, GameFi, Layer-2, etc.
- **Image fingerprinting**: perceptual hashing to detect near-duplicate or placeholder images across tokens.
- **Decentralized backup**: pinning the full image set to IPFS as a permanent backup alongside GitHub.

## 19. Appendix

### A. Chain mapping reference

Full mapping from common source chain identifiers to CoinGecko platform IDs, maintained in `chain-mappings.json`. Initial set:

| Chain ID (EVM) | TrustWallet name | Token-list chainId | CoinGecko platform ID |
| --- | --- | --- | --- |
| 1 | `ethereum` | 1 | `ethereum` |
| 56 | `smartchain` | 56 | `binance-smart-chain` |
| 137 | `polygon` | 137 | `polygon-pos` |
| 43114 | `avalanchec` | 43114 | `avalanche` |
| 42161 | `arbitrum` | 42161 | `arbitrum-one` |
| 10 | `optimism` | 10 | `optimistic-ethereum` |
| 8453 | `base` | 8453 | `base` |
| 250 | `fantom` | 250 | `fantom` |
| 25 | `cronos` | 25 | `cronos` |
| 100 | `xdai` | 100 | `xdai` |
| — | `solana` | — | `solana` |
| — | `tron` | — | `tron` |
| — | `cosmos` | — | `cosmos` |
| — | `near` | — | `near-protocol` |
| — | `sui` | — | `sui` |
| — | `aptos` | — | `aptos` |
| — | `ton` | — | `the-open-network` |

### B. Related documents

- [OpenGecko API PRD](./2026-03-20-opengecko-coingecko-compatible-api-prd.md)
- [OpenGecko Endpoint Parity Matrix](./2026-03-20-opengecko-endpoint-parity-matrix.md)
- Current image resolution logic: `src/services/asset-image-identity.ts`
