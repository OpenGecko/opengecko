#!/usr/bin/env sh
set -eu

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but not installed" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but not installed" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed" >&2
  exit 1
fi

mkdir -p data

if [ ! -d node_modules ]; then
  bun install --frozen-lockfile
fi
