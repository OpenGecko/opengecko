#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

allowlist_file="${1:-scripts/decomp/file-size-allowlist.txt}"

declare -A allowlisted
if [[ -f "$allowlist_file" ]]; then
  while read -r path _max_lines _reason; do
    [[ -z "${path:-}" || "${path:0:1}" == "#" ]] && continue
    allowlisted["$path"]=1
  done < "$allowlist_file"
fi

offenders=()

check_area() {
  local dir="$1"
  local max_lines="$2"

  while IFS= read -r -d '' file; do
    local rel="${file#./}"
    local lines
    lines="$(wc -l < "$file" | tr -d '[:space:]')"
    if (( lines > max_lines )) && [[ -z "${allowlisted[$rel]:-}" ]]; then
      offenders+=("${rel}:${lines}>${max_lines}")
    fi
  done < <(find "$dir" -type f -name '*.ts' -print0)
}

check_area "src/modules/onchain" 800
check_area "src/modules/coins" 600
check_area "src/services/data-quality-diagnostics" 600
check_area "tests/modules" 800

if (( ${#offenders[@]} > 0 )); then
  echo "Decomposition file-size gate failed; non-allowlisted offenders:" >&2
  printf '  %s\n' "${offenders[@]}" >&2
  exit 1
fi

echo "Decomposition file-size gate passed."
