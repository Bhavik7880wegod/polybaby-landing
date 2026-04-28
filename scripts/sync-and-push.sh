#!/usr/bin/env bash
set -euo pipefail

# Run from anywhere — resolve the repo root from the script's location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# Stay in sync with remote before computing the new stats
git pull --rebase --autostash --quiet origin main

# Compute and write stats.json
node "$SCRIPT_DIR/sync-stats.mjs"

# Only commit if stats.json actually changed
if git diff --quiet stats.json; then
  echo "↳ no stat changes — skipping commit"
  exit 0
fi

git add stats.json
git -c user.email="polybaby-bot@noreply" -c user.name="polybaby-stats-bot" \
    commit -m "stats: $(date -u +%Y-%m-%dT%H:%MZ) live update" --quiet
git push --quiet origin main
echo "↳ pushed stats update"
