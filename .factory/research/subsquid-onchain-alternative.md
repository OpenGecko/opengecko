# Subsquid / SQD Alternative Research

Researched 2026-03-27 for the remaining OpenGecko onchain-live-data gap.

## Summary

- SQD can be used without a custom squid for the current blocker by querying the public EVM API directly for raw Ethereum logs.
- Practical endpoint: `https://v2.archive.subsquid.io/network/ethereum-mainnet`
- This is suitable for fetching known-pool swap logs and deriving OpenGecko trades / OHLCV locally.
- This is materially smaller than building and hosting a custom Subsquid indexer or GraphQL serving layer.

## Why this path is viable

- Public raw-log querying is available with address and topic filters.
- No API key is required for the public gateway.
- The remaining mission gap is limited to Ethereum pool trades and OHLCV, so a direct raw-log client is a reasonable scoped replacement for the blocked The Graph path.

## Caveats

- The public gateway is rate-limited.
- The API is historical-focused; latest-block / hot-path coverage may still need careful freshness handling.
- OpenGecko must still decode swap logs and aggregate OHLCV locally.

## Sources

- `https://docs.sqd.ai/subsquid-network/reference/evm-api/`
- `https://docs.sqd.ai/subsquid-network/reference/networks/`
- `https://docs.sqd.ai/subsquid-network/overview/`
- `https://docs.sqd.ai/overview/`
