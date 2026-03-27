# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** required env vars, external APIs, provider dependencies, setup quirks.
**What does NOT belong here:** service ports and commands; use `.factory/services.yaml` for that.

---

- Runtime: Bun `1.3.9`
- Database: local SQLite file at `data/opengecko.db`
- Background startup and refresh logic may need outbound network access for CCXT-backed syncs.
- Do not add Redis, Docker services, or any other external infrastructure for this mission.
- No new credentials are required to begin the mission.
- If a later provider/source needs credentials, workers must return that requirement to the orchestrator instead of inventing placeholders in committed code.
- For the approved image-hydration scope, credential-free public metadata sources are acceptable, but CoinGecko API usage for token images is explicitly out of scope.
- See `.factory/services.yaml` for the authoritative mission ports and service commands.
- Startup currently performs heavy initial sync before the listener becomes reachable; validation flows must poll for readiness instead of assuming immediate bind.
