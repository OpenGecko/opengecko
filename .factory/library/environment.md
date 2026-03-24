# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** required env vars, external APIs, provider dependencies, setup quirks.
**What does NOT belong here:** service ports and commands; use `.factory/services.yaml` for that.

---

- Runtime: Bun `1.3.9`
- Database: local SQLite file at `data/opengecko.db`
- Background startup and refresh logic may need outbound network access for CCXT-backed syncs.
- Port boundary for this mission: `3100-3102`
- Port `6379` is off-limits.
- No new credentials are required to begin the mission.
- If a later provider/source needs credentials, workers must return that requirement to the orchestrator instead of inventing placeholders in committed code.
