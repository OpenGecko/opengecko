# Exchange Data Divergences

Structured record of known OpenGecko vs CoinGecko exchange-data divergences.

| endpoint | field | description |
| --- | --- | --- |
| `/exchanges` | `trust_score`, `trust_score_rank` | Values remain partially seeded or nullable until OpenGecko owns CoinGecko-equivalent trust methodology; live volume is preferred but trust scoring is not yet parity-complete. |
| `/exchanges/{id}/tickers` | `cost_to_move_up_usd`, `cost_to_move_down_usd` | Depth values are derived approximations from recent volume rather than live order book depth snapshots. |
| `/derivatives` | `funding_rate` | Funding values are venue-seeded/live-ingested when available, but venues without a current funding feed may still surface `null` for dated futures contracts. |
| `/derivatives/exchanges` | ordering breadth | OpenGecko currently supports the main BTC-volume and open-interest sort orders needed by parity coverage, but not every CoinGecko-specific ranking variant. |
