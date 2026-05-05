# OpenGecko Web PRD: Reference UI for the OpenGecko API

## 1. Document Purpose

This document is the canonical product requirements document for **OpenGecko Web**, a standalone open-source web application that consumes the OpenGecko API and renders a CoinGecko-shaped browsing experience.

It defines:

- what OpenGecko Web is and why it exists
- what user-facing surfaces it covers
- how it consumes the OpenGecko API
- how the repository is structured
- how the build, deploy, and release pipeline works
- how it serves as a parity smoke test for the API
- how it relates to other OpenGecko projects (API, Assets)
- how success will be measured

This is a separate project from the OpenGecko API server and from OpenGecko Assets. It has its own repository, its own CI/CD, and its own release cycle. It depends on the OpenGecko API as an upstream contract and on OpenGecko Assets for token images.

## 2. Executive Summary

OpenGecko Web is a thin, opinionated reference frontend for the OpenGecko API. It is **not** an attempt to clone the entire CoinGecko web product. It is a focused dogfooding surface that:

- proves the API works end-to-end against a CoinGecko-shaped user experience
- gives evaluators a live demo to interact with in under ten seconds
- serves as a contract regression test in CI: if the UI breaks, the API drifted
- gives self-hosters a working frontend they can deploy or fork without writing any UI code

The core product promise:

- **endpoint-honest**: every screen is built only on endpoints that have shipped in the API
- **zero proprietary backend**: the UI is a static SPA; all data comes from the OpenGecko API
- **swappable API base URL**: anyone can point the UI at any OpenGecko-compatible API (self-hosted, public demo, or CoinGecko itself) via a single env var
- **boring stack**: SvelteKit + TypeScript + Tailwind, no exotic dependencies, no auth, no accounts, no analytics by default
- **parity-driven**: scope grows as the API parity matrix grows. Never the reverse.

The key insight is that an API project without a visible UI is invisible. A UI without an API is a toy. Shipping both, in modular repos, gives OpenGecko a complete narrative for users, contributors, and evaluators while keeping each project replaceable.

## 3. Background and Opportunity

### 3.1 Why an API needs a reference UI

OpenGecko's product principle is contract compatibility with CoinGecko. Today, that compatibility is verified through:

- unit and integration tests in the API repo
- shell-based endpoint smoke tests under `scripts/modules/<module>/`
- the parity matrix in `docs/plans/2026-03-20-opengecko-endpoint-parity-matrix.md`

What is missing is a **rendering check**: does the API output actually drive a real product the way CoinGecko's output does? Endpoint tests assert field presence and types. They do not assert that the data is _coherent enough to render_ the screens CoinGecko renders. A reference UI is the only test that catches that class of drift.

### 3.2 Distribution and trust

API projects with no visible product surface struggle to attract users, contributors, and stars. CoinGecko itself is proof that the public web product is the front door for the API. A reference UI gives:

- a single URL to share with evaluators (`demo.opengecko.org`)
- a screenshot story for the README and social posts
- a credibility signal that the API is real, working, and used

### 3.3 Why a separate repository

A separate repo, mirroring the OpenGecko Assets pattern, gives:

1. **Independent release cadence**: UI changes do not require API releases and vice versa.
2. **Independent contributor pool**: frontend contributors do not need to learn the API codebase.
3. **Clear contract boundary**: the UI consumes the public API exactly the way any third party would. No internal shortcuts.
4. **Forkability**: self-hosters can fork the UI alone without forking the API.
5. **Discipline**: forces the API to be a real product surface, not a private internal interface for one frontend.

## 4. Product Goals

### 4.1 Primary goals

- Render every endpoint family currently marked shipped in the parity matrix using only public endpoints.
- Serve as a CI-grade contract test: a broken UI build blocks the API release that broke it.
- Provide a public hosted demo that always tracks the latest API release.
- Provide a one-command local dev experience: `bun install && bun dev` against a configurable API base URL.

### 4.2 Non-goals (explicitly out of scope)

- Full visual or feature parity with `coingecko.com`.
- Authentication, user accounts, watchlists, portfolio tracking, or any persisted user state.
- Any backend service of its own. No database, no API routes, no server-side caching beyond what SvelteKit's edge does for free.
- Any premium / Pro / Analyst-tier features. UI scope is locked to Public-tier endpoints.
- Mobile native apps.
- i18n / localization at launch. English only.
- Charting parity with CoinGecko's TradingView integration. A simple line/area chart is sufficient.

