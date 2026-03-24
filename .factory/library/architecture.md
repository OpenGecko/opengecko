# Architecture

Architecture facts, decisions, and extension notes for workers.

**What belongs here:** route/module layout, service boundaries, data flow notes, architectural constraints discovered during mission work.
**What does NOT belong here:** per-feature TODOs or mission status.

---

- OpenGecko is a Bun + TypeScript + Fastify API with SQLite/Drizzle persistence.
- Existing route families live under `src/modules/`.
- Contract compatibility takes priority over internal elegance.
- Reuse existing patterns for validation, route registration, and DB access before introducing new abstractions.
- This mission completes the remaining in-roadmap endpoint surface, then hardens cross-endpoint compatibility semantics.
- Keep provider seams replaceable; do not couple new routes tightly to a single source unless unavoidable and surfaced to the orchestrator.
