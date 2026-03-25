# Module Test Scripts

Focused shell checks for endpoint families live under `scripts/modules/`.

Each module gets its own folder and entry script so endpoint-specific smoke checks stay small and easy to run.

Examples:

- `bash scripts/modules/simple/simple.sh`
- `BASE_URL=http://localhost:3000 bash scripts/modules/simple/simple.sh`
- `bash scripts/modules/coins/coins.sh`
- `bash scripts/modules/exchanges/exchanges.sh`
- `bash scripts/modules/global/global.sh`
- `bash scripts/modules/search/search.sh`
- `bash scripts/modules/assets/assets.sh`

Shared helpers for curl/jq assertions live in `scripts/modules/lib/common.sh`.