## 5. Scope and Phasing

Scope tracks the API parity matrix one-for-one. A screen ships only after every endpoint it depends on is shipped and stable in the API.

### 5.1 Phase W0: Foundation (1–2 weeks)

Goal: prove the architecture end-to-end with the smallest useful UI.

Screens:

- `/` — landing page with global stats card (`/global`), top movers strip (`/coins/markets?per_page=10&order=price_change_percentage_24h_desc`), and search box.
- `/coins` — paginated coins markets table, columns: rank, name+image, price, 1h/24h/7d %, 24h volume, market cap, sparkline.
- `/search?q=` — search results across coins, exchanges, categories using `/search`.
- `/ping` — trivial health page that pings the API and shows latency. Useful for self-hosters.

Endpoints consumed: `/ping`, `/global`, `/coins/markets`, `/search`, `/simple/supported_vs_currencies`.

### 5.2 Phase W1: Coin detail (2 weeks)

Screens:

- `/coins/[id]` — coin detail page: header (image, name, symbol, rank, price, 24h change), description, links, market data, supply, ATH/ATL, categories.
- `/coins/[id]/chart` — price chart with day-range selector (1, 7, 14, 30, 90, 180, 365, max) using `/coins/{id}/market_chart`.
- `/coins/[id]/historical` — point-in-time historical lookup via `/coins/{id}/history`.

Endpoints consumed: `/coins/{id}`, `/coins/{id}/market_chart`, `/coins/{id}/market_chart/range`, `/coins/{id}/history`, `/coins/{id}/tickers`.

### 5.3 Phase W2: Categories, exchange rates, simple price (1 week)

Screens:

- `/categories` — category list with aggregate stats.
- `/categories/[id]` — coins in a category, reusing the markets table component.
- `/exchange-rates` — BTC-relative exchange rates table.
- `/tools/price` — interactive `/simple/price` and `/simple/token_price` playground. Pick coins, pick vs_currencies, see live JSON + a rendered table side by side.

Endpoints consumed: `/coins/categories`, `/coins/categories/list`, `/exchange_rates`, `/simple/price`, `/simple/token_price/{id}`, `/asset_platforms`.

### 5.4 Phase W3: Exchanges (2 weeks, gated on API readiness)

Screens:

- `/exchanges` — exchange list table.
- `/exchanges/[id]` — exchange detail with volume chart and tickers.
- `/derivatives` — derivatives exchanges list (only if the API parity matrix has shipped these).

Endpoints consumed: `/exchanges`, `/exchanges/list`, `/exchanges/{id}`, `/exchanges/{id}/tickers`, `/exchanges/{id}/volume_chart`, `/derivatives`, `/derivatives/exchanges`.

### 5.5 Phase W4 and beyond

DeFi globals, trending, public treasury, NFT lists, and on-chain DEX screens are added one screen at a time, only after the corresponding API endpoint family is marked stable in the parity matrix. Each new screen is its own minor release.

## 6. Architecture

### 6.1 Stack

- **Framework**: SvelteKit (static adapter where possible, Node adapter as fallback for dynamic routes).
- **Language**: TypeScript, strict mode.
- **Styling**: Tailwind CSS + a tiny shadcn-svelte-style primitives layer for buttons, tables, dialogs.
- **Data fetching**: native `fetch` wrapped in a thin typed client generated from the OpenGecko OpenAPI spec.
- **Charts**: a small library (uPlot or lightweight-charts). No TradingView.
- **Icons**: lucide-svelte.
- **State**: URL-driven where possible (`?page=`, `?vs=`, `?days=`). No global store unless required.
- **Testing**: Vitest for unit, Playwright for end-to-end against a live API.
- **Package manager**: Bun.

### 6.2 Repository layout

```
opengecko/web
├── src/
│   ├── lib/
│   │   ├── api/                 # generated typed client + thin wrappers
│   │   ├── components/          # MarketsTable, CoinHeader, PriceChart, ...
│   │   ├── format/              # currency, percent, large-number formatters
│   │   └── config.ts            # API_BASE_URL, ASSET_IMAGE_BASE_URL, defaults
│   ├── routes/
│   │   ├── +layout.svelte
│   │   ├── +page.svelte         # landing
│   │   ├── coins/
│   │   ├── categories/
│   │   ├── exchanges/
│   │   ├── search/
│   │   ├── tools/price/
│   │   └── ping/
│   └── app.html
├── tests/
│   ├── unit/
│   └── e2e/                     # Playwright suites that double as parity tests
├── scripts/
│   └── generate-client.ts       # regenerates lib/api from OpenAPI spec
├── static/
├── package.json
├── svelte.config.js
├── tailwind.config.ts
└── README.md
```

