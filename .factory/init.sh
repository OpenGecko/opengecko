#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Install dependencies (idempotent)
bun install --frozen-lockfile

# Ensure data directories exist
mkdir -p data
mkdir -p data/coingecko-snapshots
