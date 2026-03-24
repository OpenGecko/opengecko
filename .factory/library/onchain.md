# Onchain

Onchain-specific knowledge for GeckoTerminal-style parity work.

**What belongs here:** JSON:API response conventions, network/dex/pool/token identity rules, include/relationship behavior, onchain search/ranking notes.

---

- Onchain endpoints should preserve JSON:API-style `data`, `included`, `relationships`, and `meta` shapes where applicable.
- Network and dex relationships are first-class and must stay internally consistent across list/detail endpoints.
- Avoid treating address casing differences as separate entities unless the contract explicitly requires rejection.
- Ranking/search/trending endpoints need deterministic behavior plus explicit invalid-param handling.