### 6.3 Configuration

Single source of truth, all via environment variables, all overridable at build time and at runtime where the adapter allows:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_OPENGECKO_API_BASE_URL` | `https://api.opengecko.org/api/v3` | API origin |
| `PUBLIC_ASSET_IMAGE_BASE_URL` | matches API's default | Image CDN origin |
| `PUBLIC_DEFAULT_VS_CURRENCY` | `usd` | Default quote currency |
| `PUBLIC_BRAND_NAME` | `OpenGecko` | For self-hosters who want to rebrand |
| `PUBLIC_DEMO_BANNER` | unset | Optional banner text shown at top of every page |

No secrets. The UI never holds an API key. If the upstream API is rate-limited, the UI surfaces the rate-limit response gracefully.

### 6.4 Data flow

```diagram
╭────────────╮   HTTP   ╭───────────────────╮   HTTP   ╭──────────────────╮
│  Browser   │─────────▶│  OpenGecko Web    │─────────▶│ OpenGecko API    │
│  (user)    │◀─────────│  (SvelteKit SSR + │◀─────────│ (your instance   │
╰────────────╯   HTML   │   client fetch)   │   JSON   │  or public demo) │
                        ╰─────────┬─────────╯          ╰──────────────────╯
                                  │
                                  │ <img src=...>
                                  ▼
                        ╭───────────────────╮
                        │ OpenGecko Assets  │
                        │ CDN (jsDelivr)    │
                        ╰───────────────────╯
```

SSR is used for the first paint of detail and list pages so search engines and link unfurlers see real content. Client-side fetch is used for interactive controls (pagination, currency switch, day-range selector). Both paths use the same generated client.

## 7. The Parity Smoke Test

This is the most important non-obvious feature of OpenGecko Web.

### 7.1 Goal

Detect API contract drift before it ships, using the UI as the assertion surface.

### 7.2 Mechanism

A Playwright suite under `tests/e2e/parity/` is run in CI against:

1. a pinned snapshot of the OpenGecko API at the most recent stable release
2. the current main of the OpenGecko API (via its preview deploy)

The suite:

- visits every screen in the UI
- asserts that key DOM nodes are populated (price strings present, table rows > 0, image elements have `src`, etc.)
- captures the network responses and asserts schema-level shape using the generated types
- diffs visible numeric output between the two API versions where deterministic

A failed parity test produces:

- a screenshot of the broken screen
- the request URL and response body
- the diff between expected and actual response shape

### 7.3 Where it runs

- In `opengecko/web` CI: blocks PR merge if the UI breaks against the pinned API.
- In `opengecko/api` CI: runs as a downstream check via repository_dispatch. A breaking API change must either fix the UI in the same PR cycle or explicitly be tagged as a documented incompatibility per CLAUDE.md ("Document every intentional incompatibility explicitly").

## 8. Build, Deploy, and Release

### 8.1 Build

- `bun install`
- `bun run build` produces a static or hybrid SvelteKit output depending on adapter.
- `bun run generate:client` regenerates `lib/api` from the upstream OpenAPI spec. CI fails if generated files drift from committed.

### 8.2 Deploy

- Public demo: `demo.opengecko.org`, deployed from `main` on push.
- Hosting: Vercel, Netlify, or Railway. Pick whichever the API already uses for symmetry. Railway is the path of least resistance given the API already uses `railway.json`.
- Preview deploys for every PR.
- Health check: `/ping` page must render within 5 seconds, otherwise the deploy is rolled back.

### 8.3 Release

- SemVer.
- A new minor version every time a new screen ships.
- A new patch version for visual fixes, performance fixes, and dependency bumps.
- A new major version only for breaking config changes (env var renames, removed routes).
- CHANGELOG.md per release.
- Releases are tagged in git and published as GitHub releases. No npm package; the UI is consumed as a deployed app, not as a library.

## 9. Relationship to Other OpenGecko Projects

