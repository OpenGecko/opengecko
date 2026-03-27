# SPEC: openGecko README.md Design

## Context

openGecko is a self-hostable, CoinGecko-compatible open-source API for crypto market data. The README needs to appeal to a broad audience (indie devs, startups, enterprise) with a bold and confident tone, leading with the comparison hook and featuring a feature-first structure.

## Goals

- Convince users that openGecko is a viable, superior alternative to CoinGecko for most use cases.
- Communicate technical credibility (real stack, real tests, real endpoints).
- Make it trivial to get started.
- Be honest about limitations — transparency builds trust.

## README Structure

### Section 1 — Hero

**Tagline:**
> The CoinGecko API you've been using — but open, self-hosted, and yours forever.

**Sub-headline (2 sentences):**
> openGecko is a drop-in, open-source replacement for the CoinGecko API. Deploy it anywhere, own your infrastructure, and never hit a rate limit again.

### Section 2 — Feature Highlights Grid

3-column grid, 6 key selling points:

| | |
|---|---|
| **~76 Endpoints** | Full CoinGecko-compatible surface — simple, coins, exchanges, derivatives, onchain DEX. |
| **60s Fresh Data** | Hot snapshot layer refreshed every 60 seconds. Every read is fast AND current. |
| **Zero Rate Limits** | Run your own instance. Scale it yourself. No API key, no quota, no surprises. |
| **Self-Hosted** | Deploy on Fly.io, Railway, your own VM. One command to start, SQLite under the hood. |
| **CCXT-Powered** | Aggregates data from Binance, Coinbase, Kraken, OKX, and every exchange CCXT supports. |
| **110+ Tests** | Integration-tested against live exchange data. Production-ready from day one. |

### Section 3 — Quick Start

Two panels side-by-side:

**Docker:**
```bash
docker run -p 3000:3000 opengecko
```

**From Source:**
```bash
git clone https://github.com/your-org/opengecko
cd opengecko && bun install && bun run dev
```

### Section 4 — Why openGecko

Bullet list comparing openGecko to CoinGecko pain points:

- **No rate limits.** Stop watching the clock. Self-host and call the API as much as your infrastructure can handle.
- **No vendor lock-in.** Your app breaks when CoinGecko changes pricing or limits. openGecko gives you full control.
- **Fresh data by default.** 60-second refresh cadence on market data — your users see what's happening now.
- **Observable freshness.** Every response carries data provenance. Know exactly how old your prices are.
- **Transparent by design.** Every intentional divergence from CoinGecko behavior is documented. No surprises.

### Section 5 — Built With

Stack badge row (text-based, no images):
`Bun · TypeScript · Fastify · SQLite · Drizzle ORM · CCXT`

### Section 6 — Architecture

One paragraph describing the three-layer architecture:

> openGecko is built in three layers. The **Compatibility API** layer exposes the CoinGecko-compatible REST surface — same paths, same parameters, same field names where possible. The **Domain Services** layer handles business logic, freshness rules, and response shaping. The **Storage / Provider** layer keeps a hot snapshot in SQLite (refreshed every 60s) and pulls live data from CCXT-connected exchanges (Binance, Coinbase, Kraken, OKX).

ASCII diagram:
```
┌─────────────────────────────────────────────────────────┐
│                    Compatibility API                     │
│           (CoinGecko-compatible REST surface)           │
└──────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                   Domain Services                        │
│         (freshness rules, response shaping)             │
└──────────────────────────┬────────────────────────────┘
                          │
         ┌────────────────┴────────────────┐
         │                                 │
┌────────▼────────┐            ┌───────────▼─────────────┐
│    SQLite       │            │         CCXT            │
│  (hot snapshot) │            │  (Binance, Coinbase,    │
│   60s refresh   │            │   Kraken, OKX, ...)     │
└─────────────────┘            └─────────────────────────┘
```

### Section 7 — Endpoint Families

Compact table:

| Family | Phase | Endpoints | Status |
|---|---|---|---|
| Simple + General | R0 | `/ping`, `/simple/*`, `/asset_platforms`, `/exchange_rates`, `/search`, `/global` | Stable |
| Coins + Contracts | R1 | `/coins/*`, `/contracts/*` | Stable |
| Exchanges + Derivatives | R2 | `/exchanges/*`, `/derivatives/*` | Stable |
| Public Treasury | R3 | `/entities/*`, `/public_treasury/*` | Stable |
| Onchain DEX | R4 | `/onchain/*` | In Progress |

### Section 8 — Roadmap

- Expanding onchain DEX coverage (more networks and aggregators)
- Additional CCXT exchange integrations
- Enhanced OHLCV history ingestion with broader coin coverage

### Section 9 — Contributing + License

Links to contributing guide, planning docs, and the open-source license. Include a note that the project welcomes providers, exchanges, and chain adapters.

## Tone Guidelines

- Bold and confident. State advantages directly, not hedged.
- No emoji in feature labels or headings. Emoji in the hero sub-headline is acceptable.
- Avoid superlatives without substance ("best", "most powerful") — let facts do the work.
- Acknowledge limitations honestly (no WebSocket parity yet, no NFT support) — transparency builds trust.

## Files

- `README.md` — new file, replace placeholder at repo root
- Add `LICENSE` file before README ships (MIT or Apache 2.0 — TBD)
