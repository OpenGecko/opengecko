# User Testing

Testing surface, required testing skills/tools, and resource cost classification.

---

## Validation Surface

- **Surface type**: REST API endpoints (no browser UI)
- **Testing tool**: curl against local server
- **Server startup**: `PORT=3102 CCXT_EXCHANGES='' LOG_LEVEL=error bun run src/server.ts`
- **Startup time**: ~4-6 seconds (with CCXT_EXCHANGES='' for fast boot)
- **Database**: SQLite at `./data/opengecko.db` (or `:memory:` for tests)

### Endpoints to Test Per Milestone

**foundation-fixes**: `/global/market_cap_chart`, `/coins/bitcoin/market_chart`, `/coins/ethereum/contract/...`, `/token_lists/eth/all.json`, `/simple/token_price/eth`, `/ping`
**chain-id-resolution**: `/diagnostics/chain_coverage`, `/asset_platforms`, `/coins/ethereum/contract/...` with alias variants
**onchain-live-data**: `/onchain/networks`, `/onchain/networks/eth/pools`, `/onchain/networks/eth/pools/:address/ohlcv/hour`, `/onchain/networks/eth/pools/:address/trades`, `/onchain/simple/networks/eth/token_price/:addresses`
**historical-durability**: `/coins/bitcoin/market_chart`, `/coins/bitcoin/ohlc`, `/diagnostics/ohlcv_sync`
**exchange-live-fidelity**: `/exchanges`, `/exchanges/binance/tickers`, `/derivatives/exchanges`, `/exchanges/binance/volume_chart`
**compatibility-hardening**: All endpoints with invalid parameters, response shape validation

## Validation Concurrency

- **Machine**: 8 cores, 30GB RAM, ~19GB available
- **API server footprint**: ~80-120MB RAM per instance
- **Max concurrent validators**: 5 (each uses ~120MB for server + ~50MB curl overhead = ~170MB; 5 * 170MB = 850MB, well within 19GB * 0.7 = 13.3GB budget)
- **Test suite**: Vitest runs parallel by default, uses ~500MB peak

## Known Limitations

- Solana onchain endpoints remain seeded (no live Raydium subgraph)
- Holder/trader analytics remain fixture-backed
- The Graph requires API key — tests mock responses instead
- Server startup with CCXT exchanges enabled takes 30+ seconds (use CCXT_EXCHANGES='' for validation)