| Project | Role | Relationship to Web |
| --- | --- | --- |
| OpenGecko API | Backend, contract owner | Web's only data source. Web pins to API SemVer. |
| OpenGecko Assets | Image CDN | Web reads images via `PUBLIC_ASSET_IMAGE_BASE_URL`. No build-time coupling. |
| OpenGecko Web (this repo) | Reference frontend | Consumer-only. Owns no canonical data. |

The API repo gets one new responsibility: maintain a published, versioned OpenAPI spec at a stable URL. Web's CI consumes that spec to regenerate types. If the spec is missing or unparseable, that is a release-blocking bug for the API.

## 10. Documentation Updates Required in This Repo

Once OpenGecko Web exists, the following docs in this repository must be updated in lockstep:

- `CLAUDE.md`: add a "Reference UI" entry to the project direction section, mirroring the Assets entry. State that UI scope follows API parity, not the other way around.
- `docs/plans/2026-03-20-opengecko-coingecko-compatible-api-prd.md`: add a section noting that a reference UI exists and is the canonical contract dogfood surface.
- `docs/plans/2026-03-20-opengecko-engineering-execution-plan.md`: add the OpenAPI spec publication requirement and the downstream-CI hook for the UI parity suite.
- `docs/status/implementation-tracker.md`: add a new row tracking UI phase status alongside API phase status.
- `README.md`: add a "Try the demo" link and a screenshot.

## 11. Success Metrics

### 11.1 Functional

- 100% of shipped Public-tier API endpoints have at least one UI surface that exercises them.
- Parity smoke test runs green on every API release candidate.
- Public demo uptime ≥ 99.5% measured over rolling 30 days.
- First contentful paint on `/coins` ≤ 1.5s on a cold cache from a typical broadband connection.

### 11.2 Adoption

- Public demo URL is in the README within 1 week of W0 ship.
- At least 10 third parties have either deployed their own instance or linked to the demo within the first quarter.
- GitHub stars on `opengecko/web` reach 100 within the first quarter (rough proxy for visibility).

### 11.3 Quality

- 0 open P0 bugs at any release tag.
- Lighthouse Performance ≥ 90 on `/`, `/coins`, `/coins/[id]`.
- All routes pass axe-core accessibility audit at "no critical violations".

## 12. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| UI scope creeps beyond API parity | High | High | Lock rule: a screen cannot merge unless every endpoint it consumes is marked shipped in the parity matrix. |
| Maintenance burden pulls focus from API work | Medium | High | Keep the stack boring. Reject any dependency that does not pull its weight. Refuse feature requests that do not map to existing endpoints. |
| API contract drift breaks the UI silently | Medium | High | Parity smoke test in CI on both repos. UI breakage blocks API release. |
| Demo costs money and nobody pays it | Medium | Medium | Static SvelteKit output deployed to Vercel free tier. No backend, no DB, near-zero cost. |
| Self-hosters have CORS issues hitting their API | High | Medium | Document the CORS requirement in API docs. Offer an optional same-origin reverse proxy template in the Web README. |
| Visual quality embarrasses the project | Medium | Medium | One design review (`/plan-design-review`) before W0 ship. Tailwind defaults + a small set of primitives keeps it credible without a dedicated designer. |

## 13. Open Questions

- Hosting platform: Vercel, Netlify, or Railway? Railway gives symmetry with the API; Vercel gives the best SvelteKit DX. Recommendation: start on Railway.
- OpenAPI spec: does the API currently publish one? If not, that is a prerequisite engineering item that lands in the API repo before W0 starts.
- Domain: `demo.opengecko.org` vs `web.opengecko.org` vs `app.opengecko.org`. Recommendation: `demo.opengecko.org` to keep expectations honest — it is a demo, not a product.
- Brand: should the UI ever be presented as more than a "reference UI"? If yes, the goalposts and budget change. Recommendation: explicit "reference UI" framing for at least the first year.

## 14. Decision Required

Approve this PRD to:

1. Create the `opengecko/web` repository.
2. Add the OpenAPI publication requirement to the next API milestone.
3. Begin Phase W0 implementation.
4. Update the docs listed in section 10 in lockstep with W0 ship.

## 15. Next Steps After Approval

1. Run `/plan-eng-review` on this PRD with the API maintainers in the room. Lock architecture and the OpenAPI spec contract.
2. Run `/plan-design-review` to set the visual baseline before any UI code is written.
3. Open `opengecko/web` repo with the layout in section 6.2.
4. Land the OpenAPI spec publication in the API repo as a blocking prerequisite for W0.
5. Ship Phase W0. Cut v0.1.0.
