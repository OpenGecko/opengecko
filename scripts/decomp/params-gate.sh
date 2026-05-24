#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

pattern='\b(Number\(|Number\.parseInt\(|Number\.parseFloat\(|parseInt\(|parseFloat\()'
targets=(
  src/modules/coins
  src/modules/onchain
  src/modules/simple.ts
  src/modules/derivatives.ts
  src/modules/exchanges.ts
  src/modules/exchange-tickers.ts
  src/modules/search.ts
)

matches="$(rg -n "$pattern" "${targets[@]}" || true)"

if [[ -z "$matches" ]]; then
  exit 0
fi

# Explicit allow-list for preserved non-query semantics:
# - parseHistoryDate's dd-mm-yyyy regex captures in coins/helpers.ts.
# - search.ts show_max keeps its characterized Number.parseInt implementation.
# - onchain formatter/normalizer modules below convert already-parsed DB/provider
#   primitives or toFixed() strings, not HTTP query primitives.
forbidden="$(
  printf '%s\n' "$matches" | grep -Ev \
    -e '^src/modules/coins/helpers\.ts:(211|212|213):' \
    -e '^src/modules/search\.ts:34:' \
    -e '^src/modules/onchain/ohlcv-routes\.ts:' \
    -e '^src/modules/onchain/(trades|tokens|pools)\.ts:' \
    -e '^src/modules/onchain\.ts:'
)" || true

if [[ -n "$forbidden" ]]; then
  {
    echo "Forbidden ad-hoc HTTP query numeric parsing found:"
    printf '%s\n' "$forbidden"
  } >&2
  exit 1
fi
