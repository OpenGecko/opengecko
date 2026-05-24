#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

BASE_URL="${BASE_URL:-http://127.0.0.1:3103}"
export BASE_URL

modules=()
while IFS= read -r -d '' script; do
  module="$(basename "$(dirname "$script")")"
  [[ "$module" == "lib" ]] && continue
  modules+=("$module:$script")
done < <(find scripts/modules -mindepth 2 -maxdepth 2 -type f -name '*.sh' -print0 | sort -z)

echo "OpenGecko all module smoke gate"
echo "Target: ${BASE_URL}"
echo "Modules: ${#modules[@]}"
echo

echo "Running data quality gate: scripts/data-quality-gate.sh"
/usr/bin/env bash scripts/data-quality-gate.sh
echo "Data quality gate passed."
echo

for entry in "${modules[@]}"; do
  module="${entry%%:*}"
  script="${entry#*:}"
  echo "Running module smoke: ${module} (${script})"
  /usr/bin/env bash "$script"
  echo "Module smoke passed: ${module}"
  echo
done

echo "All module smoke checks passed."
