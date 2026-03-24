# API

HTTP contract notes for OpenGecko parity work.

**What belongs here:** endpoint-family semantics, response-shape rules, parameter normalization notes, error-envelope conventions.

---

- Preserve CoinGecko-compatible paths, param names, and field names.
- Prefer explicit 4xx validation for malformed params over silent coercion.
- Avoid adding OpenGecko-only response envelopes for in-scope parity endpoints.
- When extending an existing family, match its established null-vs-omitted and pagination behavior.
